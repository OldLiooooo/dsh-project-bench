// 2k 上下文编译（T4，契约 §6）与 per-session 注入状态。
//
// 预算：L0≤400 / L1≤300 / L2≤900（合计 1600，余量 400 留给工具结果），
// 总注入硬上限 2000 tokens（estimateTokens 保守估算）；任一层被裁剪或总量超限即降级。
//
// 注入状态机（与 host/prompts.js、host/session-hooks.js 共用）：
// - session/created 时 markSessionStartInjection：首步注入 L1/L2；
// - agent/pre-step 比较当前切片，切片变化时 markSliceChange：下一步重新注入 L1/L2；
// - prompts 只读 pendingFullInjection，pre-step 侧 consumeFullInjection 落账。
import { estimateTokens, truncateToTokens } from './util.js'
import { defaultBudget } from './project-defaults.js'
import { PM_ROLE, roleCardText } from './roles.js'

const EVENTS_LIMIT = 3
const DOC_LIMIT = 4
const SLICE_LIMIT = 5
const DECISION_LIMIT = 3

function textOf(value, fallback = '') {
  if (value === undefined || value === null) return fallback
  return String(value)
}

function oneLine(value, limit = 80) {
  const text = textOf(value).replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return text.slice(0, limit - 1) + '…'
}

function safeQuery(fn, fallback) {
  try { return fn() } catch (error) { return fallback }
}

function resolveBudget(explicit) {
  const base = typeof defaultBudget === 'function' ? defaultBudget() : { l0: 400, l1: 300, l2: 900, spare: 400, recall: 500, hardLimit: 2000 }
  const value = { ...base, ...(explicit && typeof explicit === 'object' ? explicit : {}) }
  return {
    l0: Math.max(1, Number(value.l0) || 400),
    l1: Math.max(0, Number(value.l1) || 300),
    l2: Math.max(0, Number(value.l2) || 900),
    recall: Math.max(1, Number(value.recall) || 500),
    hardLimit: Math.max(1, Number(value.hardLimit) || 2000),
  }
}

function listStages(db) {
  return safeQuery(() => db.db.prepare('SELECT * FROM stages WHERE project_id = ? ORDER BY position ASC').all(db.projectId), [])
}

function currentStageRow(db) {
  const stages = listStages(db)
  return stages.find((stage) => stage.status === 'active') || stages[stages.length - 1] || undefined
}

function countOf(db, sql, params = []) {
  const row = safeQuery(() => db.db.prepare(sql).get(db.projectId, ...params), undefined)
  return Number(row && row.n ? row.n : 0)
}

function sliceRow(db, sliceId) {
  if (!sliceId) return undefined
  return safeQuery(() => db.db.prepare('SELECT * FROM slices WHERE id = ? AND project_id = ?').get(sliceId, db.projectId), undefined)
}

function taskRow(db, taskId) {
  if (!taskId) return undefined
  return safeQuery(() => db.db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(taskId, db.projectId), undefined)
}

function acceptanceText(task) {
  if (!task) return ''
  const acceptance = safeParse(task.acceptance_json, {})
  const text = typeof acceptance === 'string' ? acceptance : JSON.stringify(acceptance)
  return oneLine(text, 700)
}

function safeParse(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback
  try { return JSON.parse(text) } catch (error) { return fallback }
}

function projectRow(db) {
  return safeQuery(() => db.project(), undefined) || {}
}

function activeSliceRows(db) {
  return safeQuery(
    () => db.db.prepare("SELECT * FROM slices WHERE project_id = ? AND status NOT IN ('done','archived') ORDER BY updated_at DESC LIMIT ?").all(db.projectId, SLICE_LIMIT),
    [],
  )
}

function pendingDecisions(db, sliceId) {
  if (sliceId) {
    return safeQuery(
      () => db.db.prepare("SELECT * FROM decisions WHERE project_id = ? AND slice_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT ?").all(db.projectId, sliceId, DECISION_LIMIT),
      [],
    )
  }
  return safeQuery(
    () => db.db.prepare("SELECT * FROM decisions WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT ?").all(db.projectId, DECISION_LIMIT),
    [],
  )
}

