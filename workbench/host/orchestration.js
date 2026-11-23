// 编排辅助（T4）：actor 身份解析、任务会话启动、PM/任务通知、重启对账、任务开场简报。
// 只依赖 node: 内置模块与 host/* 领域模块；所有写操作都经 store/docs/leases 的领域函数。
import { randomUUID } from 'node:crypto'
import { fail } from './db.js'
import { findProjectRoot, estimateTokens, truncateToTokens } from './util.js'
import { compileContext } from './context.js'
import { roleCardText, taskSessionName } from './roles.js'

export const PROJECT_PRESETS = Object.freeze(['project-office', 'project-task', 'project-qa'])
// qa（v5）：独立验收会话。它属于项目会话（能看项目工具），但只拿读 + 验收相关的最小工具面，
// 用 preset 的静态工具面 + 工具 actors 双重收紧 —— 「建造者不验收」不能只靠角色卡里那句话。
export const PROJECT_ACTOR_KINDS = Object.freeze(['pm', 'task', 'qa'])

const POSITIVE_TTL_MS = 5000
const NEGATIVE_TTL_MS = 2000
const MAX_CACHE_ENTRIES = 512

const actorCache = new Map()

function cacheKeyOf(agent) {
  const session = agent && agent.session
  if (!session || !session.id) return undefined
  return session.id + '|' + String((session.header && session.header.cwd) || '')
}

function pruneCache() {
  if (actorCache.size <= MAX_CACHE_ENTRIES) return
  const now = Date.now()
  for (const [key, entry] of actorCache) {
    if (entry.expiresAt <= now) actorCache.delete(key)
  }
  while (actorCache.size > MAX_CACHE_ENTRIES) {
    const oldest = actorCache.keys().next().value
    if (oldest === undefined) break
    actorCache.delete(oldest)
  }
}

/** 会话创建/结束时失效该 DSH 会话的 actor 缓存。 */
export function invalidateActorCache(dshSessionId) {
  if (!dshSessionId) return
  for (const key of actorCache.keys()) {
    if (key === dshSessionId || key.startsWith(dshSessionId + '|')) actorCache.delete(key)
  }
}

/** 清空全部缓存（插件 dispose / 测试）。 */
export function resetActorCache() {
  actorCache.clear()
}

function unknownActor(agent, extra = {}) {
  const session = agent && agent.session
  return {
    kind: 'unknown',
    dshSessionId: session ? session.id : undefined,
    cwd: session && session.header ? session.header.cwd : undefined,
    ...extra,
  }
}

function computeActor(deps, agent) {
  const session = agent && agent.session
  if (!session || !session.id || !session.header) return unknownActor(agent)
  const header = session.header
  const dshSessionId = session.id
  const cwd = header.cwd
  const preset = header.agentPreset
  // 注意：DSH 的 startActivation 子会话 header.origin 一律为 'subagent'（含工作台任务会话），
  // 因此身份的第一权威是项目 sessions 表的 dsh_session_id 行；只有"没有登记行 + DSH 层面是子会话"
  // 才判定为 subagent（子 agent 不写项目记忆 → 项目工具整组隐藏）。
  // 非项目 preset 的普通会话不查库（避免工作区 realpath 开销）；没有 preset 头的旧会话才用 .project 探测。
  if (!PROJECT_PRESETS.includes(preset)) {
    if (preset !== undefined || !cwd || !findProjectRoot(cwd)) {
      return unknownActor(agent, { preset })
    }
  }
  let rootInfo
  try { rootInfo = deps.registry.rootForWorkspace(cwd) } catch (error) { rootInfo = undefined }
  if (!rootInfo && cwd) {
    const root = findProjectRoot(cwd)
    if (root) {
      try { rootInfo = deps.registry.rootForWorkspace(root) } catch (error) { rootInfo = undefined }
    }
  }
  if (!rootInfo) return unknownActor(agent, { preset })
  let db
  try { db = deps.registry.open(rootInfo.root) } catch (error) { db = undefined }
  if (!db) return unknownActor(agent, { preset, root: rootInfo.root, rootInfo })
  let row
  try { row = deps.store.findSessionByDshId(db, dshSessionId) } catch (error) { row = undefined }
  // PM 会话兜底登记：session/created 监听器失败/竞态时，首次工具调用/注入时补登记。
  if (!row && preset === 'project-office' && deps.project && typeof deps.project.bindPmSession === 'function') {
    try { row = deps.project.bindPmSession(db, { dshSessionId }) } catch (error) { row = undefined }
  }
  if (!row) {
    // DSH 层面的子 agent（任务会话按需拉起的临时工）：不属于项目会话。
    if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) {
      return { kind: 'subagent', dshSessionId, cwd, preset, root: rootInfo.root, rootInfo, db }
    }
    return unknownActor(agent, { preset, root: rootInfo.root, rootInfo, db })
  }
  // 已结束的项目会话不再暴露/执行工具（收工/PM 切换后同一 DSH 会话仍可被打开，但只读兜底）。
  if (row.status !== 'active') {
    return unknownActor(agent, { preset, root: rootInfo.root, rootInfo, db, session: row, reason: 'session-ended' })
  }
  const kind = row.kind === 'pm' ? 'pm' : row.kind === 'task' ? 'task' : row.kind === 'qa' ? 'qa' : 'subagent'
  return {
    kind,
    dshSessionId,
    cwd,
    preset,
    root: rootInfo.root,
    rootInfo,
    db,
    session: row,
    sliceId: row.sliceId,
    role: row.role,
    name: row.name,
  }
}

