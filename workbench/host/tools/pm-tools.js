// PM（项目办公室）工具（T4）：切片/任务/会话/决策/门禁/导出导入。仅 project-office 会话可见。
import { randomUUID } from 'node:crypto'
import { fail } from '../db.js'
import { newId, nowIso, estimateTokens, sha256 } from '../util.js'
import { TASK_ROLES, ROLE_HELP, isKnownRole, taskSessionName } from '../roles.js'
import { resolveSlice, spawnTaskSession, canDeliverToSession } from '../orchestration.js'
import { validateGateTarget } from '../project.js'
import { runProjectCheckers, summarizeCheckRun } from '../checkers.js'
import {
  params, S, N, B, A, STRING_ARRAY, requireProjectActor, requireText, optionalText,
  notifyWrite, currentStageOf, exportMapOf, rootOf,
} from './spec-helpers.js'

/** 规范化截止时间：接受 ISO 字符串；非法则报错而不是静默丢。 */
function normalizeDeadline(value) {
  if (value === undefined) return undefined
  const at = Date.parse(String(value))
  if (!Number.isFinite(at)) {
    throw fail('INVALID', 'deadline 必须是可解析的时间（ISO 8601，如 2026-11-25T18:00:00+08:00）：' + value)
  }
  return new Date(at).toISOString()
}

function minimalSession(session) {
  return {
    id: session.id,
    name: session.name,
    kind: session.kind,
    role: session.role,
    sliceId: session.sliceId,
    dshSessionId: session.dshSessionId,
    provider: session.provider,
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    status: session.status,
  }
}

/** project_init：幂等初始化项目（PM）。 */
export const projectInit = {
  name: 'project_init',
  description: '初始化/确认当前工作区项目运行时（建 .project/、DB、7 阶段并把 S1 置为 active）。幂等；PM 会话启动时通常已自动初始化。',
  parameters: params({ name: S('项目名称（可选，默认工作区标题）') }, []),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const workspaceId = actor.rootInfo && actor.rootInfo.workspaceId
    if (!workspaceId) throw fail('INVALID', '无法确定当前工作区 id')
    const result = deps.project.initProject(deps.registry, { workspaceId: workspaceId, name: optionalText(args.name) })
    notifyWrite(deps, actor)
    return { initialized: true, ...result, root: actor.root }
  },
}

/** slice_create：建切片。 */
export const sliceCreate = {
  name: 'slice_create',
  description: '创建切片（工作项 workitem 或模块 module）。key 是全局唯一短标识（会用于任务会话命名 角色-key-动作）。',
  parameters: params({
    key: S('切片唯一 key（如 payment-refund）'),
    title: S('切片标题'),
    type: S('workitem | module，默认 workitem'),
    parentId: S('父切片 id（可选）'),
    acceptance: { type: 'object', additionalProperties: true, description: '切片验收标准（JSON 对象，可选）' },
  }, ['key', 'title']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const slice = deps.store.createSlice(actor.db, {
      key: requireText(args.key, 'key'),
      title: requireText(args.title, 'title'),
      type: optionalText(args.type) || 'workitem',
      parentId: optionalText(args.parentId),
      acceptance: args.acceptance,
    })
    notifyWrite(deps, actor)
    return { slice: slice }
  },
}

/** slice_update：更新切片状态/owner/交接摘要。 */
export const sliceUpdate = {
  name: 'slice_update',
  description: '更新切片状态 / owner 角色 / 交接摘要。PM 可更新任意切片；任务会话只能更新本切片（且不能改 ownerRole）。',
  parameters: params({
    id: S('切片 id'),
    status: S('新状态（如 open/in_progress/review/done/blocked）'),
    ownerRole: S('owner 角色（PM 可用；产品/UX/架构/码农/测试/发布/复盘）'),
    title: S('新标题（可选）'),
    currentHandoff: S('交接摘要（可选，1-3 行）'),
  }, ['id']),
  actors: ['pm', 'task'],
  execute: async function (args, _exec, actor, deps) {
    const id = requireText(args.id, 'id')
    if (actor.kind === 'task') {
      if (id !== actor.sliceId) throw fail('PERMISSION_DENIED', '任务会话只能更新自己绑定的切片：' + (actor.sliceId || '(无)'))
      if (args.ownerRole !== undefined) throw fail('PERMISSION_DENIED', '任务会话不能修改切片 ownerRole')
    }
    const updated = deps.store.updateSliceStatus(actor.db, {
      id: id,
      status: optionalText(args.status),
      ownerRole: optionalText(args.ownerRole),
      title: optionalText(args.title),
      currentHandoff: args.currentHandoff === undefined ? undefined : String(args.currentHandoff),
      role: actor.role,
    })
    notifyWrite(deps, actor)
    return { slice: updated }
  },
}

/**
 * slice_scope：声明/查看/清空切片的写作用域（PM）。
 *
 * 为什么必须有这个工具：没有作用域声明，收工的「片外零改动」校验就永远只能返回
 * verifiable=false（无法区分片内片外）。声明入口缺失会让整套校验形同虚设——
 * 这也是「约束要么在 DB，要么在领域函数」的必然结果：可判定的前提是**有人能声明边界**。
 */
export const sliceScope = {
  name: 'slice_scope',
  description: '声明切片的写作用域（路径模式，如 src/refund/**）。声明后收工时会用真实 git diff 校验改动是否越界；不声明则无法判定（收工会如实标注未校验）。action=list 查看，declare 追加模式，clear 清空。',
  parameters: params({
    action: S('list | declare | clear（默认 list）'),
    sliceId: S('切片 id（与 sliceKey 二选一）'),
    sliceKey: S('切片 key（与 sliceId 二选一）'),
    patterns: STRING_ARRAY('路径模式数组，如 ["src/refund/**","tests/refund/**"]（declare 必填）'),
  }, []),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const action = optionalText(args.action) || 'list'
    if (action !== 'list' && action !== 'declare' && action !== 'clear') throw fail('INVALID', 'action 必须是 list / declare / clear')
    const slice = resolveSlice(deps, actor, { sliceId: optionalText(args.sliceId), sliceKey: optionalText(args.sliceKey) })
    if (action === 'list') {
      return { slice: { id: slice.id, key: slice.key }, scopes: deps.scope.listSliceScopes(actor.db, slice.id), declared: slice.scopeDeclared }
    }
    if (action === 'declare') {
      const patterns = Array.isArray(args.patterns) ? args.patterns : []
      if (patterns.length === 0) throw fail('INVALID', 'declare 需要 patterns（至少 1 个路径模式）')
      const scopes = deps.scope.declareSliceScope(actor.db, { sliceId: slice.id, patterns, addedBy: actor.dshSessionId })
      notifyWrite(deps, actor)
      return { slice: { id: slice.id, key: slice.key }, scopes, declared: true }
    }
    const cleared = deps.scope.clearSliceScope(actor.db, { sliceId: slice.id, addedBy: actor.dshSessionId })
    notifyWrite(deps, actor)
    return { slice: { id: slice.id, key: slice.key }, cleared: cleared.removed, declared: false }
  },
}

