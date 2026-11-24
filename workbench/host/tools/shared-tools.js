// 共享工具（T4）：task_update / artifact_add / doc_freeze / file_index。按 actor 收紧。
import { fail } from '../db.js'
import { notifyPm, invalidateActorCache } from '../orchestration.js'
import {
  params, S, N, B, requireProjectActor, requireText, optionalText, notifyWrite, requireSliceId,
} from './spec-helpers.js'

function minimalTask(task) {
  return { id: task.id, sliceId: task.sliceId, title: task.title, status: task.status, assigneeSession: task.assigneeSession, acceptance: task.acceptance }
}

function minimalDocument(doc) {
  return {
    id: doc.id,
    logicalKey: doc.logicalKey,
    type: doc.type,
    title: doc.title,
    status: doc.status,
    currentVersion: doc.currentVersion,
    frozen: doc.frozen,
    sliceId: doc.sliceId,
  }
}

/** task_update：更新任务状态/验收（PM 任意；任务会话只能本切片任务）。 */
export const taskUpdate = {
  name: 'task_update',
  description: '更新任务状态或验收标准。PM 可更新任意任务；任务会话只能更新自己切片的任务（如 in_progress/blocked/done）。',
  parameters: params({
    id: S('任务 id'),
    status: S('新状态（如 pending/in_progress/blocked/done/failed）'),
    acceptance: { type: 'object', additionalProperties: true, description: '新验收标准 JSON（可选）' },
  }, ['id']),
  actors: ['pm', 'task'],
  execute: async function (args, _exec, actor, deps) {
    const id = requireText(args.id, 'id')
    const task = deps.store.getTask(actor.db, id)
    if (!task) throw fail('NOT_FOUND', '任务不存在：' + id)
    if (actor.kind === 'task' && task.sliceId !== actor.sliceId) {
      throw fail('PERMISSION_DENIED', '任务会话只能更新自己切片的任务：' + (actor.sliceId || '(无)'))
    }
    const updated = deps.store.updateTask(actor.db, {
      id: id,
      status: optionalText(args.status),
      acceptance: args.acceptance,
    })
    notifyWrite(deps, actor)
    return { task: minimalTask(updated) }
  },
}

/** artifact_add：登记代码/文件/外部产物引用（路径 + hash + 大小）。 */
export const artifactAdd = {
  name: 'artifact_add',
  description: '登记产物引用（代码文件/文档导出/外部产物）：路径 + 可选 hash/大小。代码文件本体仍在工作区，DB 只记录归属与时间线。',
  parameters: params({
    kind: S('产物类型：code-file|doc-export|package|other'),
    path: S('项目内相对路径或外部引用'),
    contentHash: S('内容 hash（可选）'),
    bytes: N('文件大小（字节，可选）'),
    metadata: { type: 'object', additionalProperties: true, description: '附加元数据 JSON（可选）' },
    sliceId: S('切片 id（可选，默认本切片）'),
  }, ['kind', 'path']),
  actors: ['pm', 'task'],
  execute: async function (args, _exec, actor, deps) {
    const sliceId = optionalText(args.sliceId) || (actor.kind === 'task' ? requireSliceId(actor, undefined) : undefined)
    if (actor.kind === 'task' && sliceId) {
      deps.leases.assertWriteScope(actor.db, { sliceId: sliceId, sessionId: actor.session.id })
    }
    const artifact = deps.store.addArtifact(actor.db, {
      sliceId: sliceId,
      kind: requireText(args.kind, 'kind'),
      path: requireText(args.path, 'path'),
      contentHash: optionalText(args.contentHash),
      bytes: args.bytes === undefined || args.bytes === null ? undefined : Number(args.bytes),
      metadata: args.metadata,
    })
    notifyWrite(deps, actor)
    return { artifact: artifact }
  },
}

/** doc_freeze：冻结文档当前/指定版本（冻结后不可写新版本）。 */
export const docFreeze = {
  name: 'doc_freeze',
  description: '冻结文档版本（冻结后该文档拒绝新版本，返工需新决策）。任务会话只能冻结本切片文档；门禁批量冻结由用户批准后自动完成。',
  parameters: params({
    docId: S('文档 id'),
    version: N('版本号（可选，默认当前版本）'),
  }, ['docId']),
  actors: ['pm', 'task'],
  execute: async function (args, _exec, actor, deps) {
    const docId = requireText(args.docId, 'docId')
    const doc = deps.docs.getDocument(actor.db, docId)
    if (!doc) throw fail('NOT_FOUND', '文档不存在：' + docId)
    if (actor.kind === 'task') {
      if (doc.sliceId !== actor.sliceId) throw fail('PERMISSION_DENIED', '任务会话只能冻结本切片文档：' + (actor.sliceId || '(无)'))
      if (doc.sliceId) deps.leases.assertWriteScope(actor.db, { sliceId: doc.sliceId, sessionId: actor.session.id })
    }
    const version = args.version === undefined || args.version === null ? undefined : Number(args.version)
    const frozen = deps.docs.freezeDocument(actor.db, { docId: docId, version: version, actorSession: actor.dshSessionId })
    notifyWrite(deps, actor)
    return { doc: minimalDocument(frozen) }
  },
}

