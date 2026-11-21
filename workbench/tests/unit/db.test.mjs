// T1 db-core 单测：node:sqlite + 临时目录直跑，不依赖 DSH 实例。
// 运行：node --test workbench/tests/unit/db.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb, projectRootOf } from '../../host/db.js'
import * as store from '../../host/store.js'
import * as docs from '../../host/docs.js'
import * as leases from '../../host/leases.js'
import * as exporters from '../../host/export.js'
import * as importer from '../../host/import.js'
import * as schema from '../../host/schema.js'
import * as defaults from '../../host/project-defaults.js'
import * as registryMod from '../../host/registry.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const TMP_BASE = join(HERE, '.tmp')
try { rmSync(TMP_BASE, { recursive: true, force: true }) } catch (error) { /* 上次运行的 WAL 偶发占用，忽略 */ }
mkdirSync(TMP_BASE, { recursive: true })

let projectSeq = 0

function newProject() {
  projectSeq += 1
  const root = join(TMP_BASE, 'p' + projectSeq + '-' + Date.now())
  mkdirSync(root, { recursive: true })
  const db = new ProjectDb(join(root, '.project', 'project.db'), {
    projectId: 'proj-' + projectSeq,
    projectName: '测试项目-' + projectSeq,
    root: root,
  })
  return { root, db }
}

function withProject(fn) {
  const ctx = newProject()
  try {
    return fn(ctx)
  } finally {
    ctx.db.close()
  }
}

async function withProjectAsync(fn) {
  const ctx = newProject()
  try {
    return await fn(ctx)
  } finally {
    ctx.db.close()
  }
}

function expectCode(fn, code) {
  let caught
  try { fn() } catch (error) { caught = error }
  assert.ok(caught, '期望抛出错误（code=' + code + '）')
  assert.equal(caught.code, code, '期望 code=' + code + '，实际 ' + caught.code + '：' + caught.message)
  return caught
}

function eventSeqs(db) {
  return db.db.prepare('SELECT seq FROM events WHERE project_id = ? ORDER BY seq ASC').all(db.projectId).map(function (row) { return Number(row.seq) })
}

function assertContiguousSeqs(db) {
  const seqs = eventSeqs(db)
  assert.ok(seqs.length > 0, '应至少有 1 条事件')
  for (let i = 0; i < seqs.length; i += 1) assert.equal(seqs[i], i + 1, '事件 seq 必须从 1 连续无空洞（位置 ' + i + '）')
  assert.equal(db.revision(), seqs.length, 'revision 应等于最大 seq')
}

after(function () {
  try { rmSync(TMP_BASE, { recursive: true, force: true }) } catch (error) { /* Windows 文件占用时忽略，不影响断言 */ }
})

// ---------------------------------------------------------------------------
// 事件 / 事务
// ---------------------------------------------------------------------------

test('事件 seq 连续无空洞；失败的写不产生事件', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'payment-refund', title: '支付退款' })
    const task = store.createTask(db, { sliceId: slice.id, title: '写 PRD', acceptance: { done: false } })
    store.updateTask(db, { id: task.id, status: 'in_progress' })
    const pm = store.createSession(db, { kind: 'pm', dshSessionId: 'dsh-pm' })
    const session = store.createSession(db, { kind: 'task', name: '产品-payment-refund-起草PRD', role: '产品', sliceId: slice.id })
    store.endSession(db, { id: session.id, status: 'done' })
    const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/payment-refund', title: '退款 PRD' })
    docs.writeDocumentVersion(db, { docId: doc.id, content: '# 背景\n退款。', authorSession: session.id })
    docs.freezeDocument(db, { docId: doc.id })
    store.addEvidence(db, { sliceId: slice.id, kind: 'test', resultSummary: '通过' })
    store.addArtifact(db, { sliceId: slice.id, kind: 'code', path: 'src/refund.ts' })
    leases.acquireLease(db, { sliceId: slice.id, sessionId: session.id, ttlMs: 60000, reason: '写 PRD' })
    leases.releaseLease(db, { sliceId: slice.id, sessionId: session.id })

    assertContiguousSeqs(db)
    const kinds = db.listEvents({ limit: 500 }).map(function (event) { return event.kind })
    for (const kind of ['slice/create', 'task/create', 'task/status', 'session/create', 'session/end',
      'doc/create', 'doc/version', 'doc/freeze', 'evidence/add', 'artifact/add', 'lease/acquire', 'lease/release']) {
      assert.ok(kinds.indexOf(kind) >= 0, '缺少事件 kind=' + kind)
    }

    // 事务回滚：失败的写不应留下事件或数据。
    const revisionBefore = db.revision()
    expectCode(function () { store.createTask(db, { sliceId: 'slice-missing', title: 'x' }) }, 'NOT_FOUND')
    expectCode(function () { docs.writeDocumentVersion(db, { docId: doc.id, content: '# 冻结后覆盖' }) }, 'DOC_FROZEN')
    assert.equal(db.revision(), revisionBefore, '失败写不得产生事件')
    assert.equal(store.listTasks(db, { sliceId: 'slice-missing' }).length, 0)

    // PM 会话按合同固定命名。
    assert.equal(pm.name, '项目办公室')
    const live = store.listSessions(db, { status: 'active' })
    assert.equal(live.length, 1)
    assert.equal(live[0].kind, 'pm')
  })
})

// ---------------------------------------------------------------------------
// 文档版本
// ---------------------------------------------------------------------------

test('文档版本只增、旧版本不可变、同 hash 幂等', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'refund', title: '退款' })
    const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/refund', title: '退款 PRD' })
    assert.equal(doc.currentVersion, 0)

    const first = docs.writeDocumentVersion(db, { docId: doc.id, content: '# 背景\n退款需求。' })
    assert.equal(first.version.version, 1)
    assert.equal(first.created, true)
    assert.equal(first.doc.currentVersion, 1)

    const sameHash = docs.writeDocumentVersion(db, { docId: doc.id, content: '# 背景\n退款需求。' })
    assert.equal(sameHash.created, false, '同内容 hash 应幂等')
    assert.equal(sameHash.version.version, 1)
    assert.equal(docs.listDocVersions(db, doc.id).length, 1)

    const second = docs.writeDocumentVersion(db, { docId: doc.id, content: '# 背景\n退款需求。\n\n## 方案\n幂等键。' })
    assert.equal(second.version.version, 2)
    assert.equal(second.doc.currentVersion, 2)

    // 旧版本内容不随新版本变化。
    assert.equal(docs.getDocVersion(db, doc.id, 1).content, '# 背景\n退款需求。')
    const versions = docs.listDocVersions(db, doc.id)
    assert.deepEqual(versions.map(function (version) { return version.version }), [1, 2])
    assert.ok(versions[0].contentHash)
    assert.equal(versions[0].content, undefined, '版本列表不返回全文')
    assert.equal(docs.getDocVersion(db, doc.id, 99), undefined)

    // 写接口不应暴露任何修改旧版本内容的函数。
    const mutators = Object.keys(docs).filter(function (name) {
      return /update|delete|edit|overwrite/i.test(name)
    })
    assert.deepEqual(mutators, [], 'docs 模块不得暴露修改旧版本的写接口：' + mutators.join(','))
  })
})