// scope_policy：项目级收工作用域策略（v6.3）。
//
// 为什么必须有这个工具：v4 引入了 scopePolicy=declare 与 acceptedOutOfScope，但全仓没有任何写入方
// （project-defaults.createProjectJson 不产出该键，只有 scope.js 在读）。结果是 lumio 真库上
// 「由 PM 显式接受越界」这条通道整体不可达，PM 只能反复 slice_scope 加路径（实测 16 分钟内改了 4 次）。
// 逃生门要么可达、要么不要存在；这里选前者，并把它做成需要写理由的显式动作。
export const scopePolicy = {
  name: 'scope_policy',
  description: '查看/设置项目级收工作用域策略（strict|declare|off）。strict=片外改动一律拒绝（默认）；declare=片外改动需 PM 显式接受（session_finish_task 传 acceptedOutOfScope+outOfScopeReason）；off=只报告不拦。crossScope（改动其它切片已声明的地盘）任何策略下都不默认接受。',
  parameters: params({
    action: S('get | set（默认 get）'),
    policy: S('strict | declare | off（set 必填）'),
    reason: S('改成该策略的理由（set 必填，会落进事件时间线）'),
  }, []),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const action = optionalText(args.action) || 'get'
    if (action !== 'get' && action !== 'set') throw fail('INVALID', 'action 必须是 get / set')
    const registry = deps.registry
    const current = deps.scope.scopePolicyOf(registry && typeof registry.projectJson === 'function' ? registry.projectJson(actor.root) : undefined)
    if (action === 'get') return { policy: current, configPath: 'project.json · scopePolicy' }
    const next = requireText(args.policy, 'policy')
    if (deps.scope.SCOPE_POLICIES.indexOf(next) < 0) throw fail('INVALID', 'policy 必须是 ' + deps.scope.SCOPE_POLICIES.join(' / '))
    const reason = requireText(args.reason, 'reason')
    if (!registry || typeof registry.updateProjectJson !== 'function') throw fail('UNAVAILABLE', 'registry 不支持写 project.json（配置写入入口未接线）')
    const written = registry.updateProjectJson(actor.root, { scopePolicy: next })
    // 配置变更也是事实：记进时间线，否则「谁把项目放宽到 off」事后无从查起。
    try {
      actor.db.tx(function () {
        actor.db.appendEvent({
          kind: 'project/config',
          subjectType: 'project',
          subjectId: actor.db.projectId,
          actorSession: actor.dshSessionId,
          role: actor.role,
          payload: { key: 'scopePolicy', from: current, to: next, reason: reason.slice(0, 300), jsonPath: written.jsonPath },
        })
        return true
      })
    } catch (error) { /* 事件写失败不阻断配置生效，但调用方会看到 written 为真 */ }
    notifyWrite(deps, actor)
    return { policy: next, previous: current, changed: written.changed, reason: reason }
  },
}

/**
 * slice_verify：验收切片（Verified Done）。
 *
 * 为什么是独立工具而不是 slice_update 的一个状态值：
 *   状态更新是「改字段」，验收是「签字」—— 后者要有签名人、要独立于实现者、要落独立事件。
 *   把两者合成一个工具，模型就会把它当状态用（"调一下 slice_update 设成 verified"），
 *   而那正是设计要防的「Verified Done 退化成又一个 done」。
 *
 * 谁能调：PM（代表用户/独立验收者）与 QA 会话（project-qa preset）。
 * 实现该切片的普通任务会话**不能**调（工具层 actors 里没有 task，且领域层还有 SELF_VERIFICATION_DENIED 双保险）。
 */
export const sliceVerify = {
  name: 'slice_verify',
  description: '验收切片（把 review/done 置为 verified，并记录验收人）。这是「唯一进度口径」的写入点：设计 §6.2 的进度、吞吐、一次通过率都只认 verified。硬约束：验收人不能是该切片最近一次实现会话（建造者不验收）；verified 是终态，不可回退。',
  parameters: params({
    sliceId: S('切片 id（与 sliceKey 二选一）'),
    sliceKey: S('切片 key（与 sliceId 二选一）'),
    verifiedBy: S('验收人（人名/身份标识，必填；会写进 verified_by 并计入审批签名）'),
    verifierSession: S('验收会话的 dshSessionId（可选但强烈建议：只有给了它才能做「建造者不验收」的强校验）'),
    resultSummary: S('验收结论摘要（验了什么、怎么验的、有没有遗留问题）'),
  }, ['verifiedBy']),
  actors: ['pm', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    const slice = resolveSlice(deps, actor, { sliceId: optionalText(args.sliceId), sliceKey: optionalText(args.sliceKey) })
    if (actor.kind === 'task' || actor.kind === 'qa') {
      if (slice.id !== actor.sliceId) throw fail('PERMISSION_DENIED', '验收会话只能验收自己绑定的切片：' + (actor.sliceId || '(无)'))
    }
    const verifiedBy = requireText(args.verifiedBy, 'verifiedBy')
    // verifierSession 默认取当前会话：否则「谁验的」与「哪个会话验的」会脱节，建造者校验失效。
    const verifierSession = optionalText(args.verifierSession) || actor.dshSessionId
    const result = deps.store.verifySlice(actor.db, {
      id: slice.id,
      verifiedBy: verifiedBy,
      verifierSession: verifierSession,
      resultSummary: optionalText(args.resultSummary),
      role: actor.role,
    })
    notifyWrite(deps, actor)
    return {
      slice: {
        id: result.slice.id, key: result.slice.key, title: result.slice.title,
        status: result.slice.status, verifiedBy: result.slice.verifiedBy, verifiedAt: result.slice.verifiedAt,
      },
      note: '切片已验收。进度只统计 verified 状态的切片；verified 是终态，返工请开新切片。',
    }
  },
}

