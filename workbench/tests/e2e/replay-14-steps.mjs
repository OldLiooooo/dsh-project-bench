#!/usr/bin/env node
// T5 verify · 14 步业务预演回放（架构 §7 / 契约 §11.2）。
// 不依赖 GUI：用 fake ctx + 真实 host 模块（registry/store/docs/leases/export/import/context/project/tools）
// 完整回放「需求 → PM → 产品/UX/架构/码农/测试 → 决策 → 门禁 → 导出 → 复盘」。
//
// 用法：
//   node workbench/tests/e2e/replay-14-steps.mjs [--strict] [--json]
//   --strict：模块缺失或 pending 视为失败（最终验收用）；默认缺失模块时以 SKIP 退出 0。
// 退出码：0 通过（或非 strict 下 pending）；1 断言失败（或 strict 下 pending）。
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import * as H from './harness.mjs'

const REQUIRED_MODULES = ['db', 'schema', 'util', 'defaults', 'store', 'docs', 'leases', 'export', 'import', 'registry', 'project']

const results = []
function record(step, title, status, detail) {
  results.push({ step, title, status, detail: detail === undefined ? '' : String(detail) })
  const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : status === 'fail' ? 'FAIL' : 'PEND'
  console.log(mark + '  [' + String(step).padStart(2) + '] ' + title + (detail ? '  — ' + String(detail).slice(0, 500) : ''))
}
async function step(number, title, fn) {
  try {
    const detail = await fn()
    record(number, title, 'pass', detail)
    return true
  } catch (error) {
    record(number, title, 'fail', (error && error.stack) || String(error))
    return false
  }
}

function toTokenCount(util, value) {
  if (typeof value === 'number') return value
  return util.estimateTokens(String(value === undefined ? '' : value))
}

function sliceField(slice, camel, snake, fallback) {
  if (!slice) return fallback
  if (slice[camel] !== undefined) return slice[camel]
  if (slice[snake] !== undefined) return slice[snake]
  return fallback
}

/** 三问可答：在做什么 / 依据什么 / 下一步。 */
export function answerThreeQuestions(host, db, sliceId) {
  const { store, docs } = host.modules
  const slice = store.getSlice(db, sliceId)
  if (!slice) throw new Error('三问失败：切片不存在 ' + sliceId)
  const stageRow = db.db.prepare("SELECT key, name FROM stages WHERE status = 'active' ORDER BY position LIMIT 1").get()
  const latestEvents = db.listEvents({ limit: 3, sliceId })
  const sliceDocs = docs.listDocuments(db, { sliceId })
  const decisions = store.listDecisions(db, { sliceId })
  const pending = decisions.filter((decision) => decision.status === 'pending')
  const doing = '在做什么：切片「' + slice.title + '」(' + slice.status + ')，阶段 ' + (stageRow ? stageRow.key + ' ' + stageRow.name : '未知')
  const basisDocs = sliceDocs.map((doc) => doc.title + '@v' + String(sliceField(doc, 'currentVersion', 'current_version', '?'))).join('、')
  const basisEvents = latestEvents.map((event) => event.kind).join('、')
  const basis = '依据：' + (basisDocs ? '文档 ' + basisDocs : '无文档') + (basisEvents ? '；最近事件 ' + basisEvents : '')
  const next = pending.length > 0
    ? '下一步：用户拍板「' + pending[0].title + '」（决策 ' + pending[0].id + '）'
    : '下一步：' + (sliceField(slice, 'currentHandoff', 'current_handoff', undefined) ? '按交接继续 ' + sliceField(slice, 'currentHandoff', 'current_handoff', '') : '派发下一角色任务')
  const answers = { doing, basis, next }
  for (const [key, value] of Object.entries(answers)) H.expect(value.length > 6, '三问「' + key + '」不可为空')
  return answers
}

function eventKinds(db) { return db.listEvents({ limit: 500 }).map((event) => event.kind) }

export function seqIsContinuous(events) {
  const seqs = events.map((event) => event.seq).sort((a, b) => a - b)
  for (let i = 0; i < seqs.length; i += 1) if (seqs[i] !== i + 1) return false
  return true
}

