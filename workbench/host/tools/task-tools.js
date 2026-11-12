// 任务会话工具（T4）：doc_write / evidence_add / session_task_report / session_finish_task。
// 仅 project-task 会话可见；写操作受切片租约（assertWriteScope）约束。
import { fail } from '../db.js'
import { nowIso } from '../util.js'
import { notifyPm, invalidateActorCache } from '../orchestration.js'
import {
  params, S, B, STRING_ARRAY, requireProjectActor, requireText, optionalText,
  requireSliceId, notifyWrite, currentStageOf, normalizeProjectPath,
} from './spec-helpers.js'

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

/** 交接文档：优先复用 handoff/<sliceKey>，冻结后自动换新 logicalKey（文档只增不改）。 */
function ensureHandoffDocument(deps, actor, slice, content, titleHint) {
  const db = actor.db
  const stage = currentStageOf(deps, db)
  const key = 'handoff/' + slice.key
  let doc = deps.docs.findDocumentByLogicalKey(db, key)
  if (!doc) {
    doc = deps.docs.createDocument(db, {
      sliceId: slice.id,
      type: 'handoff',
      logicalKey: key,
      title: titleHint || ('交接：' + slice.title),
      stage: stage ? stage.key : undefined,
      ownerSession: actor.dshSessionId,
    })
  }
  try {
    const written = deps.docs.writeDocumentVersion(db, { docId: doc.id, content: content, authorSession: actor.dshSessionId })
    return { doc: written.doc, version: written.version, created: written.created }
  } catch (error) {
    if (error && error.code === 'DOC_FROZEN') {
      const suffix = nowIso().replace(/[^0-9]/g, '').slice(0, 14)
      const key2 = key + '-' + suffix
      const fresh = deps.docs.createDocument(db, {
        sliceId: slice.id,
        type: 'handoff',
        logicalKey: key2,
        title: (titleHint || ('交接：' + slice.title)) + '（续）',
        stage: stage ? stage.key : undefined,
        ownerSession: actor.dshSessionId,
      })
      const written = deps.docs.writeDocumentVersion(db, { docId: fresh.id, content: content, authorSession: actor.dshSessionId })
      return { doc: written.doc, version: written.version, created: written.created }
    }
    throw error
  }
}

/** doc_write：任务会话写项目文档（新建或新版本）。 */
export const docWrite = {
  name: 'doc_write',
  description: '写项目文档（DB 版本链）：mode=create 按 type+logicalKey 新建；否则给 docId/logicalKey 追加新版本。旧版本不可改、冻结后拒写（DOC_FROZEN）。写正文不要写进 docs/ 文件。',
  parameters: params({
    mode: S('create | new_version（默认按参数推断）'),
    docId: S('文档 id（追加新版本时用）'),
    logicalKey: S('文档逻辑键，如 prd/payment-refund（新建或按 key 追加）'),
    type: S('文档类型：prd|ux|adr|design|spec|report|handoff|retro'),
    title: S('文档标题（新建必填；追加时可改标题）'),
    sliceId: S('所属切片 id（可选，默认本切片）'),
    content: S('Markdown 正文（整篇，会作为新版本）'),
    status: S('文档状态：draft|review|approved（可选）'),
  }, ['content']),
  actors: ['task'],
  execute: async function (args, _exec, actor, deps) {
    const content = requireText(args.content, 'content')
    const db = actor.db
    const mode = optionalText(args.mode)
    const wantCreate = mode === 'create' || (!args.docId && !args.logicalKey)
    let doc
    if (wantCreate) {
      const type = requireText(args.type, 'type')
      if (!deps.docs.DOCUMENT_TYPES.includes(type)) throw fail('INVALID', '文档类型必须是 ' + deps.docs.DOCUMENT_TYPES.join('/'))
      const sliceId = requireSliceId(actor, optionalText(args.sliceId))
      const slice = deps.store.getSlice(db, sliceId)
      if (!slice) throw fail('NOT_FOUND', '切片不存在：' + sliceId)
      const logicalKey = optionalText(args.logicalKey) || (type + '/' + slice.key)
      doc = deps.docs.findDocumentByLogicalKey(db, logicalKey)
      if (!doc) {
        const stage = currentStageOf(deps, db)
        doc = deps.docs.createDocument(db, {
          sliceId: sliceId,
          type: type,
          logicalKey: logicalKey,
          title: requireText(args.title, 'title'),
          stage: stage ? stage.key : undefined,
          ownerSession: actor.dshSessionId,
        })
      }
    } else {
      doc = args.docId ? deps.docs.getDocument(db, String(args.docId)) : deps.docs.findDocumentByLogicalKey(db, String(args.logicalKey))
      if (!doc) throw fail('NOT_FOUND', '文档不存在：' + (args.docId || args.logicalKey) + '（新建请用 mode=create 并提供 type）')
    }
    const sliceId = doc.sliceId || actor.sliceId
    if (!sliceId) throw fail('INVALID', '文档没有关联切片，无法校验写作用域')
    deps.leases.assertWriteScope(db, { sliceId: sliceId, sessionId: actor.session.id })
    const written = deps.docs.writeDocumentVersion(db, {
      docId: doc.id,
      content: content,
      authorSession: actor.dshSessionId,
      title: optionalText(args.title),
      status: optionalText(args.status),
    })
    notifyWrite(deps, actor)
    return {
      doc: minimalDocument(written.doc),
      version: written.version ? written.version.version : undefined,
      created: written.created,
      contentHash: written.version ? written.version.contentHash : undefined,
    }
  },
}