/**
 * exec/agent → 项目 actor。
 * @returns {{kind:'pm'|'task'|'subagent'|'unknown', dshSessionId?:string, root?:string, rootInfo?:object,
 *   db?:object, session?:object, sliceId?:string, role?:string, name?:string}}
 */
export function resolveActor(deps, agent) {
  const key = cacheKeyOf(agent)
  if (!key) return unknownActor(agent)
  const now = Date.now()
  const cached = actorCache.get(key)
  if (cached && cached.expiresAt > now) {
    // 正缓存命中也要复核会话是否仍 active：会话收工/切换后同一 DSH 会话可能继续调用工具
    // （store.endSession 无法反向 import 本模块，因此把校验放在读路径；SQLite 点查开销可忽略）。
    const cachedActor = cached.actor
    if (cachedActor && (cachedActor.kind === 'pm' || cachedActor.kind === 'task') && cachedActor.db && cachedActor.session) {
      let fresh
      try { fresh = deps.store.getSession(cachedActor.db, cachedActor.session.id) } catch (error) { fresh = undefined }
      if (!fresh || fresh.status !== 'active') {
        actorCache.delete(key)
        return unknownActor(agent, { preset: cachedActor.preset, root: cachedActor.root, rootInfo: cachedActor.rootInfo, db: cachedActor.db, session: fresh, reason: 'session-ended' })
      }
      cachedActor.session = fresh
    }
    return cachedActor
  }
  let actor
  try {
    actor = computeActor(deps, agent)
  } catch (error) {
    actor = unknownActor(agent, { error: String(error && error.message ? error.message : error) })
  }
  const positive = actor.kind === 'pm' || actor.kind === 'task' || actor.kind === 'qa'
  actorCache.set(key, { actor, expiresAt: now + (positive ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) })
  pruneCache()
  return actor
}

/** actor 是否可见项目工具。 */
export function isProjectActor(actor) {
  return Boolean(actor) && PROJECT_ACTOR_KINDS.includes(actor.kind)
}

/** 取 actor 的根目录（工具导出/导入用）。 */
export function actorRoot(actor) {
  if (!actor) return undefined
  if (actor.root) return actor.root
  if (actor.rootInfo && actor.rootInfo.root) return actor.rootInfo.root
  return undefined
}

/** 解析切片：sliceId 优先，其次按 key 查（PM 工具用）。 */
export function resolveSlice(deps, actor, input = {}) {
  const db = actor.db
  if (!db) throw fail('NOT_PROJECT_SESSION', '当前会话没有项目库')
  if (input.sliceId) {
    const slice = deps.store.getSlice(db, input.sliceId)
    if (!slice) throw fail('NOT_FOUND', '切片不存在：' + input.sliceId)
    return slice
  }
  const key = input.sliceKey
  if (!key) throw fail('INVALID', '需要 sliceId 或 sliceKey')
  const slices = deps.store.listSlices(db, {})
  const slice = slices.find((item) => item.key === key)
  if (!slice) throw fail('NOT_FOUND', '切片 key 不存在：' + key + '（现有：' + slices.map((item) => item.key).join('/') + '）')
  return slice
}