test('冻结文档拒绝写新版本（DOC_FROZEN），冻结幂等且写 doc/freeze 事件', function () {
  withProject(function ({ db }) {
    const doc = docs.createDocument(db, { type: 'adr', logicalKey: 'adr/refund', title: '退款 ADR' })
    docs.writeDocumentVersion(db, { docId: doc.id, content: '# 决策\n采用幂等键。' })
    const frozen = docs.freezeDocument(db, { docId: doc.id })
    assert.equal(frozen.status, 'frozen')
    assert.equal(frozen.frozen, true)
    assert.equal(docs.getDocVersion(db, doc.id, 1).frozen, true)

    const revisionAfterFreeze = db.revision()
    expectCode(function () { docs.writeDocumentVersion(db, { docId: doc.id, content: '# 决策\n改主意了。' }) }, 'DOC_FROZEN')
    expectCode(function () { docs.writeDocumentVersion(db, { docId: doc.id, content: '# 决策\n采用幂等键。' }) }, 'DOC_FROZEN')
    assert.equal(db.revision(), revisionAfterFreeze)

    // 幂等冻结：不再写事件。
    const refrozen = docs.freezeDocument(db, { docId: doc.id })
    assert.equal(refrozen.status, 'frozen')
    assert.equal(db.revision(), revisionAfterFreeze)
    assert.ok(store.timeline(db, { kinds: ['doc/freeze'], limit: 10 }).some(function (event) { return event.subjectId === doc.id }))
  })
})

// ---------------------------------------------------------------------------
// 检索（doc_sections 派生 + doc_fts trigram + 两字 LIKE 兜底）
// ---------------------------------------------------------------------------

const PRD_CONTENT = [
  '# 背景',
  '',
  '支付退款能力是支付系统的常见需求，用户可能因为各种原因要求退款。',
  '',
  '## 目标',
  '',
  '支持全额退款与部分退款，退款流程必须幂等，避免重复退款。',
  '',
  '## 约束',
  '',
  '退款金额不能超过原订单金额，并且每笔退款都要写入审计日志。',
].join('\n')

test('章节检索：trigram 命中返回片段、两字词 LIKE 兜底、切片过滤、派生可重建', function () {
  withProject(function ({ db }) {
    const sliceA = store.createSlice(db, { key: 'refund-a', title: '退款 A' })
    const sliceB = store.createSlice(db, { key: 'refund-b', title: '退款 B' })
    const docA = docs.createDocument(db, { sliceId: sliceA.id, type: 'prd', logicalKey: 'prd/refund-a', title: '退款 PRD A' })
    docs.writeDocumentVersion(db, { docId: docA.id, content: PRD_CONTENT })
    const docB = docs.createDocument(db, { sliceId: sliceB.id, type: 'report', logicalKey: 'report/refund-b', title: '退款报告 B' })
    docs.writeDocumentVersion(db, { docId: docB.id, content: '# 报告\n退款复盘与审计日志。' })

    const ftsHits = docs.searchDocSections(db, { query: '支付退款' })
    assert.ok(ftsHits.length >= 1, 'trigram 检索应命中：' + JSON.stringify(ftsHits))
    const hit = ftsHits[0]
    assert.equal(hit.documentId, docA.id)
    assert.ok(hit.heading && hit.heading.length > 0)
    assert.ok(hit.snippet.includes('支付退款') || hit.snippet.includes('退款'), '片段应包含命中词')
    assert.ok(hit.snippet.length < PRD_CONTENT.length, '只返回片段，不返回全文')
    assert.equal(hit.content, undefined, '检索结果不得包含全文')
    assert.equal(typeof hit.score, 'number')

    const likeHits = docs.searchDocSections(db, { query: '退款' })
    assert.ok(likeHits.length >= 1, '两字中文词应走 LIKE 兜底命中')

    const sliceHits = docs.searchDocSections(db, { query: '退款', sliceId: sliceA.id })
    assert.ok(sliceHits.length >= 1)
    assert.ok(sliceHits.every(function (item) { return item.documentId === docA.id }), '切片过滤应生效')

    assert.deepEqual(docs.searchDocSections(db, { query: '完全不存在的词' }), [])
    assert.deepEqual(docs.searchDocSections(db, { query: '   ' }), [])

    // doc_sections 是从最新版本派生的，可重复重建。
    const before = db.db.prepare('SELECT COUNT(*) AS n FROM doc_sections WHERE document_id = ?').get(docA.id).n
    const rebuilt = docs.rebuildDocSections(db, docA.id)
    const after = db.db.prepare('SELECT COUNT(*) AS n FROM doc_sections WHERE document_id = ?').get(docA.id).n
    assert.equal(before, after)
    assert.equal(rebuilt.sections, after)
    assert.ok(docs.searchDocSections(db, { query: '审计日志' }).some(function (item) { return item.documentId === docA.id }))

    // 新版本后派生层只保留最新版。
    docs.writeDocumentVersion(db, { docId: docA.id, content: '# 背景\n旧目标已删。\n\n## 新目标\n支持全额退款。' })
    assert.deepEqual(docs.searchDocSections(db, { query: '审计日志' }).filter(function (item) { return item.documentId === docA.id }), [])
    assert.ok(docs.searchDocSections(db, { query: '新目标' }).some(function (item) { return item.documentId === docA.id }))
  })
})

// ---------------------------------------------------------------------------
// 租约
// ---------------------------------------------------------------------------

test('租约：他人持租拒绝、同会话续期、释放校验', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'lease', title: '租约切片' })
    const sessionA = store.createSession(db, { kind: 'task', name: '码农-lease-实现', role: '码农', sliceId: slice.id })
    const sessionB = store.createSession(db, { kind: 'task', name: '测试-lease-验收', role: '测试', sliceId: slice.id })

    const first = leases.acquireLease(db, { sliceId: slice.id, sessionId: sessionA.id, ttlMs: 60000, reason: '实现' })
    assert.equal(first.sessionId, sessionA.id)

    const held = expectCode(function () {
      leases.acquireLease(db, { sliceId: slice.id, sessionId: sessionB.id, ttlMs: 60000 })
    }, 'LEASE_HELD')
    assert.equal(held.details.holder, sessionA.id)

    const renewed = leases.acquireLease(db, { sliceId: slice.id, sessionId: sessionA.id, ttlMs: 120000 })
    assert.equal(renewed.sessionId, sessionA.id)
    assert.ok(Date.parse(renewed.expiresAt) >= Date.parse(first.expiresAt), '同会话续期应延长到期时间')
    assert.equal(leases.checkLease(db, { sliceId: slice.id, sessionId: sessionA.id }).ok, true)
    assert.equal(leases.checkLease(db, { sliceId: slice.id, sessionId: sessionB.id }).ok, false, '非持租者不应视为持有有效租约')

    expectCode(function () {
      leases.releaseLease(db, { sliceId: slice.id, sessionId: sessionB.id })
    }, 'LEASE_HELD')
    assert.equal(leases.releaseLease(db, { sliceId: slice.id, sessionId: sessionA.id }).released, true)
    assert.equal(leases.checkLease(db, { sliceId: slice.id, sessionId: sessionB.id }).ok, false, '无租约时不应视为持有租约')
    assert.equal(leases.releaseLease(db, { sliceId: slice.id, sessionId: sessionA.id }).released, false, '重复释放应幂等')

    // PM 不受租约限制。
    const pm = store.createSession(db, { kind: 'pm' })
    leases.acquireLease(db, { sliceId: slice.id, sessionId: sessionA.id, ttlMs: 60000 })
    assert.equal(leases.assertWriteScope(db, { sliceId: slice.id, sessionId: pm.id }).ok, true)
    const blocked = expectCode(function () {
      leases.assertWriteScope(db, { sliceId: slice.id, sessionId: sessionB.id })
    }, 'LEASE_HELD')
    assert.equal(blocked.details.sliceId, slice.id)
  })
})

