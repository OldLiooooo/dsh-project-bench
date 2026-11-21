// 项目编排（T2 host-api）：初始化、决策拍板（不可逆二次确认）与门禁动作（冻结+导出+阶段推进+approvals）。
// 所有写路径都在 db.tx 内并写事件；决策只能由人（面板 HTTP POST）拍板，agent 工具层不暴露 resolve。
//
// ---------------------------------------------------------------------------
// v4：gate / approval / evidence / export 的统一事务与补偿模型
// ---------------------------------------------------------------------------
// 批准一个门禁要做四件事，它们的「可事务性」完全不同：
//   A. 决策落定 + approvals 行 + 事件      —— 纯 DB，同一个 tx 内，原子
//   B. 冻结文档                            —— 纯 DB（doc_versions.frozen），可放进同一个 tx
//   C. 导出文件到 docs/                    —— **文件系统**，不参与 SQLite 事务
//   D. 阶段推进                            —— 纯 DB，可放进同一个 tx
//   E. 判据复跑（async IO）                —— 必须在 tx 之外（tx 是同步的）
//
// 旧实现把 A/B/C/D 全塞进一个 db.tx，于是「C 中途失败」会回滚 A/B/D 却留下一半文件；
// 而「C 成功但 A/B/D 提交失败」会留下没人认领的文件。这两条都无法靠重试修好，
// 因为重试时无法判断上一轮的哪些文件已经写过。
//
// v4 的分层（顺序即事务边界）：
//   ① preflight（tx 外）：判据复跑 + 阶段守卫 + 文档快照校验 —— 只读，失败直接拒绝，不动任何状态
//   ② commit  （tx 内）：决策落定 → 冻结 → 推进阶段 → approvals 行（含 epoch）→ 导出**意图**（outbox）
//                        → gate/approve 事件。这一步要么全成，要么全不留痕
//   ③ apply  （tx 外）：按 outbox 逐条写文件。失败只影响对应 outbox 行
//   ④ settle （tx 内）：把导出结果写回事件/审批 payload；有 failed 就补一条 gate/export_failed 事件
//
// 补偿：
//   - outbox 里 pending/failed 的行可以随时 replayPendingExports() 重放（内容确定性 → 同 hash）；
//   - 重放成功后不需要重新批准：DB 已经推进了阶段，缺的只是文件；
//   - 因此「批准成功但导出失败」是一个**可收敛**的中间态，而不是一个需要人工判断的陷阱。
//
// 明确不做：不把「导出失败」回滚成「门禁未批准」。阶段推进是不可逆的人签名，
// 文件是可以重生成的派生物；为了派生物回滚签名，等于把不可逆变成可逆（比留个洞更糟）。
import { randomUUID } from 'node:crypto'
import * as storeApi from './store.js'
import * as docsApi from './docs.js'
import * as exportApi from './export.js'
import { projectError } from './registry.js'
import { newId, nowIso, jsonText } from './util.js'
import { defaultExportMap } from './project-defaults.js'
import { runProjectCheckers, summarizeCheckRun } from './checkers.js'
import { replayPendingExports, outboxStatus } from './export.js'
import { resolveIdentity, ensureIdentity, recordApprovalSigner, separationOf } from './identity.js'
import {
  overview, listStages, currentStage, pmEnsure,
  mapDecisionRow, mapSessionRow,
} from './snapshot.js'

const PM_SESSION_NAME = storeApi.PM_SESSION_NAME || '项目办公室'

/** 门禁拒绝错误：带 issues 明细（HTTP 层用作 409 + 结构化原因）。 */
function gateError(code, message, issues) {
  const error = projectError(code, message, 409)
  if (Array.isArray(issues)) error.issues = issues
  return error
}

/**
 * 比对「提交时」与「批准前复跑」的判据结果：按 name 对齐，比 status + resultHash。
 * 只报告有差异的项（新出现/消失的判据也算差异，因为门禁的判据集合变了）。
 */
function detectCheckDrift(submittedChecks, rerunChecks) {
  const drifted = []
  const before = new Map()
  for (const item of Array.isArray(submittedChecks) ? submittedChecks : []) {
    if (item && item.name) before.set(String(item.name), item)
  }
  const after = new Map()
  for (const item of Array.isArray(rerunChecks) ? rerunChecks : []) {
    if (item && item.name) after.set(String(item.name), item)
  }
  for (const [name, now] of after) {
    const was = before.get(name)
    if (!was) { drifted.push({ name, reason: 'checker-appeared', status: now.status }); continue }
    if (String(was.status) !== String(now.status)) { drifted.push({ name, reason: 'status-changed', from: was.status, to: now.status }); continue }
    if (was.resultHash && now.resultHash && String(was.resultHash) !== String(now.resultHash)) {
      drifted.push({ name, reason: 'result-changed', from: was.resultHash, to: now.resultHash })
    }
  }
  for (const name of before.keys()) if (!after.has(name)) drifted.push({ name, reason: 'checker-disappeared' })
  return drifted
}

