// T1 db-core 单测：node:sqlite + 临时目录直跑，不依赖 DSH 实例。
// 运行：node --test workbench/tests/unit/db.test.mjs
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb, projectRootOf } from '../../host/db.js'
import * as store from '../../host/store.js'
import * as docs from '../../host/docs.js'
import * as leases from '../../host/leases.js'
import * as exporters from '../../host/export.js'
import * as importer from '../../host/import.js'

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