/** evidence_add：任务会话记录可复核证据。 */
export const evidenceAdd = {
  name: 'evidence_add',
  description: '记录证据（测试输出/命令结果/评审记录/截图引用等）。收工前至少 1 条；resultSummary 必须能复核（原样贴命令与关键输出摘要）。',
  parameters: params({
    kind: S('证据类型：test|command|review|diff|screenshot|doc|other'),
    resultSummary: S('结果摘要（命令 + 关键输出/结论）'),
    uri: S('引用路径/URL（可选）'),
    command: S('执行过的命令（可选）'),
    contentHash: S('产物 hash（可选）'),
    sliceId: S('切片 id（可选，默认本切片）'),
    taskId: S('任务 id（可选，默认本任务）'),
  }, ['kind', 'resultSummary']),
  actors: ['task'],
  execute: async function (args, _exec, actor, deps) {
    const sliceId = requireSliceId(actor, optionalText(args.sliceId))
    deps.leases.assertWriteScope(actor.db, { sliceId: sliceId, sessionId: actor.session.id })
    const contextTaskId = actor.session && actor.session.context ? actor.session.context.taskId : undefined
    const evidence = deps.store.addEvidence(actor.db, {
      sliceId: sliceId,
      taskId: optionalText(args.taskId) || contextTaskId,
      kind: requireText(args.kind, 'kind'),
      uri: optionalText(args.uri),
      contentHash: optionalText(args.contentHash),
      command: optionalText(args.command),
      resultSummary: requireText(args.resultSummary, 'resultSummary'),
      createdBy: actor.dshSessionId,
    })
    notifyWrite(deps, actor)
    return { evidence: evidence }
  },
}

/** session_task_report：任务会话向 PM 汇报/交接（写 handoff 文档 + 通知 PM）。 */
export const sessionTaskReport = {
  name: 'session_task_report',
  description: '向 PM 汇报进展或交接：可附 handoff 文本（写入 handoff 文档新版本），并把消息投递给 PM 会话。需要人拍板的问题也走这里，由 PM 汇总成决策卡。',
  parameters: params({
    message: S('给 PM 的消息（进展/问题/需要什么支持）'),
    handoff: S('交接正文（可选；写为 handoff 文档新版本）'),
  }, ['message']),
  actors: ['task'],
  execute: async function (args, _exec, actor, deps) {
    const message = requireText(args.message, 'message')
    const db = actor.db
    const slice = deps.store.getSlice(db, actor.sliceId)
    if (!slice) throw fail('INVALID', '任务会话未绑定有效切片')
    let handoffDoc
    const handoff = optionalText(args.handoff)
    if (handoff) {
      const content = '# 交接：' + actor.name + '\n\n' + handoff + '\n'
      handoffDoc = ensureHandoffDocument(deps, actor, slice, content)
      deps.store.updateSliceStatus(db, { id: slice.id, currentHandoff: message.slice(0, 800), role: actor.role })
    }
    const notified = await notifyPm(_ctxOf(deps, _exec), deps, db, {
      senderAgent: _exec && _exec.agent,
      signal: _exec && _exec.signal,
      text: '【任务会话 ' + actor.name + '】' + message + (handoffDoc ? '（已写交接文档 v' + handoffDoc.version.version + '）' : ''),
    })
    notifyWrite(deps, actor)
    return {
      reported: true,
      handoff: handoffDoc ? { docId: handoffDoc.doc.id, version: handoffDoc.version.version } : null,
      notified: notified,
    }
  },
}

function _ctxOf(deps, _exec) {
  return deps.ctx
}