test('过期租约可抢占', async function () {
  await withProjectAsync(async function ({ db }) {
    const slice = store.createSlice(db, { key: 'expire', title: '过期租约' })
    const sessionA = store.createSession(db, { kind: 'task', name: '码农-expire-实现', role: '码农', sliceId: slice.id })
    const sessionB = store.createSession(db, { kind: 'task', name: '测试-expire-验收', role: '测试', sliceId: slice.id })
    leases.acquireLease(db, { sliceId: slice.id, sessionId: sessionA.id, ttlMs: 25 })
    await new Promise(function (resolve) { setTimeout(resolve, 60) })
    assert.equal(leases.checkLease(db, { sliceId: slice.id, sessionId: sessionA.id }).expired, true)
    assert.equal(leases.checkLease(db, { sliceId: slice.id, sessionId: sessionA.id }).ok, false, '过期租约不应视为有效')
    const takeover = leases.acquireLease(db, { sliceId: slice.id, sessionId: sessionB.id, ttlMs: 60000 })
    assert.equal(takeover.sessionId, sessionB.id)
    assert.equal(leases.checkLease(db, { sliceId: slice.id, sessionId: sessionA.id }).ok, false)
    expectCode(function () { leases.assertWriteScope(db, { sliceId: slice.id, sessionId: sessionA.id }) }, 'LEASE_HELD')
    assert.equal(leases.assertWriteScope(db, { sliceId: slice.id, sessionId: sessionB.id }).ok, true)
    const events = store.timeline(db, { kinds: ['lease/acquire'], limit: 20 })
    assert.ok(events.some(function (event) { return event.payload.previousHolder === sessionA.id }), '抢占应记录 previousHolder')
  })
})

// ---------------------------------------------------------------------------
// 会话命名 / 唯一性
// ---------------------------------------------------------------------------

test('任务会话命名=角色-切片-动作、同切片同角色 active 唯一、PM 唯一', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'payment-refund', title: '支付退款' })

    expectCode(function () {
      store.createSession(db, { kind: 'task', name: '产品-起草PRD', role: '产品', sliceId: slice.id })
    }, 'INVALID')
    expectCode(function () {
      store.createSession(db, { kind: 'task', name: '产品-other-起草', role: '产品', sliceId: slice.id })
    }, 'INVALID')
    expectCode(function () {
      store.createSession(db, { kind: 'task', name: '码农-payment-refund-实现', role: '产品', sliceId: slice.id })
    }, 'INVALID')
    expectCode(function () {
      store.createSession(db, { kind: 'task', name: '产品-payment-refund-起草', role: '产品', sliceId: 'slice-missing' })
    }, 'NOT_FOUND')

    const product = store.createSession(db, { kind: 'task', name: '产品-payment-refund-起草PRD', role: '产品', sliceId: slice.id, dshSessionId: 'dsh-1', provider: 'spawn', model: 'deepseek-flash' })
    assert.equal(product.name, '产品-payment-refund-起草PRD')
    assert.equal(product.role, '产品')
    expectCode(function () {
      store.createSession(db, { kind: 'task', name: '产品-payment-refund-复审', role: '产品', sliceId: slice.id })
    }, 'DUPLICATE_ACTIVE_SESSION')
    // 名称匹配但角色不同 -> 允许（不同角色并行）
    const tester = store.createSession(db, { kind: 'task', name: '测试-payment-refund-验收', role: '测试', sliceId: slice.id })
    assert.equal(tester.role, '测试')

    assert.equal(store.findSessionByDshId(db, 'dsh-1').id, product.id)
    assert.equal(store.findSessionByDshId(db, 'dsh-none'), undefined)

    // 元数据更新不产生事件噪音。
    const revisionBefore = db.revision()
    const updated = store.updateSession(db, { id: product.id, model: 'gpt-x', provider: 'openai' })
    assert.equal(updated.model, 'gpt-x')
    assert.equal(db.revision(), revisionBefore)

    // 结束会话后可重新创建同角色同切片会话。
    store.endSession(db, { id: product.id, status: 'done', handoffId: 'doc-handoff' })
    const again = store.createSession(db, { kind: 'task', name: '产品-payment-refund-复审', role: '产品', sliceId: slice.id })
    assert.equal(again.status, 'active')
    expectCode(function () { store.endSession(db, { id: again.id, status: 'weird' }) }, 'INVALID')
    const endedTwice = store.endSession(db, { id: product.id, status: 'done' })
    assert.equal(endedTwice.status, 'done')
    assert.equal(endedTwice.handoffId, 'doc-handoff')

    // PM 唯一且名字固定。
    const pm = store.createSession(db, { name: '随便写的名字', kind: 'pm' })
    assert.equal(pm.name, '项目办公室')
    expectCode(function () { store.createSession(db, { kind: 'pm' }) }, 'DUPLICATE_ACTIVE_SESSION')

    assert.equal(store.listSessions(db, { kind: 'pm' }).length, 1)
    assert.equal(store.listSessions(db, { status: 'active' }).length, 3)
  })
})

// ---------------------------------------------------------------------------
// 决策
// ---------------------------------------------------------------------------

test('不可逆决策必须人批准并二次确认', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'gate', title: '门禁' })
    const decision = store.createDecision(db, {
      sliceId: slice.id,
      kind: 'gate',
      title: '是否进入发布阶段',
      question: '发布不可回滚，是否批准？',
      options: ['批准', '驳回'],
      recommended: '批准',
      consequences: '驳回则返工',
      irreversible: true,
      stage: 'S6',
      gate: 'G6',
    })
    assert.equal(decision.status, 'pending')
    assert.equal(decision.irreversible, true)

    expectCode(function () {
      store.resolveDecision(db, { id: decision.id, status: 'approved', decidedBy: 'user' })
    }, 'INVALID')
    expectCode(function () {
      store.resolveDecision(db, { id: decision.id, status: 'approved', decidedBy: '', confirmed: true })
    }, 'INVALID')
    expectCode(function () {
      store.resolveDecision(db, { id: decision.id, status: 'maybe', decidedBy: 'user', confirmed: true })
    }, 'INVALID')

    const approved = store.resolveDecision(db, { id: decision.id, status: 'approved', decidedBy: 'user', rationale: '同意发布', confirmed: true })
    assert.equal(approved.status, 'approved')
    assert.equal(approved.decidedBy, 'user')
    assert.ok(approved.decidedAt)
    expectCode(function () {
      store.resolveDecision(db, { id: decision.id, status: 'rejected', decidedBy: 'user', confirmed: true })
    }, 'INVALID')
    assert.equal(store.listDecisions(db, { status: 'pending' }).length, 0)

    const normal = store.createDecision(db, { title: '普通决策', question: '选 A 还是 B', options: ['A', 'B'] })
    assert.equal(store.resolveDecision(db, { id: normal.id, status: 'rejected', decidedBy: 'user' }).status, 'rejected')
    const resolveEvent = store.timeline(db, { kinds: ['decision/resolve'], limit: 10 })[0]
    assert.equal(resolveEvent.subjectId, normal.id)
  })
})

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