/**
 * 构造任务会话开场提示：角色卡 + 2k 切片简报 + 验收 + PM 交代。
 *
 * v4：把「开场简报」纳入同一个预算（原来只有 compileContext 受预算约束，
 * PM 交代与验收是**无上限**拼进去的——PM 一次写长 brief 就能把注入撑到数倍）。
 * 预算顺序：角色卡(L1) 与切片简报(L2) 由 compileContext 裁剪；brief/acceptance 共享剩余额度，
 * 超出时先裁 brief（PM 可再发消息补充），再裁验收（验收是硬信息，最后才动）。
 * 返回值 added 字段如实给出：used（总注入）/ briefBudget / truncated，供 PM 与测试核对。
 */
export function buildTaskAssignment(input) {
  const { db, slice, task, role, action, brief, acceptance, projectName, stageLabel, budget } = input
  const name = taskSessionName(role, slice.key, action)
  const compiled = compileContext(db, {
    roleKind: 'task',
    role,
    sliceId: slice.id,
    taskId: task ? task.id : undefined,
    includeL1: true,
    includeL2: true,
    budget,
  })
  const hardLimit = compiled.budget && compiled.budget.hardLimit ? compiled.budget.hardLimit : 2000
  const acceptanceRaw = task
    ? (acceptance || (task.acceptance && Object.keys(task.acceptance).length > 0 ? JSON.stringify(task.acceptance) : ''))
    : (acceptance || '')
  /**
   * 组装函数：把可裁的两段（PM 交代 / 验收）按给定额度拼成完整提示。
   * 先按全额拼一次量出真实占用，再按**实际超出量**逐段回收 —— 这比「先估骨架」可靠：
   * 骨架估算漏掉一个 '## 本任务' 标题就会让总量突破硬上限（实测 2020 > 2000）。
   */
  const assemble = (briefText, acceptanceText) => {
    const lines = []
    lines.push('你是项目工作台的任务会话「' + name + '」（角色：' + role + '）。')
    lines.push('项目：' + (projectName || '(未命名)') + (stageLabel ? '｜阶段：' + stageLabel : ''))
    lines.push('你只对 PM（项目办公室）负责；用户只与 PM 对话，不要直接向用户提问。')
    lines.push('')
    lines.push('## 角色卡')
    lines.push(roleCardText(role))
    lines.push('')
    lines.push('## 切片简报')
    lines.push(compiled.parts.l2 || '(无)')
    if (task) {
      lines.push('')
      lines.push('## 本任务')
      lines.push('任务：' + task.title + '（' + task.status + '）')
      if (acceptanceText) lines.push('验收：' + acceptanceText)
    } else if (acceptanceText) {
      lines.push('')
      lines.push('## 本任务验收')
      lines.push(acceptanceText)
    }
    if (briefText) {
      lines.push('')
      lines.push('## PM 交代')
      lines.push(briefText)
    }
    lines.push('')
    lines.push('## 纪律')
    lines.push('1) 只写本切片写作用域内的代码/文档；片外零改动（收工会用真实 git diff 校验）。')
    lines.push('2) 需要人拍板的问题用 session_task_report 回 PM，不要直接问用户。')
    lines.push("3) 收工前用 evidence_add 记录证据（≥1 条），doc_write 写交接，最后 session_finish_task(status:'done', noOutOfScopeChanges:true)。")
    lines.push('4) 按需 project_recall/doc_get 查询；不要把整篇文档塞回上下文。')
    return lines.join('\n')
  }
  let briefText = brief ? String(brief) : ''
  let acceptanceText = acceptanceRaw ? String(acceptanceRaw) : ''
  let text = assemble(briefText, acceptanceText)
  let used = estimateTokens(text)
  if (used > hardLimit) {
    // ① 先裁 PM 交代（PM 可以再发一条消息补充，信息不会丢）
    const overBrief = used - hardLimit
    if (briefText) {
      briefText = truncateToTokens(briefText, Math.max(0, estimateTokens(briefText) - overBrief))
      text = assemble(briefText, acceptanceText)
      used = estimateTokens(text)
    }
    // ② 还不够就裁验收（验收是硬信息，最后才动）
    if (used > hardLimit && acceptanceText) {
      const overAcceptance = used - hardLimit
      acceptanceText = truncateToTokens(acceptanceText, Math.max(0, estimateTokens(acceptanceText) - overAcceptance))
      text = assemble(briefText, acceptanceText)
      used = estimateTokens(text)
    }
    // ③ 兜底：连骨架加 L1/L2 都超预算时（极端长角色卡/简报），整体硬截断并标注
    if (used > hardLimit) {
      text = truncateToTokens(text, hardLimit)
      used = estimateTokens(text)
    }
  }
  const truncated = (brief ? briefText !== String(brief) : false) || (acceptanceRaw ? acceptanceText !== String(acceptanceRaw) : false)
  return {
    name,
    text: text,
    used: used,
    hardLimit: hardLimit,
    degraded: compiled.degraded || truncated,
    truncated: { brief: Boolean(brief && briefText !== String(brief)), acceptance: Boolean(acceptanceRaw && acceptanceText !== String(acceptanceRaw)) },
    budget: compiled.budget,
  }
}

