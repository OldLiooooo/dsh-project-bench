// 项目编排（T2 host-api）：初始化、决策拍板（不可逆二次确认）与门禁动作（冻结+导出+阶段推进+approvals）。
// 所有写路径都在 db.tx 内并写事件；决策只能由人（面板 HTTP POST）拍板，agent 工具层不暴露 resolve。
import { randomUUID } from 'node:crypto'
import * as storeApi from './store.js'
import * as docsApi from './docs.js'
import * as exportApi from './export.js'
import { projectError } from './registry.js'
import { newId, nowIso, jsonText } from './util.js'
import { defaultExportMap } from './project-defaults.js'
import {
  overview, listStages, currentStage, pmEnsure,
  mapDecisionRow, mapSessionRow,
} from './snapshot.js'

const PM_SESSION_NAME = storeApi.PM_SESSION_NAME || '项目办公室'

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

/** 该 gate 相关的未冻结文档：按决策声明的 stage / slice 关联，避免误冻结无关文档。 */
function relatedDocuments(db, decision) {
  const clauses = []
  const params = [db.projectId]
  if (decision.stage) { clauses.push('stage = ?'); params.push(decision.stage) }
  if (decision.sliceId) { clauses.push('slice_id = ?'); params.push(decision.sliceId) }
  if (clauses.length === 0) return []
  return db.db
    .prepare("SELECT * FROM documents WHERE project_id = ? AND status != 'frozen' AND (" + clauses.join(' OR ') + ')')
    .all(...params)
}

/** 阶段推进：门禁阶段 done → 下一阶段 active，写 stage/change 事件。 */
function advanceStage(db, decision) {
  const stages = listStages(db)
  const from = (decision.stage ? stages.find((stage) => stage.key === decision.stage) : undefined)
    || stages.find((stage) => stage.status === 'active')
  if (!from) return null
  const index = stages.findIndex((stage) => stage.id === from.id)
  const next = index >= 0 ? (stages[index + 1] || null) : null
  const at = nowIso()
  db.db.prepare("UPDATE stages SET status = 'done', ended_at = ? WHERE id = ?").run(at, from.id)
  db.appendEvent({
    kind: 'stage/change',
    subjectType: 'stage',
    subjectId: from.key,
    payload: { from: from.key, to: next ? next.key : null, gate: decision.gate ?? from.gate ?? null, decisionId: decision.id, action: 'advance' },
  })
  if (next) {
    db.db.prepare("UPDATE stages SET status = 'active', started_at = ? WHERE id = ?").run(at, next.id)
    db.setMeta('stage.current', next.key)
  }
  return { gate: decision.gate ?? from.gate ?? null, from: from.key, to: next ? next.key : null }
}

/** approvals 行：gate_submit 已建 pending 则更新（并补 decision_id），否则补写。 */
function writeApproval(db, decision, options) {
  const at = nowIso()
  const payload = jsonText(options.payload ?? {})
  const evidence = jsonText(options.evidenceIds ?? [])
  let existing = db.db
    .prepare('SELECT id FROM approvals WHERE project_id = ? AND decision_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(db.projectId, decision.id)
  if (!existing) {
    existing = db.db
      .prepare("SELECT id FROM approvals WHERE project_id = ? AND status = 'pending' AND gate IS ? ORDER BY rowid DESC LIMIT 1")
      .get(db.projectId, decision.gate ?? null)
  }
  if (existing) {
    db.db
      .prepare('UPDATE approvals SET status = ?, approved_by = ?, approved_at = ?, snapshot_json = ?, decision_id = COALESCE(decision_id, ?) WHERE id = ?')
      .run(options.status, options.decidedBy ?? null, at, payload, decision.id, existing.id)
    return existing.id
  }
  const id = newId('appr')
  db.db
    .prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, db.projectId, decision.stage ?? null, decision.gate ?? null, decision.id, options.status, evidence, payload, options.decidedBy ?? null, at)
  return id
}

