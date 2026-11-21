// T5 verify · 负向测试（契约 §11 第 3 项 / 架构 §8.3 不变量）。
// 运行：node --test workbench/tests/e2e/negative.test.mjs
// 也可被 PTC run_code in-process import 后调用 makeSuite()/runCases()。
import test from 'node:test'
import { join } from 'node:path'
import * as H from './harness.mjs'

const isNodeTest = process.env.NODE_TEST_CONTEXT !== undefined
const AUTHED_COOKIE = 'test-cookie'
const AUTH_HEADERS = { cookie: 'dsh-auth-test=' + AUTHED_COOKIE }

function baseRegistryStub() {
  const calls = []
  return {
    calls,
    listProjects() { calls.push('listProjects'); return [] },
    pmSession() { calls.push('pmSession'); return undefined },
    open() { calls.push('open'); return undefined },
    async ensure() { calls.push('ensure'); throw new Error('not found') },
    async rootForWorkspace() { calls.push('rootForWorkspace'); throw new Error('not found') },
    closeAll() { calls.push('closeAll') },
  }
}

function baseCtxForHttp() {
  const ctx = H.makeFakeCtx({
    workspaces: [{ id: 'ws1', path: 'C:/fake/project', title: 'fake' }],
    rejection: (req) => {
      const cookie = req.headers && req.headers.cookie
      return cookie && cookie.includes(AUTHED_COOKIE) ? undefined : 401
    },
  })
  return ctx
}

/** 等模块落地后才启用的用例统一 skip。 */
function pending(reason) { return { skip: reason } }