/** 模拟 http.js 的门禁动作（approve）：冻结文档 + 导出 + 阶段推进 + approvals 行 + 事件。 */
export function simulateGateApprove(host, db, input) {
  const { export: exportMod } = host.modules
  const util = host.modules.util
  const docsMod = host.modules.docs
  const frozen = []
  const exported = []
  for (const docId of input.docIds || []) {
    const doc = docsMod.getDocument(db, docId)
    if (!doc) continue
    docsMod.freezeDocument(db, { docId })
    frozen.push(docId)
  }
  for (const docId of input.docIds || []) {
    const doc = docsMod.getDocument(db, docId)
    if (!doc || typeof exportMod.exportDocument !== 'function') continue
    const written = exportMod.exportDocument(db, { docId, root: input.root, exportMap: input.exportMap })
    if (written && written.path) exported.push(written.path)
  }
  db.tx(() => {
    const at = new Date().toISOString()
    // 门禁通过：把当前阶段及之前所有未完成阶段置 done（并行 UX/架构阶段也在此收口），再激活下一阶段。
    db.db.prepare("UPDATE stages SET status = 'done', ended_at = COALESCE(ended_at, ?) WHERE position <= (SELECT position FROM stages WHERE key = ?) AND status != 'done'").run(at, input.stageKey)
    if (input.nextStageKey) db.db.prepare("UPDATE stages SET status = 'active', started_at = COALESCE(started_at, ?) WHERE key = ?").run(at, input.nextStageKey)
    const approvalId = 'ap-' + input.gate + '-' + util.sha256(String(input.decisionId)).slice(0, 8)
    db.db.prepare("INSERT OR REPLACE INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at) VALUES (?,?,?,?,?,'approved',?,?,?,?)")
      .run(approvalId, db.projectId, input.stageKey, input.gate, input.decisionId,
        JSON.stringify(input.evidenceIds || []), JSON.stringify({ frozen, exported }), input.approvedBy || 'user:owner', at)
    db.appendEvent({
      kind: 'gate/approve', actorSession: input.actorSession, role: 'PM', sliceId: input.sliceId || null,
      subjectType: 'gate', subjectId: input.gate,
      payload: { gate: input.gate, stage: input.stageKey, decisionId: input.decisionId, frozen, exported },
    })
    db.appendEvent({ kind: 'stage/change', actorSession: input.actorSession, role: 'PM', payload: { from: input.stageKey, to: input.nextStageKey || null, gate: input.gate } })
  })
  return { frozen, exported }
}

/**
 * 用户批准门禁：优先调用真实 project.resolveDecisionAction（与面板 POST /decision 同一实现），
 * 只有该 API 缺失时才回退到模拟门禁动作（早期模块未落地时的兼容路径）。
 */
function approveGate(host, ctx, db, input) {
  const project = host.modules.project
  if (project && typeof project.resolveDecisionAction === 'function') {
    const result = project.resolveDecisionAction(ctx, db, {
      id: input.decisionId,
      status: 'approved',
      decidedBy: input.decidedBy || 'user:owner',
      rationale: input.rationale || '用户批准',
      confirmed: true,
    }, { root: input.root, exportMap: input.exportMap })
    H.expect(result && result.decision && result.decision.status === 'approved', '决策应 approved')
    H.expect(result.actions && result.actions.approved === true, '门禁 approve 动作应执行')
    return result
  }
  const fallback = simulateGateApprove(host, db, input)
  return { decision: { status: 'approved' }, actions: { approved: true, frozenDocs: (fallback.frozen || []).map((docId) => ({ docId })), exports: (fallback.exported || []).map((p) => ({ path: p })), stage: { from: input.stageKey, to: input.nextStageKey } } }
}

function resolveDbAfterEnsure(ensured, registry, root) {
  if (ensured && typeof ensured.tx === 'function') return ensured
  if (ensured && ensured.db && typeof ensured.db.tx === 'function') return ensured.db
  const opened = registry.open && registry.open(root)
  if (opened) return opened
  return undefined
}