/**
 * PM 派任务：写 sessions 行 + 租约 + 事件，然后 startActivation 拉起 project-task 会话。
 *
 * v4 失败回滚（原来的三条缺口逐个补上）：
 *   1. 会话失败不记原因 → endSession 现在带 failureCode/failureDetail（SPAWN_FAILED 时落库）；
 *   2. 派活失败不回滚 task → 任务会被挂在一个已失败的会话上（幽灵指派）。现在显式回滚：
 *      task.status 回到 pending、assignee_session 清空，并写一条 task/status 事件（有据可查）；
 *   3. 失败路径零测试 → tests/unit/failure.test.mjs 覆盖 spawn 失败、租约冲突、栅栏抢占三条路径。
 */
export async function spawnTaskSession(ctx, deps, input) {
  const { actor, role, slice, task, action, brief, acceptance, provider, model, reasoningEffort, signal, parentAgent } = input
  const db = actor.db
  const name = taskSessionName(role, slice.key, action)
  if (!name) throw fail('INVALID', '任务会话命名失败：需要 角色-切片-动作')
  const dshSessionId = randomUUID()
  const agentOptions = {}
  if (provider) agentOptions.provider = provider
  if (model) agentOptions.model = model
  if (reasoningEffort) agentOptions.reasoningEffort = reasoningEffort
  const session = deps.store.createSession(db, {
    name,
    kind: 'task',
    role,
    sliceId: slice.id,
    dshSessionId,
    parentSessionId: actor.session.id,
    provider: provider || undefined,
    model: model || undefined,
    reasoningEffort: reasoningEffort || undefined,
    context: {
      action,
      brief: brief ? String(brief).slice(0, 8000) : undefined,
      acceptance: acceptance || undefined,
      taskId: task ? task.id : undefined,
      spawnedBy: actor.dshSessionId,
    },
  })
  let lease
  try {
    lease = deps.leases.acquireLease(db, {
      sliceId: slice.id,
      sessionId: session.id,
      ttlMs: deps.leases.DEFAULT_LEASE_TTL_MS,
      reason: 'task session spawn: ' + name,
    })
  } catch (error) {
    try {
      deps.store.endSession(db, {
        id: session.id, status: 'failed',
        failureCode: 'LEASE_ACQUIRE_FAILED',
        failureDetail: String((error && error.message) || error).slice(0, 500),
      })
    } catch (cleanupError) { /* 保留原始错误 */ }
    throw error
  }
  // 栅栏令牌落进会话上下文：之后所有写路径都会拿它与当前租约 epoch 比对（抢占后必然不符）。
  const fenceEpoch = lease ? Number(lease.epoch) : undefined
  if (fenceEpoch !== undefined) {
    try {
      deps.store.updateSession(db, { id: session.id, context: { ...session.context, taskId: task ? task.id : undefined, fenceEpoch } })
      session.context = { ...session.context, fenceEpoch }
    } catch (error) { /* 令牌写不进去时不阻断派活；写路径会退化为 holder 校验 */ }
  }
  let taskAdvanced = false
  if (task && typeof deps.store.updateTask === 'function') {
    try {
      deps.store.updateTask(db, { id: task.id, status: 'in_progress', assigneeSession: session.id })
      taskAdvanced = true
    } catch (error) { /* 任务状态更新失败不阻断派活 */ }
  }
  /** 回滚：任务不留在已失败的会话上（幽灵指派）。 */
  const rollbackTaskAssignment = () => {
    if (!taskAdvanced || !task || typeof deps.store.updateTask !== 'function') return
    try {
      deps.store.updateTask(db, { id: task.id, status: 'pending', assigneeSession: null })
    } catch (error) { /* 回滚失败不覆盖原始错误，但会在事件里缺失归属说明 */ }
  }
  const project = db.project() || {}
  const stage = deps.project && typeof deps.project.currentStage === 'function' ? deps.project.currentStage(db) : undefined
  const assignment = buildTaskAssignment({
    db,
    slice,
    task,
    role,
    action,
    brief,
    acceptance,
    projectName: project.name,
    stageLabel: stage ? stage.key + ' ' + stage.name : undefined,
  })
  let activation
  try {
    activation = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      childId: dshSessionId,
      label: name,
      // 契约（@deepseek-ai/dsh-subagent 0.2.2-rc.5 实测）：prompt / parent / agentPreset 是**顶层字段**。
      // 之前包在 request 里，DSH 侧 manager.startLocal 的 const parent = spec.parent 拿到 undefined，
      // 派活 100% 失败（错误只有一句 Cannot read properties of undefined (reading 'id')）。
      prompt: [{ type: 'text', text: assignment.text }],
      parent: parentAgent,
      agentPreset: 'project-task',
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      signal,
    })
  } catch (error) {
    const detail = String(error && error.message ? error.message : error)
    // 顺序很重要：先释放租约（释放校验 holder，会话还是 active 才不会被当成人已不在），
    // 再结束会话并写入失败原因，最后回滚任务指派。任一步失败都不覆盖原始错误。
    try { deps.leases.releaseLease(db, { sliceId: slice.id, sessionId: session.id }) } catch (cleanupError) { /* 保留原始错误 */ }
    try {
      deps.store.endSession(db, {
        id: session.id,
        status: 'failed',
        failureCode: 'SPAWN_FAILED',
        failureDetail: detail.slice(0, 500),
      })
    } catch (cleanupError) { /* 保留原始错误 */ }
    rollbackTaskAssignment()
    const wrapped = fail('SPAWN_FAILED', '任务会话启动失败：' + detail, {
      sessionId: session.id,
      dshSessionId,
      attempt: session.attempt,
      cause: String(error && error.code ? error.code : 'unknown'),
      // 失败原因同时带回给 PM：它要能立刻决定「重试 vs 换切片 vs 报告用户」。
      failureCode: 'SPAWN_FAILED',
      taskRolledBack: taskAdvanced,
    })
    throw wrapped
  }
  return { session, dshSessionId, lease, assignment, activation, name, fenceEpoch }
}