export async function makeSuite() {
  const host = await H.loadHostModules()
  const { modules } = host
  const cases = []
  const add = (name, fn, extra = {}) => cases.push({ name, fn, ...extra })

  // ---- HTTP 路由鉴权（http.js 落地后启用） ----
  if (!modules.http) {
    add('http: 无 cookie 访问 /project-workbench/api/* → 401', async () => {}, pending('host/http.js 尚未落地'))
    add('http: 未鉴权请求不得触发注册表/写操作', async () => {}, pending('host/http.js 尚未落地'))
  } else {
    add('http: 无 cookie 访问 /project-workbench/api/* → 401', async () => {
      const ctx = baseCtxForHttp()
      const registry = baseRegistryStub()
      const bus = { emit() {}, subscribe() { return () => {} }, close() {} }
      modules.http.registerHttp(ctx, registry, bus)
      H.expect(ctx.state.routes.length > 0, 'http.js 应注册至少一条路由')
      const server = await H.createRouteServer(ctx)
      try {
        const prefix = ctx.state.routes[0].path
        H.expect(prefix.startsWith('/project-workbench/api'), '路由前缀应为 /project-workbench/api: ' + prefix)
        for (const route of ctx.state.routes) {
          const target = 'http://127.0.0.1:' + String(server.port) + route.path
          const response = await H.httpRequest(target)
          H.expect([401, 403].includes(response.status), '未鉴权 ' + route.path + ' 应 401/403，实际 ' + String(response.status))
        }
        const projects = await H.httpRequest('http://127.0.0.1:' + String(server.port) + '/project-workbench/api/projects', { headers: AUTH_HEADERS })
        H.expectEqual(projects.status, 200, '带 cookie GET /projects 应 200，body=' + projects.body.slice(0, 300))
        H.expect(Array.isArray(JSON.parse(projects.body).projects), '/projects 应返回 projects 数组')
      } finally { server.server.close() }
    })

    add('http: 未鉴权请求不得触发注册表/写操作', async () => {
      const ctx = baseCtxForHttp()
      const registry = baseRegistryStub()
      const emitted = []
      const bus = { emit(...args) { emitted.push(args) }, subscribe() { return () => {} }, close() {} }
      modules.http.registerHttp(ctx, registry, bus)
      const server = await H.createRouteServer(ctx)
      try {
        for (const route of ctx.state.routes) {
          await H.httpRequest('http://127.0.0.1:' + String(server.port) + route.path)
        }
        H.expectEqual(registry.calls.length, 0, '未鉴权请求不应触达注册表: ' + registry.calls.join(','))
        H.expectEqual(emitted.length, 0, '未鉴权请求不应广播变更事件')
      } finally { server.server.close() }
    })
  }

  // ---- agent 不能代批决策 ----
  const toolsProbe = (() => {
    if (!modules.tools || typeof modules.tools.registerTools !== 'function') return undefined
    try {
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws1', path: 'C:/fake/project', title: 'fake' }] })
      modules.tools.registerTools(ctx, baseRegistryStub(), { emit() {}, subscribe() { return () => {} }, close() {} })
      return [...ctx.state.tools.keys()]
    } catch (error) {
      return []
    }
  })()
  if (!toolsProbe || toolsProbe.length === 0) {
    add('tools: 不存在 decision_resolve/decision_approve 工具（agent 不能代批）', async () => {}, pending('host/tools/index.js 尚未注册任何工具（T4 编排层待落地）'))
  } else {
    add('tools: 不存在 decision_resolve/decision_approve 工具（agent 不能代批）', async () => {
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws1', path: 'C:/fake/project', title: 'fake' }] })
      const registry = baseRegistryStub()
      const bus = { emit() {}, subscribe() { return () => {} }, close() {} }
      modules.tools.registerTools(ctx, registry, bus)
      const names = [...ctx.state.tools.keys()]
      H.expect(names.length > 0, '应注册项目工具')
      for (const forbidden of ['decision_resolve', 'decision_approve', 'decision_decide']) {
        H.expect(!names.includes(forbidden), '不得注册 ' + forbidden + '（决策只能人批准）')
      }
      const literalDecision = names.filter((name) => /^(decision_)/.test(name))
      for (const name of literalDecision) {
        H.expect(!/resolve|approve|decide/i.test(name), '决策落定工具不应由 agent 调用: ' + name)
      }
    })
  }

  // ---- 域负向：重复会话 / frozen / 租约 / seq（模块落地后启用） ----
  const store = modules.store
  const docs = modules.docs
  const leases = modules.leases
  const dbMod = modules.db
  const util = modules.util
  const defaults = modules.defaults

  function makeFixture() {
    const root = H.makeTempProject('neg')
    const projectJson = defaults.createProjectJson({ projectId: 'prj_neg', name: '负向项目', root })
    H.writeJson(join(root, '.project', 'project.json'), projectJson)
    const db = new dbMod.ProjectDb(join(root, '.project', 'project.db'), { projectId: 'prj_neg', projectName: '负向项目', root })
    const slice = store.createSlice(db, { type: 'workitem', key: 'neg-slice', title: '负向切片', acceptance: {} })
    const session = store.createSession(db, { name: '产品-neg-slice-评审', kind: 'task', role: '产品', sliceId: slice.id, dshSessionId: 'dsh-neg-product' })
    return { root, db, projectJson, slice, session }
  }

  if (!store) {
    add('store: 同（切片,角色）重复 active 会话被拒', async () => {}, pending('host/store.js 尚未落地'))
    add('store: 事件 seq 无空洞（混合操作后）', async () => {}, pending('host/store.js 尚未落地'))
  } else {
    add('store: 同（切片,角色）重复 active 会话被拒', async () => {
      const fx = makeFixture()
      try {
        H.expectThrows(() => store.createSession(fx.db, { name: '产品-neg-slice-评审2', kind: 'task', role: '产品', sliceId: fx.slice.id, dshSessionId: 'dsh-neg-dup' }), 'DUPLICATE_ACTIVE_SESSION', '同切片同角色重复 active 应拒绝')
        const otherSlice = store.createSlice(fx.db, { type: 'workitem', key: 'neg-slice-2', title: '另一片', acceptance: {} })
        const other = store.createSession(fx.db, { name: '测试-neg-slice-2-回归', kind: 'task', role: '测试', sliceId: otherSlice.id, dshSessionId: 'dsh-neg-test' })
        H.expect(other.status === 'active', '不同（切片,角色）可以并存')
      } finally { fx.db.close() }
    })

    add('store: 事件 seq 无空洞（混合操作后）', async () => {
      const fx = makeFixture()
      try {
        const slice2 = store.createSlice(fx.db, { type: 'module', key: 'neg-slice-3', title: '模块三', acceptance: {} })
        store.createTask(fx.db, { sliceId: slice2.id, title: '任务 A', acceptance: {} })
        store.addEvidence(fx.db, { sliceId: slice2.id, kind: 'test', resultSummary: '通过', createdBy: fx.session.id })
        store.createDecision(fx.db, { sliceId: slice2.id, kind: 'decision', title: '问题', question: '？', options: [], recommended: '', consequences: '', irreversible: false, createdBy: fx.session.id })
        const seqs = fx.db.listEvents({ limit: 500 }).map((event) => event.seq).sort((a, b) => a - b)
        for (let i = 0; i < seqs.length; i += 1) H.expectEqual(seqs[i], i + 1, 'seq 应连续，缺 ' + String(i + 1))
        H.expectEqual(fx.db.revision(), seqs.length, 'revision 应等于事件数')
      } finally { fx.db.close() }
    })
  }

  if (!docs) {
    add('docs: frozen 文档改版被拒且旧版本不可变', async () => {}, pending('host/docs.js 尚未落地'))
  } else {
    add('docs: frozen 文档改版被拒且旧版本不可变', async () => {
      const fx = makeFixture()
      try {
        const doc = docs.createDocument(fx.db, { sliceId: fx.slice.id, type: 'prd', logicalKey: 'prd/neg', title: '负向 PRD', stage: 'S1', ownerSession: fx.session.id })
        docs.writeDocumentVersion(fx.db, { docId: doc.id, content: '# v1\n初始内容。', authorSession: fx.session.id })
        docs.freezeDocument(fx.db, { docId: doc.id })
        H.expectThrows(() => docs.writeDocumentVersion(fx.db, { docId: doc.id, content: '# v2\n改动。', authorSession: fx.session.id }), 'DOC_FROZEN', '冻结后新版本应被拒')
        const versions = docs.listDocVersions(fx.db, doc.id)
        H.expectEqual(versions.length, 1, '冻结拒绝后不应产生新版本')
        H.expectEqual(docs.getDocVersion(fx.db, doc.id, 1).content, '# v1\n初始内容。', '旧版本内容不可变')
      } finally { fx.db.close() }
    })
  }

  if (!leases) {
    add('leases: 他人持租被拒 + 写作用域校验', async () => {}, pending('host/leases.js 尚未落地'))
  } else {
    add('leases: 他人持租被拒 + 写作用域校验', async () => {
      const fx = makeFixture()
      try {
        const slice2 = store.createSlice(fx.db, { type: 'module', key: 'neg-lease', title: '租约片', acceptance: {} })
        const coder = store.createSession(fx.db, { name: '码农-neg-lease-实现', kind: 'task', role: '码农', sliceId: slice2.id, dshSessionId: 'dsh-neg-coder' })
        leases.acquireLease(fx.db, { sliceId: slice2.id, sessionId: coder.id, ttlMs: 60000, reason: '实现' })
        H.expectThrows(() => leases.acquireLease(fx.db, { sliceId: slice2.id, sessionId: fx.session.id, ttlMs: 60000, reason: '抢' }), 'LEASE_HELD', '他人持租应拒绝')
        let code
        try { leases.assertWriteScope(fx.db, { sliceId: slice2.id, sessionId: fx.session.id }) } catch (error) { code = error.code }
        H.expect(['LEASE_HELD', 'LEASE_REQUIRED', 'NO_LEASE', 'INVALID'].includes(code), '无租约会话写作用域应被拒，实际 code=' + String(code))
        // 持租者可以写
        leases.assertWriteScope(fx.db, { sliceId: slice2.id, sessionId: coder.id })
      } finally { fx.db.close() }
    })
  }


  // ---- HTTP 集成（真实 registry/project/http + 路由级服务器；等价于面板数据通道的负向与正向） ----
  const httpReady = modules.http && modules.registry && modules.project && store && docs
  if (!httpReady) {
    add('http: POST /init → snapshot → timeline → SSE 全链路', async () => {}, pending('http/registry/project/store/docs 模块尚未全部落地'))
    add('http: 不可逆决策缺 confirmed 被拒（409 CONFIRM_REQUIRED）', async () => {}, pending('http/registry/project/store/docs 模块尚未全部落地'))
    add('http: 门禁批准经面板路径冻结+导出+阶段推进', async () => {}, pending('http/registry/project/store/docs 模块尚未全部落地'))
  } else {
    const authGate = (req) => {
      const cookie = req.headers && req.headers.cookie
      return cookie && cookie.includes(AUTHED_COOKIE) ? undefined : 401
    }
    const authHeaders = { cookie: 'dsh-auth-test=' + AUTHED_COOKIE }
    async function makeHttpFixture(prefix) {
      const root = H.makeTempProject('http-' + prefix)
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws-' + prefix, path: root, title: 'HTTP 项目' }], rejection: authGate })
      const registry = modules.registry.createRegistry(ctx)
      const bus = modules.bus.createBus()
      const api = modules.http.registerHttp(ctx, registry, bus)
      const server = await H.createRouteServer(ctx)
      const base = server.baseUrl
      return {
        root, ctx, registry, bus, api, base,
        get: (path) => H.httpRequest(base + path, { headers: authHeaders }),
        post: (path, body) => H.httpRequest(base + path, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        close: async () => {
          try { server.server.close() } catch { /* ignore */ }
          try { api.dispose() } catch { /* ignore */ }
          try { registry.closeAll() } catch { /* ignore */ }
          try { await ctx.dispose() } catch { /* ignore */ }
        },
      }
    }
    function cookieForSse() { return 'dsh-auth-test=' + AUTHED_COOKIE }
    function rootQuery(root, extra) { return '?root=' + encodeURIComponent(root) + (extra || '') }

    add('http: POST /init → snapshot → timeline → SSE 全链路', async () => {
      const fx = await makeHttpFixture('flow')
      try {
        const init = await fx.post('/project-workbench/api/init', { root: fx.root })
        H.expectEqual(init.status, 200, 'POST /init 应 200: ' + init.body.slice(0, 300))
        const initPayload = JSON.parse(init.body)
        H.expect(initPayload.ok === true, 'init 应返回 ok')
        H.expect(initPayload.revision >= 1, 'init 应写事件并产生 revision')

        const projects = JSON.parse((await fx.get('/project-workbench/api/projects')).body)
        H.expect(Array.isArray(projects.projects) && projects.projects.length === 1, '/projects 应返回 1 个项目')
        H.expectEqual(projects.projects[0].initialized, true, '项目应 initialized')
        H.expectEqual(projects.projects[0].stage.key, 'S1', '初始阶段应为 S1')

        const snapshotResponse = await fx.get('/project-workbench/api/snapshot' + rootQuery(fx.root))
        H.expectEqual(snapshotResponse.status, 200, '/snapshot 应 200: ' + snapshotResponse.body.slice(0, 300))
        const snapshot = JSON.parse(snapshotResponse.body)
        H.expect(snapshot.project && snapshot.project.stage && snapshot.project.stage.key === 'S1', 'snapshot 应含 S1 阶段')
        H.expectEqual(Array.isArray(snapshot.stages) && snapshot.stages.length, 7, 'snapshot 应含 7 阶段')
        H.expect(snapshot.revision >= 1, 'snapshot 应含 revision')

        const timelineResponse = await fx.get('/project-workbench/api/timeline' + rootQuery(fx.root, '&limit=20'))
        H.expectEqual(timelineResponse.status, 200, '/timeline 应 200')
        const timeline = JSON.parse(timelineResponse.body)
        H.expect(Array.isArray(timeline.events) && timeline.events.length >= 2, '/timeline 应返回事件数组')
        const kinds = timeline.events.map((event) => event.kind)
        H.expect(kinds.includes('project/init') || kinds.includes('stage/change'), '时间线应含初始化事件: ' + kinds.join(','))

        // 未注册 root：403 + JSON error code
        const unregistered = await fx.get('/project-workbench/api/snapshot?root=' + encodeURIComponent('C:/definitely/not/a/workspace'))
        H.expect([403, 404].includes(unregistered.status), '未注册 root 应 4xx，实际 ' + String(unregistered.status))
        const unregisteredPayload = JSON.parse(unregistered.body)
        H.expect(unregisteredPayload.error && unregisteredPayload.error.code, '错误响应应带 {error:{code}}')

        // 未知路由 404
        const unknown = await fx.get('/project-workbench/api/not-a-route')
        H.expectEqual(unknown.status, 404, '未知路由应 404')

        // SSE：鉴权 cookie 下建立 text/event-stream，并立即收到初始 revision（revision>0）
        const sse = await H.readSse(fx.base + '/project-workbench/api/events' + rootQuery(fx.root), { cookie: cookieForSse(), timeoutMs: 8000 })
        H.expectEqual(sse.status, 200, 'SSE 应 200')
        H.expect(sse.contentType.includes('text/event-stream'), 'SSE content-type: ' + sse.contentType)
        H.expect(sse.bodyPrefix.includes('retry:'), 'SSE 应以 retry 帧开始: ' + sse.bodyPrefix.slice(0, 120))
        H.expect(/event: change[\s\S]*data: \{"revision":\d+\}/.test(sse.bodyPrefix), 'SSE 应推初始 change 事件: ' + sse.bodyPrefix.slice(0, 200))
      } finally { await fx.close() }
    })

    add('http: 不可逆决策缺 confirmed 被拒（409 CONFIRM_REQUIRED）', async () => {
      const fx = await makeHttpFixture('irreversible')
      try {
        H.expectEqual((await fx.post('/project-workbench/api/init', { root: fx.root })).status, 200, 'init 应 200')
        const db = fx.registry.open(fx.root)
        const slice = store.createSlice(db, { type: 'workitem', key: 'irreversible', title: '不可逆决策片', acceptance: {} })
        const decision = store.createDecision(db, {
          sliceId: slice.id, kind: 'decision', title: '删除历史数据', question: '不可逆动作，是否继续？',
          options: [{ id: 'approve', label: '继续' }, { id: 'reject', label: '取消' }], recommended: 'reject',
          consequences: '数据不可恢复', irreversible: true, stage: 'S1', createdBy: null,
        })
        const rejected = await fx.post('/project-workbench/api/decision', { root: fx.root, id: decision.id, status: 'approved' })
        H.expectEqual(rejected.status, 409, '缺 confirmed 应 409，实际 ' + String(rejected.status))
        const rejectedPayload = JSON.parse(rejected.body)
        H.expectEqual(rejectedPayload.error.code, 'CONFIRM_REQUIRED', '错误码应为 CONFIRM_REQUIRED')
        H.expectEqual(store.getDecision(db, decision.id).status, 'pending', '被拒后决策应仍 pending')
        const approved = await fx.post('/project-workbench/api/decision', { root: fx.root, id: decision.id, status: 'approved', confirmed: true, rationale: '确认不可逆' })
        H.expectEqual(approved.status, 200, '带 confirmed 应 200: ' + approved.body.slice(0, 300))
        const approvedPayload = JSON.parse(approved.body)
        H.expectEqual(approvedPayload.decision.status, 'approved', '决策应 approved')
        H.expect(approvedPayload.decision.decidedBy, '应记录人 decidedBy')
      } finally { await fx.close() }
    })

    add('http: 门禁批准经面板路径冻结+导出+阶段推进', async () => {
      const fx = await makeHttpFixture('gate')
      try {
        H.expectEqual((await fx.post('/project-workbench/api/init', { root: fx.root })).status, 200, 'init 应 200')
        const db = fx.registry.open(fx.root)
        const slice = store.createSlice(db, { type: 'workitem', key: 'gate-http', title: '门禁片', acceptance: {} })
        const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/gate-http', title: '门禁 PRD', stage: 'S1', ownerSession: null })
        docs.writeDocumentVersion(db, { docId: doc.id, content: '# 门禁 PRD\n## 范围\nHTTP 路径验证。', authorSession: null })
        const gate = store.createDecision(db, {
          sliceId: slice.id, kind: 'gate', title: 'G1：HTTP 门禁', question: '是否批准？',
          options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '驳回' }], recommended: 'approve',
          consequences: '驳回则重写', irreversible: false, stage: 'S1', gate: 'G1', createdBy: null,
        })
        // 与 gate_submit 一致：先把「提交快照」写进 pending approval 行。
        // 批准时按快照冻结/导出，不再按 stage/slice 现场重查（否则提交 A 会被批准成 B）。
        const versionRow = db.db.prepare('SELECT content_hash FROM doc_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(doc.id)
        db.db.prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run('appr_neg_gate', db.projectId, 'S1', 'G1', gate.id, 'pending', '[]',
            JSON.stringify({ decisionId: gate.id, gate: 'G1', stage: 'S1', docIds: [doc.id], docVersions: [{ docId: doc.id, version: 1, hash: versionRow ? versionRow.content_hash : null }], evidenceIds: [] }),
            null, null)
        const response = await fx.post('/project-workbench/api/decision', { root: fx.root, id: gate.id, status: 'approved', rationale: '面板批准' })
        H.expectEqual(response.status, 200, '门禁批准应 200: ' + response.body.slice(0, 400))
        const payload = JSON.parse(response.body)
        H.expect(payload.actions && payload.actions.approved === true, '应返回门禁 approve 动作')
        H.expectEqual(payload.actions.stage.to, 'S2', '阶段应 S1→S2')
        H.expect(payload.actions.frozenDocs.length >= 1, '应冻结 PRD')
        H.expect(payload.actions.exports.length >= 1, '应导出 PRD')
        const stageRow = db.db.prepare("SELECT key FROM stages WHERE status = 'active' ORDER BY position LIMIT 1").get()
        H.expectEqual(stageRow.key, 'S2', 'DB 阶段应为 S2')
        const frozen = db.db.prepare('SELECT frozen FROM doc_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(doc.id)
        H.expectEqual(Number(frozen.frozen), 1, '文档版本应 frozen')
        const exported = payload.actions.exports[0]
        H.expect(exported.path, '导出动作应带 path')
        const fs = await import('node:fs')
        H.expect(fs.existsSync(join(fx.root, exported.path)) || fs.existsSync(exported.path), '导出文件应存在: ' + String(exported.path))
        H.expect(db.listEvents({ limit: 200 }).map((event) => event.kind).includes('gate/approve'), '应写 gate/approve 事件')
      } finally { await fx.close() }
    })
  }

  return cases
}

if (isNodeTest) {
  const cases = await makeSuite()
  for (const item of cases) test(item.name, { skip: item.skip }, item.fn)
} else if (H.isMain(import.meta.url)) {
  const cases = await makeSuite()
  const summary = await H.runCases('negative.test', cases)
  H.cleanupTracked()
  process.exitCode = H.summaryExitCode(summary)
}