/** session_finish_task：任务会话收工（校验 handoff + 证据≥1 + 片外零改动声明）。 */
export const sessionFinishTask = {
  name: 'session_finish_task',
  description: '任务会话收工。硬校验：handoff 正文非空、证据 ≥1 条（evidenceIds 或已记录）、必须声明片外零改动（noOutOfScopeChanges=true）。通过后写交接文档、结束会话、释放租约、通知 PM。',
  parameters: params({
    status: S('done | failed（默认 done）'),
    handoff: S('交接正文：做了什么、怎么验证、遗留/风险、下一步'),
    evidenceIds: STRING_ARRAY('证据 id 列表（可选；不给则统计本切片已有证据）'),
    files: STRING_ARRAY('本次改动的项目内相对路径（可选，会登记为 artifact）'),
    noOutOfScopeChanges: B('必须为 true：声明本任务没有改切片写作用域之外的文件'),
  }, ['handoff', 'noOutOfScopeChanges']),
  actors: ['task'],
  execute: async function (args, _exec, actor, deps) {
    const status = optionalText(args.status) || 'done'
    if (status !== 'done' && status !== 'failed') throw fail('INVALID', 'status 必须是 done 或 failed')
    const handoff = requireText(args.handoff, 'handoff')
    if (args.noOutOfScopeChanges !== true) {
      throw fail('INVALID', '收工必须显式声明片外零改动：noOutOfScopeChanges=true。若确有片外改动，先用 session_task_report 回 PM，由 PM 调整切片/写决策后再收工。')
    }
    const db = actor.db
    const sliceId = requireSliceId(actor, undefined)
    const slice = deps.store.getSlice(db, sliceId)
    if (!slice) throw fail('NOT_FOUND', '切片不存在：' + sliceId)
    const contextTaskId = actor.session && actor.session.context ? actor.session.context.taskId : undefined
    // 证据校验：显式 evidenceIds 或本切片/本任务已记录的证据，至少 1 条
    let evidenceCount = 0
    if (Array.isArray(args.evidenceIds) && args.evidenceIds.length > 0) {
      for (const evidenceId of args.evidenceIds) {
        const evidence = deps.store.getEvidence(db, String(evidenceId))
        if (!evidence) throw fail('NOT_FOUND', '证据不存在：' + evidenceId)
        if (evidence.sliceId && evidence.sliceId !== sliceId) throw fail('INVALID', '证据不属于本切片：' + evidenceId)
        evidenceCount += 1
      }
    } else {
      const listed = deps.store.listEvidence(db, { sliceId: sliceId })
      evidenceCount = listed.length
    }
    if (evidenceCount === 0) {
      throw fail('NO_EVIDENCE', '收工前必须有证据：先 evidence_add 记录测试/命令/评审结果（至少 1 条）')
    }
    // 片外零改动声明 → 登记改动文件为 artifact
    const files = Array.isArray(args.files) ? args.files.map(function (path) { return normalizeProjectPath(path) }) : []
    for (const file of files) {
      try {
        deps.store.addArtifact(db, { sliceId: sliceId, kind: 'code-file', path: file, metadata: { session: actor.name } })
      } catch (error) { /* artifact 登记失败不阻断收工 */ }
    }
    const content = '# 交接：' + actor.name + '\n\n' + handoff + '\n'
    const handoffDoc = ensureHandoffDocument(deps, actor, slice, content)
    if (contextTaskId) {
      try { deps.store.updateTask(db, { id: contextTaskId, status: status === 'done' ? 'done' : 'failed' }) } catch (error) { /* 任务状态更新失败不阻断 */ }
    }
    try {
      deps.store.updateSliceStatus(db, {
        id: sliceId,
        status: status === 'done' ? 'review' : 'blocked',
        currentHandoff: handoff.slice(0, 800),
        role: actor.role,
      })
    } catch (error) { /* 切片状态更新失败不阻断 */ }
    const ended = deps.store.endSession(db, { id: actor.session.id, status: status, handoffId: handoffDoc.doc.id })
    try { deps.leases.releaseLease(db, { sliceId: sliceId, sessionId: actor.session.id }) } catch (error) { /* 租约已释放/被他人持有 */ }
    invalidateActorCache(actor.dshSessionId)
    const notified = await notifyPm(deps.ctx, deps, db, {
      senderAgent: _exec && _exec.agent,
      signal: _exec && _exec.signal,
      text: '【任务会话 ' + actor.name + ' 收工】status=' + status + '；证据 ' + evidenceCount + ' 条；改动文件 ' + files.length + ' 个；交接文档 v' + handoffDoc.version.version + '。' + handoff.slice(0, 400),
    })
    notifyWrite(deps, actor)
    return {
      finished: true,
      status: status,
      session: { id: ended.id, name: ended.name, status: ended.status },
      slice: { id: slice.id, key: slice.key, status: 'review' },
      handoff: { docId: handoffDoc.doc.id, version: handoffDoc.version.version, created: handoffDoc.created },
      evidenceCount: evidenceCount,
      files: files,
      notified: notified,
    }
  },
}

export function createTaskTools(_ctx, _deps) {
  return [docWrite, evidenceAdd, sessionTaskReport, sessionFinishTask]
}
