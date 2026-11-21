// PM（项目办公室）工具（T4）：切片/任务/会话/决策/门禁/导出导入。仅 project-office 会话可见。
import { randomUUID } from 'node:crypto'
import { fail } from '../db.js'
import { newId, nowIso, estimateTokens, sha256 } from '../util.js'
import { TASK_ROLES, ROLE_HELP, isKnownRole, taskSessionName } from '../roles.js'
import { resolveSlice, spawnTaskSession } from '../orchestration.js'
import { validateGateTarget } from '../project.js'
import { runProjectCheckers, summarizeCheckRun } from '../checkers.js'
import {
  params, S, N, B, A, STRING_ARRAY, requireProjectActor, requireText, optionalText,
  notifyWrite, currentStageOf, exportMapOf, rootOf,
} from './spec-helpers.js'

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
      throw fail('DUPLICATE_ACTIVE_SESSION', '同一（切片,角色）已有 active 任务会话：' + existing[0].name + '（先收工或换切片/角色）', { sessionId: existing[0].id })
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
    }
  },
}

/** session_send_task：PM 给任务会话发消息。 */
export const sessionSendTask = {
  name: 'session_send_task',
  description: '向任务会话发消息（补充信息、纠偏、追问）。需要任务会话仍 active；已收工的会话不能再发。',
  parameters: params({
    sessionId: S('项目会话 id（可选）'),
    name: S('任务会话名（可选，如 码农-支付退款-实现）'),
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
      const rows = deps.store.listSessions(actor.db, { kind: 'task' })
      target = rows.find(function (row) { return row.name === wanted && row.status === 'active' }) || rows.find(function (row) { return row.name === wanted })
    } else throw fail('INVALID', '需要 sessionId / name / dshSessionId 之一')
    if (!target) throw fail('NOT_FOUND', '任务会话不存在')
    if (target.kind !== 'task') throw fail('INVALID', '目标不是任务会话：' + target.name)
    if (target.status !== 'active') throw fail('INVALID', '任务会话已结束（' + target.status + '），不能再发消息：' + target.name)
    if (!target.dshSessionId) throw fail('INVALID', '任务会话没有绑定 DSH 会话（可能尚未启动）：' + target.name)
    const sender = _exec && _exec.agent
    if (!sender || !ctx.subagents || typeof ctx.subagents.sendMessage !== 'function') throw fail('UNAVAILABLE', 'subagents 服务不可用')
    try {
      await ctx.subagents.sendMessage(sender, target.dshSessionId, [{ type: 'text', text: message }], { signal: _exec && _exec.signal })
    } catch (error) {
      const detail = String(error && error.message ? error.message : error)
      throw fail('DELIVERY_FAILED', '消息投递失败：' + detail, { sessionId: target.id, dshSessionId: target.dshSessionId })
    }
    return { delivered: true, session: minimalSession(target), messageChars: message.length }
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
      createdBy: actor.dshSessionId,
    })
    notifyWrite(deps, actor)
    return { decision: decision, note: '决策卡已加入待决策；等用户在面板答复，不要代批。' }
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

/** import_inbox：PM 导入 .project/inbox 文件为文档新版本。 */
export const importInbox = {
  name: 'import_inbox',
  description: '把 .project/inbox 下的外部产物（工作包/回执）导入为文档新版本（受控导入，双向同步不做）。',
  parameters: params({
    path: S('inbox 内相对路径或绝对路径'),
    docId: S('目标文档 id（可选；给出则追加新版本）'),
    type: S('新建文档类型：prd|ux|adr|design|spec|report|handoff|retro（无 docId 时必填）'),
    title: S('文档标题（可选）'),
    logicalKey: S('新建文档逻辑键（可选）'),
    sliceId: S('关联切片 id（可选）'),
  }, ['path']),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const result = deps.importer.importInboxFile(actor.db, {
      sourcePath: requireText(args.path, 'path'),
      docId: optionalText(args.docId),
      type: optionalText(args.type),
      title: optionalText(args.title),
      logicalKey: optionalText(args.logicalKey),
      sliceId: optionalText(args.sliceId),
      importedBy: actor.dshSessionId,
    })
    notifyWrite(deps, actor)
    return { imported: true, doc: result.doc, version: result.version ? result.version.version : undefined, created: result.created, sourcePath: result.sourcePath }
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
  return [projectInit, sliceCreate, sliceUpdate, sliceScope, taskCreate, sessionSpawnTask, sessionSendTask, decisionCreate, gateSubmit, exportProject, importInbox, docExport]
}
