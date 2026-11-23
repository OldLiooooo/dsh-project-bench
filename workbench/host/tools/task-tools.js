// 任务会话工具（T4）：doc_write / evidence_add / session_task_report / session_finish_task。
// 仅 project-task 会话可见；写操作受切片租约（assertWriteScope）约束。
import { fail } from '../db.js'
import { nowIso } from '../util.js'
import { notifyPm, invalidateActorCache } from '../orchestration.js'
import { validateFinish, scopePolicyOf } from '../scope.js'
import { checkDeliverableType, isReadonlyRole } from '../project-defaults.js'

/** project.json（缺失/读取失败时返回 undefined —— 由 checkDeliverableType 当作「不约束」）。 */
function projectJsonOf(deps, actor) {
  try {
    if (deps.registry && typeof deps.registry.projectJson === 'function' && actor.root) return deps.registry.projectJson(actor.root)
  } catch (error) { /* 读不到就不约束，但事件里会体现 */ }
  return undefined
}
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

/**
 * 收工回执里的「下一步」提示（v5）。
 *
 * 三类结局，三种下一步：
 *   交付成功（切片→review）  → PM 该拉独立验收（session_spawn_qa），不是自己 slice_update 成 done
 *   交付失败（切片→blocked） → PM 该解阻塞或换切片，不是反复重试同一会话
 *   证据不足                 → 先补证据（理论上收工已被 NO_EVIDENCE 拦住，这里是兜底）
 *
 * 注意措辞：这是**建议**不是**强制**。PM 可以不采纳（例如它想先补齐更多交付再一起验），
 * 但回执必须让它在没有上下文时也能做出正确决定。
 */
function buildNextStep(actor, sliceId, finishedSlice, meta) {
  const sliceLabel = finishedSlice && finishedSlice.key ? finishedSlice.key : sliceId
  if (meta.status === 'failed') {
    return {
      action: 'resolve_blocker',
      hint: '切片「' + sliceLabel + '」已标记 blocked。PM：查失败原因是外部阻塞还是需要拆小，'
        + '解掉后重新 session_spawn_task；不要对同一个已结束的会话重复 send。',
    }
  }
  if (meta.evidenceCount === 0) {
    return {
      action: 'add_evidence',
      hint: '本切片没有可复核证据，验收会拒绝。PM：要求补 evidence（命令+输出）后再收工。',
    }
  }
  return {
    action: 'spawn_qa',
    hint: '切片「' + sliceLabel + '」已进入 review，可以验收了。'
      + 'PM：调 session_spawn_qa({sliceKey:"' + sliceLabel + '", action:"验收", prompt:"..."}) 拉起独立验收会话；'
      + '**不要**用实现会话验收（会被 SELF_VERIFICATION_DENIED 拒），也**不要**直接 slice_update 成 verified（会被拒）。'
      + '验收会话签字后切片变 verified，L0 的进度自动前进。',
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
      // B3：阶段可交付类型（deliverableTypes）此前只写不读，这里让它真的生效。
      // 只拦「新建文档」：给已有文档追加新版本时类型已经定了，再拦只会把正常返工卡死。
      const stageRow = currentStageOf(deps, db)
      const stageKey = stageRow ? stageRow.key : undefined
      // 调研报告不参与阶段交付物校验：它不是本阶段的交付物，而是回答 PM 问题的调查结论，
      // 会横跨多个阶段（S1 只允许 prd，但调研当然可以在 S1 写 report）。
      const policyCheck = isReadonlyRole(actor.role)
        ? { allowed: true, enforced: false, reason: '只读角色（调研）的报告不受阶段交付类型约束' }
        : checkDeliverableType(projectJsonOf(deps, actor), stageKey, type)
      if (!policyCheck.allowed) {
        throw fail('STAGE_DELIVERABLE_NOT_ALLOWED', policyCheck.reason, {
          stage: policyCheck.stageKey, allowedTypes: policyCheck.allowedTypes, requestedType: type,
        })
      }
      const logicalKey = optionalText(args.logicalKey) || (isReadonlyRole(actor.role) ? 'report/research-' + slice.key + '-' + String(actor.session ? actor.session.id : '').slice(-8) : type + '/' + slice.key)
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
    // 只读角色不持租约（见 orchestration.spawnTaskSession）：它写的是 DB 里的调研报告，
    // 不是切片产物，所以既不占写作用域，也不该被别人的租约挡住（查资料时同切片可能正在实现）。
    if (!isReadonlyRole(actor.role)) deps.leases.assertWriteScope(db, { sliceId: sliceId, sessionId: actor.session.id })
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
  // qa：验收会话也要能记证据（验收结论本身就是证据）。但它没有租约，所以下面按 actor 区分校验。
  actors: ['task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    const sliceId = requireSliceId(actor, optionalText(args.sliceId))
    // 验收会话不占租约（它不写工作区），跳过写作用域校验；任务会话必须过租约。
    // v6：只读角色（调研）同样不持租约，跳过——否则它会被同切片正在实现的会话的租约挡住。
    if (actor.kind === 'task' && !isReadonlyRole(actor.role)) deps.leases.assertWriteScope(actor.db, { sliceId: sliceId, sessionId: actor.session.id })
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
    // v6：只读角色（调研）的「交结果」就是它的收工 —— 它不能用 session_finish_task（会推进切片），
    // 所以必须在 report 这条路径上真正结束会话并释放位置，否则 DB 里会留一条永远 active 的调研会话，
    // 且同(切片,角色)唯一性会挡住「再派一次调研」。
    const readonlyFinish = isReadonlyRole(actor.role)
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
      text: (isReadonlyRole(actor.role) ? '【调研会话 ' : '【任务会话 ') + actor.name + '】' + message
        + (handoffDoc ? '（已写交接文档 v' + handoffDoc.version.version + '）' : '')
        + (isReadonlyRole(actor.role) ? '\n【已收工】调研会话交结果即结束；切片状态未改动（调研不推进切片）。' : ''),
    })
    // 只读角色：report = 收工。结束会话但不改切片状态、不释放别人的租约（它本来就没租约）。
    let ended = null
    if (readonlyFinish) {
      try {
        ended = deps.store.endSession(db, {
          id: actor.session.id,
          status: 'done',
          handoffId: handoffDoc ? handoffDoc.doc.id : undefined,
        })
        invalidateActorCache(actor.dshSessionId)
      } catch (error) { /* 结束失败不阻断交付 */ }
    }
    notifyWrite(deps, actor)
    return {
      reported: true,
      handoff: handoffDoc ? { docId: handoffDoc.doc.id, version: handoffDoc.version.version } : null,
      notified: notified,
      ...(ended ? { finished: true, note: '调研会话已结束（切片状态未改动）' } : {}),
    }
  },
}