function requireFunction(name, value) {
  if (typeof value !== 'function') throw projectError('DATA_LAYER_UNAVAILABLE', 'store API is not available: ' + name, 503)
  return value
}

/**
 * project 初始化：ensure（.project 布局 + DB + project.json + 7 阶段行 + S1 active + 事件），
 * 返回 overview 形状的投影（附 workspaceId/root/revision）。
 */
export function initProject(registry, options = {}) {
  const reference = options.workspaceId ?? options.root ?? options.workspace
  const workspace = registry.rootForWorkspace(reference)
  const db = registry.ensure(workspace.root, { name: options.name, workspaceId: workspace.workspaceId })
  const ov = overview(db, workspace.root)
  return { ...ov, workspaceId: workspace.workspaceId, root: workspace.root, revision: db.revision() }
}

// ---------------------------------------------------------------------------
// 门禁状态机守卫（P1 修复）：
// 1) 提交时必须点名「当前 active 阶段」且 gate 与该阶段匹配 —— 否则会批准未来阶段，
//    造成「两个 active 阶段」这种非法状态；
// 2) 批准时以「提交时快照」为准（approvals.snapshot_json 的 docIds@version@hash），
//    不再按 stage/slice 现场重查 —— 否则提交 A 却被批准冻结 B；
// 3) 内容在提交后变动（新版本 / hash 不同）必须重新提交 —— 否则旧审批会冻结没审过的内容。
// ---------------------------------------------------------------------------

/** 读最近一条 pending approvals 行（gate_submit 写入的快照）。 */
function pendingApprovalFor(db, decision) {
  return db.db
    .prepare("SELECT * FROM approvals WHERE project_id = ? AND decision_id = ? AND status = 'pending' ORDER BY rowid DESC LIMIT 1")
    .get(db.projectId, decision.id)
}