/** task_create：建任务（PM）。 */
export const taskCreate = {
  name: 'task_create',
  description: '在切片下创建任务（PM 派活的可验收单元）。返回 task.id，可在 session_spawn_task 里用 taskId 绑定。',
  parameters: params({
    sliceId: S('所属切片 id（也可用 sliceKey）'),
    sliceKey: S('所属切片 key（与 sliceId 二选一）'),
    title: S('任务标题'),
    acceptance: { type: 'object', additionalProperties: true, description: '任务验收标准（JSON 对象，可选）' },
  }, ['title']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const slice = resolveSlice(deps, actor, { sliceId: optionalText(args.sliceId), sliceKey: optionalText(args.sliceKey) })
    const task = deps.store.createTask(actor.db, {
      sliceId: slice.id,
      title: requireText(args.title, 'title'),
      acceptance: args.acceptance,
    })
    notifyWrite(deps, actor)
    return { task: task, slice: { id: slice.id, key: slice.key, title: slice.title } }
  },
}

/** session_spawn_task：PM 拉起任务会话（角色-切片-动作）。 */
export const sessionSpawnTask = {
  name: 'session_spawn_task',
  description: '拉起一个任务会话（角色-切片-动作三段命名，如 产品-支付退款-PRD）。会写 sessions 行、占切片租约、发 session/create 事件，并用 project-task preset 启动子会话；开场自带角色卡+切片简报+验收。同一（切片,角色）只能有一个 active 任务会话；同切片同时只允许一个任务写入（租约）。角色词：' + ROLE_HELP + '。',
  parameters: params({
    role: S('角色：' + ROLE_HELP),
    sliceId: S('切片 id（与 sliceKey 二选一）'),
    sliceKey: S('切片 key（与 sliceId 二选一）'),
    action: S('动作短语（中文，如 支付退款PRD / 会话保持实现），用于会话名'),
    prompt: S('PM 交代：本任务要做什么、边界、已知上下文、验收要求'),
    taskId: S('绑定的任务 id（可选；建议先用 task_create 建任务）'),
    acceptance: S('补充验收标准文本（可选）'),
    provider: S('子会话 provider（可选，默认继承 PM）'),
    model: S('子会话 model（可选，默认继承 PM）'),
    reasoningEffort: S('推理强度（可选）'),
  }, ['role', 'action', 'prompt']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps, ctx) {
    const role = requireText(args.role, 'role')
    if (!isKnownRole(role)) throw fail('INVALID', '未知角色：' + role + '（可用：' + ROLE_HELP + '）')
    const slice = resolveSlice(deps, actor, { sliceId: optionalText(args.sliceId), sliceKey: optionalText(args.sliceKey) })
    const action = requireText(args.action, 'action')
    const brief = requireText(args.prompt, 'prompt')
    const name = taskSessionName(role, slice.key, action)
    let task
    if (args.taskId) {
      task = deps.store.getTask(actor.db, args.taskId)
      if (!task) throw fail('NOT_FOUND', '任务不存在：' + args.taskId)
      if (task.sliceId !== slice.id) throw fail('INVALID', '任务不属于该切片：' + task.id)
    }
    const existing = deps.store.listSessions(actor.db, { kind: 'task', status: 'active', sliceId: slice.id, role: role })
    if (existing.length > 0) {
      // 例外：旧会话虽然 active，但在 DSH 侧已经投递不到（PM 重开/换树/进程重启）。
      // 那种情况下拒绝派单等于把 PM 锁死 —— 发不出去也派不进来。交给 spawnTaskSession 接替它。
      // 判定不出来（目录服务不可用）时保持原语义：宁可报明确冲突，也不误杀。
      let unreachableAll = true
      for (const row of existing) {
        const deliverable = await canDeliverToSession(ctx, actor.dshSessionId, row.dshSessionId)
        if (deliverable !== false) { unreachableAll = false; break }
      }
      if (!unreachableAll) {
        throw fail('DUPLICATE_ACTIVE_SESSION',
          '同一（切片,角色）已有 **可投递的** active 任务会话：' + existing[0].name + '（先收工、换切片/角色，或用 session_send_task 补充要求）。',
          { sessionId: existing[0].id })
      }
    }
    const spawned = await spawnTaskSession(ctx, deps, {
      actor: actor,
      role: role,
      slice: slice,
      task: task,
      action: action,
      brief: brief,
      acceptance: optionalText(args.acceptance),
      provider: optionalText(args.provider),
      model: optionalText(args.model),
      reasoningEffort: optionalText(args.reasoningEffort),
      signal: _exec && _exec.signal,
      parentAgent: _exec && _exec.agent,
    })
    notifyWrite(deps, actor)
    return {
      session: minimalSession(spawned.session),
      dshSessionId: spawned.dshSessionId,
      name: name,
      slice: { id: slice.id, key: slice.key, title: slice.title },
      lease: spawned.lease ? { sliceId: spawned.lease.sliceId, expiresAt: spawned.lease.expiresAt } : null,
      promptTokens: estimateTokens(spawned.assignment.text),
      // 接替提示：PM 需要知道「我这次派单顺手清理了一条失联会话」，否则它会困惑为什么重名会话不见了。
      ...(spawned.superseded
        ? { superseded: spawned.superseded, note: '已接替一条失联会话（DB 里 active 但 DSH 侧不可投递），它被标为 interrupted：' + spawned.superseded.name }
        : {}),
    }
  },
}

