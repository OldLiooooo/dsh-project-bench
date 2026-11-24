// 编排辅助（T4）：actor 身份解析、任务会话启动、PM/任务通知、重启对账、任务开场简报。
// 只依赖 node: 内置模块与 host/* 领域模块；所有写操作都经 store/docs/leases 的领域函数。
import { randomUUID } from 'node:crypto'
import { fail } from './db.js'
import { findProjectRoot, estimateTokens, truncateToTokens } from './util.js'
import { compileContext } from './context.js'
import { roleCardText, taskSessionName, isReadonlyRole } from './roles.js'

export const PROJECT_PRESETS = Object.freeze(['project-office', 'project-task', 'project-qa', 'project-research'])

/**
 * 角色 → 子会话 preset。
 *
 * 为什么按角色分 preset 而不是全部用 project-task：preset 是**工具面的硬边界**
 * （设计原则 1：提示词不算约束）。调研会话必须没有写文件工具，否则「只查不改」
 * 就只有角色卡里一句话在守。qa 已经是这个思路（project-qa），v6 把调研补上。
 */
export function presetForRole(role) {
  if (role === '调研') return 'project-research'
  return 'project-task'
}
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
    if (isReadonlyRole(role)) {
      // 只读角色（调研）的纪律与写者不同：它不改切片状态，交结果只走 report。
      lines.push('1) 只读：不改产品文件、不改代码/测试/文档正文；你只写调研报告（doc_write type=report）与证据。')
      lines.push('2) 每个结论必须带出处（文件:行 / 命令+输出摘要 / URL）；查不到就写「查不到」并说明查了哪里。')
      lines.push('3) 收工用 session_task_report 把结论交回 PM；**不要**调 session_finish_task（那会推进切片状态）。')
      lines.push('4) 按需 project_recall/doc_get 查询；不要把整篇文档塞回上下文。')
    } else {
      lines.push('1) 只写本切片写作用域内的代码/文档；片外零改动（收工会用真实 git diff 校验）。')
      lines.push('2) 需要人拍板的问题用 session_task_report 回 PM，不要直接问用户。')
      lines.push("3) 收工前用 evidence_add 记录证据（≥1 条），doc_write 写交接，最后 session_finish_task(status:'done', noOutOfScopeChanges:true)。")
      lines.push('4) 按需 project_recall/doc_get 查询；不要把整篇文档塞回上下文。')
    }
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
  // v6.1：接替「仍然 active 但已经收不到消息」的同(切片,角色)会话。
  //
  // 为什么必须有这一步：PM 会话重开/重启后，旧任务会话还挂在上一棵 activation 树里，
  // DB 里仍是 active（所以唯一性会拦新派单），但 DSH 的相邻关系规则已经不允许再投递。
  // 旧行为是死锁：PM 既发不出去，也派不进来，只能对用户说「拿不到结果」。
  // 现在改成：判定为不可投递的旧会话 → 标 interrupted（带原因）+ 释放它的租约，再建新会话。
  // 注意：判定不出来（ctx.agents 不可用）时**不动**旧会话 —— 宁可让 PM 看到唯一的报错，
  // 也不要因为探测不到就把它当成死的，误杀了还能用的会话。
  let superseded
  try {
    const previous = deps.store.listSessions(db, { kind: 'task', status: 'active', sliceId: slice.id, role: role })
    for (const row of previous) {
      if (!row) continue
      const deliverable = await canDeliverToSession(ctx, actor.dshSessionId, row.dshSessionId)
      if (deliverable !== false) continue
      try {
        deps.store.endSession(db, {
          id: row.id,
          status: 'interrupted',
          failureCode: 'SUPERSEDED_UNREACHABLE',
          failureDetail: '会话在 DB 里仍是 active，但 DSH 侧已无法投递（换树/进程重启）：' + String(row.name || row.id)
            + '（dshSessionId=' + String(row.dshSessionId || '-') + '）。PM 重新派单时被自动接替。',
        })
      } catch (error) { /* 结束失败就跳过接替，让下面的唯一约束报错（保留原语义） */ }
      try {
        const lease = deps.leases.getLease(db, slice.id)
        if (lease && lease.sessionId === row.id) deps.leases.releaseLease(db, { sliceId: slice.id, sessionId: row.id })
      } catch (error) { /* 租约释放失败：新会话 acquireLease 会明确报 LEASE_HELD */ }
      superseded = row
    }
  } catch (error) { /* 查询失败不阻断派单；唯一约束会给出明确错误 */ }
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
  // v6：只读角色（调研）不占写作用域租约。
  //
  // 租约的语义是「同一切片同时只有一个**写者**」，不是「同一切片同时只有一个会话」。
  // 让调研持租会把同切片的实现会话挡在门外 —— 拿写锁当排队用，正好是本末倒置。
  // 代价：调研会话没有写作用域，所以它在 doc_write/evidence_add 上仍会被自己的
  // actors/readonly 校验挡住（不会偷偷写），见 task-tools.js。
  const readonly = isReadonlyRole(role)
  let lease
  try {
    if (readonly) {
      lease = undefined
    } else {
      lease = deps.leases.acquireLease(db, {
        sliceId: slice.id,
        sessionId: session.id,
        ttlMs: deps.leases.DEFAULT_LEASE_TTL_MS,
        reason: 'task session spawn: ' + name,
      })
    }
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
  // 工作树 baseline 快照（v6.4）：收工时用它把「本次会话的改动」与「别人留下的脏状态」分开。
  //
  // 为什么必须在 spawn 时拍：越晚拍，越可能把别人的改动算进本次会话。
  // 为什么可以无条件拍：captureWorkspaceSnapshot 只写对象库 + 临时索引，不改工作树、不动真索引，
  // 拍不出来（无 git/沙箱禁 spawn）时返回 undefined，收工时会如实降级为整树口径并标注。
  let baselineSnapshot
  try {
    const snapRoot = actor.cwd || actor.root
    baselineSnapshot = deps.scope && typeof deps.scope.captureWorkspaceSnapshot === 'function'
      ? deps.scope.captureWorkspaceSnapshot(snapRoot, { tag: 'spawn' })
      : undefined
  } catch (error) { baselineSnapshot = undefined }
  const contextPatch = {
    taskId: task ? task.id : undefined,
    ...(fenceEpoch !== undefined ? { fenceEpoch } : {}),
    ...(baselineSnapshot ? { baselineSnapshot } : {}),
    // 会话自己的 cwd：worktree 隔离时它与项目根不同（lumio P1-2）。
    ...(actor.cwd && actor.cwd !== actor.root ? { worktree: actor.cwd } : {}),
  }
  try {
    deps.store.updateSession(db, { id: session.id, context: { ...session.context, ...contextPatch } })
    session.context = { ...session.context, ...contextPatch }
  } catch (error) { /* 上下文写不进去时不阻断派活；收工会退化为整树口径 */ }
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
      prompt: [{ type: 'text', text: assignment.text }],
      parent: parentAgent,
      agentPreset: presetForRole(role),
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
  return { session, dshSessionId, lease, assignment, activation, name, fenceEpoch, superseded: superseded ? { sessionId: superseded.id, name: superseded.name, dshSessionId: superseded.dshSessionId } : undefined }
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
 * 这个项目会话的 DSH agent 现在还能不能收消息？
 *
 * 为什么需要它（真机复验 2026-11-23 实测）：DSH 的 sendMessage 要求**确切相邻关系** ——
 * 消息只能在「同一条 activation 树」里投递。PM 会话重开/重启后是新的根会话，
 * 而旧的调研/任务会话挂在上一棵树里，于是 PM 调 session_send_task 会失败，
 * 报「existing session belongs to another sub-agent tree」。
 *
 * 那一刻 DB 里两边都是 active，面板上也看得见，但**消息通道已经断了**。
 * 旧实现对此毫无察觉：PM 既不能发消息（投递失败），也不能重新派单
 * （同切片同角色唯一性会拦），只能空手告诉用户「我拿不到结果」——
 * 这是真机上真实发生的死锁，不是理论问题。
 *
 * 判定口径（只认「现场事实」，不猜）：
 *   - ctx.agents 拿不到该会话的 agent（进程重启/会话被回收）→ 不可投递；
 *   - agent 存在但不在活动态、也没有 followup/steer 能力 → 不可投递；
 *   - 拿不到 ctx.agents 服务本身 → 返回 undefined（无法判定），由调用方决定是否放行。
 * @returns {boolean|undefined} true/false 为确定结论，undefined 为无法判定
 */
export async function canDeliverToSession(ctx, parentDshSessionId, dshSessionId) {
  if (!dshSessionId) return false
  const subagents = ctx && ctx.subagents
  // 只用**只读目录**判定（listChildren）：它是父会话持久化的直接子级清单，
  // 不加载也不恢复子 agent。绝不用「agents.get 拿不到」来推断失联 ——
  // 拿不到 live agent 可能只是还没物化，把它当成死了会误杀还能用的会话。
  // 目录不可用（无该服务/调用抛出）时返回 undefined = 无法判定，调用方必须保留原语义。
  if (!subagents || typeof subagents.listChildren !== 'function') return undefined
  if (!parentDshSessionId) return undefined
  let list
  try { list = await subagents.listChildren(parentDshSessionId) } catch (error) { return undefined }
  if (!Array.isArray(list)) return undefined
  const ids = new Set(list.map(function (entry) { return entry && entry.id }).filter(Boolean))
  return ids.has(dshSessionId)
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
    // v6.3：重启对账必须连 qa 一起扫。原先只扫 task，验收会话永远清不掉 ——
    // 「进程重启也解不开」（lumio P0-3）就是这么来的。qa 行没有租约，下面释放租约那段对它天然跳过。
    try {
      rows = deps.store.listSessions(db, { kind: 'task', status: 'active' })
        .concat(deps.store.listSessions(db, { kind: 'qa', status: 'active' }))
    } catch (error) { rows = [] }
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