function _ctxOf(deps, _exec) {
  return deps.ctx
}

/** session_finish_task：任务会话收工（校验 handoff + 证据≥1 + 片外零改动声明）。 */
export const sessionFinishTask = {
  name: 'session_finish_task',
  description: '任务会话收工。硬校验：handoff 正文非空、证据 ≥1 条（evidenceIds 或已记录）、切片作用域校验（对真实 git diff，不再只认声明）、租约栅栏有效。通过后写交接文档、结束会话、释放租约、通知 PM。',
  parameters: params({
    status: S('done | failed（默认 done）'),
    handoff: S('交接正文：做了什么、怎么验证、遗留/风险、下一步'),
    evidenceIds: STRING_ARRAY('证据 id 列表（可选；不给则统计本切片已有证据）'),
    files: STRING_ARRAY('本次改动的项目内相对路径（可选，会登记为 artifact）'),
    noOutOfScopeChanges: B('必须为 true：声明本任务没有改切片写作用域之外的文件（实际是否越界由真实 diff 校验）'),
    failureCode: S('status=failed 时的失败码（如 TESTS_FAILED / BLOCKED_DEPENDENCY），会落库供对账查询'),
    failureDetail: S('status=failed 时的失败详情（可复核的一句话）'),
    acceptedOutOfScope: B('片外改动已由 PM 接受时置 true（需同时给 outOfScopeReason；仅 scopePolicy=declare 生效）'),
    outOfScopeReason: S('接受片外改动的理由'),
  }, ['handoff', 'noOutOfScopeChanges']),
  actors: ['task'],
  execute: async function (args, _exec, actor, deps) {
    const status = optionalText(args.status) || 'done'
    if (status !== 'done' && status !== 'failed') throw fail('INVALID', 'status 必须是 done 或 failed')
    const handoff = requireText(args.handoff, 'handoff')
    // v6：只读角色（调研）不能收工——session_finish_task 会把切片推到 review/blocked，
    // 而调研不产出切片交付物。它能不接受这条约束，等于让「只查不改」的角色悄悄改状态。
    // 调研交结果走 session_task_report（工具描述与角色卡都这么写）。
    if (isReadonlyRole(actor.role)) {
      throw fail('PERMISSION_DENIED', '只读角色（' + actor.role + '）不能调用 session_finish_task：它会把切片状态推进到 review/blocked，而调研不产出切片交付物。请用 session_task_report 把调研结论交回 PM；报告用 doc_write、证据用 evidence_add。', {
        role: actor.role,
        hint: 'session_task_report({ message, handoff })',
      })
    }
    if (args.noOutOfScopeChanges !== true) {
      throw fail('INVALID', '收工必须显式声明片外零改动：noOutOfScopeChanges=true。若确有片外改动，先用 session_task_report 回 PM，由 PM 调整切片/写决策后再收工。')
    }
    const db = actor.db
    const sliceId = requireSliceId(actor, undefined)
    const slice = deps.store.getSlice(db, sliceId)
    if (!slice) throw fail('NOT_FOUND', '切片不存在：' + sliceId)
    // 租约守卫：收工也是一次写入。租约被他人接管后仍允许收工会让「任务 done / 切片 review」
    // 与「别人持租在写」同时成立（P1 缺陷）。这里在写入前先确认写作用域仍属于本会话。
    // v4：除 holder 外还校验栅栏令牌——抢占后旧会话的重试必须被拒（LEASE_FENCED）。
    deps.leases.assertWriteScope(db, { sliceId: sliceId, sessionId: actor.session.id })
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
    // 切片作用域校验（v4）：拿**真实工作区 diff** 去对作用域声明。
    //
    // 为什么放在证据校验之后：错误要按「先补什么」排序。
    // 没有证据是缺一步记录（1 条命令就能补）；越界是改错了地方（要回滚或重新划范围）。
    // 把「先补证据」摆在前面，收工失败时提示的才是真正该做的下一件事。
    //
    // 旧实现只校验调用方「声明了」片外零改动 —— 声明永远能写 true，等于没校验。
    // 现在：能判定（有 git + 有声明）就真判；不能判定就如实标注 verifiable=false，
    // 而不是伪造一个「通过」（这才是「声明 ≠ 证据」的正确处理方式）。
    let scopeCheck
    try {
      const projectJson = deps.registry && typeof deps.registry.projectJson === 'function' ? deps.registry.projectJson(actor.root) : undefined
      scopeCheck = validateFinish(db, {
        sliceId: sliceId,
        root: actor.root,
        policy: scopePolicyOf(projectJson),
        acceptedOutOfScope: args.acceptedOutOfScope === true,
        outOfScopeReason: args.outOfScopeReason,
      })
    } catch (error) {
      scopeCheck = {
        ok: false, policy: 'strict', basis: 'unavailable', verifiable: false,
        reason: String((error && error.message) || error), unresolved: true,
        counts: { changed: 0, inScope: 0, outOfScope: 0, crossScope: 0 },
        inScope: [], outOfScope: [], crossScope: [], declared: [],
        issues: [{ code: 'SCOPE_CHECK_ERROR', message: String((error && error.message) || error) }],
      }
    }
    if (!scopeCheck.ok) {
      throw fail('OUT_OF_SCOPE_CHANGES', '收工被拒：切片作用域校验未通过 —— ' + scopeCheck.issues.map(function (issue) { return issue.message }).join('；'), {
        sliceId: sliceId,
        scope: {
          policy: scopeCheck.policy, basis: scopeCheck.basis, verifiable: scopeCheck.verifiable,
          counts: scopeCheck.counts, outOfScope: scopeCheck.outOfScope, crossScope: scopeCheck.crossScope,
          declared: scopeCheck.declared, issues: scopeCheck.issues,
        },
      })
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
    let finishedSlice = slice
    try {
      finishedSlice = deps.store.updateSliceStatus(db, {
        id: sliceId,
        status: status === 'done' ? 'review' : 'blocked',
        currentHandoff: handoff.slice(0, 800),
        role: actor.role,
      }) || slice
    } catch (error) { /* 切片状态更新失败不阻断（返回值回落到更新前记录） */ }
    const ended = deps.store.endSession(db, {
      id: actor.session.id,
      status: status,
      handoffId: handoffDoc.doc.id,
      // 失败必须留原因（v4）：只写 status='failed' 的会话，重启对账/面板/PM 都无法回答「为什么失败」。
      failureCode: status === 'failed' ? (optionalText(args.failureCode) || 'TASK_REPORTED_FAILED') : undefined,
      failureDetail: status === 'failed' ? (optionalText(args.failureDetail) || handoff.slice(0, 500)) : undefined,
    })
    try { deps.leases.releaseLease(db, { sliceId: sliceId, sessionId: actor.session.id }) } catch (error) { /* 租约已释放/被他人持有 */ }
    invalidateActorCache(actor.dshSessionId)
    const notified = await notifyPm(deps.ctx, deps, db, {
      senderAgent: _exec && _exec.agent,
      signal: _exec && _exec.signal,
      text: '【任务会话 ' + actor.name + ' 收工】status=' + status
        + (status === 'failed' ? '（' + (ended.failureCode || 'TASK_REPORTED_FAILED') + '）' : '')
        + '；证据 ' + evidenceCount + ' 条；改动文件 ' + files.length + ' 个；交接文档 v' + handoffDoc.version.version
        + '；作用域 ' + (scopeCheck.verifiable
          ? ('已校验：改动 ' + scopeCheck.counts.changed + ' 个，域内 ' + scopeCheck.counts.inScope + '，域外 ' + scopeCheck.counts.outOfScope)
          : ('未校验（' + (scopeCheck.unresolvedReason || 'unknown') + '）'))
        + '。' + handoff.slice(0, 400)
        // v5：唤醒消息里直接带「下一步」，因为 PM 先看到的是这条消息，不是工具返回值。
        + '\n【下一步】' + buildNextStep(actor, sliceId, finishedSlice, { status: status, evidenceCount: evidenceCount }).hint,
    })
    notifyWrite(deps, actor)
    return {
      finished: true,
      status: status,
      session: {
        id: ended.id, name: ended.name, status: ended.status,
        failureCode: ended.failureCode, failureDetail: ended.failureDetail, attempt: ended.attempt,
      },
      slice: {
        id: finishedSlice.id,
        key: finishedSlice.key,
        status: finishedSlice.status,
      },
      sliceBefore: { status: slice.status, ownerRole: slice.ownerRole },
      handoff: { docId: handoffDoc.doc.id, version: handoffDoc.version.version, created: handoffDoc.created },
      evidenceCount: evidenceCount,
      files: files,
      /**
       * v5：把「下一步该做什么」直接写给 PM。
       *
       * 为什么必须由工具返回、而不是靠 PM 自己从角色卡推：
       *   收工回执是 PM 每一次都会读的东西，而角色卡是每步注入的一段静态文字 ——
       *   前者能带**这一片的具体状态**（有几条证据、切片现在什么状态），后者只能给一般原则。
       *   实测教训：v5 做完 verified 后，PM 仍会按旧习惯用 slice_update(status=done) 收尾，
       *   因为没人告诉它"这一片现在可以验收了"。
       */
      nextStep: buildNextStep(actor, sliceId, finishedSlice, { status, evidenceCount }),
      // 作用域校验结果必须回传：这是「片外零改动」从声明变成证据的那一步，人要看得到证据。
      scope: {
        policy: scopeCheck.policy,
        basis: scopeCheck.basis,
        baseline: scopeCheck.baseline,
        verifiable: scopeCheck.verifiable,
        unresolved: scopeCheck.unresolved,
        unresolvedReason: scopeCheck.unresolvedReason,
        counts: scopeCheck.counts,
        inScope: scopeCheck.inScope,
        outOfScope: scopeCheck.outOfScope,
        crossScope: scopeCheck.crossScope,
        declared: scopeCheck.declared,
      },
      notified: notified,
    }
  },
}

export function createTaskTools(_ctx, _deps) {
  return [docWrite, evidenceAdd, sessionTaskReport, sessionFinishTask]
}