/** session_send_task：PM 给任务会话发消息。 */
export const sessionSendTask = {
  name: 'session_send_task',
  description: '向任务会话发消息（补充信息、纠偏、追问）。需要任务会话仍 active；已收工的会话不能再发。',
  parameters: params({
    sessionId: S('项目会话 id（可选）'),
    name: S('会话名（可选，如 码农-支付退款-实现 / 验收-支付退款-验收）'),
    dshSessionId: S('DSH 会话 id（可选）'),
    message: S('消息正文'),
  }, ['message']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps, ctx) {
    const message = requireText(args.message, 'message')
    let target
    if (args.sessionId) target = deps.store.getSession(actor.db, args.sessionId)
    else if (args.dshSessionId) target = deps.store.findSessionByDshId(actor.db, args.dshSessionId)
    else if (args.name) {
      const wanted = String(args.name).trim()
      const rows = deps.store.listSessions(actor.db, { kind: 'task' }).concat(deps.store.listSessions(actor.db, { kind: 'qa' }))
      target = rows.find(function (row) { return row.name === wanted && row.status === 'active' }) || rows.find(function (row) { return row.name === wanted })
    } else throw fail('INVALID', '需要 sessionId / name / dshSessionId 之一')
    if (!target) throw fail('NOT_FOUND', '任务/验收会话不存在')
    if (target.kind !== 'task' && target.kind !== 'qa') throw fail('INVALID', '目标不是任务或验收会话：' + target.name)
    if (target.status !== 'active') throw fail('INVALID', '会话已结束（' + target.status + '），不能再发消息：' + target.name)
    if (!target.dshSessionId) throw fail('INVALID', '任务会话没有绑定 DSH 会话（可能尚未启动）：' + target.name)
    const sender = _exec && _exec.agent
    if (!sender || !ctx.subagents || typeof ctx.subagents.sendMessage !== 'function') throw fail('UNAVAILABLE', 'subagents 服务不可用')
    // 预检：DSH 只允许在**同一条 activation 树**里投递。PM 会话重开/重启后，
    // 旧任务会话虽然 DB 里还是 active，但已经收不到消息了（真机复验 2026-11-23 实测）。
    // 这里提前判定，给出一个**可操作**的错误（而不是让 PM 反复撞 DELIVERY_FAILED 后空手回答）。
    if (await canDeliverToSession(ctx, (sender && sender.session && sender.session.id) || (actor && actor.dshSessionId), target.dshSessionId) === false) {
      throw fail('SESSION_UNREACHABLE',
        '会话「' + target.name + '」在 DB 里是 active，但 DSH 侧已无法投递（属于另一棵子代理树或已失活）。'
        + '处理办法：重新调 session_spawn_task 派同一(切片,角色)——工作台会自动把这条失联会话标 interrupted 并接替它；'
        + '不要反复 session_send_task。',
        { sessionId: target.id, dshSessionId: target.dshSessionId, name: target.name, hint: 'respown' })
    }
    try {
      await ctx.subagents.sendMessage(sender, target.dshSessionId, [{ type: 'text', text: message }], { signal: _exec && _exec.signal })
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      // 兜底：预检说能投递但实际失败（竞态/A2A 规则变化）。同样给可操作提示。
      const unreachable = /another sub-agent tree|not a direct child|adjacency|not.*reachable/i.test(detail)
      throw fail(unreachable ? 'SESSION_UNREACHABLE' : 'DELIVERY_FAILED',
        unreachable
          ? '消息投递失败：' + detail + '。处理办法：重新 session_spawn_task 同一(切片,角色) 以接替这条失联会话。'
          : '消息投递失败：' + detail,
        { sessionId: target.id, dshSessionId: target.dshSessionId, ...(unreachable ? { hint: 'respown' } : {}) })
    }
    return { delivered: true, session: minimalSession(target), messageChars: message.length }
  },
}

/**
 * session_spawn_qa：拉起独立验收会话（project-qa preset）。
 *
 * 为什么必须是独立工具而不是 session_spawn_task(role='测试')：
 *   任务会话带租约、能写文件、能改文档 —— 用它做验收，「建造者不验收」就只剩角色卡里一句话。
 *   验收会话应当：不占租约、只读工作区、只能 evidence_add + slice_verify。
 *
 * 一个切片同时只允许一个 active 验收会话（避免同一交付被两个"验收者"给出矛盾结论）。
 */
export const sessionSpawnQa = {
  name: 'session_spawn_qa',
  description: '拉起独立验收会话（project-qa）：不写文件、不占租约、只读工作区，产出验收证据、可调 slice_verify 签字，验完/拒完调 session_finish_qa 自己离场。用于里程碑门禁前的独立验证——「建造者不验收」的机制化落地。同切片同时只允许一个 active 验收会话（复验前需上一个已离场）。',
  parameters: params({
    sliceId: S('切片 id（与 sliceKey 二选一）'),
    sliceKey: S('切片 key（与 sliceId 二选一）'),
    action: S('动作短语（如 退款验收 / 回归复验）'),
    prompt: S('验收交代：验什么、按什么标准、已知风险与重点回归面'),
    provider: S('子会话 provider（可选，默认继承 PM）'),
    model: S('子会话 model（可选，默认继承 PM）'),
  }, ['action', 'prompt']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps, ctx) {
    const slice = resolveSlice(deps, actor, { sliceId: optionalText(args.sliceId), sliceKey: optionalText(args.sliceKey) })
    const action = requireText(args.action, 'action')
    const brief = requireText(args.prompt, 'prompt')
    const existing = deps.store.listSessions(actor.db, { kind: 'qa', status: 'active', sliceId: slice.id })
    if (existing.length > 0) {
      throw fail('DUPLICATE_ACTIVE_SESSION', '该切片已有 active 验收会话：' + existing[0].name + '（先收工或换切片）', {
        sessionId: existing[0].id, name: existing[0].name,
      })
    }
    const name = '验收-' + slice.key + '-' + action
    const dshSessionId = newId('qa')
    const session = deps.store.createSession(actor.db, {
      name: name,
      kind: 'qa',
      role: '测试',
      sliceId: slice.id,
      dshSessionId: dshSessionId,
      parentSessionId: actor.session.id,
      provider: optionalText(args.provider) || undefined,
      model: optionalText(args.model) || undefined,
      context: { action: action, brief: brief.slice(0, 8000), spawnedBy: actor.dshSessionId, qa: true },
    })
    const text = [
      '【独立验收会话】切片「' + slice.title + '」(' + slice.key + ')',
      '你的职责：独立验证这次交付是否达到验收标准。**不要改产品代码、不要改测试把红的改绿**。',
      '验收标准：' + (slice.acceptance && Object.keys(slice.acceptance).length > 0 ? JSON.stringify(slice.acceptance) : '（切片未声明验收标准，请按 PM 交代与文档判断）'),
      '',
      'PM 交代：',
      brief,
      '',
      'available 工具：project_status / project_brief / doc_list / doc_get / task_list / slice_list / evidence_add / slice_verify / session_finish_qa。',
      '做完后：evidence_add 记录可复核证据（原样贴命令与输出摘要），再调 slice_verify（verifiedBy 写人名）。',
      '如果没通过：**不要** slice_verify，用 evidence_add 记录失败证据，并在交接里写清缺陷与复现步骤。',
      // v6.3：离场是必须的一步。没有它，这个切片再也拉不起复验（同切片只允许一个 active 验收会话）。
      '无论过不过，**最后都要调 session_finish_qa(verdict=passed|rejected, summary=...) 离场**：',
      '它只结束你自己，不改切片状态。不调它，这条会话会永久 active，同切片就再也拉不起复验。',
    ].join('\n')
    try {
      await ctx.subagents.startActivation({
        delivery: 'parent',
        provider: 'spawn',
        childId: dshSessionId,
        label: name,
        prompt: [{ type: 'text', text: text }],
        parent: _exec && _exec.agent,
        agentPreset: 'project-qa',
        signal: _exec && _exec.signal,
      })
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      try {
        deps.store.endSession(actor.db, { id: session.id, status: 'failed', failureCode: 'SPAWN_FAILED', failureDetail: detail.slice(0, 500) })
      } catch (cleanupError) { /* 保留原始错误 */ }
      throw fail('SPAWN_FAILED', '拉起验收会话失败：' + detail, { sessionId: session.id })
    }
    notifyWrite(deps, actor)
    return {
      session: minimalSession(session),
      dshSessionId: dshSessionId,
      name: name,
      slice: { id: slice.id, key: slice.key, title: slice.title },
      note: '验收会话不占租约、不写文件；它产出证据并可调 slice_verify。',
    }
  },
}

