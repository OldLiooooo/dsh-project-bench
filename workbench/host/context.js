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

/**
 * 进度（v5）：口径与 snapshot.projectProgress 保持**完全相同** ——
 * 分母排除 archived/cut，doneUnverified 单列不进百分比。
 *
 * 为什么不直接 import snapshot.js：L0 是每步注入的热路径，
 * 而 snapshot 会拉 docs/store 一大串；这里只数两列，代价可忽略。
 * 但口径必须一致 —— 两处算错一处，PM 说的进度和面板显示的就会对不上。
 */
function progressOf(db) {
  const rows = safeQuery(() => db.db.prepare('SELECT status, COUNT(*) AS n FROM slices WHERE project_id = ? GROUP BY status').all(db.projectId), [])
  const by = new Map()
  for (const row of rows) by.set(String(row.status), Number(row.n))
  const num = (key) => Number(by.get(key) || 0)
  const verified = num('verified')
  const doneUnverified = num('done')
  const inFlight = num('in_progress') + num('review')
  const blocked = num('blocked')
  const notStarted = num('open')
  const total = verified + doneUnverified + inFlight + blocked + notStarted
  return {
    total, verified, doneUnverified, inFlight, blocked, notStarted,
    abandoned: num('archived') + num('cut'),
    percent: total === 0 ? 0 : Math.round((verified / total) * 100),
  }
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

/**
 * 取本切片最新一版 handoff 文档的正文节选（按段落边界截断）。
 *
 * 只取 handoff 类文档：PRD/ADR 的正文不该进 2k 预算（那是 doc_get 的事），
 * 而交接是「下一个人接手必须知道的事」，属于 L2 该付的预算。
 * @returns {string} 空串表示没有可用交接
 */
function latestHandoffPreview(db, sliceId, maxChars) {
  if (!sliceId) return ''
  const doc = safeQuery(
    () => db.db.prepare("SELECT id, current_version FROM documents WHERE project_id = ? AND slice_id = ? AND type = 'handoff' AND current_version > 0 ORDER BY updated_at DESC LIMIT 1")
      .get(db.projectId, sliceId),
    undefined,
  )
  if (!doc) return ''
  const row = safeQuery(
    () => db.db.prepare('SELECT content FROM doc_versions WHERE document_id = ? AND version = ? LIMIT 1').get(doc.id, doc.current_version),
    undefined,
  )
  const content = row && typeof row.content === 'string' ? row.content : ''
  if (!content.trim()) return ''
  const limit = Math.max(200, Number(maxChars) || 1200)
  if (content.length <= limit) return content.trim()
  // 按段落边界截，避免给出半句话；标题行保留（它说明这一轮做了什么）
  // 按二级标题切段，但**只有标题行的段要并进后一段**：
  // 否则 "# 交接：实现" 会独占一个极短的段，导致预算全花在标题上、真正正文被挤掉（实测踩到）。
  const blocks = []
  let pendingHeading = ''
  for (const block of content.split(/\n(?=##\s)/)) {
    const text = block.trim()
    if (!text) continue
    const isBareHeading = /^#{1,6}\s[^\n]*$/.test(text)
    if (isBareHeading) {
      pendingHeading = pendingHeading ? pendingHeading + '\n' + text : text
      continue
    }
    blocks.push(pendingHeading ? pendingHeading + '\n' + text : text)
    pendingHeading = ''
  }
  if (pendingHeading) blocks.push(pendingHeading)
  const out = []
  let used = 0
  for (const block of blocks) {
    const text = block.trim()
    if (!text) continue
    if (used + text.length > limit && out.length > 0) break
    out.push(text.length > limit - used ? text.slice(0, limit - used) : text)
    used += Math.min(text.length, limit - used)
    if (used >= limit) break
  }
  const joined = out.join('\n').trim()
  if (joined.length >= content.trim().length) return joined
  // 截断标记必须放在**开头**：这个预览后面还会被 compileContext 按 2k 预算再裁一次
  // （实测 L2 已到 900 token 上限时，尾部整段会被砍掉），标记写在尾部等于没写 ——
  // 模型会以为交接就这么短，而不是「这里被截了、全文要 doc_get」。
  return '（交接正文已截断，以下为节选；全文用 doc_get 取）\n' + joined
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
  // v5：进度进 L0。PM 若只看到「待决策/活跃会话」，回答「到哪了」就只能现场查 ——
  // 而设计 §6.2 要求 30 秒内答出三问。这里给最省字的形态：已验收 x/y（z%），外加待验收数。
  const progress = progressOf(db)
  const progressLine = progress.total > 0
    ? ('进度：已验收 ' + progress.verified + '/' + progress.total + '（' + progress.percent + '%）'
        + (progress.doneUnverified > 0 ? '｜已交付未验收 ' + progress.doneUnverified : '')
        + (progress.blocked > 0 ? '｜阻塞 ' + progress.blocked : ''))
    : '进度：（还没有切片）'
  lines.push(progressLine)
  return lines.join('\n')
}

/** L1：角色卡（读写边界 + 开工/收工清单），会话启动/切切片时注入。 */
export function buildL1(options = {}) {
  // qa 会话没有「角色词」（它不是 7 个任务角色之一），必须显式映射到验收卡，
  // 否则它的 L1 注入是空串 —— 会话会不知道自己来干什么（v5 接线时踩到的同一个坑）。
  const role = options.roleKind === 'pm' ? PM_ROLE
    : options.roleKind === 'qa' ? 'QA'
    : textOf(options.role)
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
  // 交接：优先注入 handoff 文档的正文节选，而不是 slices.current_handoff 那一行摘要。
  //
  // 为什么换：v6.1 实测 lumio 的最新交接 2594 字，原来只注入 current_handoff 的 400 字，丢 85%。
  // 新派的任务会话于是「不知道上一轮做到哪、为什么停」，只能重新查一遍 ——
  // 这是「同一个切片反复派活」的真实成本来源。
  //
  // 为什么**不**两个都注入：current_handoff 在实践中往往就是那份交接的开头
  // （lumio 的 slice 摘要是 doc_write 被门禁拒绝后的兜底），两份一起给等于同一段话说两遍，
  // 实测白烧 405 字符（≈200 token），把 L2 挤出预算并触发降级。
  // 兜底：没有 handoff 文档时才退回摘要（老项目/早期切片仍在用 current_handoff）。
  // 700 字（不是 900）：L2 的总预算是 900 token，而 CJK 大约 1 字 1 token。
  // 留出切片行/验收/文档摘要的位置，否则预览会独占预算、把别的段挤掉。
  const handoffPreview = latestHandoffPreview(db, sliceId, 700)
  if (handoffPreview) {
    lines.push('上一轮交接（节选，全文用 doc_get 取）：')
    for (const line of handoffPreview.split('\n')) lines.push(line)
  } else if (slice.current_handoff) {
    lines.push('交接摘要：' + oneLine(slice.current_handoff, 400))
  }
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
  // 三态：pm / qa / task。qa 不能被降级成 task（那会让它拿到任务角色卡与写心智）。
  const roleKind = options.roleKind === 'pm' ? 'pm' : options.roleKind === 'qa' ? 'qa' : 'task'
  const opts = { roleKind, ...options }
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