test('导出：exportMap 决定 docs/ 路径、generated 标记、可重生成、exports 行与事件', function () {
  withProject(function ({ db, root }) {
    const slice = store.createSlice(db, { key: 'public-api', title: '公开 API' })
    const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/public-api', title: '公开 API PRD' })
    docs.writeDocumentVersion(db, { docId: doc.id, content: '# 背景\n对外 API 需要稳定。' })
    docs.writeDocumentVersion(db, { docId: doc.id, content: '# 背景\n对外 API 需要稳定。\n\n## 契约\n使用 OpenAPI 描述。' })
    docs.freezeDocument(db, { docId: doc.id })

    const exported = exporters.exportDocument(db, { docId: doc.id, root: root, exportMap: { prd: 'product' } })
    assert.equal(exported.relativePath, 'docs/product/prd-public-api.md')
    assert.ok(existsSync(exported.path), '导出文件应存在')
    const content = readFileSync(exported.path, 'utf8')
    assert.ok(content.includes('generated'), '导出文件必须带 generated 标记')
    assert.ok(content.includes('使用 OpenAPI 描述。'), '导出文件应包含当前版本正文')
    assert.ok(content.includes('version: 2'), '导出文件应标注版本号')

    const exportedAgain = exporters.exportDocument(db, { docId: doc.id, root: root, exportMap: { prd: 'product' } })
    assert.equal(exportedAgain.hash, exported.hash, '同版本重复导出应可重生成（hash 稳定）')
    assert.equal(readFileSync(exportedAgain.path, 'utf8'), content)

    // 指定旧版本导出，覆盖同一路径但 hash 不同。
    const oldExport = exporters.exportDocument(db, { docId: doc.id, version: 1, root: root, exportMap: { prd: 'product' } })
    assert.notEqual(oldExport.hash, exported.hash)
    assert.ok(readFileSync(oldExport.path, 'utf8').includes('使用 OpenAPI 描述。') === false)

    // exports 行 + doc/export 事件。
    const exportRows = db.db.prepare('SELECT * FROM exports WHERE kind = ? ORDER BY exported_at ASC, rowid ASC').all('document')
    assert.equal(exportRows.length, 3)
    assert.equal(Number(exportRows[0].version), 2)
    assert.equal(Number(exportRows[1].version), 2)
    assert.equal(Number(exportRows[2].version), 1)
    assert.equal(exportRows[0].path, 'docs/product/prd-public-api.md')
    assert.equal(db.listEvents({ kinds: ['doc/export'], limit: 10 }).length, 3)

    // root 省略时从 db.root 推导。
    const viaDbRoot = exporters.exportDocument(db, { docId: doc.id })
    assert.equal(viaDbRoot.relativePath, 'docs/product/prd-public-api.md')

    expectCode(function () { exporters.exportDocument(db, { docId: 'doc-missing', root: root }) }, 'NOT_FOUND')
    const empty = docs.createDocument(db, { type: 'report', logicalKey: 'report/empty', title: '空文档' })
    expectCode(function () { exporters.exportDocument(db, { docId: empty.id, root: root }) }, 'NOT_FOUND')
  })
})

test('导出：时间线/快照可重生成、快照全量且清理陈旧文件', function () {
  withProject(function ({ db, root }) {
    const slice = store.createSlice(db, { key: 'snap', title: '快照切片' })
    const doc1 = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/snap', title: '快照 PRD' })
    docs.writeDocumentVersion(db, { docId: doc1.id, content: '# PRD\n快照内容。' })
    const doc2 = docs.createDocument(db, { sliceId: slice.id, type: 'adr', logicalKey: 'adr/snap', title: '快照 ADR' })
    docs.writeDocumentVersion(db, { docId: doc2.id, content: '# ADR\n架构决策。' })
    const emptyDoc = docs.createDocument(db, { type: 'spec', logicalKey: 'spec/empty', title: '无版本' })

    const timeline1 = exporters.exportTimeline(db, { root: root })
    const timeline2 = exporters.exportTimeline(db, { root: root })
    assert.equal(timeline1.relativePath, '.project/exports/timeline.md')
    assert.equal(timeline1.hash, timeline2.hash, '时间线导出应对同一项目状态可重生成')
    const timelineText = readFileSync(timeline1.path, 'utf8')
    assert.ok(timelineText.includes('generated'))
    assert.ok(timelineText.includes('测试项目-'))
    assert.ok(timelineText.includes('doc/version'))
    assert.ok(db.listEvents({ kinds: ['export/snapshot'], limit: 10 }).length >= 2)

    const snapshot1 = exporters.exportSnapshot(db, { root: root })
    assert.equal(snapshot1.count, 2, '无版本的空文档不进入快照')
    assert.ok(snapshot1.documents.every(function (item) { return existsSync(item.path) }))
    assert.ok(existsSync(snapshot1.timeline.path))
    assert.equal(snapshot1.documents[0].relativePath.indexOf('.project/exports/docs/'), 0)

    // 陈旧文件应在重生成时被清理。
    const stale = join(root, '.project', 'exports', 'docs', 'stale.md')
    writeFileSync(stale, 'stale', 'utf8')
    assert.ok(existsSync(stale))
    const snapshot2 = exporters.exportSnapshot(db, { root: root })
    assert.equal(existsSync(stale), false, '全量快照应清理陈旧文件')
    assert.deepEqual(
      snapshot1.documents.map(function (item) { return item.hash }),
      snapshot2.documents.map(function (item) { return item.hash }),
      '快照可重生成（hash 稳定）'
    )
    assert.equal(snapshot1.timeline.hash, snapshot2.timeline.hash)
    assert.equal(emptyDoc.currentVersion, 0)
  })
})

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

test('导入 inbox 文件为新版本、同内容幂等、只允许 inbox 目录', function () {
  withProject(function ({ db, root }) {
    const slice = store.createSlice(db, { key: 'inbox', title: '导入切片' })
    const doc = docs.createDocument(db, { sliceId: slice.id, type: 'report', logicalKey: 'report/qa', title: '验收报告' })
    docs.writeDocumentVersion(db, { docId: doc.id, content: '# 验收 v1\n第一轮全部通过。' })
    const inboxDir = join(root, '.project', 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    const inboxFile = join(inboxDir, 'qa-round2.md')
    writeFileSync(inboxFile, '# 验收 v2\n第二轮：补充退款用例，全部通过。\n', 'utf8')

    const imported = importer.importInboxFile(db, { sourcePath: 'qa-round2.md', docId: doc.id, importedBy: 'session-qa' })
    assert.equal(imported.created, true)
    assert.equal(imported.version.version, 2)
    assert.ok(imported.version.content.includes('第二轮'))
    assert.equal(imported.sourcePath, '.project/inbox/qa-round2.md')

    const importsRows = db.db.prepare('SELECT * FROM imports WHERE document_id = ? ORDER BY imported_at ASC, rowid ASC').all(doc.id)
    assert.equal(importsRows.length, 1)
    assert.equal(importsRows[0].source_path, '.project/inbox/qa-round2.md')
    assert.equal(importsRows[0].content_hash, imported.contentHash)
    assert.equal(Number(importsRows[0].version), 2)
    assert.equal(db.listEvents({ kinds: ['import/inbox'], limit: 10 }).length, 1)

    // 同内容再次导入：不新增版本，但记录导入行与事件（导入行为本身发生）。
    const again = importer.importInboxFile(db, { sourcePath: 'qa-round2.md', docId: doc.id, importedBy: 'session-qa' })
    assert.equal(again.created, false)
    assert.equal(again.version.version, 2)
    assert.equal(docs.listDocVersions(db, doc.id).length, 2)
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM imports WHERE document_id = ?').get(doc.id).n, 2)

    // 不带 docId：按 type + 文件名创建新文档并写入 v1。
    writeFileSync(join(inboxDir, 'review.md'), '# 评审\n外部评审意见。\n', 'utf8')
    const created = importer.importInboxFile(db, { sourcePath: 'review.md', type: 'report', title: '外部评审', importedBy: 'session-pm' })
    assert.equal(created.doc.logicalKey, 'report/review')
    assert.equal(created.version.version, 1)
    writeFileSync(join(inboxDir, 'review.md'), '# 评审 v2\n外部评审意见（补充）。\n', 'utf8')
    const revised = importer.importInboxFile(db, { sourcePath: 'review.md', type: 'report', importedBy: 'session-pm' })
    assert.equal(revised.doc.id, created.doc.id, '同 type/文件名的再次导入应追加版本而不是新建文档')
    assert.equal(revised.version.version, 2)

    // 越界路径 / 缺失 / 空文件 / 冻结文档。
    const outside = join(root, 'outside.md')
    writeFileSync(outside, '# outside', 'utf8')
    expectCode(function () { importer.importInboxFile(db, { sourcePath: outside, docId: doc.id }) }, 'INVALID')
    expectCode(function () { importer.importInboxFile(db, { sourcePath: 'missing.md', docId: doc.id }) }, 'NOT_FOUND')
    writeFileSync(join(inboxDir, 'empty.md'), '   \n', 'utf8')
    expectCode(function () { importer.importInboxFile(db, { sourcePath: 'empty.md', docId: doc.id }) }, 'INVALID')
    const frozenDoc = docs.createDocument(db, { type: 'spec', logicalKey: 'spec/frozen', title: '冻结规格' })
    docs.writeDocumentVersion(db, { docId: frozenDoc.id, content: '# 规格\n已冻结。' })
    docs.freezeDocument(db, { docId: frozenDoc.id })
    writeFileSync(join(inboxDir, 'frozen.md'), '# 新内容', 'utf8')
    expectCode(function () { importer.importInboxFile(db, { sourcePath: 'frozen.md', docId: frozenDoc.id }) }, 'DOC_FROZEN')
    expectCode(function () { importer.importInboxFile(db, { sourcePath: 'review.md' }) }, 'INVALID')
  })
})

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

test('时间线查询与 timelineMarkdown 输出', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'time', title: '时间线' })
    store.updateSliceStatus(db, { id: slice.id, status: 'in_progress', ownerRole: '产品' })
    store.addEvidence(db, { sliceId: slice.id, kind: 'command', command: 'node --test', resultSummary: '通过' })

    const page = store.timeline(db, { limit: 2 })
    assert.equal(page.length, 2)
    assert.ok(page[0].seq > page[1].seq, '时间线默认最新在前')
    const after = store.timeline(db, { afterSeq: page[0].seq, limit: 10 })
    assert.ok(after.every(function (event) { return event.seq > page[0].seq }))

    const markdown = store.timelineMarkdown(db)
    assert.equal(typeof markdown, 'string')
    assert.ok(markdown.includes('测试项目-'))
    assert.ok(markdown.includes('slice/create'))
    assert.ok(markdown.includes('evidence/add'))
    const docVersionMarkdown = store.timelineMarkdown(db, { kinds: ['slice/status'] })
    assert.ok(docVersionMarkdown.includes('slice/status'))
    assert.ok(!docVersionMarkdown.includes('evidence/add'))
  })
})