/** 门禁批准：冻结相关文档 → 导出 docs/ → 阶段推进 → approvals 行 → gate/approve 事件。 */
function applyGateApproval(db, decision, options) {
  const freezeDocument = requireFunction('docs.freezeDocument', docsApi.freezeDocument)
  const exportDocument = requireFunction('export.exportDocument', exportApi.exportDocument)
  const exportMap = options.exportMap && typeof options.exportMap === 'object' ? options.exportMap : defaultExportMap()
  const frozenDocs = []
  const exports = []
  for (const row of relatedDocuments(db, decision)) {
    const doc = docsApi.mapDocument(row) || row
    let frozen
    try {
      frozen = freezeDocument(db, { docId: doc.id, version: doc.currentVersion || undefined, actorSession: options.decidedBy })
    } catch (error) {
      if (error.code !== 'DOC_FROZEN') throw error
      frozen = docsApi.getDocument(db, doc.id) || doc
    }
    const version = Number(frozen?.currentVersion || doc.currentVersion || 0)
    frozenDocs.push({ docId: doc.id, type: doc.type, logicalKey: doc.logicalKey, version })
    if (options.root && version > 0) {
      const out = exportDocument(db, { docId: doc.id, version, root: options.root, exportMap })
      exports.push({ docId: doc.id, version, path: out?.relativePath ?? out?.path ?? null, hash: out?.hash ?? null })
    }
  }
  const stage = advanceStage(db, decision)
  const approvalId = writeApproval(db, decision, {
    status: 'approved',
    decidedBy: options.decidedBy,
    payload: { decisionId: decision.id, gate: decision.gate ?? null, stage, frozenDocIds: frozenDocs.map((doc) => doc.docId), exports, rationale: options.rationale ?? null },
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
      approvedBy: options.decidedBy ?? null,
      approvalId,
    },
  })
  return { approved: true, frozenDocs, exports, stage, approvalId }
}

/** 门禁驳回：不推进阶段，记录 gate/reject 事件并把 pending approval 置为 rejected。 */
function applyGateRejection(db, decision, options) {
  const approvalId = writeApproval(db, decision, {
    status: 'rejected',
    decidedBy: options.decidedBy,
    payload: { decisionId: decision.id, gate: decision.gate ?? null, rationale: options.rationale ?? null },
  })
  db.appendEvent({
    kind: 'gate/reject',
    subjectType: 'gate',
    subjectId: decision.gate ?? null,
    sliceId: decision.sliceId,
    payload: { decisionId: decision.id, gate: decision.gate ?? null, title: decision.title, rationale: options.rationale ?? null, rejectedBy: options.decidedBy ?? null, approvalId },
  })
  return { approved: false, rejected: true, approvalId }
}

function buildWakeText(decision, status, actions, rationale) {
  const suffix = rationale ? '；理由：' + rationale : ''
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
 * 决策拍板（人操作）：pending → approved/rejected。
 * - 不可逆决策批准必须 confirmed === true（二次确认），否则 409 CONFIRM_REQUIRED。
 * - kind='gate' 批准时执行门禁动作；驳回时只记事件/审批行。
 * - 落定后唤醒 PM 会话。
 */
export function resolveDecisionAction(ctx, db, input = {}, options = {}) {
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
  const decidedBy = typeof input.decidedBy === 'string' && input.decidedBy.trim() ? input.decidedBy.trim() : 'user'
  const rationale = typeof input.rationale === 'string' ? input.rationale : null
  let actions = null
  db.tx(() => {
    resolveDecision(db, { id, status, decidedBy, rationale, confirmed: input.confirmed === true })
    if (before.kind === 'gate') {
      actions = status === 'approved'
        ? applyGateApproval(db, before, { root: options.root, exportMap: options.exportMap, decidedBy, rationale })
        : applyGateRejection(db, before, { decidedBy, rationale })
    }
  })
  const decision = getDecision(db, id)
  const wake = wakePm(ctx, db, buildWakeText(decision || before, status, actions, rationale))
  return { decision, actions, wake, revision: db.revision() }
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