/** 解析提交快照：{ docIds, docVersions:[{docId,version,hash}], stage, gate }。 */
function readSubmitSnapshot(approval) {
  if (!approval || !approval.snapshot_json) return null
  try {
    const parsed = JSON.parse(approval.snapshot_json)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/**
 * 门禁提交校验（PM gate_submit 与批准路径共用）。
 * 返回 { stage, stageRow, issues }；issues 非空即拒绝提交或拒绝批准。
 */
export function validateGateTarget(db, input = {}) {
  const issues = []
  const gate = input.gate
  const requestedStage = input.stage
  if (!gate) issues.push({ code: 'GATE_REQUIRED', message: '门禁必须点名 gate key' })
  const stages = listStages(db)
  const activeStages = stages.filter((stage) => stage.status === 'active')
  const current = activeStages[0]
  // 零阶段行：项目没有阶段机（旧库/headless），没有可违反的转移，保持宽松且不做推演。
  if (stages.length === 0) return { stage: requestedStage, stageRow: undefined, issues, stages, noStageMachine: true }
  if (!current) {
    issues.push({ code: 'NO_ACTIVE_STAGE', message: '没有 active 阶段，无法提交/批准门禁' })
    return { stage: requestedStage, stageRow: undefined, issues, stages }
  }
  if (activeStages.length > 1) {
    issues.push({
      code: 'MULTIPLE_ACTIVE_STAGES',
      message: '存在多个 active 阶段（' + activeStages.map((stage) => stage.key).join(',') + '），项目状态已损坏，先修复阶段表',
    })
  }
  const target = requestedStage ? stages.find((stage) => stage.key === requestedStage) : current
  if (requestedStage && !target) {
    issues.push({ code: 'STAGE_NOT_FOUND', message: '阶段不存在：' + requestedStage })
    return { stage: requestedStage, stageRow: undefined, issues, stages }
  }
  if (target && target.key !== current.key) {
    issues.push({
      code: 'STALE_GATE_STAGE',
      message: '门禁只能提交给当前 active 阶段：当前是 ' + current.key + '，请求的是 ' + target.key,
      currentStage: current.key,
      requestedStage: target.key,
    })
  }
  if (target && target.gate && gate && target.gate !== gate) {
    issues.push({
      code: 'GATE_MISMATCH',
      message: '门禁 key 与阶段不匹配：阶段 ' + target.key + ' 的门禁是 ' + target.gate + '，请求的是 ' + gate,
    })
  }
  if (target && target.status === 'done') {
    issues.push({ code: 'STALE_GATE_STAGE', message: '阶段已结束：' + target.key })
  }
  return { stage: target ? target.key : requestedStage, stageRow: target, issues, stages }
}

/**
 * 批准时校验：提交快照里的文档集合与版本必须与「现在」一致。
 * 返回 { documents, issues }。
 */
export function validateSubmittedDocuments(db, snapshot) {
  const issues = []
  const documents = []
  const entries = Array.isArray(snapshot && snapshot.docVersions) ? snapshot.docVersions : []
  if (entries.length === 0) return { documents, issues }
  for (const entry of entries) {
    const docId = entry && entry.docId ? String(entry.docId) : ''
    if (!docId) {
      issues.push({ code: 'INVALID_SUBMISSION', message: '提交快照里的文档条目缺少 docId' })
      continue
    }
    const doc = docsApi.getDocument(db, docId)
    if (!doc) {
      issues.push({ code: 'SUBMITTED_DOC_GONE', message: '提交的文档已不存在：' + docId, docId })
      continue
    }
    const submittedVersion = Number(entry.version || 0)
    const currentVersion = Number(doc.currentVersion || 0)
    if (submittedVersion > 0 && currentVersion !== submittedVersion) {
      issues.push({
        code: 'SUBMITTED_DOC_DRIFT',
        message: '文档在提交后被改版：提交 v' + submittedVersion + '，当前 v' + currentVersion + '（须重新提交门禁）',
        docId,
        submittedVersion,
        currentVersion,
      })
      continue
    }
    const version = submittedVersion > 0 ? submittedVersion : currentVersion
    const versionRow = version > 0 ? docsApi.getDocVersion(db, docId, version) : undefined
    if (entry.hash && versionRow && versionRow.contentHash && String(entry.hash) !== String(versionRow.contentHash)) {
      issues.push({
        code: 'SUBMITTED_DOC_DRIFT',
        message: '文档内容在提交后变化（hash 不一致），须重新提交门禁',
        docId,
        submittedHash: entry.hash,
        currentHash: versionRow.contentHash,
      })
      continue
    }
    documents.push({ doc, version })
  }
  return { documents, issues }
}

/** 阶段推进：只允许从决策指向的阶段 → 下一阶段；非法来源一律拒绝。 */
function advanceStage(db, decision) {
  const stages = listStages(db)
  if (stages.length === 0) return null // 没有阶段机的项目：不推进（与旧行为一致）
  const activeStages = stages.filter((stage) => stage.status === 'active')
  if (activeStages.length !== 1) {
    throw projectError(
      'STALE_STAGE',
      '阶段推进被拒：active 阶段数应为 1，实际 ' + activeStages.length + '（' + activeStages.map((stage) => stage.key).join(',') + '）',
      409,
    )
  }
  const current = activeStages[0]
  if (decision.stage && decision.stage !== current.key) {
    throw projectError(
      'STALE_GATE_STAGE',
      '阶段推进被拒：门禁属于 ' + decision.stage + '，当前 active 是 ' + current.key,
      409,
    )
  }
  const index = stages.findIndex((stage) => stage.id === current.id)
  const next = index >= 0 ? (stages[index + 1] || null) : null
  const at = nowIso()
  db.db.prepare("UPDATE stages SET status = 'done', ended_at = ? WHERE id = ?").run(at, current.id)
  db.appendEvent({
    kind: 'stage/change',
    subjectType: 'stage',
    subjectId: current.key,
    payload: { from: current.key, to: next ? next.key : null, gate: decision.gate ?? current.gate ?? null, decisionId: decision.id, action: 'advance' },
  })
  if (next) {
    db.db.prepare("UPDATE stages SET status = 'active', started_at = ? WHERE id = ?").run(at, next.id)
    db.setMeta('stage.current', next.key)
  }
  return { gate: decision.gate ?? current.gate ?? null, from: current.key, to: next ? next.key : null }
}

/**
 * approvals 行：gate_submit 已建 pending 则更新（并补 decision_id），否则补写。
 *
 * v4 变化：
 *   - 只认**本次决策对应的那条** pending 审批行（原来是「同 gate 任意 pending」，会串批）；
 *   - 写入 epoch：审批是对「某一代提交快照」的签名，重提必须换 epoch（见 store/gate 的 supersede）；
 *   - 签名人的结构化身份写进 approval_signers（approvals.approved_by 仍存 subject 字符串，向后兼容）。
 */
function writeApproval(db, decision, options) {
  const at = nowIso()
  const payload = jsonText(options.payload ?? {})
  const evidence = jsonText(options.evidenceIds ?? [])
  let existing = db.db
    .prepare('SELECT id, epoch FROM approvals WHERE project_id = ? AND decision_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(db.projectId, decision.id)
  if (!existing) {
    existing = db.db
      .prepare("SELECT id, epoch FROM approvals WHERE project_id = ? AND status = 'pending' AND gate IS ? ORDER BY rowid DESC LIMIT 1")
      .get(db.projectId, decision.gate ?? null)
  }
  const identity = options.identity || resolveIdentity({ decidedBy: options.decidedBy })
  if (existing) {
    db.db
      .prepare('UPDATE approvals SET status = ?, approved_by = ?, approved_at = ?, snapshot_json = ?, decision_id = COALESCE(decision_id, ?) WHERE id = ?')
      .run(options.status, identity.subject, at, payload, decision.id, existing.id)
    if (options.status === 'approved' || options.status === 'rejected') {
      recordApprovalSigner(db, { approvalId: existing.id, identity, clientHint: options.clientHint })
    }
    return existing.id
  }
  const id = newId('appr')
  db.db
    .prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, db.projectId, decision.stage ?? null, decision.gate ?? null, decision.id, options.status, evidence, payload, identity.subject, at, 1)
  if (options.status === 'approved' || options.status === 'rejected') {
    recordApprovalSigner(db, { approvalId: id, identity, clientHint: options.clientHint })
  }
  return id
}

/**
 * 把同一决策/同一门禁的**旧 pending 审批**标成 superseded（不删除，保留历史）。
 * 为什么需要：重提交会产生新的 pending 行，若旧行仍是 pending，「批准哪一个」就变成未定义行为。
 * v4 之前靠「ORDER BY rowid DESC LIMIT 1」取最新，等于把旧行留成了永远批不掉的僵尸。
 */
function supersedePendingApprovals(db, decision, options = {}) {
  const rows = db.db
    .prepare("SELECT id FROM approvals WHERE project_id = ? AND status = 'pending' AND (decision_id = ? OR (decision_id IS NULL AND gate IS ?))")
    .all(db.projectId, decision.id, decision.gate ?? null)
  if (rows.length === 0) return []
  const at = nowIso()
  const supersededBy = options.supersededBy ?? decision.id
  const reason = options.reason ?? 'resubmitted'
  for (const row of rows) {
    db.db.prepare("UPDATE approvals SET status = 'superseded', superseded_reason = ?, superseded_by = ?, approved_at = ? WHERE id = ?")
      .run(reason, supersededBy, at, row.id)
    db.appendEvent({
      kind: 'approval/supersede',
      subjectType: 'approval',
      subjectId: row.id,
      payload: { reason, supersededBy, gate: decision.gate ?? null, decisionId: decision.id },
    })
  }
  return rows.map((row) => row.id)
}

/**
 * 门禁批准：冻结「提交时那一组文档」→ 导出 docs/ → 阶段推进 → approvals 行 → gate/approve 事件。
 * 冻结集合来自 approvals.snapshot_json（提交快照），不再按 stage/slice 现场重查；
 * 快照里的版本/内容与当前不一致时整体拒绝（STALE_APPROVAL），要求重新提交门禁。
 */
function applyGateApproval(db, decision, options) {
  const freezeDocument = requireFunction('docs.freezeDocument', docsApi.freezeDocument)
  const exportDocument = requireFunction('export.exportDocument', exportApi.exportDocument)
  const exportMap = options.exportMap && typeof options.exportMap === 'object' ? options.exportMap : defaultExportMap()
  // ① 阶段守卫：只能批准当前 active 阶段的门禁（防止跨阶段批准造成两个 active）
  const gateTarget = validateGateTarget(db, { gate: decision.gate, stage: decision.stage })
  if (gateTarget.issues.length > 0) {
    throw gateError('STALE_GATE_STAGE', '门禁批准被拒：' + gateTarget.issues.map((issue) => issue.message).join('；'), gateTarget.issues)
  }
  // ② 判据守卫的复跑在 db.tx 之前完成（见 preflightGateApproval），这里只消费结果。
  // ③ 文档集合守卫：以提交快照为准，且内容不得在提交后变化
  const approval = pendingApprovalFor(db, decision)
  const snapshot = readSubmitSnapshot(approval)
  const submitted = validateSubmittedDocuments(db, snapshot)
  if (submitted.issues.length > 0) {
    throw gateError('STALE_APPROVAL', '门禁批准被拒：提交内容已过期 —— ' + submitted.issues.map((issue) => issue.message).join('；'), submitted.issues)
  }
  const frozenDocs = []
  const exports = []
  if (submitted.documents.length === 0 && snapshot && Array.isArray(snapshot.docIds) && snapshot.docIds.length > 0) {
    throw projectError('STALE_APPROVAL', '门禁批准被拒：提交快照缺少文档版本信息，请重新提交门禁', 409)
  }
  const targets = submitted.documents
  // 导出批次：本次批准产生的所有文件共用一个 batch_id，「导全了没有」因此是可查询的事实。
  const batchId = options.batchId || newId('batch')
  const plans = []
  for (const target of targets) {
    const doc = target.doc
    let frozen
    try {
      frozen = freezeDocument(db, { docId: doc.id, version: target.version || undefined, actorSession: options.decidedBy })
    } catch (error) {
      if (error.code !== 'DOC_FROZEN') throw error
      frozen = docsApi.getDocument(db, doc.id) || doc
    }
    const version = Number(target.version || frozen?.currentVersion || doc.currentVersion || 0)
    frozenDocs.push({ docId: doc.id, type: doc.type, logicalKey: doc.logicalKey, version })
    if (options.root && version > 0) {
      // deferWrite：这里仍在事务里（db.tx 可重入），文件必须等到提交之后再写。
      const out = exportDocument(db, { docId: doc.id, version, root: options.root, exportMap, batchId, deferWrite: true })
      if (out && out.plan) plans.push(out.plan)
      exports.push({ docId: doc.id, version, path: out?.relativePath ?? null, hash: out?.hash ?? null, outboxId: out?.outboxId, batchId })
    }
  }
  const stage = advanceStage(db, decision)
  const approvalId = writeApproval(db, decision, {
    status: 'approved',
    decidedBy: options.decidedBy,
    identity: options.identity,
    clientHint: options.clientHint,
    payload: {
      decisionId: decision.id,
      gate: decision.gate ?? null,
      stage,
      frozenDocIds: frozenDocs.map((doc) => doc.docId),
      exports,
      batchId,
      rationale: options.rationale ?? null,
      precheck: options.precheck ?? null,
      identity: options.identity ?? null,
    },
  })
  db.appendEvent({
    kind: 'gate/approve',
    subjectType: 'gate',
    subjectId: decision.gate ?? null,
    sliceId: decision.sliceId,
    payload: {
      decisionId: decision.id,
      gate: decision.gate ?? null,
      title: decision.title,
      stage,
      frozenDocIds: frozenDocs.map((doc) => doc.docId),
      exports,
      batchId,
      approvedBy: options.identity ? options.identity.subject : (options.decidedBy ?? null),
      approvalEpoch: options.approvalEpoch ?? null,
      approvalId,
      precheck: options.precheck ?? null,
      identity: options.identity ?? null,
    },
  })
  return { approved: true, frozenDocs, exports, stage, approvalId, batchId, plans, precheck: options.precheck ?? null }
}

/**
 * 门禁批准之后的**导出落地与外层结算**（在事务提交之后调用）。
 *
 * 为什么单独一步：
 *   - 文件写失败不能回滚「人已经签的字」，只能留下一条可补偿的 outbox 行；
 *   - 但失败也**不能被静默吞掉**：必须写进审批 payload、写一条 gate/export_failed 事件，
 *     并在返回值里如实告诉调用方「阶段已推进，文件没导全，可补偿」。
 *
 * @returns {{batchId:string, status:object, files:Array, failed:number, compensated:boolean}}
 */
function settleGateExports(db, decision, approvalId, plans, options = {}) {
  const root = options.root
  const batchId = options.batchId
  if (!root || !Array.isArray(plans) || plans.length === 0) {
    return { batchId: batchId ?? null, status: batchId ? outboxStatus(db, batchId) : null, files: [], failed: 0, compensated: false }
  }
  let flushed = exportApi.flushPlannedExports(db, root, plans)
  let compensated = false
  // 有失败就立刻补偿一次：绝大多数失败是瞬时 IO（目录被占用/防病毒扫描），
  // 当场重试能收敛掉大部分，避免把「需要人处理」的比例放大。
  if (flushed.failed > 0) {
    const replay = replayPendingExports(db, { root, batchId })
    compensated = true
    flushed = {
      batchId,
      applied: flushed.applied + replay.done,
      failed: replay.failed,
      files: flushed.files,
      status: outboxStatus(db, batchId),
    }
  }
  const status = flushed.status
  db.tx(() => {
    const approval = db.db.prepare('SELECT snapshot_json FROM approvals WHERE id = ?').get(approvalId)
    if (approval) {
      let payload = {}
      try { payload = JSON.parse(approval.snapshot_json || '{}') } catch (error) { payload = {} }
      payload.exportResult = { batchId, status, failed: flushed.failed, compensated, at: nowIso() }
      db.db.prepare('UPDATE approvals SET snapshot_json = ? WHERE id = ?').run(jsonText(payload), approvalId)
    }
    if (flushed.failed > 0) {
      db.appendEvent({
        kind: 'gate/export_failed',
        subjectType: 'gate',
        subjectId: decision.gate ?? null,
        sliceId: decision.sliceId,
        payload: { decisionId: decision.id, approvalId, batchId, failed: flushed.failed, status, compensated },
      })
    }
  })
  return { batchId, status, files: flushed.files, failed: flushed.failed, compensated }
}

/** 门禁驳回：不推进阶段，记录 gate/reject 事件并把 pending approval 置为 rejected。 */
function applyGateRejection(db, decision, options) {
  const approvalId = writeApproval(db, decision, {
    status: 'rejected',
    decidedBy: options.decidedBy,
    identity: options.identity,
    clientHint: options.clientHint,
    payload: { decisionId: decision.id, gate: decision.gate ?? null, rationale: options.rationale ?? null, identity: options.identity ?? null },
  })
  db.appendEvent({
    kind: 'gate/reject',
    subjectType: 'gate',
    subjectId: decision.gate ?? null,
    sliceId: decision.sliceId,
    payload: {
      decisionId: decision.id,
      gate: decision.gate ?? null,
      title: decision.title,
      rationale: options.rationale ?? null,
      rejectedBy: options.identity ? options.identity.subject : (options.decidedBy ?? null),
      approvalId,
      identity: options.identity ?? null,
    },
  })
  return { approved: false, rejected: true, approvalId }
}

/**
 * 决策选项的可读摘要：「A」→「A 扩展本项范围（理由：…）」。唤醒 PM 时必须带上它，
 * 否则 PM 只知道"被批准了"，不知道被批准的是哪个方案。
 */
function describeAnswer(decision, answer) {
  if (!answer) return ''
  const options = Array.isArray(decision && decision.options) ? decision.options : []
  const index = options.findIndex((option, position) => storeApi.optionValueOf(option, position) === String(answer))
  if (index < 0) return String(answer)
  const option = options[index]
  const label = option && typeof option === 'object'
    ? String(option.label !== undefined ? option.label : option.title !== undefined ? option.title : option.value !== undefined ? option.value : option.text !== undefined ? option.text : '')
    : String(option)
  return String(answer) + (label ? ' ' + label : '')
}

function buildWakeText(decision, status, actions, rationale, answer) {
  const choice = describeAnswer(decision, answer)
  const suffix = (choice ? '；选定：' + choice : '') + (rationale ? '；理由：' + rationale : '')
  if (decision.kind === 'gate') {
    const gate = decision.gate || '门禁'
    if (status === 'approved' && actions) {
      const stage = actions.stage
      return '用户已批准' + gate + '（' + decision.title + '）：阶段 ' + (stage?.from ?? '?') + ' → ' + (stage?.to ?? '完成') +
        '；冻结文档 ' + (actions.frozenDocs?.length ?? 0) + ' 篇，导出 ' + (actions.exports?.length ?? 0) + ' 篇' + suffix + '。请按新阶段继续编排。'
    }
    return '用户已驳回' + gate + '（' + decision.title + '）' + suffix + '。请组织返工，补齐文档/证据后重新提交门禁。'
  }
  return '决策「' + decision.title + '」已被用户' + (status === 'approved' ? '批准' : '驳回') + suffix + '。请据此更新项目。'
}

/** 唤醒 PM 会话：空闲时 followup（启动新轮次），运行中 steer（并入下一步）。 */
export function wakePm(ctx, db, text) {
  if (!text) return { woke: false, reason: 'empty' }
  const pm = pmEnsure(db)
  if (!pm || !pm.dshSessionId) return { woke: false, reason: 'no-pm-session' }
  const agents = ctx?.agents
  const agent = agents && typeof agents.get === 'function' ? agents.get(pm.dshSessionId) : undefined
  if (!agent) return { woke: false, reason: 'no-live-pm-agent' }
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'project-workbench' },
  }
  try {
    if (agent.status === 'running' && typeof agent.steer === 'function') {
      agent.steer(message)
      return { woke: true, delivery: 'steer', pmSessionId: pm.id }
    }
    if (typeof agent.followup === 'function') {
      agent.followup(message)
      return { woke: true, delivery: 'followup', pmSessionId: pm.id }
    }
    return { woke: false, reason: 'no-followup-api' }
  } catch (error) {
    try { ctx?.logger?.warn?.('project-workbench: wake PM failed: ' + error.message) } catch { /* logger 不可用 */ }
    return { woke: false, reason: 'error', message: error.message }
  }
}