// ---------------------------------------------------------------------------
// 错误码 / 基础校验 / 重开 DB
// ---------------------------------------------------------------------------

test('领域错误码稳定（INVALID/NOT_FOUND/DUPLICATE_*）', function () {
  withProject(function ({ db }) {
    expectCode(function () { store.createSlice(db, { key: '', title: 'x' }) }, 'INVALID')
    expectCode(function () { store.createSlice(db, { key: 'k', title: 'x', type: 'nope' }) }, 'INVALID')
    const slice = store.createSlice(db, { key: 'dup', title: '重复' })
    expectCode(function () { store.createSlice(db, { key: 'dup', title: '重复 2' }) }, 'DUPLICATE_SLICE')
    const doc = docs.createDocument(db, { sliceId: slice.id, type: 'spec', logicalKey: 'spec/dup', title: '规格' })
    expectCode(function () { docs.createDocument(db, { type: 'spec', logicalKey: 'spec/dup', title: '规格 2' }) }, 'DUPLICATE_DOCUMENT')
    expectCode(function () { docs.createDocument(db, { type: 'bad-type', logicalKey: 'bad/x', title: 'x' }) }, 'INVALID')
    expectCode(function () { docs.writeDocumentVersion(db, { docId: 'doc-missing', content: '# x' }) }, 'NOT_FOUND')
    expectCode(function () { docs.writeDocumentVersion(db, { docId: doc.id, content: '' }) }, 'INVALID')
    expectCode(function () { store.addEvidence(db, { sliceId: 'slice-missing', kind: 'test' }) }, 'NOT_FOUND')
    expectCode(function () { store.updateSliceStatus(db, { id: 'slice-missing', status: 'done' }) }, 'NOT_FOUND')
    expectCode(function () { store.addArtifact(db, { kind: 'code', path: 'a.ts', bytes: -1 }) }, 'INVALID')
    expectCode(function () { store.resolveDecision(db, { id: 'decision-missing', status: 'approved' }) }, 'NOT_FOUND')
    expectCode(function () { leases.acquireLease(db, { sliceId: slice.id }) }, 'INVALID')
    assert.equal(store.getSlice(db, 'slice-missing'), undefined)
    assert.equal(store.getTask(db, 'task-missing'), undefined)
    assert.equal(docs.getDocument(db, 'doc-missing'), undefined)
  })
})

test('重开 DB：自动推导 projectId/root，数据保留，迁移幂等', function () {
  const ctx = newProject()
  try {
    const slice = store.createSlice(ctx.db, { key: 'persist', title: '持久化' })
    const doc = docs.createDocument(ctx.db, { sliceId: slice.id, type: 'spec', logicalKey: 'spec/persist', title: '持久化规格' })
    docs.writeDocumentVersion(ctx.db, { docId: doc.id, content: '# 持久化\n数据在 DB。' })
    const revision = ctx.db.revision()
    ctx.db.close()

    const reopened = new ProjectDb(join(ctx.root, '.project', 'project.db'))
    try {
      assert.equal(reopened.projectId, 'proj-' + projectSeq)
      assert.equal(projectRootOf(reopened), ctx.root)
      assert.equal(reopened.revision(), revision)
      assert.equal(docs.getDocument(reopened, doc.id).currentVersion, 1)
      assert.equal(store.listSlices(reopened).length, 1)
    } finally {
      reopened.close()
    }
  } finally {
    try { ctx.db.close() } catch (error) { /* already closed */ }
  }
})

// ---------------------------------------------------------------------------
// W1：数据库层防线（v2）。全部是「绕过应用层直连 DB」的反证——
// 这些断言的意义在于：即使有人拿到 sqlite 句柄，不变量也仍然成立。
// ---------------------------------------------------------------------------

const { GUARD_TRIGGERS, STATUS_ENUMS, auditStatuses } = schema

test('W1: 迁移到 v2..v5 后触发器与唯一索引到位', function () {
  withProject(function ({ db }) {
    const triggers = db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map(function (row) { return row.name })
    assert.equal(triggers.length, GUARD_TRIGGERS.length)
    for (const name of ['guard_events_no_update', 'guard_events_no_delete', 'guard_events_seq_contiguous',
      'guard_doc_versions_no_delete', 'guard_doc_versions_body_immutable',
      'guard_decisions_terminal', 'guard_approvals_terminal',
      // v4：栅栏令牌单调 + 任务会话终态 + 审批代次单调 + outbox 终态
      'guard_lease_epoch_monotonic', 'guard_task_session_terminal',
      'guard_approval_epoch_monotonic', 'guard_outbox_done_terminal',
      // v5：Verified Done —— 验收是终态，且必须有签名人
      'guard_verified_slice_terminal', 'guard_verified_requires_signer']) {
      assert.ok(triggers.includes(name), '缺触发器 ' + name)
    }
    const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ux_%'").all().map(function (row) { return row.name })
    assert.ok(indexes.includes('ux_artifacts_fact'), '缺 artifacts 唯一索引')
    assert.ok(indexes.includes('ux_evidence_fact'), '缺 evidence 唯一索引')
    assert.equal(Number(db.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v), schema.SCHEMA_VERSION)
    assert.equal(schema.SCHEMA_VERSION, 5)
  })
})