/** 主回放。options: {strict, json} */
export async function runReplay(options = {}) {
  results.length = 0
  const host = await H.loadHostModules()
  const missing = REQUIRED_MODULES.filter((name) => !host.modules[name])
  const fatalImportErrors = host.errors.filter((item) => REQUIRED_MODULES.includes(item.name))
  if (missing.length > 0 || fatalImportErrors.length > 0) {
    const reason = '待模块落地: ' + missing.join(',') + (fatalImportErrors.length ? '；导入失败: ' + fatalImportErrors.map((item) => item.name + ':' + String(item.error && item.error.message)).join('|') : '')
    console.log('SKIP  14 步预演 — ' + reason)
    H.cleanupTracked()
    const summary = { status: 'skip', reason, passed: 0, failed: 0, pending: 1, results: [] }
    return options.strict ? { ...summary, status: 'fail', failed: 1 } : summary
  }
  const util = host.modules.util
  const defaults = host.modules.defaults
  const store = host.modules.store
  const docs = host.modules.docs
  const leases = host.modules.leases
  const exportMod = host.modules.export
  const importMod = host.modules.import

  const root = H.makeTempProject('replay14')
  const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws-replay', path: root, title: '支付项目' }] })
  const registry = host.modules.registry.createRegistry(ctx)
  const bus = host.modules.bus ? host.modules.bus.createBus() : { emit() {}, subscribe() { return () => {} }, close() {} }
  let db
  try {
    const ensured = typeof registry.ensure === 'function' ? await registry.ensure(root, { name: '支付项目', workspaceId: 'ws-replay' }) : undefined
    db = resolveDbAfterEnsure(ensured, registry, root)
    if (!db) throw new Error('registry.ensure 未返回 ProjectDb')
    if (host.modules.project && typeof host.modules.project.initProject === 'function') {
      await host.modules.project.initProject(registry, { workspaceId: 'ws-replay' })
      db = resolveDbAfterEnsure(ensured, registry, root) || db
    }
  } catch (error) {
    console.error('FAIL  初始化项目失败: ' + String((error && error.stack) || error))
    H.cleanupTracked()
    return { status: 'fail', reason: String(error && error.message), passed: 0, failed: 1, pending: 0, results: [] }
  }

  let projectJson = {}
  try { projectJson = JSON.parse(readFileSync(join(root, '.project', 'project.json'), 'utf8')) } catch { /* 用默认映射 */ }
  const exportMap = projectJson.exportMap || defaults.defaultExportMap()
  const activeStage = () => db.db.prepare("SELECT key, name, gate FROM stages WHERE status = 'active' ORDER BY position LIMIT 1").get()

  const pmSession = store.createSession(db, { name: '项目办公室', kind: 'pm', role: 'PM', dshSessionId: 'dsh-pm-1', provider: 'deepseek-official', model: 'deepseek-flash', context: {} })
  const intentText = '支付要能退款'
  let prdSlice, uxSlice, archSlice, coreSlice, uiSlice, taskPrd, productSession
  let prdDoc, prdV1, gate1DecisionRef = { id: undefined }, uxSession, archSession
  let uxDocRef = { id: undefined }, adrDocRef = { id: undefined }
  let coderCore = { session: undefined, task: undefined }, coderUi = { session: undefined, task: undefined }, testSession

  // ---- 第 1 步：用户需求 → PM 记 intent，草拟切片 ----
  await step(1, '用户→PM 提需求「支付要能退款」；PM 记 intent + 草拟切片', async () => {
    db.tx(() => db.appendEvent({ kind: 'project/intent', actorSession: pmSession.id, role: 'PM', payload: { text: intentText, from: 'user' } }))
    prdSlice = store.createSlice(db, { type: 'workitem', key: 'payment-refund', title: '支付退款', acceptance: { criteria: ['用户可在订单页发起退款', '7 个工作日内到账'] } })
    H.expect(prdSlice && prdSlice.id, '草拟切片应创建')
    H.expect(eventKinds(db).includes('project/intent'), '应有 intent 事件')
    return 'slice=' + prdSlice.id
  })

  // ---- 第 2 步：PM 判断 S1，拆切片/任务，spawn 产品会话 ----
  const productName = '产品-payment-refund-prd-PRD'
  await step(2, 'PM 判断 S1；拆切片/任务；spawn 产品会话（命名 角色-切片-动作）', async () => {
    uxSlice = store.createSlice(db, { type: 'workitem', key: 'payment-refund-ux', title: '退款交互', acceptance: {} })
    archSlice = store.createSlice(db, { type: 'module', key: 'payment-refund-adr', title: '退款架构契约', acceptance: {} })
    coreSlice = store.createSlice(db, { type: 'module', key: 'payment-core', title: '支付核心', acceptance: {} })
    uiSlice = store.createSlice(db, { type: 'module', key: 'payment-ui', title: '退款 UI', acceptance: {} })
    taskPrd = store.createTask(db, { sliceId: prdSlice.id, title: '写退款 PRD', acceptance: { done: ['PRD v1', '用户批准'] } })
    H.expectEqual(activeStage().key, 'S1', '项目应从 S1 产品阶段开始')
    productSession = store.createSession(db, {
      name: productName, kind: 'task', role: '产品', sliceId: prdSlice.id, dshSessionId: 'dsh-product-1',
      provider: 'deepseek-official', model: 'deepseek-flash', context: { taskId: taskPrd.id },
    })
    H.expectEqual(productSession.status, 'active', '产品会话应 active')
    H.expectThrows(() => store.createSession(db, { name: '产品-payment-refund-prd-PRD2', kind: 'task', role: '产品', sliceId: prdSlice.id, dshSessionId: 'dsh-product-dup' }), 'DUPLICATE_ACTIVE_SESSION', '同切片同角色重复 spawn 应被拒')
    H.expectEqual(store.listSessions(db, { kind: 'task', status: 'active' }).length, 1, '同切片同角色仅一个 active 任务会话')
    return productSession.id
  })

  // ---- 第 3 步：产品会话装载 2k 简报，写 PRD v1 ----
  await step(3, '产品会话装载 2k 简报；写 PRD 文档 v1；登记调研证据', async () => {
    if (host.modules.context && typeof host.modules.context.compileContext === 'function') {
      const compiled = host.modules.context.compileContext(db, { roleKind: 'task', sessionId: productSession.id, role: '产品', sliceId: prdSlice.id, step: 1 })
      const used = toTokenCount(util, compiled.used !== undefined ? compiled.used : compiled.text)
      H.expect(used <= 2000, '2k 预算被突破: ' + String(used))
      H.expect(typeof compiled.text === 'string' && compiled.text.length > 0, '注入文本非空')
    }
    leases.acquireLease(db, { sliceId: prdSlice.id, sessionId: productSession.id, ttlMs: 30 * 60 * 1000, reason: '写 PRD' })
    leases.assertWriteScope(db, { sliceId: prdSlice.id, sessionId: productSession.id })
    prdDoc = docs.createDocument(db, { sliceId: prdSlice.id, type: 'prd', logicalKey: 'prd/payment-refund', title: '支付退款 PRD', stage: 'S1', ownerSession: productSession.id })
    prdV1 = docs.writeDocumentVersion(db, {
      docId: prdDoc.id, authorSession: productSession.id,
      content: '# 支付退款 PRD\n## 背景\n支付订单需要支持原路退款。\n## 范围\n仅退款，不含换货。\n## 时效\n7 个工作日内到账。\n## 幂等\n同一退款请求重复提交返回同一结果。',
    })
    H.expectEqual(prdV1.version.version, 1, 'PRD 应为 v1')
    store.addEvidence(db, { sliceId: prdSlice.id, taskId: taskPrd.id, kind: 'research', uri: 'docs/research/refund.md', resultSummary: '调研三家支付渠道退款时效（T+7）', createdBy: productSession.id })
    return 'prd v1'
  })

  // ---- 第 4 步：产品交 handoff；PM 校验；生成 G1 决策卡 ----
  await step(4, '产品交 handoff；PM 校验；生成 G1 门禁决策卡（pending）', async () => {
    const handoff = docs.createDocument(db, { sliceId: prdSlice.id, type: 'handoff', logicalKey: 'handoff/payment-refund-prod', title: '产品交接：支付退款', stage: 'S1', ownerSession: productSession.id })
    docs.writeDocumentVersion(db, { docId: handoff.id, content: '## 交接\nPRD v1 已就绪，等待用户批准 G1。\n## 风险\n退款渠道时效差异。', authorSession: productSession.id })
    store.updateTask(db, { id: taskPrd.id, status: 'review', assigneeSession: productSession.id })
    leases.releaseLease(db, { sliceId: prdSlice.id, sessionId: productSession.id })
    const gate = store.createDecision(db, {
      sliceId: prdSlice.id, kind: 'gate', title: 'G1：PRD 是否认可', question: '是否批准支付退款 PRD v1 进入 UX 阶段？',
      options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '驳回' }], recommended: 'approve',
      consequences: '驳回将退回产品重写 PRD（新版本 + 新决策）', irreversible: false, stage: 'S1', gate: 'G1', createdBy: pmSession.id,
    })
    gate1DecisionRef.id = gate.id
    H.expectEqual(gate.status, 'pending', 'G1 决策应 pending')
    H.expectEqual(store.listDecisions(db, { status: 'pending', sliceId: prdSlice.id }).length, 1, '决策收件箱应有 1 条')
    return 'decision=' + gate.id
  })

  // ---- 第 5 步：用户批准 PRD；冻结 + 导出；阶段 S1→S2 ----
  await step(5, '用户批准 PRD；冻结文档、导出 docs 快照、阶段 S1→S2', async () => {
    const result = approveGate(host, ctx, db, { decisionId: gate1DecisionRef.id, root, exportMap, rationale: 'PRD 认可' })
    const actions = result.actions
    H.expect(actions.frozenDocs.length >= 1, 'G1 应冻结相关文档')
    H.expect(actions.frozenDocs.some((doc) => doc.docId === prdDoc.id), 'G1 冻结集合应包含 PRD')
    H.expectEqual(actions.stage.to, 'S2', '门禁动作应报告阶段 S1→S2')
    H.expectEqual(activeStage().key, 'S2', '阶段应推进到 S2')
    const frozenRow = db.db.prepare('SELECT frozen FROM doc_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(prdDoc.id)
    H.expectEqual(Number(frozenRow.frozen), 1, 'PRD 最新版本应 frozen')
    H.expectThrows(() => docs.writeDocumentVersion(db, { docId: prdDoc.id, content: '# 改稿\n不应成功。', authorSession: productSession.id }), 'DOC_FROZEN', '冻结后拒绝改版')
    const exportRow = db.db.prepare('SELECT COUNT(*) AS c FROM exports').get()
    H.expect(Number(exportRow.c) >= 1, '应写 exports 行')
    H.expect(actions.exports.length >= 1, 'G1 应导出 PRD 到 docs/')
    return 'exported=' + String((actions.exports[0] && actions.exports[0].path) || '')
  })

  // ---- 第 6 步：PM 并行 spawn UX 与架构会话 ----
  await step(6, 'PM 并行 spawn UX 会话与架构会话', async () => {
    uxSession = store.createSession(db, { name: 'UX-payment-refund-ux-交互稿', kind: 'task', role: 'UX', sliceId: uxSlice.id, dshSessionId: 'dsh-ux-1', provider: 'grsai', model: 'gpt-6.1-sol' })
    archSession = store.createSession(db, { name: '架构-payment-refund-adr-ADR', kind: 'task', role: '架构', sliceId: archSlice.id, dshSessionId: 'dsh-arch-1', provider: 'deepseek-official', model: 'deepseek-flash' })
    H.expectEqual(store.listSessions(db, { kind: 'task', status: 'active' }).length, 3, '应有 产品/UX/架构 三个 active 任务会话')
    leases.acquireLease(db, { sliceId: uxSlice.id, sessionId: uxSession.id, ttlMs: 30 * 60 * 1000, reason: '写交互稿' })
    leases.acquireLease(db, { sliceId: archSlice.id, sessionId: archSession.id, ttlMs: 30 * 60 * 1000, reason: '写 ADR' })
    return 'sessions=' + [productSession.id, uxSession.id, archSession.id].join(',')
  })

  // ---- 第 7 步：UX/架构写文档与证据（版本链） ----
  let specDoc
  await step(7, 'UX 写交互稿（v1→v2）；架构写 ADR/接口规格；评审证据', async () => {
    uxDocRef.id = docs.createDocument(db, { sliceId: uxSlice.id, type: 'ux', logicalKey: 'ux/payment-refund', title: '退款交互稿', stage: 'S2', ownerSession: uxSession.id }).id
    docs.writeDocumentVersion(db, { docId: uxDocRef.id, content: '# 退款交互 v1\n订单详情页增加「申请退款」。', authorSession: uxSession.id })
    const uxV2 = docs.writeDocumentVersion(db, { docId: uxDocRef.id, content: '# 退款交互 v2\n订单详情页增加「申请退款」；补充退款原因选择与二次确认。', authorSession: uxSession.id })
    H.expectEqual(uxV2.version.version, 2, 'UX 文档应有 v2（版本链）')
    const adr = docs.createDocument(db, { sliceId: archSlice.id, type: 'adr', logicalKey: 'adr/payment-refund', title: '退款架构决策 ADR-001', stage: 'S3', ownerSession: archSession.id })
    adrDocRef.id = adr.id
    docs.writeDocumentVersion(db, { docId: adr.id, content: '# ADR-001 退款架构\n## 决策\n退款走支付网关异步回调，状态机 pending→refunded。\n## 幂等键\n订单号 + 退款请求号。', authorSession: archSession.id })
    specDoc = docs.createDocument(db, { sliceId: archSlice.id, type: 'spec', logicalKey: 'spec/refund-api', title: '退款接口规格', stage: 'S3', ownerSession: archSession.id })
    docs.writeDocumentVersion(db, { docId: specDoc.id, content: '# 退款接口\nPOST /refund {orderId, amount, reason} → {refundId, status}', authorSession: archSession.id })
    store.addEvidence(db, { sliceId: uxSlice.id, kind: 'review', resultSummary: '子 agent 评审：交互稿 v2 通过（3 条建议已采纳）', createdBy: uxSession.id })
    store.addEvidence(db, { sliceId: archSlice.id, kind: 'review', resultSummary: '子 agent 评审：ADR 与接口规格一致，无阻塞', createdBy: archSession.id })
    return 'ux v2 / adr v1 / spec v1'
  })

  // ---- 第 8 步：架构门禁 → 用户批准 → 进入实现 ----
  await step(8, '架构门禁 G3：用户批准；冻结 ADR/交互；阶段 S3→S4', async () => {
    const gate = store.createDecision(db, {
      sliceId: archSlice.id, kind: 'gate', title: 'G3：架构契约是否认可', question: 'ADR-001 与退款接口规格是否进入实现？',
      options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '驳回' }], recommended: 'approve',
      consequences: '驳回将退回架构重写 ADR', irreversible: false, stage: 'S3', gate: 'G3', createdBy: pmSession.id,
    })
    const g2 = store.createDecision(db, {
      sliceId: uxSlice.id, kind: 'gate', title: 'G2：交互稿是否认可', question: 'UX 交互稿 v2 是否进入架构门禁？',
      options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '驳回' }], recommended: 'approve',
      consequences: '驳回将退回 UX 返工', irreversible: false, stage: 'S2', gate: 'G2', createdBy: pmSession.id,
    })
    const g2Result = approveGate(host, ctx, db, { decisionId: g2.id, root, exportMap, rationale: '交互稿通过' })
    H.expectEqual(g2Result.actions.stage.to, 'S3', 'G2 应推进 S2→S3')
    const g3Result = approveGate(host, ctx, db, { decisionId: gate.id, root, exportMap, rationale: '架构通过' })
    H.expectEqual(g3Result.actions.stage.to, 'S4', 'G3 应推进 S3→S4')
    H.expectEqual(activeStage().key, 'S4', '阶段应推进到 S4 实现')
    H.expect(g2Result.actions.frozenDocs.length + g3Result.actions.frozenDocs.length >= 2, 'G2/G3 应冻结 UX 与 ADR 文档')
    H.expect(g3Result.actions.exports.length >= 1, '门禁应导出文档')
    leases.releaseLease(db, { sliceId: uxSlice.id, sessionId: uxSession.id })
    leases.releaseLease(db, { sliceId: archSlice.id, sessionId: archSession.id })
    store.endSession(db, { id: uxSession.id, status: 'done' })
    store.endSession(db, { id: archSession.id, status: 'done' })
    return 'frozen=' + String(g2Result.actions.frozenDocs.length + g3Result.actions.frozenDocs.length)
  })

  // ---- 第 9 步：PM 拆实现任务，spawn 码农会话（多切片）；lease 负向 ----
  await step(9, 'PM 拆实现任务；spawn 码农会话（多切片）；跨片 lease 冲突被拒', async () => {
    coderCore.task = store.createTask(db, { sliceId: coreSlice.id, title: '实现退款核心状态机', acceptance: { done: ['状态机代码', '单测通过'] } })
    coderUi.task = store.createTask(db, { sliceId: uiSlice.id, title: '实现退款 UI', acceptance: { done: ['交互稿验收', '组件测试'] } })
    coderCore.session = store.createSession(db, { name: '码农-payment-core-实现', kind: 'task', role: '码农', sliceId: coreSlice.id, dshSessionId: 'dsh-coder-core', provider: 'deepseek-official', model: 'deepseek-flash', context: { taskId: coderCore.task.id } })
    coderUi.session = store.createSession(db, { name: '码农-payment-ui-实现', kind: 'task', role: '码农', sliceId: uiSlice.id, dshSessionId: 'dsh-coder-ui', provider: 'deepseek-official', model: 'deepseek-flash', context: { taskId: coderUi.task.id } })
    leases.acquireLease(db, { sliceId: coreSlice.id, sessionId: coderCore.session.id, ttlMs: 60 * 60 * 1000, reason: '实现退款核心' })
    H.expectThrows(() => leases.acquireLease(db, { sliceId: coreSlice.id, sessionId: coderUi.session.id, ttlMs: 60000, reason: '抢核心片' }), 'LEASE_HELD', '跨会话抢同一片租约应被拒')
    leases.acquireLease(db, { sliceId: uiSlice.id, sessionId: coderUi.session.id, ttlMs: 60 * 60 * 1000, reason: '实现退款 UI' })
    return 'coders=' + [coderCore.session.id, coderUi.session.id].join(',')
  })

  // ---- 第 10 步：码农改代码、跑测试、写文档/证据；inbox 导入 ----
  await step(10, '码农改代码文件；证据/产物落库；交接；inbox 受控导入新版本', async () => {
    const codeDir = join(root, 'src', 'refund')
    H.ensureDir(codeDir)
    const code = "export function nextStatus(input) {\n  // pending -> refunded; 幂等键 orderId+requestId\n  return input.status === 'pending' ? 'refunded' : input.status\n}\n"
    writeFileSync(join(codeDir, 'state-machine.js'), code, 'utf8')
    store.addArtifact(db, { sliceId: coreSlice.id, kind: 'code', path: 'src/refund/state-machine.js', contentHash: util.sha256(code), bytes: code.length, metadata: { session: coderCore.session.id } })
    store.addEvidence(db, { sliceId: coreSlice.id, taskId: coderCore.task.id, kind: 'test', command: 'node --test src/refund', resultSummary: '8/8 通过；幂等用例覆盖重复请求', contentHash: util.sha256('8/8'), createdBy: coderCore.session.id })
    const implDoc = docs.createDocument(db, { sliceId: coreSlice.id, type: 'design', logicalKey: 'design/refund-state-machine', title: '退款状态机实现说明', stage: 'S4', ownerSession: coderCore.session.id })
    docs.writeDocumentVersion(db, { docId: implDoc.id, content: '# 退款状态机\n状态 pending → refunded；幂等键 orderId + requestId。', authorSession: coderCore.session.id })
    const coderHandoff = docs.createDocument(db, { sliceId: coreSlice.id, type: 'handoff', logicalKey: 'handoff/payment-core', title: '码农交接：支付核心', stage: 'S4', ownerSession: coderCore.session.id })
    docs.writeDocumentVersion(db, { docId: coderHandoff.id, content: '## 交接\n退款核心状态机完成，单测 8/8。\n## 片外改动\n无。', authorSession: coderCore.session.id })
    store.updateTask(db, { id: coderCore.task.id, status: 'done', assigneeSession: coderCore.session.id })
    leases.releaseLease(db, { sliceId: coreSlice.id, sessionId: coderCore.session.id })
    store.endSession(db, { id: coderCore.session.id, status: 'done' })
    // 外部工具产物经 .project/inbox 导入（导入到未冻结的实现说明文档，形成新版本）
    const inbox = join(root, '.project', 'inbox')
    H.ensureDir(inbox)
    const inboxFile = join(inbox, 'codex-impl-review.md')
    writeFileSync(inboxFile, '# 外部评审补充\nCodex 复核：幂等键建议加入 requestId。', 'utf8')
    const imported = importMod.importInboxFile(db, { sourcePath: inboxFile, docId: implDoc.id, importedBy: pmSession.id })
    H.expect(imported && imported.version && imported.version.version >= 2, 'inbox 导入应形成新版本')
    H.expect(eventKinds(db).includes('import/inbox'), '应记录 import/inbox 事件')
    return 'artifact+evidence+handoff+import'
  })

  // ---- 第 11 步：PM 收实现交接，spawn 测试会话 ----
  await step(11, 'PM 收实现交接；spawn 测试会话', async () => {
    const active = store.listSessions(db, { kind: 'task', status: 'active' })
    H.expect(!active.some((session) => session.id === coderCore.session.id), '码农会话应结束')
    const g4 = store.createDecision(db, {
      sliceId: coreSlice.id, kind: 'gate', title: 'G4：实现交接是否认可', question: '实现交接与单测证据是否进入测试阶段？',
      options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '退回' }], recommended: 'approve',
      consequences: '退回将让码农返工', irreversible: false, stage: 'S4', gate: 'G4', createdBy: pmSession.id,
    })
    const g4Result = approveGate(host, ctx, db, { decisionId: g4.id, root, exportMap, rationale: '实现交接完整' })
    H.expectEqual(g4Result.actions.stage.to, 'S5', 'G4 应推进 S4→S5')
    testSession = store.createSession(db, { name: '测试-payment-core-回归', kind: 'task', role: '测试', sliceId: coreSlice.id, dshSessionId: 'dsh-tester-1', provider: 'deepseek-official', model: 'deepseek-flash' })
    leases.acquireLease(db, { sliceId: coreSlice.id, sessionId: testSession.id, ttlMs: 60 * 60 * 1000, reason: '独立验证' })
    return testSession.id
  })

  // ---- 第 12 步：测试独立验证，写验收证据 ----
  await step(12, '测试会话独立验证；写验收证据与回归报告', async () => {
    store.addEvidence(db, { sliceId: coreSlice.id, kind: 'acceptance', command: 'node --test tests/refund', resultSummary: '独立回归 12/12 通过；覆盖幂等/超时/重复回调', createdBy: testSession.id })
    const report = docs.createDocument(db, { sliceId: coreSlice.id, type: 'report', logicalKey: 'report/refund-regression', title: '退款回归报告', stage: 'S5', ownerSession: testSession.id })
    docs.writeDocumentVersion(db, { docId: report.id, content: '# 回归报告\n12/12 通过。\n## 结论\n可进入验收门禁 G5。', authorSession: testSession.id })
    leases.releaseLease(db, { sliceId: coreSlice.id, sessionId: testSession.id })
    store.endSession(db, { id: testSession.id, status: 'done' })
    return 'report=' + report.id
  })

  // ---- 第 13 步：用户验收门禁 G5；阶段→发布 ----
  await step(13, '用户验收门禁：批准 G5；阶段 S5→S6 发布', async () => {
    const gate = store.createDecision(db, {
      sliceId: coreSlice.id, kind: 'gate', title: 'G5：验收结论是否认可', question: '回归报告与证据是否通过验收？',
      options: [{ id: 'approve', label: '验收' }, { id: 'reject', label: '拒收' }], recommended: 'approve',
      consequences: '拒收将开缺陷任务回实现', irreversible: false, stage: 'S5', gate: 'G5', createdBy: pmSession.id,
    })
    const result = approveGate(host, ctx, db, { decisionId: gate.id, root, exportMap, rationale: '验收通过' })
    H.expectEqual(result.actions.stage.to, 'S6', 'G5 应推进 S5→S6')
    H.expectEqual(activeStage().key, 'S6', '阶段应推进到 S6 发布')
    return 'S6'
  })

  // ---- 第 14 步：发布；导出快照；复盘 ----
  await step(14, 'PM 发布：G6 门禁 → 快照导出 + 复盘文档；时间线三问可答', async () => {
    const g6 = store.createDecision(db, {
      sliceId: coreSlice.id, kind: 'gate', title: 'G6：是否发布', question: '验收通过，是否发布并进入复盘？',
      options: [{ id: 'approve', label: '发布' }, { id: 'reject', label: '不发布' }], recommended: 'approve',
      consequences: '不发布则不导出快照', irreversible: false, stage: 'S6', gate: 'G6', createdBy: pmSession.id,
    })
    const g6Result = approveGate(host, ctx, db, { decisionId: g6.id, root, exportMap, rationale: '发布' })
    H.expectEqual(g6Result.actions.stage.to, 'S7', 'G6 应推进 S6→S7')
    exportMod.exportSnapshot(db, { root })
    H.expect(eventKinds(db).includes('export/snapshot'), '应记录 export/snapshot 事件')
    const retro = docs.createDocument(db, { sliceId: prdSlice.id, type: 'retro', logicalKey: 'retro/payment-refund', title: '支付退款复盘', stage: 'S7', ownerSession: pmSession.id })
    docs.writeDocumentVersion(db, { docId: retro.id, content: '# 复盘\n## 做得好\n门禁前置，返工少。\n## 改进\n退款渠道时效需要外部对接确认。', authorSession: pmSession.id })
    H.expectEqual(activeStage().key, 'S7', '发布后应进入 S7 复盘')
    const prdAnswers = answerThreeQuestions(host, db, prdSlice.id)
    const coreAnswers = answerThreeQuestions(host, db, coreSlice.id)
    H.expect(prdAnswers.next.length > 6 && coreAnswers.next.length > 6, '三问「下一步」可答')
    return JSON.stringify(coreAnswers).slice(0, 240)
  })

  // ---- 贯穿断言：事件/版本链/冻结/导出/恢复 ----
  await step(15, '贯穿检查：seq 连续、事件齐全、版本链/冻结/导出、重启后恢复', async () => {
    const events = db.listEvents({ limit: 500 })
    const seqs = events.map((event) => event.seq).sort((a, b) => a - b)
    const gaps = []
    for (let i = 0; i < seqs.length; i += 1) if (seqs[i] !== i + 1) gaps.push('期望 ' + String(i + 1) + ' 实际 ' + String(seqs[i]))
    H.expectEqual(gaps.length, 0, '事件 seq 空洞: ' + gaps.slice(0, 5).join('; '))
    H.expect(seqIsContinuous(events), '事件 seq 应连续无空洞')
    const kinds = eventKinds(db)
    for (const kind of ['slice/create', 'task/create', 'session/create', 'doc/create', 'doc/version', 'doc/freeze', 'decision/create', 'decision/resolve', 'gate/approve', 'stage/change', 'doc/export', 'evidence/add', 'artifact/add', 'lease/acquire', 'lease/release', 'export/snapshot', 'session/end', 'import/inbox']) {
      H.expect(kinds.includes(kind), '时间线缺事件 ' + kind)
    }
    const versions = docs.listDocVersions(db, uxDocRef.id).map((version) => version.version).sort((a, b) => a - b)
    H.expectDeepEqual(versions, [1, 2], 'UX 版本链应为 1,2')
    const frozenCount = db.db.prepare('SELECT COUNT(*) AS c FROM doc_versions WHERE frozen = 1').get().c
    H.expect(Number(frozenCount) >= 2, '门禁应冻结至少 2 个文档版本')
    const exportRows = db.db.prepare('SELECT COUNT(*) AS c FROM exports').get().c
    H.expect(Number(exportRows) >= 1, '导出表应有记录')
    H.expect(Number(db.db.prepare('SELECT COUNT(*) AS c FROM imports').get().c) >= 1, 'imports 表应有记录')
    // 导出可重生成：同一事件集下连导两次应字节一致（删目录后重建）
    exportMod.exportSnapshot(db, { root })
    const timelineFile = join(root, '.project', 'exports', 'timeline.md')
    const beforeExport = readFileSync(timelineFile, 'utf8')
    rmSync(join(root, '.project', 'exports'), { recursive: true, force: true })
    exportMod.exportSnapshot(db, { root })
    const afterExport = readFileSync(timelineFile, 'utf8')
    H.expectEqual(afterExport, beforeExport, '导出快照应可重生成且字节一致')
    return 'events=' + String(events.length)
  })

  // ---- 工具层抽检（orchestration 落地后） ----
  const toolsRegistered = (() => {
    if (!host.modules.tools || typeof host.modules.tools.registerTools !== 'function') return false
    try {
      const probeCtx = H.makeFakeCtx({ workspaces: [{ id: 'ws-replay', path: root, title: '支付项目' }] })
      host.modules.tools.registerTools(probeCtx, registry, bus)
      return probeCtx.state.tools.size > 0
    } catch (error) {
      return false
    }
  })()
  if (!toolsRegistered) {
    record(16, '工具层抽检：project_status / task_list / doc_get + 无代批决策工具', 'skip', 'host/tools/index.js 尚未注册任何工具（T4 编排层待落地）')
  } else {
    await step(16, '工具层抽检：project_status / task_list / doc_get + 无代批决策工具', async () => {
      const toolsCtx = H.makeFakeCtx({ workspaces: [{ id: 'ws-replay', path: root, title: '支付项目' }] })
      host.modules.tools.registerTools(toolsCtx, registry, bus)
      const names = [...toolsCtx.state.tools.keys()]
      H.expect(names.length > 0, '应注册项目工具')
      H.expect(!names.some((name) => /decision_resolve|decision_approve/i.test(name)), 'agent 不得拥有代批决策工具')
      const statusTool = toolsCtx.tool('project_status')
      H.expect(statusTool !== undefined, '应有 project_status 工具')
      const exec = H.makeExec({ dshSessionId: 'dsh-pm-1', cwd: root, agentPreset: 'project-office', label: 'pm' })
      const status = await statusTool.execute({}, exec)
      H.expect(status !== undefined && status !== null, 'project_status 应返回结果')
      return 'tools=' + String(names.length)
    })
  }

  // ---- 第 17 步：恢复（重启模拟）：关闭项目库后重开，revision/阶段/导出文件一致 ----
  await step(17, '恢复：关闭项目库后重开，revision/阶段/导出文件一致', async () => {
    const beforeRevision = db.revision()
    db.close()
    const reopened = new host.modules.db.ProjectDb(join(root, '.project', 'project.db'))
    try {
      H.expectEqual(reopened.revision(), beforeRevision, '重开 DB 后 revision 应一致')
      H.expectEqual(reopened.projectId, db.projectId, '重开后 projectId 应一致')
      const stageAfter = reopened.db.prepare("SELECT key FROM stages WHERE status = 'active'").get()
      H.expectEqual(stageAfter.key, 'S7', '重开后阶段应保持 S7')
      const timelineAfterRestart = readFileSync(join(root, '.project', 'exports', 'timeline.md'), 'utf8')
      H.expect(timelineAfterRestart.includes('# 项目时间线'), '重开后导出文件应可读')
      const frozenCount = reopened.db.prepare('SELECT COUNT(*) AS c FROM doc_versions WHERE frozen = 1').get().c
      H.expect(Number(frozenCount) >= 2, '重开后冻结版本仍在')
    } finally { reopened.close() }
    return 'revision=' + String(beforeRevision)
  })

  H.cleanupTracked()
  const failed = results.filter((item) => item.status === 'fail').length
  const pending = results.filter((item) => item.status === 'skip').length
  const passed = results.filter((item) => item.status === 'pass').length
  const summary = { passed, failed, pending, results: results.slice(), strict: Boolean(options.strict) }
  console.log('\n[replay-14-steps] passed=' + String(passed) + ' failed=' + String(failed) + ' pending=' + String(pending))
  console.log(failed > 0 ? 'RESULT: FAIL' : pending > 0 && options.strict ? 'RESULT: FAIL (strict, pending)' : 'RESULT: PASS')
  return summary
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--strict') options.strict = true
    else if (arg === '--json') options.json = true
  }
  return options
}

const entry = process.argv[1]
const isMain = Boolean(entry) && pathToFileURL(resolve(entry)).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  const summary = await runReplay(options)
  if (options.json) console.log(JSON.stringify({ passed: summary.passed, failed: summary.failed, pending: summary.pending, status: summary.status || undefined, results: summary.results }, null, 2))
  process.exitCode = summary.failed > 0 || (options.strict && summary.pending > 0) ? 1 : 0
}