/** decision_create：PM 建决策卡（人不代批）。 */
export const decisionCreate = {
  name: 'decision_create',
  description: '创建决策卡，等待用户拍板（agent 不能代批）。用于方案取舍、范围变更、不可逆动作前的确认；门禁请用 gate_submit。',
  parameters: params({
    title: S('决策标题'),
    question: S('要用户回答的问题'),
    options: A({ type: 'string' }, '可选项（字符串数组）'),
    recommended: S('推荐选项（理由一句话）'),
    consequences: S('不返工/选错的后果'),
    irreversible: B('是否不可逆（不可逆必须用户二次确认）'),
    sliceId: S('关联切片 id（可选）'),
    stage: S('关联阶段 key（可选，默认当前阶段）'),
    gate: S('关联门禁 key（可选）'),
    deadline: S('答复截止（ISO 时间，如 2026-11-25T18:00:00+08:00）。设计 §6.3 的超时策略靠它：非不可逆超时用推荐值继续，不可逆超时挂起并提醒'),
    defaultOption: S('超时后默认采用的选项 value（可选；只有非不可逆时才有意义）'),
  }, ['title', 'question', 'options']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const options = Array.isArray(args.options) ? args.options.map(function (item) { return String(item) }) : []
    if (options.length === 0) throw fail('INVALID', 'options 至少 1 个')
    const stage = optionalText(args.stage) || (currentStageOf(deps, actor.db) || {}).key
    const decision = deps.store.createDecision(actor.db, {
      title: requireText(args.title, 'title'),
      question: requireText(args.question, 'question'),
      options: options,
      recommended: optionalText(args.recommended),
      consequences: optionalText(args.consequences),
      irreversible: args.irreversible === true,
      sliceId: optionalText(args.sliceId),
      stage: stage,
      gate: optionalText(args.gate),
      deadline: normalizeDeadline(optionalText(args.deadline)),
      defaultOption: optionalText(args.defaultOption),
      createdBy: actor.dshSessionId,
    })
    notifyWrite(deps, actor)
    const notes = ['决策卡已加入待决策；等用户在面板答复，不要代批。']
    if (decision.deadline) {
      notes.push('截止 ' + decision.deadline + '（逾期会在概览与决策收件箱标红）。')
      if (decision.irreversible) notes.push('不可逆决策逾期不自动采用默认值，必须人来拍板（设计 §6.3）。')
      else if (decision.defaultOption) notes.push('非不可逆：逾期可按默认值 ' + decision.defaultOption + ' 继续，并在报告里标注这是假设。')
    }
    return { decision: decision, note: notes.join(' ') }
  },
}