test('v4 迁移：老库（v3）升级后新增列与表都在，且守卫被补齐', function () {
  const root = join(TMP_BASE, 'v4-migrate-' + Date.now())
  mkdirSync(root, { recursive: true })
  const file = join(root, 'project.db')
  // 造一个 v3 库：先按当前 schema 建库，然后删掉 v4 的列/表/触发器模拟老库。
  const first = new ProjectDb(file, { projectId: 'proj-v4', projectName: '老库', root })
  const v4Columns = ['failure_code', 'failure_detail', 'failure_at', 'attempt']
  // SQLite 不能 DROP COLUMN 带约束的，所以造老库的办法是：删表重建为 v3 形态
  first.db.exec('DROP TABLE sessions')
  first.db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT, slice_id TEXT, dsh_session_id TEXT, parent_session_id TEXT, provider TEXT, model TEXT, reasoning_effort TEXT, status TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, ended_at TEXT, handoff_id TEXT, context_json TEXT NOT NULL DEFAULT '{}', UNIQUE(project_id, dsh_session_id))")
  first.db.exec('DROP TABLE export_outbox')
  first.db.exec('DROP TABLE identities')
  first.db.exec('DROP TABLE slice_scopes')
  first.db.exec('DROP TABLE approval_signers')
  first.db.exec('DROP TRIGGER IF EXISTS guard_task_session_terminal')
  first.db.exec('DROP TRIGGER IF EXISTS guard_lease_epoch_monotonic')
  // 模拟 v3 库：v4 与之后的版本记录都要删掉。迁移闸门按 MAX(version) 判断，
  // 只删 4 不删 5 会让 MAX 仍是 5，v4/v5 迁移都不会重跑（这是测试构造老库的方式问题，不是迁移缺陷）。
  first.db.exec('DELETE FROM schema_migrations WHERE version >= 4')
  first.close()

  const reopened = new ProjectDb(file, { root })
  try {
    const columns = reopened.db.prepare('PRAGMA table_info(sessions)').all().map((row) => String(row.name))
    for (const column of v4Columns) assert.ok(columns.includes(column), '迁移后应有 sessions.' + column)
    const tables = reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => String(row.name))
    for (const table of ['export_outbox', 'identities', 'slice_scopes', 'approval_signers']) {
      assert.ok(tables.includes(table), '迁移后应有表 ' + table)
    }
    const triggers = reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => String(row.name))
    assert.ok(triggers.includes('guard_task_session_terminal'), 'v4 触发器应在老库上升级出来')
    assert.equal(Number(reopened.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v), schema.SCHEMA_VERSION)
    // 幂等：再开一次不报错、不重复记录版本
    reopened.close()
    const again = new ProjectDb(file, { root })
    try {
      assert.equal(Number(again.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 4').get().n), 1)
      assert.equal(Number(again.db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 5').get().n), 1)
    } finally { again.close() }
  } finally {
    try { reopened.close() } catch (error) { /* 已关闭 */ }
  }
})

test('W1: events append-only —— 直连 DB 改/删都被拒', function () {
  withProject(function ({ db }) {
    db.tx(function () { db.appendEvent({ kind: 'test/a' }) })
    const raw = db.db
    assert.throws(function () { raw.exec("DELETE FROM events WHERE kind='test/a'") }, /EVENT_IMMUTABLE/)
    assert.throws(function () { raw.exec("UPDATE events SET payload_json='{}' WHERE kind='test/a'") }, /EVENT_IMMUTABLE/)
    assert.equal(db.listEvents({ limit: 10 }).length, 1, '事件不应被删除')
  })
})

test('W1: events.seq 必须连续 —— 跳号与倒填都被拒', function () {
  withProject(function ({ db }) {
    db.tx(function () { db.appendEvent({ kind: 'test/first' }) })
    const raw = db.db
    const insert = raw.prepare('INSERT INTO events(id, project_id, seq, at, kind, payload_json) VALUES (?,?,?,?,?,?)')
    assert.throws(function () { insert.run('e-gap', db.projectId, 99, 'now', 'x', '{}') }, /SEQ_NOT_CONTIGUOUS/)
    assert.throws(function () { insert.run('e-back', db.projectId, 0, 'now', 'x', '{}') }, /SEQ_NOT_CONTIGUOUS/)
    // 连续的下一个 seq 必须仍可写（否则正常追加会被误伤）
    assert.doesNotThrow(function () { insert.run('e-ok', db.projectId, 2, 'now', 'x', '{}') })
  })
})

test('W1: doc_versions 只增 —— 删行与改正文被拒，冻结列仍可改', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'w1-doc', title: 'W1 文档' })
    const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/w1', title: 'W1' })
    docs.writeDocumentVersion(db, { docId: doc.id, content: 'v1 正文' })
    const raw = db.db
    assert.throws(function () { raw.exec('DELETE FROM doc_versions') }, /DOCVERSION_IMMUTABLE/)
    assert.throws(function () { raw.exec("UPDATE doc_versions SET content='forged'") }, /DOCVERSION_IMMUTABLE/)
    assert.throws(function () { raw.exec("UPDATE doc_versions SET content_hash='forged'") }, /DOCVERSION_IMMUTABLE/)
    // frozen 是允许更新的列（freezeDocument 依赖它）
    assert.doesNotThrow(function () { docs.freezeDocument(db, { docId: doc.id }) })
    assert.equal(docs.getDocument(db, doc.id).currentVersion, 1)
  })
})

test('W1: 一个事实一行 —— 重复 artifact / evidence 被唯一索引拒', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'w1-uniq', title: 'W1 唯一' })
    store.addArtifact(db, { sliceId: slice.id, kind: 'code-file', path: 'src/a.js' })
    // 应用层先给出可读错误码；DB 唯一索引是兜底（绕过应用层时由它拦，见下一条断言）
    expectCode(function () { store.addArtifact(db, { sliceId: slice.id, kind: 'code-file', path: 'src/a.js' }) }, 'DUPLICATE_ARTIFACT')
    assert.throws(function () {
      db.db.prepare('INSERT INTO artifacts(id, project_id, kind, path, created_at) VALUES (?,?,?,?,?)').run('a-raw', db.projectId, 'code-file', 'src/a.js', 'now')
    }, /UNIQUE/, '绕过应用层时 DB 唯一索引必须兜底')
    // 同路径不同 kind 是不同事实，必须允许
    assert.doesNotThrow(function () { store.addArtifact(db, { sliceId: slice.id, kind: 'doc-export', path: 'src/a.js' }) })
    store.addEvidence(db, { sliceId: slice.id, kind: 'command', uri: 'EV-1.md', resultSummary: 'run 1' })
    expectCode(function () { store.addEvidence(db, { sliceId: slice.id, kind: 'command', uri: 'EV-1.md', resultSummary: 'run 2' }) }, 'DUPLICATE_EVIDENCE')
    assert.throws(function () {
      db.db.prepare('INSERT INTO evidence(id, project_id, kind, uri, result_summary, created_at) VALUES (?,?,?,?,?,?)').run('ev-raw', db.projectId, 'command', 'EV-1.md', 'x', 'now')
    }, /UNIQUE/, '绕过应用层时 DB 唯一索引必须兜底')
    // 无 uri 的运行期证据不受唯一约束
    assert.doesNotThrow(function () {
      store.addEvidence(db, { sliceId: slice.id, kind: 'command', resultSummary: 'no uri 1' })
      store.addEvidence(db, { sliceId: slice.id, kind: 'command', resultSummary: 'no uri 2' })
    })
  })
})

test('W1: decision 终态不可回退 —— pending 可落定，落定后不可改判', function () {
  withProject(function ({ db }) {
    const decision = store.createDecision(db, { title: 'D', question: 'Q', options: ['a', 'b'] })
    store.resolveDecision(db, { id: decision.id, status: 'approved', decidedBy: 'user' })
    assert.throws(function () { db.db.exec("UPDATE decisions SET status='pending' WHERE id='" + decision.id + "'") }, /DECISION_TERMINAL/)
    assert.throws(function () { db.db.exec("UPDATE decisions SET status='rejected' WHERE id='" + decision.id + "'") }, /DECISION_TERMINAL/)
    assert.equal(store.getDecision(db, decision.id).status, 'approved')
  })
})

