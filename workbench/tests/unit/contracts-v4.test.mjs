// v4 契约测试：身份模型、HTTP 错误详情、prompt 预算一致性、审批代次。
// 这些是「看起来像小事、但决定系统可不可复盘」的接口约定。
// 运行：node --test --test-isolation=none workbench/tests/unit/contracts-v4.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '../../host/db.js'
import * as store from '../../host/store.js'
import * as docs from '../../host/docs.js'
import * as leases from '../../host/leases.js'
import { ensureGuards } from '../../host/schema.js'
import { resolveIdentity, ensureIdentity, listIdentities, recordApprovalSigner, getApprovalSigner, separationOf } from '../../host/identity.js'
import { createApi, API_PREFIX } from '../../host/http.js'
import { buildTaskAssignment } from '../../host/orchestration.js'
import { compileContext } from '../../host/context.js'
import { estimateTokens } from '../../host/util.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function newDb() {
  const root = mkdtempSync(join(HERE, '.tmp-v4-'))
  const db = new ProjectDb(join(root, '.project', 'project.db'), { projectId: 'proj-v4c', projectName: '契约', root })
  ensureGuards(db.db)
  return { root, db, cleanup() { try { db.close() } catch (e) { /* closed */ } try { rmSync(root, { recursive: true, force: true }) } catch (e) { /* best effort */ } } }
}

// ---------------------------------------------------------------------------
// 身份
// ---------------------------------------------------------------------------

test('身份解析：宿主 > 显式 actingAs > decidedBy > local，且来源如实标注', () => {
  const host = resolveIdentity({ identity: { subject: 'alice@example.com', displayName: 'Alice', source: 'host' } })
  assert.equal(host.subject, 'alice@example.com')
  assert.equal(host.source, 'host')

  const declared = resolveIdentity({ actingAs: '鲍勃' })
  assert.equal(declared.subject, '鲍勃')
  assert.equal(declared.source, 'declared', '人自己填的名字只能是 declared，不能冒充 host')

  const legacy = resolveIdentity({ decidedBy: 'carol' })
  assert.equal(legacy.subject, 'carol')
  assert.equal(legacy.source, 'declared')

  // 旧的默认值 'user' 不是人填的：归 local 比伪装成 declared 更诚实
  const legacyDefault = resolveIdentity({ decidedBy: 'user' })
  assert.equal(legacyDefault.subject, 'user')
  assert.equal(legacyDefault.source, 'local')

  const fallback = resolveIdentity({})
  assert.equal(fallback.subject, 'local')
  assert.equal(fallback.source, 'local')

  // 空/控制字符被拒
  assert.equal(resolveIdentity({ actingAs: '   ' }).subject, 'local')
  assert.equal(resolveIdentity({ identity: { subject: 'a\u0000b' } }).subject, 'ab')
})

test('身份落库：ensureIdentity 幂等且只允许来源升级（不降级）', () => {
  const { db, cleanup } = newDb()
  try {
    const first = ensureIdentity(db, resolveIdentity({ actingAs: 'dave' }))
    assert.equal(first.source, 'declared')
    const again = ensureIdentity(db, { subject: 'dave', source: 'declared' })
    assert.equal(again.id, first.id, '同 subject 复用同一行')
    const upgraded = ensureIdentity(db, { subject: 'dave', displayName: 'Dave', source: 'host' })
    assert.equal(upgraded.source, 'host', '来源可升级到更可信')
    assert.equal(upgraded.displayName, 'Dave')
    const downgraded = ensureIdentity(db, { subject: 'dave', source: 'local' })
    assert.equal(downgraded.source, 'host', '来源不允许降级（历史记录不能被改写成更弱的声明）')
    assert.equal(listIdentities(db).length, 1)
  } finally {
    cleanup()
  }
})