/** 找当前 active PM 会话行。 */
export function findPmSession(deps, db) {
  try {
    const rows = deps.store.listSessions(db, { kind: 'pm', status: 'active' })
    if (rows.length > 0) return rows[0]
  } catch (error) { /* 查询失败按无 PM 处理 */ }
  if (deps.project && typeof deps.project.pmEnsure === 'function') {
    try { return deps.project.pmEnsure(db) || undefined } catch (error) { /* 忽略 */ }
  }
  return undefined
}

/**
 * 任务会话 → PM 通知：优先子 agent 消息（真实对话），失败回退宿主 followup/steer 唤醒。
 * @returns {{delivered:boolean, method?:string, reason?:string}}
 */
export async function notifyPm(ctx, deps, db, input = {}) {
  const text = typeof input.text === 'string' ? input.text : ''
  if (!text) return { delivered: false, reason: 'empty' }
  const pm = findPmSession(deps, db)
  if (!pm || !pm.dshSessionId) return { delivered: false, reason: 'no-pm-session' }
  const sender = input.senderAgent
  if (sender && ctx.subagents && typeof ctx.subagents.sendMessage === 'function') {
    try {
      await ctx.subagents.sendMessage(sender, pm.dshSessionId, [{ type: 'text', text }], input.signal ? { signal: input.signal } : {})
      return { delivered: true, method: 'subagent-message', pmSessionId: pm.id, pmDshSessionId: pm.dshSessionId }
    } catch (error) {
      if (deps.project && typeof deps.project.wakePm === 'function') {
        try {
          const wake = deps.project.wakePm(ctx, db, text)
          return { delivered: Boolean(wake && wake.woke), method: 'wake-pm', reason: String(error && error.message ? error.message : error), pmSessionId: pm.id }
        } catch (wakeError) { /* 落到失败 */ }
      }
      return { delivered: false, method: 'subagent-message', reason: String(error && error.message ? error.message : error), pmSessionId: pm.id }
    }
  }
  if (deps.project && typeof deps.project.wakePm === 'function') {
    const wake = deps.project.wakePm(ctx, db, text)
    return { delivered: Boolean(wake && wake.woke), method: 'wake-pm', pmSessionId: pm.id }
  }
  return { delivered: false, reason: 'no-delivery-channel' }
}