test('决策 answer：人来选的是哪一项必须被记住（设计文档 §7.2 的 [批准 A] [选 B]）', function () {
  withProject(function ({ db }) {
    const decision = store.createDecision(db, {
      title: '同类过期口径的处置范围',
      question: '除已修的 README 外还有同类过期口径，如何处置？',
      options: ['只修生成物里的状态句', '全部另立一个工作项统一处理', '暂不处理'],
      recommended: '全部另立一个工作项统一处理（理由：生成物与生成器必须同改）',
    })
    // 1) 选项的机器值：字符串选项按位置给 A/B/C（与客户端 decisionOptions 一致）
    assert.deepEqual(decision.options.map(function (option, index) { return store.optionValueOf(option, index) }), ['A', 'B', 'C'])

    // 2) 批准必须能指定选了哪一项
    const resolved = store.resolveDecision(db, { id: decision.id, status: 'approved', decidedBy: 'user', answer: 'B', rationale: '一次性收口' })
    assert.equal(resolved.status, 'approved')
    assert.equal(resolved.answer, 'B', 'answer 应保存选项值')
    assert.equal(store.getDecision(db, decision.id).answer, 'B')

    // 3) 事件里也带着 answer，审计时能看出选的是哪一条
    const event = store.timeline(db, { kinds: ['decision/resolve'], limit: 1 })[0]
    assert.equal(event.payload.answer, 'B')

    // 4) 不存在的选项要被拒（不能记一个查无此项的答案）
    const second = store.createDecision(db, { title: 'D2', question: 'Q2', options: ['x', 'y'] })
    expectCode(function () {
      store.resolveDecision(db, { id: second.id, status: 'approved', decidedBy: 'user', answer: 'Z' })
    }, 'INVALID')

    // 5) 没有选项的门禁决策：answer 为空是合法的（status 本身即答案）
    const gate = store.createDecision(db, {
      title: '是否进入发布阶段', question: '发布不可回滚，是否批准？',
      options: ['批准', '驳回'], recommended: '批准', kind: 'gate', gate: 'G6', irreversible: true,
    })
    const approved = store.resolveDecision(db, { id: gate.id, status: 'approved', decidedBy: 'user', confirmed: true })
    assert.equal(approved.status, 'approved')
    assert.equal(approved.answer, undefined, '门禁决策不强制 answer')

    // 6) 拒绝也可以记录选的是哪一项（驳回理由之外还有"驳回的是哪条建议"）
    const third = store.createDecision(db, { title: 'D3', question: 'Q3', options: ['p', 'q'] })
    assert.equal(store.resolveDecision(db, { id: third.id, status: 'rejected', decidedBy: 'user', answer: 'A' }).answer, 'A')
  })
})

test('W1: 迁移去重 —— 存量重复 evidence 在同一事务里降噪后再加约束', function () {
  const ctx = newProject()
  try {
    // 手工造出 v1 形态的重复行（此时唯一索引已存在，先临时摘掉以模拟旧库）
    const slice = store.createSlice(ctx.db, { key: 'legacy', title: '旧库' })
    ctx.db.db.exec('DROP INDEX IF EXISTS ux_evidence_fact')
    ctx.db.db.exec('DROP INDEX IF EXISTS ux_artifacts_fact')
    const insertEvidence = ctx.db.db.prepare('INSERT INTO evidence(id, project_id, kind, uri, result_summary, created_at) VALUES (?,?,?,?,?,?)')
    insertEvidence.run('ev-1', ctx.db.projectId, 'command', 'EV-dup.md', 'first', 'now')
    insertEvidence.run('ev-2', ctx.db.projectId, 'command', 'EV-dup.md', 'second', 'now')
    const insertArtifact = ctx.db.db.prepare('INSERT INTO artifacts(id, project_id, kind, path, created_at) VALUES (?,?,?,?,?)')
    insertArtifact.run('a-1', ctx.db.projectId, 'code-file', 'dup.js', 'now')
    insertArtifact.run('a-2', ctx.db.projectId, 'code-file', 'dup.js', 'now')
    // 重置版本标记，让迁移重跑一次
    ctx.db.db.exec('DELETE FROM schema_migrations')
    schema.migrate(ctx.db.db)
    assert.equal(ctx.db.db.prepare("SELECT COUNT(*) AS c FROM evidence WHERE uri='EV-dup.md'").get().c, 1, '重复 evidence 应只留 1 行')
    assert.equal(ctx.db.db.prepare("SELECT COUNT(*) AS c FROM artifacts WHERE path='dup.js'").get().c, 1, '重复 artifact 应只留 1 行')
    assert.equal(ctx.db.db.prepare("SELECT result_summary AS s FROM evidence WHERE uri='EV-dup.md'").get().s, 'first', '应保留最早一条')
    assert.equal(slice.key, 'legacy')
  } finally { ctx.db.close() }
})

test('W1: auditStatuses 报告越界状态且不抛错', function () {
  withProject(function ({ db }) {
    const slice = store.createSlice(db, { key: 'audit', title: '审计' })
    assert.deepEqual(auditStatuses(db), [], '新建项目不应有越界状态')
    db.db.exec("UPDATE slices SET status='随便什么' WHERE id='" + slice.id + "'")
    const findings = auditStatuses(db)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].table, 'slices')
    assert.equal(findings[0].status, '随便什么')
  })
})

test('W1: 状态枚举覆盖代码实际写入的每一个值', function () {
  // 防止枚举写窄了把正常写入拒掉：这里断言各实体的枚举与代码里实际使用的取值一致。
  // v5 在 done 与 archived 之间插入 verified：交付方自认完成（done）≠ 独立验收通过（verified）。
  assert.deepEqual(STATUS_ENUMS.slices.slice(0, 6), ['open', 'in_progress', 'review', 'blocked', 'done', 'verified'])
  assert.ok(STATUS_ENUMS.slices.includes('archived'), 'slices 必须允许 archived（在 verified 之后）')
  assert.ok(STATUS_ENUMS.tasks.includes('in_progress'), 'tasks 必须允许 in_progress（orchestration 派活时写入）')
  assert.ok(STATUS_ENUMS.tasks.includes('review'), 'tasks 必须允许 review（replay 预演用到）')
  assert.ok(STATUS_ENUMS.slices.includes('review'), 'slices 必须允许 review（收工写入）')
  assert.ok(STATUS_ENUMS.slices.includes('blocked'), 'slices 必须允许 blocked（收工失败写入）')
  assert.ok(STATUS_ENUMS.approvals.includes('pending'), 'approvals 必须允许 pending（gate_submit 写入）')
})

// ---------------------------------------------------------------------------
// W2：阶段模板可配置。核心断言是「project.json 的改动真的生效」——
// 改动前它只写不读，所以这些测试在旧实现上会全部失败。
// ---------------------------------------------------------------------------

test('W2: 阶段模板校验 —— 空数组/重复 key/重复 gate/缺字段都被拒', function () {
  assert.equal(defaults.normalizeStageTemplate([]).ok, false)
  assert.equal(defaults.normalizeStageTemplate(undefined).ok, false)
  assert.equal(defaults.normalizeStageTemplate('not-an-array').ok, false)
  assert.equal(defaults.normalizeStageTemplate([{ key: 'A', name: 'a' }, { key: 'A', name: 'b' }]).code, 'POLICY_INVALID')
  assert.equal(defaults.normalizeStageTemplate([{ key: 'A', name: 'a', gate: 'G1' }, { key: 'B', name: 'b', gate: 'G1' }]).ok, false)
  assert.equal(defaults.normalizeStageTemplate([{ key: '', name: 'a' }]).ok, false)
  assert.equal(defaults.normalizeStageTemplate([{ key: 'A' }]).ok, false)
  // 合法模板：position 由数组顺序补齐
  const ok = defaults.normalizeStageTemplate([{ key: 'X', name: '某阶段', gate: 'GX' }, { key: 'Y', name: '另一阶段' }])
  assert.equal(ok.ok, true)
  assert.equal(ok.template[0].position, 0)
  assert.equal(ok.template[1].position, 1)
  assert.equal(ok.template[1].gate, null, '未给 gate 时应规范化为 null')
})