/**
 * 批准前的判据复跑（async，必须在 db.tx 之外执行 —— tx 是同步的）。
 *
 * 为什么需要它：gate_submit 时判据是绿的，不代表人点批准时还是绿的。
 * 提交到批准之间，代码可能改了、文档可能断了、交接可能过期——那正是"门禁形同虚设"的经典形态。
 *
 * 语义（与 gate_submit 的 fail-closed 保持一致）：
 * - 提交快照里没有 checks（提交时本来就无判据）→ 不复跑，返回 { skipped:true }
 * - 复跑不通过                                  → STALE_PRECHECK
 * - 复跑通过但结果与提交时不同（hash/status/集合变了）→ STALE_PRECHECK
 * - 复跑通过且一致                               → 返回复跑摘要，写进 approval payload 与事件
 */
async function preflightGateApproval(db, decision, options = {}) {
  const snapshot = readSubmitSnapshot(pendingApprovalFor(db, decision))
  const checksAtSubmit = Array.isArray(snapshot && snapshot.checks) ? snapshot.checks : []
  if (checksAtSubmit.length === 0) {
    return { ranAt: nowIso(), skipped: true, reason: 'no-checks-at-submit', ok: true, checks: [] }
  }
  if (!options.root) {
    return { ranAt: nowIso(), skipped: true, reason: 'no-root', ok: true, checks: [] }
  }
  const rerun = await runProjectCheckers(options.root, { registry: options.registry })
  const summary = { ranAt: nowIso(), skipped: rerun.skipped, ok: rerun.ok, checks: rerun.checks, durationMs: rerun.durationMs }
  if (!rerun.ok) {
    throw gateError('STALE_PRECHECK', '门禁批准被拒：提交后判据已变红 —— ' + summarizeCheckRun(rerun), rerun.issues)
  }
  const drifted = detectCheckDrift(checksAtSubmit, rerun.checks)
  if (drifted.length > 0) {
    throw gateError(
      'STALE_PRECHECK',
      '门禁批准被拒：提交后判据结果发生变化（' + drifted.map(function (item) { return item.name }).join('、') + '），须重新提交门禁',
      drifted,
    )
  }
  return summary
}