/**
 * 重启对账：DB 中 active 任务会话但进程内没有 live agent → 标 interrupted + 释放其租约。
 * PM 会话保留 active（用户重开继续）。
 *
 * v4 变化（原实现对账「对了但没记原因」）：
 *   - 每个被中断的会话都落 failureCode='HOST_RESTART' + failureDetail（含 dshSessionId/attempt），
 *     之前只写 status='interrupted'，人无法回答「它为什么没了」；
 *   - 顺带发现**孤儿租约**（持租会话已经不是 active）也一并清理，否则新会话永远拿不到该切片；
 *   - 顺带发现**幽灵任务**（task.status=in_progress 但 assignee 会话已不在 active）回滚成 pending；
 *   - 结果里分别计数，便于面板/交接文档如实报告「这次重启修好了什么」。
 */
export function reconcileStaleSessions(ctx, registry, deps) {
  const result = {
    projects: 0, checked: 0, interrupted: 0, leasesReleased: 0,
    orphanLeases: 0, phantomTasks: 0, errors: [],
  }
  let projects = []
  try { projects = registry.listProjects() } catch (error) { return result }
  const live = new Set()
  try {
    for (const agent of ctx.agents.list()) if (agent && agent.session && agent.session.id) live.add(agent.session.id)
  } catch (error) { /* agents 服务不可用：按无 live agent 处理 */ }
  for (const item of projects) {
    if (!item || !item.exists) continue
    let db
    try { db = registry.open(item.workspaceId !== undefined ? item.workspaceId : item.root) } catch (error) { continue }
    if (!db) continue
    result.projects += 1
    let rows = []
    try { rows = deps.store.listSessions(db, { kind: 'task', status: 'active' }) } catch (error) { rows = [] }
    for (const row of rows) {
      result.checked += 1
      if (row.dshSessionId && live.has(row.dshSessionId)) continue
      try {
        deps.store.endSession(db, {
          id: row.id,
          status: 'interrupted',
          failureCode: 'HOST_RESTART',
          failureDetail: '重启对账：DB 中 active 但进程内无 live agent（dshSessionId=' + String(row.dshSessionId || '-') + '，attempt=' + String(row.attempt || 1) + '）',
        })
        result.interrupted += 1
      } catch (error) {
        result.errors.push({ sessionId: row.id, step: 'endSession', message: String((error && error.message) || error) })
      }
      if (row.sliceId) {
        try {
          const lease = deps.leases.getLease(db, row.sliceId)
          if (lease && lease.sessionId === row.id) {
            deps.leases.releaseLease(db, { sliceId: row.sliceId, sessionId: row.id })
            result.leasesReleased += 1
          }
        } catch (error) { /* 租约释放失败忽略（下一轮对账还会看到它） */ }
      }
    }
    // 孤儿租约：持租会话已经结束 → 租约永远挡着新会话。清掉并记数。
    let leaseRows = []
    try { leaseRows = db.db.prepare('SELECT slice_id, session_id FROM leases WHERE project_id = ?').all(db.projectId) } catch (error) { leaseRows = [] }
    for (const lease of leaseRows) {
      let holder
      try { holder = deps.store.getSession(db, lease.session_id) } catch (error) { holder = undefined }
      if (holder && holder.status === 'active') continue
      try {
        deps.leases.releaseLease(db, { sliceId: lease.slice_id, sessionId: lease.session_id })
        result.orphanLeases += 1
      } catch (error) {
        result.errors.push({ sliceId: lease.slice_id, step: 'releaseOrphanLease', message: String((error && error.message) || error) })
      }
    }
    // 幽灵任务：in_progress 但指派会话不 active（派活失败/会话中断但任务没回滚）。
    let taskRows = []
    try { taskRows = db.db.prepare("SELECT id, assignee_session FROM tasks WHERE project_id = ? AND status = 'in_progress'").all(db.projectId) } catch (error) { taskRows = [] }
    for (const task of taskRows) {
      if (!task.assignee_session) continue
      let assignee
      try { assignee = deps.store.getSession(db, task.assignee_session) } catch (error) { assignee = undefined }
      if (assignee && assignee.status === 'active') continue
      try {
        deps.store.updateTask(db, { id: task.id, status: 'pending', assigneeSession: null })
        result.phantomTasks += 1
      } catch (error) {
        result.errors.push({ taskId: task.id, step: 'rollbackPhantomTask', message: String((error && error.message) || error) })
      }
    }
  }
  return result
}