/** file_index：回填/刷新工作区文件索引（路径+hash+bytes → artifacts + index/backfill 事件）。PM 专用。 */
export const fileIndex = {
  name: 'file_index',
  description: '扫描并回填工作区文件索引：代码/测试/脚本仍以文件为本体，DB 只记相对路径、sha256 与字节数，并写一条 index/backfill 事件。代码/测试类任务收工前调用一次，时间线即可回答「改了哪些文件」。幂等：未变文件不重写，消失文件清出索引。',
  parameters: params({
    sliceId: S('切片 id（可选：把本次索引归属到该切片）'),
    forceEvent: B('即使没有变化也写一条事件（默认 false）'),
  }, []),
  actors: ['pm'],
  execute: async function (args, _exec, actor, deps) {
    const sliceId = optionalText(args.sliceId)
    if (sliceId !== undefined) {
      const slice = deps.store.getSlice(actor.db, sliceId)
      if (!slice) throw fail('NOT_FOUND', '切片不存在：' + sliceId)
    }
    const summary = deps.indexer.indexWorkspaceFiles(actor.db, actor.root, {
      sliceId: sliceId,
      actorSession: actor.dshSessionId,
      forceEvent: args.forceEvent === true,
    })
    notifyWrite(deps, actor)
    return { root: actor.root, ...summary }
  },
}

/**
 * session_finish_qa：验收会话的离场出口（v6.3，lumio 真库 P0-3）。
 *
 * 为什么必须有它：验收会话（kind='qa'）工具面里没有 session_finish_task（刻意的边界：验收不该推进切片），
 * 也没有 session_task_report；而「会话结束」的两条兜底路径又都只扫 kind='task'
 * （session-hooks.js 的 session/disposed、orchestration.reconcileStaleSessions）。
 * 于是 QA 行一旦创建就是终态 active：真库 4 个 QA 会话 4 个都签过字，4 个都还 active，
 * 重启也清不掉 —— 每个切片实际上只能被验收一次（复验永远撞 DUPLICATE_ACTIVE_SESSION）。
 *
 * 边界（为什么不干脆给 QA 开 session_finish_task）：验收会话不写工作区、不持租约、
 * 不产交付物，所以它不该有「把切片推到 review/blocked」的能力。这个工具只结束它自己。
 */
export const sessionFinishQa = {
  name: 'session_finish_qa',
  description: '验收会话离场：结束本验收会话并释放它占用的位置（同切片可再拉复验）。只结束自己，不改切片状态、不写文档、不碰租约。签字（slice_verify）与离场是两件事：验完要签字再离场；不通过也要离场，否则该切片再也拉不起验收。',
  parameters: params({
    verdict: S('passed | rejected（默认 passed；仅用于回执与事件，不改切片状态）'),
    summary: S('离场说明（必填）：验了什么、结论、遗留问题与复现步骤'),
  }, ['summary']),
  actors: ['qa'],
  execute: async function (args, _exec, actor, deps) {
    const verdict = optionalText(args.verdict) || 'passed'
    if (verdict !== 'passed' && verdict !== 'rejected') throw fail('INVALID', 'verdict 必须是 passed 或 rejected')
    const summary = requireText(args.summary, 'summary')
    const db = actor.db
    if (actor.kind !== 'qa') throw fail('PERMISSION_DENIED', 'session_finish_qa 只给验收会话（当前是 ' + actor.kind + '）')
    const slice = actor.sliceId ? deps.store.getSlice(db, actor.sliceId) : undefined
    const ended = deps.store.endSession(db, {
      id: actor.session.id,
      status: verdict === 'passed' ? 'done' : 'failed',
      // 失败留原因（v4 以来的硬约定）：只写 status 的会话，重启对账/面板/PM 都答不出「为什么」
      failureCode: verdict === 'passed' ? undefined : 'QA_REJECTED',
      failureDetail: verdict === 'passed' ? undefined : summary.slice(0, 500),
    })
    try { invalidateActorCache(actor.dshSessionId) } catch (error) { /* 缓存失效失败不阻断离场 */ }
    const verified = Boolean(slice && slice.status === 'verified')
    // 回执里直接写「下一步」：PM 读到的是这条，不是角色卡。
    const nextStep = !slice
      ? '本验收会话没有绑定切片；直接重新派验收即可。'
      : (verified
        ? '切片已 verified（终态）。需要复验/返工请开新切片，不要在这个切片上重拉验收。'
        : '切片当前是 ' + slice.status + '：没有签字。请 PM 决定「补证据后重拉验收」还是「返工后开新切片」。')
    const notified = await notifyPm(deps.ctx, deps, db, {
      senderAgent: _exec && _exec.agent,
      signal: _exec && _exec.signal,
      text: '【验收会话 ' + actor.name + ' 离场】verdict=' + verdict
        + '；切片「' + (slice ? slice.title : '-') + '」当前 ' + (slice ? slice.status : '-')
        + '。' + summary.slice(0, 400)
        + '\n【下一步】' + nextStep,
    })
    notifyWrite(deps, actor)
    return {
      finished: true,
      verdict: verdict,
      session: { id: ended.id, name: ended.name, status: ended.status, failureCode: ended.failureCode },
      slice: slice ? { id: slice.id, key: slice.key, status: slice.status, verified: verified } : null,
      note: '验收会话已结束；该切片现在可以重新 session_spawn_qa（复验）。',
      nextStep: nextStep,
      notified: notified,
    }
  },
}

export function createSharedTools(_ctx, _deps) {
  return [taskUpdate, artifactAdd, docFreeze, fileIndex, sessionFinishQa]
}