/** gate_submit：PM 提交门禁（建 pending approvals + gate 决策卡）。 */
export const gateSubmit = {
  name: 'gate_submit',
  description: '提交阶段门禁：冻结候选文档、汇总证据、生成 pending approval 与 gate 决策卡，等待用户批准。用户批准后由面板执行冻结+导出+阶段推进。',
  parameters: params({
    gate: S('门禁 key（如 G1）'),
    stage: S('阶段 key（可选，默认当前阶段）'),
    docIds: STRING_ARRAY('参与门禁的文档 id 列表'),
    evidenceIds: STRING_ARRAY('证据 id 列表（至少 1 条）'),
    summary: S('门禁摘要：交付了什么、证据在哪、风险'),
  }, ['gate', 'summary']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const gate = requireText(args.gate, 'gate')
    const summary = requireText(args.summary, 'summary')
    const requestedStage = optionalText(args.stage)
    // ① 阶段守卫：只能提交给当前 active 阶段，且 gate 必须与该阶段匹配。
    //    否则会出现「S1 还 active 时批准了 S4 门禁」→ 两个 active 阶段（P1 缺陷）。
    const gateTarget = validateGateTarget(actor.db, { gate: gate, stage: requestedStage })
    if (gateTarget.issues.length > 0) {
      throw fail('GATE_STAGE_INVALID', '门禁提交被拒：' + gateTarget.issues.map(function (issue) { return issue.message }).join('；'), {
        issues: gateTarget.issues,
      })
    }
    const stage = gateTarget.stage
    const docIds = Array.isArray(args.docIds) ? args.docIds.map(String) : []
    const evidenceIds = Array.isArray(args.evidenceIds) ? args.evidenceIds.map(String) : []
    const docs = []
    // ② 文档快照：提交时把「版本 + 内容 hash」钉住，批准时据此冻结，不再现场重查。
    const docVersions = []
    for (const docId of docIds) {
      const doc = deps.docs.getDocument(actor.db, docId)
      if (!doc) throw fail('NOT_FOUND', '门禁文档不存在：' + docId)
      const version = Number(doc.currentVersion || 0)
      const versionRow = version > 0 ? deps.docs.getDocVersion(actor.db, doc.id, version) : undefined
      if (version <= 0) throw fail('INVALID', '门禁文档还没有任何版本，不能提交：' + docId)
      docVersions.push({ docId: doc.id, version: version, hash: versionRow ? versionRow.contentHash : null })
      docs.push({ id: doc.id, type: doc.type, title: doc.title, version: version, hash: versionRow ? versionRow.contentHash : null })
    }
    if (evidenceIds.length === 0) throw fail('NO_EVIDENCE', '门禁提交至少需要 1 条证据（evidenceIds）')
    // ③ 前置机检：门禁判据必须由机器给出，而不是「人点了批准」。
    //    通过 → 落一条 evidence（原文 + hash）；失败 → 直接拒绝提交，把 issues 原文返回给调用方。
    const machineCheck = await runProjectCheckers(rootOf(actor), { registry: deps.registry })
    const checkSummary = summarizeCheckRun(machineCheck)
    if (!machineCheck.ok) {
      throw fail('GATE_PRECHECK_FAILED', '门禁前置机检未通过，拒绝提交：' + checkSummary, {
        issues: machineCheck.issues.slice(0, 20),
        checks: machineCheck.checks,
      })
    }
    const checkEvidence = machineCheck.skipped ? undefined : deps.store.addEvidence(actor.db, {
      kind: 'check',
      uri: 'gate/' + gate + '/' + new Date().toISOString(),
      command: 'gate_submit:runProjectCheckers',
      contentHash: sha256(JSON.stringify(machineCheck.checks)),
      resultSummary: checkSummary,
      createdBy: actor.dshSessionId,
    })
    const evidence = []
    for (const evidenceId of evidenceIds) {
      const item = deps.store.getEvidence(actor.db, evidenceId)
      if (!item) throw fail('NOT_FOUND', '证据不存在：' + evidenceId)
      evidence.push({ id: item.id, kind: item.kind, resultSummary: item.resultSummary })
    }
    const decision = deps.store.createDecision(actor.db, {
      kind: 'gate',
      title: '门禁 ' + gate + ' 提交',
      question: '是否批准 ' + gate + ' 门禁？批准后将冻结相关文档、导出 docs/ 并推进阶段。',
      options: ['批准', '驳回'],
      recommended: '批准',
      consequences: '批准即推进阶段并冻结相关文档（不可逆，需二次确认）；驳回则返工补齐文档/证据后重新提交。',
      irreversible: true,
      sliceId: optionalText(args.sliceId),
      stage: stage,
      gate: gate,
      createdBy: actor.dshSessionId,
    })
    let approvalId
    let superseded = []
    let approvalEpoch = 1
    actor.db.tx(function () {
      // 重提交：同门禁的旧 pending 审批必须先作废（保留行），否则「批准哪一条」未定义。
      superseded = deps.project.supersedePendingApprovals(actor.db, decision, { reason: 'resubmitted', supersededBy: decision.id })
      const previous = actor.db.db
        .prepare("SELECT MAX(epoch) AS e FROM approvals WHERE project_id = ? AND gate IS ?")
        .get(actor.db.projectId, gate)
      approvalEpoch = Number(previous && previous.e !== null && previous.e !== undefined ? previous.e : 0) + 1
      approvalId = newId('appr')
      const allEvidenceIds = checkEvidence ? evidenceIds.concat([checkEvidence.id]) : evidenceIds
      const snapshot = JSON.stringify({
        decisionId: decision.id, gate: gate, stage: stage, summary: summary,
        docIds: docIds, docVersions: docVersions, evidenceIds: allEvidenceIds,
        checks: machineCheck.checks,
        // v4：判据的「信任级别」也是快照的一部分 —— 批准时要能回答「当时是隔离跑的还是一进程内跑的」。
        checkTrust: machineCheck.trust,
        submittedBy: actor.dshSessionId, submittedAt: new Date().toISOString(), epoch: approvalEpoch,
      })
      actor.db.db.prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(approvalId, actor.db.projectId, stage || null, gate, decision.id, 'pending', JSON.stringify(allEvidenceIds), snapshot, null, null, approvalEpoch)
      actor.db.appendEvent({
        kind: 'gate/submit',
        subjectType: 'gate',
        subjectId: gate,
        sliceId: optionalText(args.sliceId),
        payload: {
          decisionId: decision.id, approvalId: approvalId, gate: gate, stage: stage,
          docIds: docIds, evidenceIds: evidenceIds, summary: summary,
          epoch: approvalEpoch, superseded, trust: machineCheck.trust ? machineCheck.trust.mode : undefined,
        },
      })
    })
    notifyWrite(deps, actor)
    return {
      decision: decision,
      approvalId: approvalId,
      gate: gate,
      stage: stage,
      documents: docs,
      evidenceCount: evidence.length + (checkEvidence ? 1 : 0),
      approvalEpoch: approvalEpoch,
      supersededApprovals: superseded,
      machineCheck: {
        ok: machineCheck.ok, skipped: machineCheck.skipped, reason: machineCheck.reason,
        durationMs: machineCheck.durationMs, checks: machineCheck.checks,
        // 信任级别必须回传：门禁判据是「机器给的」还是「一进程内跑的自述脚本」，是两件事。
        trust: machineCheck.trust,
      },
      note: machineCheck.skipped
        ? '未发现可用判据（root/tools/engineering/*.mjs），本次门禁只有人工判据；其余同前。'
        : '机检已通过并存证；等待用户批准，批准后自动冻结/导出/推进阶段。'
          + (machineCheck.trust && machineCheck.trust.degraded ? '⚠ 判据未隔离执行（' + machineCheck.trust.mode + '），仅适用于可信判据。' : ''),
    }
  },
}

