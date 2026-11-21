// T2 host-api 单元测试：用假 ctx（捕获 webServer.register 的 route）直接调用 handler，
// 不依赖真实 DSH 实例；项目库建在临时目录里，测试后清理。
// 覆盖：鉴权拒绝、注册表幂等、快照/切片/文档/时间线、不可逆决策二次确认、门禁动作、PM 绑定、SSE 订阅与断开清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRegistry, projectPaths } from '../../host/registry.js'
import { createBus } from '../../host/bus.js'
import { createApi, registerHttp, API_PREFIX, HEARTBEAT_MS } from '../../host/http.js'
import { createSlice, createDecision, createSession } from '../../host/store.js'
import { createDocument, writeDocumentVersion } from '../../host/docs.js'
import { overview } from '../../host/snapshot.js'
import { bindPmSession } from '../../host/project.js'

const API = API_PREFIX

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

function makeWorkspaceRoot() {
  return mkdtempSync(join(process.cwd(), '.tmp-api-test-'))
}

/** Windows 上 SQLite 句柄释放有延迟：带重试删除临时目录。 */
function safeRemove(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) } catch { /* 延迟释放 */ }
}

function fakeCtx(workspaces, options = {}) {
  const routes = []
  const agents = new Map()
  const agentCalls = []
  const ctx = {
    workspaceRegistry: { list: () => workspaces },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    connection: {
      requestRejection: (req) => (typeof options.rejection === 'function' ? options.rejection(req) : options.rejection),
    },
    agents: { get: (id) => agents.get(id) },
    logger: { info() {}, warn() {}, error() {} },
    effects: [],
    effect: (fn) => {
      const disposer = fn()
      ctx.effects.push(disposer)
      return disposer
    },
    routes,
    agentsMap: agents,
    agentCalls,
  }
  return ctx
}

function makeReq(options = {}) {
  const req = new EventEmitter()
  req.method = options.method || 'GET'
  req.url = options.url || '/'
  req.headers = options.headers || {}
  return req
}

function makeRes() {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headers = {}
  res.chunks = []
  res.writableEnded = false
  res.headersSent = false
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value
    res.headersSent = true
  }
  res.flushHeaders = () => {}
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true }
  res.end = (body) => {
    if (body !== undefined) res.chunks.push(String(body))
    res.writableEnded = true
    res.headersSent = true
    res.emit('close')
  }
  res.bodyText = () => res.chunks.join('')
  res.json = () => {
    const text = res.bodyText()
    return text ? JSON.parse(text) : undefined
  }
  return res
}

async function invoke(route, request, res, body) {
  const pending = route.handler(request, res)
  if (body !== undefined) {
    setImmediate(() => {
      request.emit('data', Buffer.from(JSON.stringify(body)))
      request.emit('end')
    })
  }
  await pending
  return res
}

function getRoute(ctx) {
  assert.equal(ctx.routes.length, 1, 'registerHttp 应注册一个前缀路由')
  const route = ctx.routes[0]
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, API)
  return route
}

function newProject(options = {}) {
  const root = makeWorkspaceRoot()
  const workspaces = [{ id: 'ws-1', path: root, title: '测试项目', sessionIds: [] }]
  if (options.extraWorkspaces) workspaces.push(...options.extraWorkspaces)
  const ctx = fakeCtx(workspaces, { rejection: options.rejection })
  const registry = createRegistry(ctx)
  const project = { root, workspaces, ctx, registry, db: undefined }
  project.open = () => registry.open('ws-1')
  project.ensure = () => { const db = registry.ensure('ws-1', { name: '测试项目' }); project.db = db; return db }
  project.api = (bus) => {
    const api = createApi(ctx, registry, bus)
    return api
  }
  project.cleanup = () => {
    try { registry.closeAll() } catch { /* 已关闭 */ }
    safeRemove(root)
  }
  return project
}

function withProject(fn) {
  return async () => {
    const project = newProject()
    try {
      project.ensure()
      await fn(project)
    } finally {
      project.cleanup()
    }
  }
}

function registerAuthorized(project, bus) {
  project.ctx.connection.requestRejection = () => undefined
  registerHttp(project.ctx, project.registry, bus)
  return getRoute(project.ctx)
}