/**
 * 决策拍板（人操作）：pending → approved/rejected。
 * - 不可逆决策批准必须 confirmed === true（二次确认），否则 409 CONFIRM_REQUIRED。
 * - kind='gate' 批准时执行门禁动作；驳回时只记事件/审批行。
 * - 落定后唤醒 PM 会话。
 */
export async function resolveDecisionAction(ctx, db, input = {}, options = {}) {
  const id = input.id
  if (typeof id !== 'string' || !id) throw projectError('INVALID', 'decision id is required')
  const status = input.status
  if (status !== 'approved' && status !== 'rejected') throw projectError('INVALID', "status must be 'approved' or 'rejected'")
  const getDecision = requireFunction('store.getDecision', storeApi.getDecision)
  const resolveDecision = requireFunction('store.resolveDecision', storeApi.resolveDecision)
  const before = getDecision(db, id)
  if (!before) throw projectError('NOT_FOUND', 'decision not found: ' + id, 404)
  if (before.status !== 'pending') throw projectError('CONFLICT', 'decision is already ' + before.status, 409)
  if (status === 'approved' && before.irreversible && input.confirmed !== true) {
    throw projectError('CONFIRM_REQUIRED', 'irreversible decision requires confirmed=true', 409)
  }
  const identity = options.identityObj || resolveIdentity({ identity: input.identity, decidedBy: input.decidedBy, actingAs: input.actingAs, clientHint: input.clientHint })
  const decidedBy = identity.subject
  const rationale = typeof input.rationale === 'string' ? input.rationale : null
  const answer = input.answer === undefined || input.answer === null ? undefined : String(input.answer)
  const batchId = before.kind === 'gate' && status === 'approved' ? newId('batch') : undefined

  // ① preflight（事务外，只读）：判据复跑 + 阶段守卫 + 快照校验。
  //    任何一步不过就整体拒绝，此时**没有写任何状态**，重试是安全的。
  let precheck = null
  if (before.kind === 'gate' && status === 'approved') {
    precheck = await preflightGateApproval(db, before, options)
    assertApprovalStillCurrent(db, before)
  }

  // ② commit（事务内）：决策落定 → 冻结 → 阶段推进 → approvals → 导出意图。
  //    导出只落 outbox 意图，不写文件（文件系统不参与回滚）。
  let actions = null
  let approvalEpoch = null
  db.tx(() => {
    resolveDecision(db, { id, status, decidedBy, rationale, answer, confirmed: input.confirmed === true })
    if (before.kind === 'gate') {
      const approval = pendingApprovalFor(db, before)
      approvalEpoch = approval ? Number(approval.epoch ?? 1) : null
      actions = status === 'approved'
        ? applyGateApproval(db, before, {
          root: options.root, exportMap: options.exportMap, decidedBy, identity,
          clientHint: input.clientHint, rationale, precheck, batchId, approvalEpoch,
        })
        : applyGateRejection(db, before, { decidedBy, identity, clientHint: input.clientHint, rationale })
    }
  })

  // ③ apply + ④ settle（事务外文件写 + 事务内结算）。
  let exportResult = null
  if (actions && actions.approved && actions.plans && actions.plans.length > 0) {
    exportResult = settleGateExports(db, before, actions.approvalId, actions.plans, { root: options.root, batchId })
  }

  const decision = getDecision(db, id)
  const separation = separationOf(db, { submittedBy: readSubmitter(db, before), approvedBy: decidedBy })
  const wake = wakePm(ctx, db, buildWakeText(decision || before, status, actions, rationale, answer))
  return {
    decision,
    actions,
    exportResult,
    separation,
    wake,
    revision: db.revision(),
  }
}