function documentRows(db, sliceId) {
  if (sliceId) {
    return safeQuery(
      () => db.db.prepare('SELECT *, d.title AS doc_title FROM documents d WHERE project_id = ? AND slice_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(db.projectId, sliceId, DOC_LIMIT),
      [],
    )
  }
  return safeQuery(
    () => db.db.prepare('SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?').all(db.projectId, DOC_LIMIT),
    [],
  )
}

function docSummaryLine(db, doc) {
  const row = safeQuery(
    () => db.db.prepare('SELECT content FROM doc_versions WHERE document_id = ? AND version = ? LIMIT 1').get(doc.id, doc.current_version),
    undefined,
  )
  const content = row && typeof row.content === 'string' ? row.content : ''
  const line = content.split(/\r?\n/).map((item) => item.replace(/^#+\s*/, '').trim()).find((item) => item.length > 0) || ''
  const type = doc.type || 'doc'
  const head = doc.logical_key || doc.title || doc.id
  const version = Number(doc.current_version || 0)
  return '· ' + type + '｜' + head + '｜v' + version + (line ? '｜' + oneLine(line, 100) : '')
}

function recentEventLines(db, sliceId) {
  const events = safeQuery(() => db.listEvents({ limit: EVENTS_LIMIT, sliceId: sliceId || undefined }), [])
  return events.map((event) => {
    const payload = event.payload && Object.keys(event.payload).length > 0 ? oneLine(JSON.stringify(event.payload), 60) : ''
    return '· #' + event.seq + ' ' + event.kind + (event.role ? '[' + event.role + ']' : '') + (sliceId ? '' : (event.sliceId ? '·slice=' + event.sliceId : '')) + (payload ? '｜' + payload : '')
  })
}

/** L0：项目名/阶段/门禁/当前切片/待决策数/活跃任务会话数（每步注入）。 */
export function buildL0(db, options = {}) {
  const project = projectRow(db)
  const stage = currentStageRow(db)
  const slice = sliceRow(db, options.sliceId)
  const pendingCount = countOf(db, "SELECT COUNT(*) AS n FROM decisions WHERE project_id = ? AND status = 'pending'")
  const activeTasks = countOf(db, "SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND kind = 'task' AND status = 'active'")
  const lines = []
  lines.push('【工作台 L0】项目：' + textOf(project.name || project.id, '(未命名)'))
  if (stage) {
    lines.push('阶段：' + textOf(stage.key) + ' ' + textOf(stage.name) + '｜门禁 ' + textOf(stage.gate || '-') + '（' + textOf(stage.status) + '）')
  } else {
    lines.push('阶段：（未初始化）')
  }
  if (slice) {
    lines.push('当前切片：' + textOf(slice.key) + ' ' + textOf(slice.title) + '（' + textOf(slice.status) + '）')
  } else if (options.roleKind === 'pm') {
    lines.push('当前切片：（PM 未指定；按需 project_status/brief 查询）')
  }
  lines.push('待决策 ' + pendingCount + '｜活跃任务会话 ' + activeTasks)
  return lines.join('\n')
}

/** L1：角色卡（读写边界 + 开工/收工清单），会话启动/切切片时注入。 */
export function buildL1(options = {}) {
  const role = options.roleKind === 'pm' ? PM_ROLE : textOf(options.role)
  return roleCardText(role)
}

/** L2：当前切片简报（任务验收/交接/相关文档摘要/最近事件 + 待决策）。 */
export function buildL2(db, options = {}) {
  const lines = []
  const sliceId = options.sliceId
  if (options.roleKind === 'pm' || !sliceId) {
    const slices = activeSliceRows(db)
    lines.push('【工作台 L2】在办切片（' + slices.length + '）')
    if (slices.length === 0) lines.push('· （暂无在办切片）')
    for (const slice of slices) {
      lines.push('· ' + textOf(slice.key) + ' ' + textOf(slice.title) + '（' + textOf(slice.status) + '｜owner ' + textOf(slice.owner_role || '-') + '）')
    }
    const sessions = safeQuery(
      () => db.db.prepare("SELECT name, role, provider, model FROM sessions WHERE project_id = ? AND kind = 'task' AND status = 'active' ORDER BY started_at DESC LIMIT ?").all(db.projectId, SLICE_LIMIT),
      [],
    )
    lines.push('活跃任务会话（' + sessions.length + '）')
    for (const session of sessions) {
      const model = [session.provider, session.model].filter(Boolean).join('/')
      lines.push('· ' + textOf(session.name) + (session.role ? '（' + session.role + '）' : '') + (model ? '｜' + model : ''))
    }
    for (const decision of pendingDecisions(db, undefined)) {
      lines.push('待决策：' + oneLine(decision.title, 60) + '｜' + oneLine(decision.question, 80))
    }
    for (const line of recentEventLines(db, undefined)) lines.push(line)
    return lines.join('\n')
  }

  const slice = sliceRow(db, sliceId)
  if (!slice) return '【工作台 L2】当前切片不存在（id=' + sliceId + '）'
  lines.push('【工作台 L2】切片：' + textOf(slice.key) + ' ' + textOf(slice.title) + '｜状态 ' + textOf(slice.status) + '｜owner ' + textOf(slice.owner_role || '-'))
  if (slice.current_handoff) lines.push('交接摘要：' + oneLine(slice.current_handoff, 400))
  const sliceAcceptance = acceptanceText(slice)
  if (sliceAcceptance) lines.push('切片验收：' + sliceAcceptance)
  const task = taskRow(db, options.taskId)
  if (task) {
    lines.push('本任务：' + textOf(task.title) + '（' + textOf(task.status) + '）')
    const acceptance = acceptanceText(task)
    if (acceptance) lines.push('本任务验收：' + acceptance)
  }
  const docs = documentRows(db, sliceId)
  if (docs.length > 0) {
    lines.push('相关文档：')
    for (const doc of docs) lines.push(docSummaryLine(db, doc))
  }
  for (const decision of pendingDecisions(db, sliceId)) {
    lines.push('待决策：' + oneLine(decision.title, 60) + '｜' + oneLine(decision.question, 80))
  }
  for (const line of recentEventLines(db, sliceId)) lines.push(line)
  return lines.join('\n')
}

/**
 * 编译 2k 注入上下文。
 * @returns {{text:string, used:number, parts:{l0:string,l1:string,l2:string}, degraded:boolean, budget:object}}
 */
export function compileContext(db, options = {}) {
  const budget = resolveBudget(options.budget)
  const opts = { roleKind: options.roleKind === 'pm' ? 'pm' : 'task', ...options }
  const raw = {
    l0: buildL0(db, opts),
    l1: options.includeL1 === false ? '' : buildL1(opts),
    l2: options.includeL2 === false ? '' : buildL2(db, opts),
  }
  const caps = { l0: budget.l0, l1: budget.l1, l2: budget.l2 }
  const parts = { l0: '', l1: '', l2: '' }
  let degraded = false
  for (const layer of ['l0', 'l1', 'l2']) {
    const capped = truncateToTokens(raw[layer], caps[layer])
    parts[layer] = capped
    if (capped !== raw[layer]) degraded = true
  }
  const join = (value) => [value.l0, value.l1, value.l2].filter((part) => part && part.length > 0).join('\n\n')
  let text = join(parts)
  if (estimateTokens(text) > budget.hardLimit) {
    degraded = true
    parts.l2 = ''
    text = join(parts)
    if (estimateTokens(text) > budget.hardLimit) {
      parts.l1 = ''
      text = join(parts)
    }
    parts.l0 = truncateToTokens(parts.l0, budget.l0)
    text = join(parts)
  }
  if (degraded) {
    text = (text ? text + '\n\n' : '') + '【上下文已降级】注入超出预算，使用 project_recall/doc_get 按需查询。'
  }
  return { text, used: estimateTokens(text), parts, degraded, budget }
}

// ---------------------------------------------------------------------------
// per-session 注入状态（prompts 读，session-hooks 写）
// ---------------------------------------------------------------------------

const sessions = new Map()

function stateOf(dshSessionId) {
  if (!dshSessionId) return undefined
  let state = sessions.get(dshSessionId)
  if (!state) {
    state = { dshSessionId, pendingFull: false, lastSliceId: undefined, lastStep: -1, steps: 0, downgrades: 0 }
    sessions.set(dshSessionId, state)
  }
  return state
}

/** 会话启动（session/created）：首步注入 L1/L2。 */
export function markSessionStartInjection(dshSessionId, sliceId) {
  const state = stateOf(dshSessionId)
  if (!state) return
  state.pendingFull = true
  state.lastSliceId = sliceId === undefined ? state.lastSliceId : sliceId
  state.steps = 0
}

/** 每步记账（agent/pre-step）：步数、当前切片；切片变化时标记下一步重新注入。 */
export function noteStep(dshSessionId, options = {}) {
  const state = stateOf(dshSessionId)
  if (!state) return
  if (Number.isFinite(Number(options.step))) state.lastStep = Number(options.step)
  state.steps += 1
  const sliceId = options.sliceId
  if (sliceId !== undefined && state.lastSliceId !== sliceId) {
    state.lastSliceId = sliceId
    state.pendingFull = true
  }
}

/** prompts 只读：本步是否包含 L1/L2。 */
export function pendingFullInjection(dshSessionId) {
  const state = dshSessionId ? sessions.get(dshSessionId) : undefined
  return Boolean(state && state.pendingFull)
}

/** pre-step 落账：本步已注入（或已确认不需要注入）后清空标记。 */
export function consumeFullInjection(dshSessionId, sliceId) {
  const state = stateOf(dshSessionId)
  if (!state) return
  state.pendingFull = false
  if (sliceId !== undefined) state.lastSliceId = sliceId
}

/** 会话释放时清状态，避免进程内泄漏。 */
export function forgetSessionInjection(dshSessionId) {
  sessions.delete(dshSessionId)
}

/** 降级计数（session-hooks 记 context/downgrade 事件）。 */
export function markDowngrade(dshSessionId, detail) {
  const state = stateOf(dshSessionId)
  if (!state) return false
  const token = detail && detail.sliceId !== undefined ? String(detail.sliceId) : 'l0'
  const key = String(token)
  state.downgradedKeys = state.downgradedKeys || new Set()
  if (state.downgradedKeys.has(key)) return false
  state.downgradedKeys.add(key)
  state.downgrades += 1
  return true
}

/** 测试/诊断快照。 */
export function injectionDiagnostics(dshSessionId) {
  const state = dshSessionId ? sessions.get(dshSessionId) : undefined
  if (!state) return undefined
  return {
    dshSessionId: state.dshSessionId,
    pendingFull: state.pendingFull,
    lastSliceId: state.lastSliceId,
    lastStep: state.lastStep,
    steps: state.steps,
    downgrades: state.downgrades,
  }
}

/** 清空全部状态（插件 dispose / 测试）。 */
export function resetInjectionState() {
  sessions.clear()
}