async function callApi(route, options = {}) {
  const req = makeReq(options)
  const res = makeRes()
  await invoke(route, req, res, options.body)
  return res
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

test('registry.ensure 幂等创建 .project 布局、project.json 与 7 阶段行', () => {
  const project = newProject()
  try {
    const db = project.ensure()
    // M0：权威数据（DB / project.json / inbox / packages）在 store，导出投影在工作区 docs/。
    const paths = projectPaths(project.root)
    assert.ok(existsSync(paths.dbPath), 'project.db 应在 store：' + paths.dbPath)
    assert.ok(existsSync(paths.jsonPath), 'project.json 应在 store：' + paths.jsonPath)
    assert.ok(existsSync(paths.inboxDir), 'inbox 应在 store')
    assert.ok(existsSync(paths.packagesDir), 'packages 应在 store')
    assert.ok(existsSync(paths.docsDir), 'docs 导出目录应在工作区')
    if (paths.external) {
      assert.equal(existsSync(join(project.root, '.project', 'project.db')), false, 'M0 之后工作区不应再有 project.db')
    }
    const config = JSON.parse(readFileSync(paths.jsonPath, 'utf8'))
    assert.equal(config.format, 1)
    assert.equal(config.projectId, db.projectId)
    assert.equal(config.root, '.')
    const first = overview(db, project.root)
    assert.equal(first.stages.length, 7)
    assert.equal(first.stages[0].key, 'S1')
    assert.equal(first.stages[0].status, 'active')
    assert.equal(first.project.name, '测试项目')
    const revision = db.revision()
    assert.ok(revision >= 2, '项目初始化应写 project/init + stage/change 事件')
    const events = db.listEvents({ limit: 20 })
    assert.ok(events.some((event) => event.kind === 'project/init'))
    assert.ok(events.some((event) => event.kind === 'stage/change'))

    const db2 = project.registry.ensure('ws-1')
    assert.equal(db2, db, 'ensure 应复用同一个 ProjectDb')
    assert.equal(overview(db2).stages.length, 7, '重复初始化不能重复建阶段行')
    assert.equal(db2.revision(), revision, '重复 ensure 不能新增事件')
  } finally {
    project.cleanup()
  }
})

test('registry 只接受已登记 workspace（realpath 相等）', () => {
  const project = newProject()
  try {
    project.ensure()
    const registered = project.registry.rootForWorkspace('ws-1')
    assert.equal(registered.workspaceId, 'ws-1')
    const other = makeWorkspaceRoot()
    try {
      assert.throws(() => project.registry.open(other), (error) => error.code === 'NOT_REGISTERED_WORKSPACE' && error.status === 403)
    } finally {
      safeRemove(other)
    }
    const listed = project.registry.listProjects()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].exists, true)
    assert.equal(listed[0].project.stage.key, 'S1')
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

test('所有 API 路由先过 requestRejection：无 cookie 一律 401', async () => {
  const project = newProject()
  try {
    project.ensure()
    project.ctx.connection.requestRejection = () => 401
    registerHttp(project.ctx, project.registry, undefined)
    const route = getRoute(project.ctx)
    for (const [method, url] of [
      ['GET', API + '/projects'],
      ['GET', API + '/snapshot'],
      ['GET', API + '/events'],
      ['POST', API + '/init'],
    ]) {
      const res = await callApi(route, { method, url: url + (url.includes('?') ? '&' : '?') + 'root=' + encodeURIComponent(project.root), body: method === 'POST' ? { root: project.root } : undefined })
      assert.equal(res.statusCode, 401, method + ' ' + url + ' 应拒绝未认证请求')
      assert.equal(res.json().error.code, 'UNAUTHORIZED')
    }
  } finally {
    project.cleanup()
  }
})

test('connection 服务缺失时 fail-closed 返回 401', async () => {
  const project = newProject()
  try {
    project.ensure()
    project.ctx.connection = undefined
    registerHttp(project.ctx, project.registry, undefined)
    const route = getRoute(project.ctx)
    const res = await callApi(route, { url: API + '/projects' })
    assert.equal(res.statusCode, 401)
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 快照 / 切片 / 文档 / 时间线
// ---------------------------------------------------------------------------

test('GET /projects 与 /snapshot 返回客户端需要的投影', async () => {
  const project = newProject()
  try {
    const db = project.ensure()
    createSlice(db, { type: 'workitem', key: 'payment', title: '支付退款', acceptance: { note: '可退款' } })
    const route = registerAuthorized(project)

    const projects = await callApi(route, { url: API + '/projects' })
    assert.equal(projects.statusCode, 200)
    const projectsBody = projects.json()
    assert.equal(projectsBody.projects.length, 1)
    assert.equal(projectsBody.projects[0].workspaceId, 'ws-1')
    assert.equal(projectsBody.projects[0].initialized, true)
    assert.equal(projectsBody.projects[0].stage.key, 'S1')
    assert.equal(projectsBody.projects[0].pendingDecisions, 0)

    const snapshot = await callApi(route, { url: API + '/snapshot?root=' + encodeURIComponent(project.root) })
    assert.equal(snapshot.statusCode, 200)
    const body = snapshot.json()
    assert.equal(body.initialized, true)
    assert.ok(body.revision >= 1)
    assert.equal(body.stages.length, 7)
    assert.equal(body.tree.length, 7)
    assert.equal(body.project.name, '测试项目')
    const stage1 = body.tree[0]
    assert.equal(stage1.stage.key, 'S1')
    assert.equal(stage1.slices.length, 1)
    assert.equal(stage1.slices[0].slice.key, 'payment')
    assert.equal(stage1.slices[0].counts.tasks, 0)
    assert.deepEqual(stage1.slices[0].tasks, [], '树默认不展开子对象（用 counts 汇总）')
    assert.ok(Array.isArray(body.recentTimeline))
  } finally {
    project.cleanup()
  }
})

test('未初始化 workspace 的 /snapshot 返回 initialized:false', async () => {
  const otherRoot = makeWorkspaceRoot()
  const project = newProject()
  try {
    project.ensure()
    project.workspaces.push({ id: 'ws-empty', path: otherRoot, title: '空项目', sessionIds: [] })
    const route = registerAuthorized(project)
    const res = await callApi(route, { url: API + '/snapshot?root=' + encodeURIComponent(otherRoot) })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.initialized, false)
    assert.equal(body.revision, 0)
    assert.deepEqual(body.tree, [])
    assert.deepEqual(body.stages, [])
  } finally {
    project.cleanup()
    safeRemove(otherRoot)
  }
})

test('GET /slice /doc /timeline 返回全量子对象与内容预览', async () => {
  const project = newProject()
  try {
    const db = project.ensure()
    const slice = createSlice(db, { type: 'workitem', key: 'payment', title: '支付退款' })
    const doc = createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/payment', title: '支付 PRD', stage: 'S1' })
    writeDocumentVersion(db, { docId: doc.id, content: '# 支付 PRD\n\n支持原路退款。', authorSession: 'dsh-1' })
    const route = registerAuthorized(project)

    const detail = await callApi(route, { url: API + '/slice?id=' + slice.id + '&root=' + encodeURIComponent(project.root) })
    assert.equal(detail.statusCode, 200)
    const detailBody = detail.json()
    assert.equal(detailBody.slice.id, slice.id)
    assert.equal(detailBody.stageKey, 'S1')
    assert.equal(detailBody.documents.length, 1)
    assert.equal(detailBody.documents[0].currentVersion, 1)
    assert.ok(Array.isArray(detailBody.recentTimeline))

    const preview = await callApi(route, { url: API + '/doc?id=' + doc.id + '&root=' + encodeURIComponent(project.root) })
    assert.equal(preview.statusCode, 200)
    const previewBody = preview.json()
    assert.equal(previewBody.version, 1)
    assert.match(previewBody.content, /支持原路退款/)
    assert.equal(previewBody.frozen, false)
    assert.equal(previewBody.versions.length, 1)

    const timeline = await callApi(route, { url: API + '/timeline?root=' + encodeURIComponent(project.root) + '&limit=5' })
    assert.equal(timeline.statusCode, 200)
    const timelineBody = timeline.json()
    assert.ok(timelineBody.events.length >= 1)
    assert.ok(timelineBody.events.some((event) => event.kind === 'doc/version'))
    assert.ok(timelineBody.revision >= timelineBody.events[0].seq)

    const missing = await callApi(route, { url: API + '/slice?id=nope&root=' + encodeURIComponent(project.root) })
    assert.equal(missing.statusCode, 404)
    assert.equal(missing.json().error.code, 'NOT_FOUND')
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 决策 / 门禁
// ---------------------------------------------------------------------------

function seedGate(project) {
  const db = project.db
  const slice = createSlice(db, { type: 'workitem', key: 'payment', title: '支付退款' })
  const doc = createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/payment', title: '支付 PRD', stage: 'S1' })
  writeDocumentVersion(db, { docId: doc.id, content: '# 支付 PRD\n\n支持原路退款。', authorSession: 'dsh-1' })
  const decision = createDecision(db, {
    sliceId: slice.id,
    kind: 'gate',
    title: 'G1 产品门禁',
    question: 'PRD 是否可以进入 UX？',
    options: ['批准', '驳回'],
    recommended: '批准',
    consequences: '批准后 PRD 冻结并导出，阶段推进到 S2。',
    irreversible: true,
    stage: 'S1',
    gate: 'G1',
    createdBy: 'pm',
  })
  // 与 gate_submit 一致：提交快照钉住「提交时那一组文档的版本 + hash」。
  // 批准时按这份快照冻结/导出，而不是按 stage/slice 现场重查（P1 修复的契约）。
  const versionRow = db.db.prepare('SELECT content_hash FROM doc_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(doc.id)
  db.db.prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('appr_seed_gate', db.projectId, 'S1', 'G1', decision.id, 'pending', '[]',
      JSON.stringify({ decisionId: decision.id, gate: 'G1', stage: 'S1', docIds: [doc.id], docVersions: [{ docId: doc.id, version: 1, hash: versionRow ? versionRow.content_hash : null }], evidenceIds: [] }),
      null, null)
  return { slice, doc, decision }
}

test('不可逆决策缺少 confirmed → 409 CONFIRM_REQUIRED 且不改库', async () => {
  const project = newProject()
  try {
    project.ensure()
    seedGate(project)
    bindPmSession(project.db, { dshSessionId: 'dsh-pm' })
    const route = registerAuthorized(project)
    const before = project.db.revision()
    const res = await callApi(route, {
      method: 'POST',
      url: API + '/decision',
      body: { root: project.root, id: 'whatever', status: 'approved' },
    })
    assert.equal(res.statusCode, 404)
    const gateDecision = project.db.db.prepare("SELECT id FROM decisions WHERE kind = 'gate'").get()
    const res2 = await callApi(route, {
      method: 'POST',
      url: API + '/decision',
      body: { root: project.root, id: gateDecision.id, status: 'approved', rationale: '直接批' },
    })
    assert.equal(res2.statusCode, 409)
    assert.equal(res2.json().error.code, 'CONFIRM_REQUIRED')
    assert.equal(project.db.revision(), before, '缺少二次确认时不能写任何事件')
    const stillPending = project.db.db.prepare('SELECT status FROM decisions WHERE id = ?').get(gateDecision.id)
    assert.equal(stillPending.status, 'pending')
  } finally {
    project.cleanup()
  }
})

test('门禁批准：冻结+导出+阶段推进+approvals+唤醒 PM；驳回不改阶段', async () => {
  const project = newProject()
  try {
    project.ensure()
    const { doc, decision } = seedGate(project)
    bindPmSession(project.db, { dshSessionId: 'dsh-pm' })
    const calls = []
    project.ctx.agentsMap.set('dsh-pm', {
      status: 'idle',
      followup(message) { calls.push({ delivery: 'followup', message }) },
      steer(message) { calls.push({ delivery: 'steer', message }) },
    })
    const route = registerAuthorized(project)

    const res = await callApi(route, {
      method: 'POST',
      url: API + '/decision',
      body: { root: project.root, id: decision.id, status: 'approved', rationale: 'PRD 通过', confirmed: true },
    })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.decision.status, 'approved')
    assert.equal(body.actions.stage.from, 'S1')
    assert.equal(body.actions.stage.to, 'S2')
    assert.equal(body.actions.frozenDocs.length, 1)
    assert.equal(body.actions.exports.length, 1)

    const stages = overview(project.db).stages
    assert.equal(stages[0].status, 'done')
    assert.equal(stages[1].status, 'active')

    const frozen = project.db.db.prepare('SELECT status FROM documents WHERE id = ?').get(doc.id)
    assert.equal(frozen.status, 'frozen')
    const exportedPath = join(project.root, 'docs', 'product', 'prd-payment.md')
    assert.ok(existsSync(exportedPath), '门禁批准应把文档导出到 docs/product/')
    assert.match(readFileSync(exportedPath, 'utf8'), /generated: true/)

    const approval = project.db.db.prepare('SELECT * FROM approvals ORDER BY rowid DESC LIMIT 1').get()
    assert.equal(approval.status, 'approved')
    assert.equal(approval.decision_id, decision.id)
    const kinds = project.db.listEvents({ limit: 100 }).map((event) => event.kind)
    assert.ok(kinds.includes('gate/approve'))
    assert.ok(kinds.includes('stage/change'))
    assert.ok(kinds.includes('doc/freeze'))
    assert.ok(kinds.includes('doc/export'))
    assert.equal(calls.length, 1, '决策落定后应唤醒 PM 会话')
    assert.equal(calls[0].delivery, 'followup')
    assert.equal(calls[0].message.role, 'user')
    assert.equal(calls[0].message.source.kind, 'project-workbench')
    assert.match(calls[0].message.content[0].text, /G1/)

    // 驳回一个不可逆非门禁决策：阶段不推进
    const second = createDecision(project.db, {
      kind: 'decision', title: '是否引入新依赖', question: '可以吗', options: ['可以', '不可以'],
      irreversible: true, stage: 'S2', gate: 'G2', createdBy: 'pm',
    })
    const reject = await callApi(route, {
      method: 'POST',
      url: API + '/decision',
      body: { root: project.root, id: second.id, status: 'rejected', rationale: '不引入', confirmed: true },
    })
    assert.equal(reject.statusCode, 200)
    assert.equal(reject.json().decision.status, 'rejected')
    const stagesAfter = overview(project.db).stages
    assert.equal(stagesAfter[1].status, 'active', '驳回决策不应推进阶段')
  } finally {
    project.cleanup()
  }
})

test('门禁驳回写 gate/reject 事件且阶段不变', async () => {
  const project = newProject()
  try {
    project.ensure()
    const { decision } = seedGate(project)
    bindPmSession(project.db, { dshSessionId: 'dsh-pm' })
    const route = registerAuthorized(project)
    const res = await callApi(route, {
      method: 'POST',
      url: API + '/decision',
      body: { root: project.root, id: decision.id, status: 'rejected', rationale: '信息不足', confirmed: true },
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().decision.status, 'rejected')
    const stages = overview(project.db).stages
    assert.equal(stages[0].status, 'active')
    const kinds = project.db.listEvents({ limit: 100 }).map((event) => event.kind)
    assert.ok(kinds.includes('gate/reject'))
    // 没绑 PM live agent 时不应报错，只是无法唤醒
    const wake = res.json().wake
    assert.equal(wake.woke, false)
    assert.equal(wake.reason, 'no-live-pm-agent')
  } finally {
    project.cleanup()
  }
})

test('PM 会话绑定/切换：旧 PM 结束、新 PM 激活，重复绑定幂等', async () => {
  const project = newProject()
  try {
    project.ensure()
    const route = registerAuthorized(project)
    const first = await callApi(route, {
      method: 'POST', url: API + '/pm', body: { root: project.root, dshSessionId: 'dsh-pm-1' },
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().session.kind, 'pm')
    assert.equal(first.json().session.status, 'active')
    const again = await callApi(route, {
      method: 'POST', url: API + '/pm', body: { root: project.root, dshSessionId: 'dsh-pm-1' },
    })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().session.id, first.json().session.id, '重复绑定同一 dsh 会话不应新建行')
    const switched = await callApi(route, {
      method: 'POST', url: API + '/pm', body: { root: project.root, dshSessionId: 'dsh-pm-2' },
    })
    assert.equal(switched.statusCode, 200)
    const actives = project.db.db.prepare("SELECT * FROM sessions WHERE kind = 'pm' AND status = 'active'").all()
    assert.equal(actives.length, 1)
    assert.equal(actives[0].dsh_session_id, 'dsh-pm-2')
    const ended = project.db.db.prepare("SELECT * FROM sessions WHERE dsh_session_id = 'dsh-pm-1'").get()
    assert.equal(ended.status, 'ended')
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('SSE /events：订阅 bus、收到 change、断开后清理', async () => {
  const project = newProject()
  try {
    project.ensure()
    const bus = createBus()
    let subscribeCount = 0
    const originalSubscribe = bus.subscribe
    bus.subscribe = (root, listener) => {
      subscribeCount += 1
      return originalSubscribe(root, listener)
    }
    const route = registerAuthorized(project, bus)
    const workspace = project.registry.rootForWorkspace('ws-1')
    const req = makeReq({ url: API + '/events?root=' + encodeURIComponent(project.root) + '&after=0' })
    const res = makeRes()
    await route.handler(req, res)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    assert.equal(HEARTBEAT_MS, 25000)
    assert.ok(subscribeCount >= 1, 'SSE 应订阅 bus')
    const before = res.chunks.length

    bus.emit(workspace.root, { revision: 1234 })
    assert.ok(res.chunks.length > before, 'bus 变更应推送到 SSE')
    assert.ok(res.chunks.some((chunk) => chunk.includes('"revision":1234')))

    res.emit('close')
    const afterClose = res.chunks.length
    bus.emit(workspace.root, { revision: 4321 })
    assert.equal(res.chunks.length, afterClose, '断开后不应再推送')
    bus.close()
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 路由表
// ---------------------------------------------------------------------------

test('未知路由 404、方法不允许 405、非法 JSON 400', async () => {
  const project = newProject()
  try {
    project.ensure()
    const route = registerAuthorized(project)
    const notFound = await callApi(route, { url: API + '/nope' })
    assert.equal(notFound.statusCode, 404)
    assert.equal(notFound.json().error.code, 'NOT_FOUND')

    const wrongMethod = await callApi(route, { method: 'POST', url: API + '/projects', body: {} })
    assert.equal(wrongMethod.statusCode, 405)
    assert.equal(wrongMethod.headers.allow, 'GET')

    const badJsonReq = makeReq({ method: 'POST', url: API + '/init', headers: { 'content-type': 'application/json' } })
    const badJsonRes = makeRes()
    const pending = route.handler(badJsonReq, badJsonRes)
    setImmediate(() => { badJsonReq.emit('data', Buffer.from('{not json')); badJsonReq.emit('end') })
    await pending
    assert.equal(badJsonRes.statusCode, 400)

    const forbidden = await callApi(route, { url: API + '/snapshot?root=' + encodeURIComponent('C:/definitely/not/registered') })
    assert.equal(forbidden.statusCode, 403)
    assert.equal(forbidden.json().error.code, 'NOT_REGISTERED_WORKSPACE')
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

test('POST /init 初始化项目并返回 overview；重复调用幂等', async () => {
  const root = makeWorkspaceRoot()
  const ctx = fakeCtx([{ id: 'ws-init', path: root, title: '新项目', sessionIds: [] }], { rejection: undefined })
  const registry = createRegistry(ctx)
  try {
    registerHttp(ctx, registry, undefined)
    const route = getRoute(ctx)
    const res = await callApi(route, { method: 'POST', url: API + '/init', body: { root } })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.initialized, true)
    assert.equal(body.overview.stages.length, 7)
    assert.equal(body.overview.project.name, '新项目')
    const revision = body.revision
    assert.ok(revision >= 2)
    const again = await callApi(route, { method: 'POST', url: API + '/init', body: { root } })
    assert.equal(again.statusCode, 200)
    assert.equal(again.json().revision, revision, '重复初始化不应新增事件')
  } finally {
    registry.closeAll()
    safeRemove(root)
  }
})

test('registry.open(root,{create:true}) 等价 ensure 且幂等复用', () => {
  const project = newProject()
  try {
    const db = project.registry.open('ws-1', { create: true })
    assert.ok(db && db.projectId, 'open({create:true}) 应初始化项目库')
    assert.ok(existsSync(projectPaths(project.root).dbPath), 'project.db 应在 store')
    assert.equal(project.registry.open('ws-1', { create: true }), db, '重复 open 应复用句柄')
    assert.equal(overview(db).stages.length, 7)
  } finally {
    project.cleanup()
  }
})

test('SSE 插件卸载 dispose 关闭流并取消订阅；bus 数字 revision 也可推送', async () => {
  const project = newProject()
  try {
    project.ensure()
    const bus = createBus()
    const route = registerAuthorized(project, bus)
    const workspace = project.registry.rootForWorkspace('ws-1')
    const req = makeReq({ url: API + '/events?root=' + encodeURIComponent(project.root) + '&after=0' })
    const res = makeRes()
    await route.handler(req, res)
    const before = res.chunks.length
    bus.emit(workspace.root, 77)
    assert.ok(res.chunks.length > before)
    assert.ok(res.chunks.some((chunk) => chunk.includes('"revision":77')), 'bus.emit(root, number) 也应被规范化')
    const afterEvent = res.chunks.length
    assert.equal(project.ctx.effects.length, 1, 'registerHttp 应注册一个 effect disposer')
    project.ctx.effects[0]()
    assert.equal(res.writableEnded, true, '插件卸载时应关闭 SSE 流')
    bus.emit(workspace.root, 88)
    assert.equal(res.chunks.length, afterEvent, '卸载后不应再推送')
    bus.close()
  } finally {
    project.cleanup()
  }
})