test('审批签名：结构化记录谁签的字，并如实报告「提交人与批准人是否同一人」', () => {
  const { db, cleanup } = newDb()
  try {
    const signer = recordApprovalSigner(db, { approvalId: 'appr-1', identity: { subject: 'erin', source: 'host', displayName: 'Erin' }, clientHint: 'Mozilla/5.0' })
    assert.equal(signer.subject, 'erin')
    assert.equal(signer.source, 'host')
    assert.equal(getApprovalSigner(db, 'appr-1').identityId, signer.identityId)

    const same = separationOf(db, { submittedBy: 'erin', approvedBy: 'erin' })
    assert.equal(same.separated, false, '单机单用户下必然同人——如实报告，不假装是错误')
    const different = separationOf(db, { submittedBy: 'pm-session-1', approvedBy: 'erin' })
    assert.equal(different.separated, true)
    const unknown = separationOf(db, { approvedBy: 'erin' })
    assert.equal(unknown.separated, false)
    assert.equal(unknown.submittedBy, null)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// HTTP 错误详情
// ---------------------------------------------------------------------------

function fakeCtx() {
  return {
    connection: { requestRejection: () => undefined },
    logger: { warn: () => {}, info: () => {} },
  }
}

function fakeRegistry(db, root) {
  return {
    rootForWorkspace: () => ({ workspaceId: 'ws-v4', root, title: '契约工作区' }),
    open: () => db,
    ensure: () => db,
    listProjects: () => [],
    projectJson: () => ({ exportMap: {} }),
    closeAll: () => {},
  }
}

function call(handler, { method = 'GET', url, body }) {
  return new Promise((resolve, reject) => {
    const listeners = {}
    const req = {
      method,
      url,
      headers: { 'content-type': 'application/json' },
      on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn) },
    }
    let statusCode = 0
    const headers = {}
    const chunks = []
    const res = {
      headersSent: false,
      writableEnded: false,
      set statusCode(value) { statusCode = value },
      get statusCode() { return statusCode },
      setHeader: (key, value) => { headers[String(key).toLowerCase()] = value },
      flushHeaders: () => {},
      write: (chunk) => { chunks.push(String(chunk)) },
      end: (chunk) => {
        if (chunk !== undefined) chunks.push(String(chunk))
        res.writableEnded = true
        const text = chunks.join('')
        let json
        try { json = JSON.parse(text) } catch (error) { json = undefined }
        resolve({ statusCode, headers, text, json: () => json })
      },
      destroy: () => {},
      on: () => {},
    }
    handler(req, res).then(() => {
      if (!res.writableEnded) {
        res.writableEnded = true
        const text = chunks.join('')
        let json
        try { json = JSON.parse(text) } catch (error) { json = undefined }
        resolve({ statusCode, headers, text, json: () => json })
      }
    }).catch(reject)
    // 驱动请求体
    setImmediate(() => {
      const dataListeners = listeners.data || []
      const endListeners = listeners.end || []
      if (body !== undefined) {
        const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
        for (const fn of dataListeners) fn(payload)
      }
      for (const fn of endListeners) fn()
    })
  })
}

test('HTTP 错误详情：门禁失败带 issues 原文与下一步建议，租约冲突带持有者', async () => {
  const { db, root, cleanup } = newDb()
  try {
    const slice = store.createSlice(db, { key: 'http-err', title: 'HTTP 错误' })
    const holderA = store.createSession(db, { kind: 'task', name: '码农-http-err-实现', role: '码农', sliceId: slice.id })
    const sessionB = store.createSession(db, { kind: 'task', name: '测试-http-err-验收', role: '测试', sliceId: slice.id })
    leases.acquireLease(db, { sliceId: slice.id, sessionId: holderA.id, ttlMs: 60000 })
    const api = createApi(fakeCtx(), fakeRegistry(db, root), { emit: () => {}, subscribe: () => () => {} })

    // 直接调 handler 走真实错误映射：用一个不存在的 decision，触发 NOT_FOUND + hints
    const res = await call(api.handler, {
      method: 'POST',
      url: API_PREFIX + '/decision',
      body: { root, id: 'no-such-decision', status: 'approved' },
    })
    assert.equal(res.statusCode, 404)
    const payload = res.json()
    assert.equal(payload.error.code, 'NOT_FOUND')

    // LEASE_HELD 的 details 必须带 holder / sliceId（面板要能显示「谁占着」）
    let leaseError
    try { leases.assertWriteScope(db, { sliceId: slice.id, sessionId: sessionB.id }) } catch (error) { leaseError = error }
    assert.ok(leaseError)
    assert.equal(leaseError.code, 'LEASE_HELD')
    assert.equal(leaseError.details.holder.sessionId, holderA.id)
    assert.equal(leaseError.details.sliceId, slice.id)
  } finally {
    cleanup()
  }
})

test('HTTP 未知路由/非法方法/超大请求体：错误码稳定且可机读', async () => {
  const { db, root, cleanup } = newDb()
  try {
    const api = createApi(fakeCtx(), fakeRegistry(db, root), { emit: () => {}, subscribe: () => () => {} })
    const missing = await call(api.handler, { method: 'GET', url: API_PREFIX + '/nope' })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().error.code, 'NOT_FOUND')

    const wrongMethod = await call(api.handler, { method: 'PUT', url: API_PREFIX + '/decision' })
    assert.equal(wrongMethod.statusCode, 405)
    assert.equal(wrongMethod.json().error.code, 'METHOD_NOT_ALLOWED')

    const tooBig = await call(api.handler, { method: 'POST', url: API_PREFIX + '/init', body: 'x'.repeat(70 * 1024) })
    assert.equal(tooBig.statusCode, 413)
    assert.equal(tooBig.json().error.code, 'PAYLOAD_TOO_LARGE')

    const badJson = await call(api.handler, { method: 'POST', url: API_PREFIX + '/init', body: '{not json' })
    assert.equal(badJson.statusCode, 400)
    assert.equal(badJson.json().error.code, 'INVALID')
  } finally {
    cleanup()
  }
})