/**
 * weekly_report：生成周报（MVP 验收标准 ⑤）。
 *
 * 设计取舍：周报**不是**让模型现写的。它由 host 从项目库渲染，模型只负责转述/摘选。
 * 理由：设计 §6.2 的原则是「指标必须能从项目文件/会话事件自动生成」；
 * 让模型每周编一段「本周完成了…」，等于把唯一进度口径交回给自然语言 —— 那正是要消灭的东西。
 *
 * mode=preview 只返回内容不写盘（PM 想先看一眼再决定要不要发布）；
 * mode=write 写到 <root>/.project/exports/weekly.md（走 outbox，可补偿）。
 */
export const weeklyReport = {
  name: 'weekly_report',
  description: '生成周报（Markdown，可直接贴进 GitHub Issue）。内容全部从项目库自动渲染：进度（唯一口径 = verified）、本期验收数、待决策、阻塞项、本期完成清单。不是模型现写，因此可复核、可重复生成。',
  parameters: params({
    mode: S('preview | write（默认 preview：只返回内容，不写盘）'),
    since: S('本期起始时间（ISO，可选；默认用 period.startedAt，没有则近 7 天）'),
    title: S('标题（可选，默认「<项目名> 周报 · <周期>」）'),
  }, []),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const mode = optionalText(args.mode) || 'preview'
    if (mode !== 'preview' && mode !== 'write') throw fail('INVALID', 'mode 必须是 preview 或 write')
    const options = { since: optionalText(args.since), title: optionalText(args.title) }
    if (mode === 'preview') {
      const content = deps.exporter.renderWeeklyReport(actor.db, options)
      return {
        mode: 'preview',
        content,
        chars: content.length,
        note: '未写盘。确认内容后可调 weekly_report({mode:"write"}) 落到 .project/exports/weekly.md。',
      }
    }
    const root = rootOf(actor)
    const result = deps.exporter.exportWeekly(actor.db, { ...options, root: root })
    notifyWrite(deps, actor)
    return {
      mode: 'write',
      path: result.relativePath,
      written: result.written,
      error: result.error,
      content: result.content,
      note: result.written
        ? '已写入 ' + result.relativePath + '（内容确定性，可重复生成）。可直接复制到 GitHub Issue。'
        : '写盘失败：' + String(result.error || 'unknown') + '（导出意图已记录，可用 exports/replay 补偿）',
    }
  },
}

/**
 * period_roll：推进项目周期（设计 §5.4 的两周周期 + cooldown）。
 *
 * 为什么需要显式工具而不是日历自动滚动：
 *   「这个周期做了什么」是复盘与指标的分母。自动按日历滚动会把「跨零点的提交」
 *   归到哪个周期变成一件靠时钟猜的事；显式推进则是可审计动作（有人按了、写进了时间线）。
 *
 * 记录形态（project_meta）：
 *   period.current  = '2026-W47'（可读标识）
 *   period.index    = 12（自项目初始化起的第几个周期，单调，用于趋势）
 *   period.startedAt / period.endedAt
 *   period.lengthDays（默认 14，来自 project.json.period.lengthDays 或 14）
 */
export const periodRoll = {
  name: 'period_roll',
  description: '推进项目周期：结束当前周期并开启下一个（写 project_meta 与 period/roll 事件）。周期是「每周期验证吞吐」「appetite 偏差」等指标的分母；不自动滚动是刻意的——推进必须是可审计的显式动作。',
  parameters: params({
    label: S('新周期标识（可选，如 2026-W48；不给则按 index 生成）'),
    note: S('本周期结论/复盘摘要（可选，会写进事件）'),
    lengthDays: N('新周期长度（天，可选；默认沿用或 14）'),
  }, []),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const db = actor.db
    const currentIndex = Number(db.getMeta('period.index') || 0)
    const nextIndex = currentIndex + 1
    const at = nowIso()
    const lengthDays = Number.isFinite(Number(args.lengthDays)) && Number(args.lengthDays) > 0
      ? Number(args.lengthDays)
      : Number(db.getMeta('period.lengthDays') || 14)
    const label = optionalText(args.label) || ('P' + String(nextIndex).padStart(2, '0'))
    const previous = {
      current: db.getMeta('period.current') || null,
      index: currentIndex || null,
      startedAt: db.getMeta('period.startedAt') || null,
    }
    // 周期结束时把「这一周期验了多少」定格下来：否则推进后就再也算不出历史吞吐。
    const verifiedInPeriod = Number(db.db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND kind = 'slice/verify' AND at >= ?"
    ).get(db.projectId, previous.startedAt || '0000').n || 0)
    db.tx(function () {
      db.setMeta('period.current', label)
      db.setMeta('period.index', nextIndex)
      db.setMeta('period.startedAt', at)
      db.setMeta('period.lengthDays', lengthDays)
      if (previous.current) db.setMeta('period.lastEndedAt', at)
      db.appendEvent({
        kind: 'period/roll',
        subjectType: 'project',
        subjectId: db.projectId,
        actorSession: actor.dshSessionId,
        role: actor.role,
        payload: {
          from: previous.current, to: label, index: nextIndex,
          lengthDays: lengthDays, verifiedInPreviousPeriod: verifiedInPeriod,
          note: optionalText(args.note),
        },
      })
    })
    notifyWrite(deps, actor)
    return {
      period: { current: label, index: nextIndex, startedAt: at, lengthDays: lengthDays },
      previous: { ...previous, verifiedCount: verifiedInPeriod },
      note: '周期已推进。历史周期的验证吞吐已定格在上一条 period/roll 事件的 payload 里。',
    }
  },
}