/**
 * 批准前重新确认「这条 pending 审批仍然是当前有效的那一条」。
 *
 * 为什么单独一条：preflight 是 async 的，从复跑判据到真正进事务之间仍然有一个窗口，
 * PM 可能在这个窗口里重新提交门禁（产生新的 pending 行）。若不复核，
 * 人签的就是「已经作废的提交」，而冻结/推进却按旧快照执行 —— 这正是 STALE 类缺陷的成因。
 */
function assertApprovalStillCurrent(db, decision) {
  const approval = pendingApprovalFor(db, decision)
  if (!approval) {
    throw gateError('STALE_APPROVAL', '门禁批准被拒：提交快照已不存在（可能已被重新提交或撤回），请重新提交门禁', [])
  }
  return approval
}

/** 提交人（approvals.snapshot_json.submittedBy 或决策的 created_by）。 */
function readSubmitter(db, decision) {
  try {
    const approval = pendingApprovalFor(db, decision)
    const snapshot = readSubmitSnapshot(approval)
    if (snapshot && typeof snapshot.submittedBy === 'string') return snapshot.submittedBy
  } catch (error) { /* 读不到就退到决策创建者 */ }
  return decision && decision.createdBy ? String(decision.createdBy) : undefined
}

/**
 * 导出补偿入口（人/面板可触发）：把 pending/failed 的导出意图重新落地。
 * 与「重新批准」解耦：阶段推进是不可逆签名，文件是可再生的派生物。
 */