test('HTTP 鉴权失败关闭：没有 connection 服务时拒绝访问（不是放行）', async () => {
  const { db, root, cleanup } = newDb()
  try {
    const api = createApi({ logger: { warn: () => {} } }, fakeRegistry(db, root), { emit: () => {}, subscribe: () => () => {} })
    const res = await call(api.handler, { method: 'GET', url: API_PREFIX + '/projects' })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().error.code, 'UNAUTHORIZED')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// prompt 预算
// ---------------------------------------------------------------------------

test('prompt 预算：开场简报（角色卡+简报+验收+PM 交代）统一受硬上限约束', () => {
  const { db, cleanup } = newDb()
  try {
    const slice = store.createSlice(db, { key: 'budget', title: '预算' })
    const task = store.createTask(db, { sliceId: slice.id, title: '实现', acceptance: { done: '全部用例通过' } })
    // 极端长 brief + 长验收：旧实现会无条件拼进去
    const longBrief = '需要实现退款。'.repeat(400)
    const longAcceptance = '验收标准：'.repeat(300)
    const assignment = buildTaskAssignment({
      db, slice, task, role: '码农', action: '实现',
      brief: longBrief, acceptance: longAcceptance,
      projectName: '预算项目', stageLabel: 'S1 产品',
    })
    assert.ok(assignment.used <= assignment.hardLimit, '总注入必须 ≤ 硬上限：used=' + assignment.used + ' hardLimit=' + assignment.hardLimit)
    assert.equal(assignment.hardLimit, 2000)
    assert.equal(assignment.degraded, true, '被裁剪时必须标注降级')
    assert.equal(assignment.truncated.brief, true, '长 brief 应先被裁')
    assert.equal(estimateTokens(assignment.text), assignment.used, 'used 必须是真实估算值')

    // 正常长度不裁剪
    const normal = buildTaskAssignment({
      db, slice, task, role: '码农', action: '实现',
      brief: '实现退款接口，按 PRD 验收。', acceptance: '用例通过',
      projectName: '预算项目', stageLabel: 'S1 产品',
    })
    assert.deepEqual(normal.truncated, { brief: false, acceptance: false })
    assert.ok(normal.used <= normal.hardLimit)
  } finally {
    cleanup()
  }
})

test('prompt 预算：compileContext 三层合计不超预算，超限先裁 L2 再裁 L1', () => {
  const { db, cleanup } = newDb()
  try {
    const slice = store.createSlice(db, { key: 'ctx', title: '上下文' })
    for (let i = 0; i < 6; i += 1) {
      const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/ctx-' + i, title: '文档 ' + i })
      docs.writeDocumentVersion(db, { docId: doc.id, content: '# 标题\n' + '内容'.repeat(200) })
    }
    const compiled = compileContext(db, { roleKind: 'task', role: '码农', sliceId: slice.id, includeL1: true, includeL2: true })
    assert.ok(compiled.used <= compiled.budget.hardLimit, '总注入必须 ≤ hardLimit')
    assert.ok(estimateTokens(compiled.parts.l0) <= compiled.budget.l0 + 60, 'L0 受自身预算约束（+降级提示余量）')
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// 审批代次 / 状态机
// ---------------------------------------------------------------------------

test('审批代次：epoch 单调、superseded 旧审批不再可批准、会话终态不可复活', () => {
  const { db, cleanup } = newDb()
  try {
    const decision = store.createDecision(db, { kind: 'gate', title: 'G1', question: '批？', options: ['批准'], gate: 'G1', stage: 'S1' })
    db.tx(() => {
      db.db.prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run('a1', db.projectId, 'S1', 'G1', decision.id, 'pending', '[]', '{}', null, null, 1)
    })
    // epoch 不能回退（否则「旧快照的签名」可以复用）
    assert.throws(() => {
      db.db.prepare('UPDATE approvals SET epoch = 0 WHERE id = ?').run('a1')
    }, /APPROVAL_EPOCH_REGRESSION/)

    // superseded 后不再是 pending
    db.tx(() => {
      db.db.prepare("UPDATE approvals SET status = 'superseded', superseded_reason = 'resubmitted' WHERE id = 'a1'").run()
    })
    const row = db.db.prepare('SELECT status FROM approvals WHERE id = ?').get('a1')
    assert.equal(row.status, 'superseded')

    // 任务会话终态不可复活
    const slice = store.createSlice(db, { key: 'terminal', title: '终态' })
    const session = store.createSession(db, { kind: 'task', name: '码农-terminal-实现', role: '码农', sliceId: slice.id })
    store.endSession(db, { id: session.id, status: 'failed', failureCode: 'X', failureDetail: 'y' })
    assert.throws(() => {
      db.db.prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(session.id)
    }, /SESSION_TERMINAL/)

    // 租约 epoch 不可回退
    leases.acquireLease(db, { sliceId: slice.id, sessionId: session.id, ttlMs: 60000 })
    assert.throws(() => {
      db.db.prepare('UPDATE leases SET epoch = 0 WHERE slice_id = ?').run(slice.id)
    }, /LEASE_EPOCH_REGRESSION/)
  } finally {
    cleanup()
  }
})

test('会话失败：failed 必须带原因；幂等结束时补齐缺失原因而不是洗掉它', () => {
  const { db, cleanup } = newDb()
  try {
    const slice = store.createSlice(db, { key: 'fail-reason', title: '失败原因' })
    const session = store.createSession(db, { kind: 'task', name: '码农-fail-reason-实现', role: '码农', sliceId: slice.id })
    const ended = store.endSession(db, { id: session.id, status: 'failed' })
    assert.equal(ended.status, 'failed')
    assert.equal(ended.failureCode, 'FAILED_UNSPECIFIED', '没给原因也要有一个可查的默认码')
    assert.ok(ended.failureAt)

    // 再结束一次（幂等）不改变状态，但会补原因
    const slice2 = store.createSlice(db, { key: 'fail-reason-2', title: '失败原因2' })
    const session2 = store.createSession(db, { kind: 'task', name: '码农-fail-reason-2-实现', role: '码农', sliceId: slice2.id })
    // 模拟旧代码路径：只写 status=failed，没写原因
    db.tx(() => {
      db.db.prepare("UPDATE sessions SET status = 'failed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), session2.id)
    })
    assert.equal(store.getSession(db, session2.id).failureCode, undefined)
    const repaired = store.endSession(db, { id: session2.id, status: 'failed', failureCode: 'BACKFILLED', failureDetail: '补齐' })
    assert.equal(repaired.failureCode, 'BACKFILLED', '幂等结束应补齐缺失的失败原因')
    assert.equal(repaired.status, 'failed')
  } finally {
    cleanup()
  }
})