test('W2: resolveStageTemplate —— 缺失回退默认、非法回退并带出原因、合法则采用', function () {
  const missing = defaults.resolveStageTemplate({})
  assert.equal(missing.source, 'default')
  assert.equal(missing.template.length, defaults.STAGE_TEMPLATE.length)

  const invalid = defaults.resolveStageTemplate({ stageTemplate: [{ key: 'A', name: 'a' }, { key: 'A', name: 'b' }] })
  assert.equal(invalid.source, 'default', '非法模板应回退默认')
  assert.equal(invalid.error.code, 'POLICY_INVALID', '必须带出非法原因，而不是静默吞掉')

  const custom = [{ key: 'P1', name: '需求', gate: 'GP1' }, { key: 'P2', name: '实现', gate: 'GP2' }]
  const resolved = defaults.resolveStageTemplate({ stageTemplate: custom })
  assert.equal(resolved.source, 'project.json', '合法模板必须以 project.json 为准')
  assert.deepEqual(resolved.template.map(function (s) { return s.key }), ['P1', 'P2'])
})

test('W2: project.json 的 stageTemplate 真的生效 —— 改配置后阶段行跟着变', function () {
  // local 模式：验的是「配置入口生效」，与权威源位置无关（外部 store 的位置由另一组用例覆盖）。
  const prevMode = process.env.PROJECT_WORKBENCH_STORE
  process.env.PROJECT_WORKBENCH_STORE = 'local'
  const root = mkdtempSync(join(TMP_BASE, 'w2-' + Date.now()))
  mkdirSync(join(root, '.project'), { recursive: true })
  const projectId = 'proj-w2'
  const custom = [{ key: 'P1', name: '需求', gate: 'GP1' }, { key: 'P2', name: '实现', gate: 'GP2' }]
  writeFileSync(join(root, '.project', 'project.json'), JSON.stringify({
    format: 1, projectId: projectId, name: 'W2 项目', root: '.', createdAt: new Date().toISOString(),
    stageTemplate: custom,
  }, null, 2))
  const db = new ProjectDb(join(root, '.project', 'project.db'), { projectId: projectId, projectName: 'W2 项目', root: root })
  try {
    const registry = registryMod.createRegistry({ get: function () { return undefined } })
    // 无 workspaceRegistry 时以「已存在 .project 运行时」准入
    const opened = registry.open(root)
    assert.ok(opened, '应能打开已初始化的项目')
    const stages = opened.db.prepare('SELECT key, name, gate, status FROM stages WHERE project_id = ? ORDER BY position').all(projectId)
    assert.deepEqual(stages.map(function (s) { return s.key }), ['P1', 'P2'], '阶段行必须来自 project.json，而不是内置 S1..S7')
    assert.equal(stages[0].name, '需求')
    assert.equal(stages[0].gate, 'GP1')
    assert.equal(stages[0].status, 'active', '第一个阶段应 active')
    registry.closeAll()
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
    if (prevMode === undefined) delete process.env.PROJECT_WORKBENCH_STORE
    else process.env.PROJECT_WORKBENCH_STORE = prevMode
  }
})

test('W2: 已有项目不被自动改写 —— 只补缺失阶段，不删不改', function () {
  // 这条用例刻意用 local 模式（权威源仍在工作区 .project/）：它验证的是「打开已有项目不隐式改写」，
  // 与 M0 的外部 store 位置无关；同时顺带覆盖 local 兼容路径。
  const prevMode = process.env.PROJECT_WORKBENCH_STORE
  process.env.PROJECT_WORKBENCH_STORE = 'local'
  const root = mkdtempSync(join(TMP_BASE, 'w2-keep-' + Date.now()))
  mkdirSync(join(root, '.project'), { recursive: true })
  const projectId = 'proj-w2keep'
  // 先按默认模板建库
  writeFileSync(join(root, '.project', 'project.json'), JSON.stringify({
    format: 1, projectId: projectId, name: 'W2 保留', root: '.', createdAt: new Date().toISOString(),
  }, null, 2))
  const registry = registryMod.createRegistry({ get: function () { return undefined } })
  try {
    const first = registry.ensure(root, { root: root })
    const before = first.db.prepare('SELECT key, name FROM stages WHERE project_id = ? ORDER BY position').all(projectId)
    assert.equal(before.length, 7, '默认模板应建 7 个阶段')
    // 人为把当前阶段推进一格，模拟「已经跑了一阵」的项目
    first.db.prepare("UPDATE stages SET status = 'done' WHERE project_id = ? AND key = 'S1'").run(projectId)
    first.db.prepare("UPDATE stages SET status = 'active' WHERE project_id = ? AND key = 'S2'").run(projectId)
    registry.closeAll()

    // 现在换一个只有 2 个阶段的新模板（含一个全新 key），重开项目
    const json = JSON.parse(readFileSync(join(root, '.project', 'project.json'), 'utf8'))
    json.stageTemplate = [{ key: 'S1', name: '产品定义（改名）', gate: 'G1' }, { key: 'S9', name: '全新阶段', gate: 'G9' }]
    writeFileSync(join(root, '.project', 'project.json'), JSON.stringify(json, null, 2))

    const second = registry.open(root)
    const after = second.db.prepare('SELECT key, name, status FROM stages WHERE project_id = ? ORDER BY position').all(projectId)
    const keys = after.map(function (s) { return s.key })
    assert.ok(keys.includes('S3'), '旧阶段的 key 不能被删掉（不做隐式破坏）')
    assert.ok(keys.includes('S9'), '模板里的新 key 应被补建')
    const s1 = after.find(function (s) { return s.key === 'S1' })
    assert.equal(s1.name, '产品', '已有阶段行不被改名（改模板是显式操作）')
    const s2 = after.find(function (s) { return s.key === 'S2' })
    assert.equal(s2.status, 'active', '现有 active 阶段不被改动')
  } finally {
    registry.closeAll()
    rmSync(root, { recursive: true, force: true })
    if (prevMode === undefined) delete process.env.PROJECT_WORKBENCH_STORE
    else process.env.PROJECT_WORKBENCH_STORE = prevMode
  }
})

test('W2: planStageRemap 只出计划不改数据 —— 报告增删改名改门禁', function () {
  const currentRows = [
    { key: 'S1', name: '产品', gate: 'G1', status: 'done', position: 0 },
    { key: 'S2', name: 'UX', gate: 'G2', status: 'active', position: 1 },
    { key: 'S3', name: '架构', gate: 'G3', status: 'pending', position: 2 },
  ]
  const target = [
    { key: 'S1', name: '产品定义', gate: 'G1', position: 0 },
    { key: 'S2', name: 'UX', gate: 'G2-NEW', position: 1 },
    { key: 'S9', name: '新阶段', gate: 'G9', position: 2 },
  ]
  const plan = defaults.planStageRemap(currentRows, target)
  assert.deepEqual(plan.added, ['S9'])
  assert.deepEqual(plan.removed, ['S3'])
  assert.deepEqual(plan.renamed, [{ key: 'S1', from: '产品', to: '产品定义' }])
  assert.deepEqual(plan.regated, [{ key: 'S2', from: 'G2', to: 'G2-NEW' }])
  assert.equal(plan.activeStage, 'S2')
  assert.equal(plan.activeStageSurvives, true)
  assert.equal(plan.needsConfirmation, true)

  // 模板与现状完全一致时不需要确认
  const same = defaults.planStageRemap(currentRows, currentRows.map(function (r, i) {
    return { key: r.key, name: r.name, gate: r.gate, position: i }
  }))
  assert.equal(same.needsConfirmation, false)
})

test('W2: lumio 生命周期模板本身合法', function () {
  const normalized = defaults.normalizeStageTemplate(defaults.LUMIO_STAGE_TEMPLATE)
  assert.equal(normalized.ok, true, '内置的 lumio 模板必须能通过自身校验')
  assert.deepEqual(normalized.template.map(function (s) { return s.key }), ['PRD', 'DEV', 'FILE', 'CODE'])
  assert.deepEqual(normalized.template.map(function (s) { return s.gate }), ['PRD-AUDIT', 'DEV-GATE', 'FILE-GATE', 'CODE-GATE'])
})