export function replayExports(db, input = {}) {
  const result = replayPendingExports(db, input)
  if (result.replayed > 0) {
    db.tx(() => {
      db.appendEvent({
        kind: 'export/replay',
        subjectType: 'project',
        subjectId: db.projectId,
        payload: { batchId: result.batchId, replayed: result.replayed, done: result.done, failed: result.failed, remaining: result.remaining },
      })
    })
  }
  return { ...result, revision: db.revision() }
}

/** 绑定/切换项目 PM 会话（客户端 startSession 后登记 dshSessionId）。 */
export function bindPmSession(db, input = {}) {
  const dshSessionId = input.dshSessionId
  if (typeof dshSessionId !== 'string' || !dshSessionId.trim()) throw projectError('INVALID', 'dshSessionId is required')
  // 契约 §3：kind='pm' 的会话名固定为「项目办公室」（与 store.createSession 的校验一致）。
  const name = PM_SESSION_NAME
  let sessionId
  db.tx(() => {
    const existing = db.db
      .prepare('SELECT * FROM sessions WHERE project_id = ? AND dsh_session_id = ?')
      .get(db.projectId, dshSessionId)
    const actives = db.db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND kind = 'pm' AND status = 'active'")
      .all(db.projectId)
    const at = nowIso()
    for (const row of actives) {
      if (existing && row.id === existing.id) continue
      db.db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(at, row.id)
      db.appendEvent({ kind: 'session/end', subjectType: 'session', subjectId: row.id, payload: { name: row.name, kind: 'pm', reason: 'pm switched' } })
    }
    if (existing) {
      db.db
        .prepare("UPDATE sessions SET status = 'active', kind = 'pm', name = ?, started_at = ?, ended_at = NULL WHERE id = ?")
        .run(name, at, existing.id)
      db.appendEvent({ kind: 'session/create', subjectType: 'session', subjectId: existing.id, payload: { name, kind: 'pm', dshSessionId, reason: 'pm rebound' } })
      sessionId = existing.id
      return
    }
    sessionId = newId('sess')
    db.db
      .prepare('INSERT INTO sessions(id, project_id, name, kind, role, slice_id, dsh_session_id, parent_session_id, provider, model, reasoning_effort, status, started_at, ended_at, handoff_id, context_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(sessionId, db.projectId, name, 'pm', 'PM', null, dshSessionId, null,
        input.provider ?? null, input.model ?? null, input.reasoningEffort ?? null,
        'active', at, null, null, jsonText({ source: 'project-workbench' }))
    db.appendEvent({ kind: 'session/create', subjectType: 'session', subjectId: sessionId, payload: { name, kind: 'pm', dshSessionId } })
  })
  const row = db.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
  return mapSessionRow(row)
}

export { mapSessionRow, mapDecisionRow, overview, listStages, currentStage, pmEnsure }
export { supersedePendingApprovals, assertApprovalStillCurrent }