/** export_project：PM 导出文档或全量快照。 */
export const exportProject = {
  name: 'export_project',
  description: '导出项目交付物：kind=docs 把指定/全部文档导出到 <root>/docs/（只写不回读）；kind=snapshot 重建 .project/exports/docs 全量快照 + timeline.md。',
  parameters: params({
    kind: S('docs | snapshot'),
    sliceId: S('只导出某切片（可选）'),
  }, ['kind']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const kind = requireText(args.kind, 'kind')
    if (kind !== 'docs' && kind !== 'snapshot') throw fail('INVALID', 'kind 必须是 docs 或 snapshot')
    const root = rootOf(actor)
    if (!root) throw fail('INVALID', '无法确定项目根目录')
    const exportMap = exportMapOf(deps, actor)
    if (kind === 'snapshot') {
      const result = deps.exporter.exportSnapshot(actor.db, { root: root, exportMap: exportMap, sliceId: optionalText(args.sliceId) })
      notifyWrite(deps, actor)
      return { kind: 'snapshot', root: root, count: result.count, documents: result.documents, timeline: result.timeline }
    }
    const docs = deps.docs.listDocuments(actor.db, optionalText(args.sliceId) ? { sliceId: args.sliceId } : {})
    const exported = []
    const failed = []
    // 整批共用一个 batch：部分失败时可以用同一个 batchId 一次性补偿。
    const batchId = newId('batch')
    for (const doc of docs) {
      if (!doc.currentVersion) continue
      const out = deps.exporter.exportDocument(actor.db, { docId: doc.id, version: doc.currentVersion, root: root, exportMap: exportMap, batchId })
      const item = { docId: doc.id, type: doc.type, title: doc.title, version: out.version, path: out.path, hash: out.hash, written: out.written !== false }
      exported.push(item)
      if (out.written === false) failed.push({ docId: doc.id, relativePath: out.relativePath, error: out.error })
    }
    notifyWrite(deps, actor)
    return {
      kind: 'docs', root: root, count: exported.length, documents: exported,
      batchId,
      failed: failed.length,
      failures: failed,
      note: failed.length > 0
        ? '有 ' + failed.length + ' 篇导出失败：意图已记录在 outbox，可补偿重放（不成功的文件不在 docs/ 里）。'
        : 'docs/ 是导出快照，不要回读；项目事实源在 DB。',
    }
  },
}

/** import_inbox：导入 inbox 文件为文档新版本（PM 与任务会话；任务会话限本切片）。 */
export const importInbox = {
  name: 'import_inbox',
  description: '把 inbox 下的外部产物（工作包/回执）导入为文档新版本（受控导入，双向同步不做，会记 imports 行与 contentHash 供溯源）。搜索顺序：项目 store 的 inbox（权威数据所在）→ 工作区 .project/inbox（历史兼容）。任务会话与 PM 都可用。',
  parameters: params({
    path: S('inbox 内相对路径或绝对路径'),
    docId: S('目标文档 id（可选；给出则追加新版本）'),
    type: S('新建文档类型：prd|ux|adr|design|spec|report|handoff|retro（无 docId 时必填）'),
    title: S('文档标题（可选）'),
    logicalKey: S('新建文档逻辑键（可选）'),
    sliceId: S('关联切片 id（可选）'),
  }, ['path']),
  // v6.4（lumio P2-2）：任务会话也要能导入。原先只有 PM 能调，任务会话只能走 doc_write，
  // 于是 imports 表恒空 —— 所有文档都成了「AI 写的正文」，外部材料的来源与 hash 无从溯源。
  // 任务会话受切片约束：只能导入到自己绑定的切片（见 execute 里的校验）。
  actors: ['pm', 'task'],
  execute: async function (args, _exec, actor, deps) {
    const wantsSlice = optionalText(args.sliceId)
    if (actor.kind === 'task') {
      if (!actor.sliceId) throw fail('PERMISSION_DENIED', '任务会话没有绑定切片，不能导入')
      if (wantsSlice && wantsSlice !== actor.sliceId) throw fail('PERMISSION_DENIED', '任务会话只能导入到自己绑定的切片：' + actor.sliceId)
    }
    const result = deps.importer.importInboxFile(actor.db, {
      sourcePath: requireText(args.path, 'path'),
      docId: optionalText(args.docId),
      type: optionalText(args.type),
      title: optionalText(args.title),
      logicalKey: optionalText(args.logicalKey),
      // 任务会话不传 sliceId 时默认落到自己的切片：否则导入的文档会变成无归属的孤儿。
      sliceId: wantsSlice || (actor.kind === 'task' ? actor.sliceId : undefined),
      importedBy: actor.dshSessionId,
    })
    notifyWrite(deps, actor)
    return { imported: true, doc: result.doc, version: result.version ? result.version.version : undefined, created: result.created, sourcePath: result.sourcePath, contentHash: result.contentHash }
  },
}

/** doc_export：PM 导出单篇文档。 */
export const docExport = {
  name: 'doc_export',
  description: '把单篇文档的指定/最新版本导出到 <root>/docs/（只写文件，DB 仍是事实源）。',
  parameters: params({
    docId: S('文档 id'),
    version: N('版本号（可选，默认最新版）'),
  }, ['docId']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const docId = requireText(args.docId, 'docId')
    const doc = deps.docs.getDocument(actor.db, docId)
    if (!doc) throw fail('NOT_FOUND', '文档不存在：' + docId)
    const root = rootOf(actor)
    if (!root) throw fail('INVALID', '无法确定项目根目录')
    const version = args.version === undefined || args.version === null ? doc.currentVersion : Number(args.version)
    const out = deps.exporter.exportDocument(actor.db, { docId: docId, version: version, root: root, exportMap: exportMapOf(deps, actor) })
    notifyWrite(deps, actor)
    // 写盘失败不能被当成「导出成功」：DB 侧意图已提交（outbox 有 failed 行，可补偿），
    // 但调用方必须立刻知道文件没落地，否则它会以为 docs/ 里已经有内容。
    if (out.written === false) {
      throw fail('EXPORT_FAILED', '文档导出失败：' + String(out.error || 'unknown') + '（导出意图已记录，可用 export_replay/exports/replay 补偿）', {
        docId: docId,
        version: out.version,
        relativePath: out.relativePath,
        batchId: out.batchId,
        outboxId: out.outboxId,
        path: out.path,
      })
    }
    return { docId: docId, version: out.version, path: out.path, relativePath: out.relativePath, hash: out.hash, batchId: out.batchId }
  },
}

export function createPmTools(_ctx, _deps) {
  return [projectInit, sliceCreate, sliceUpdate, sliceScope, scopePolicy, sliceVerify, taskCreate, sessionSpawnTask, sessionSpawnQa, sessionSendTask, decisionCreate, gateSubmit, exportProject, importInbox, docExport, periodRoll, weeklyReport]
}
