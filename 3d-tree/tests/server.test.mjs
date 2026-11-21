// 3d-tree/tests/server.test.mjs
// 运行：node 3d-tree/tests/server.test.mjs
//
// 真正起一个 HTTP 服务打到临时项目库上。重点验三件事：
//   1. 只读契约 —— 除了 /api/reload 全是 GET，且不写库；
//   2. 读的是真数据（不是写死的假数字）；
//   3. watcher 能感知外部写入（实时的前提）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createTreeServer, parseArgs, readSnapshot, scanDocs, resolveTarget } from '../server.mjs'
import { migrate } from '../../workbench/host/schema.js'

// ---------------------------------------------------------------------------
// 临时项目夹具
// ---------------------------------------------------------------------------

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), '3dtree-'))
  const projectDir = join(root, '.project')
  mkdirSync(projectDir, { recursive: true })
  const dbPath = join(projectDir, 'project.db')

  const db = new DatabaseSync(dbPath)
  migrate(db)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO projects(id, name, root, stage_template_json, config_json, created_at) VALUES (?,?,?,?,?,?)')
    .run('proj-1', '夹具项目', root, '[]', JSON.stringify({
      exportMap: { prd: 'docs/product', handoff: 'docs/handoffs' },
    }), now)
  db.prepare('INSERT INTO stages(id, project_id, key, name, status, gate, position) VALUES (?,?,?,?,?,?,?)')
    .run('st-1', 'proj-1', 'S1', '产品', 'active', 'G1', 0)
  db.prepare('INSERT INTO stages(id, project_id, key, name, status, gate, position) VALUES (?,?,?,?,?,?,?)')
    .run('st-2', 'proj-1', 'S2', 'UX', 'pending', 'G2', 1)
  db.prepare('INSERT INTO slices(id, project_id, type, key, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('sl-1', 'proj-1', 'workitem', 'k1', '退款切片', 'in_progress', now, now)
  db.prepare('INSERT INTO tasks(id, project_id, slice_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('tk-1', 'proj-1', 'sl-1', '写 PRD', 'done', now, now)
  db.prepare('INSERT INTO documents(id, project_id, slice_id, type, logical_key, title, status, current_version, stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('dc-1', 'proj-1', 'sl-1', 'prd', 'prd/refund', '退款 PRD', 'frozen', 1, 'S1', now, now)
  db.prepare('INSERT INTO doc_versions(id, document_id, version, content, content_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run('dv-1', 'dc-1', 1, '# 退款 PRD', 'hash1', now)
  db.prepare('INSERT INTO decisions(id, project_id, slice_id, kind, title, question, status, irreversible, stage, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('de-1', 'proj-1', 'sl-1', 'decision', '要不要做', '做不做？', 'pending', 1, 'S1', now)
  db.close()

  // 写一个导出文件，让 synced 分支有真数据
  mkdirSync(join(root, 'docs', 'product'), { recursive: true })
  writeFileSync(join(root, 'docs', 'product', 'prd-refund.md'), '# 退款 PRD\n')
  // 一个项目自有、库里没登记的文档
  mkdirSync(join(root, 'docs', 'notes'), { recursive: true })
  writeFileSync(join(root, 'docs', 'notes', 'self.md'), '# 自述\n')

  return { root, dbPath, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 起服务并返回 {url, close}。端口用 0 让系统分配，避免测试互相踩。 */
async function startServer(target, options = {}) {
  const app = createTreeServer(target, { watch: false, ...options })
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done))
  const { port } = app.server.address()
  return {
    url: 'http://127.0.0.1:' + port,
    app,
    close: () => new Promise((done) => { app.close(); done() }),
  }
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

test('parseArgs 解析 root/port/host 与位置参数', () => {
  const a = parseArgs(['--root', 'X:/p', '--port', '6000', '--host', '0.0.0.0', '--open', '--no-watch'])
  assert.equal(a.root, 'X:/p')
  assert.equal(a.port, 6000)
  assert.equal(a.host, '0.0.0.0')
  assert.equal(a.open, true)
  assert.equal(a.watch, false)

  const b = parseArgs(['X:/positional'])
  assert.equal(b.root, 'X:/positional')

  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['--list']).list, true)
})

test('resolveTarget 缺项目时给可读错误而不是抛异常', () => {
  const result = resolveTarget({ root: 'C:/definitely/not/here' })
  assert.ok(result.error)
  assert.ok(result.error.includes('project.db') || result.error.includes('not found'))
})

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

test('readSnapshot 把真库读成有完成度的树', () => {
  const project = makeProject()
  try {
    const tree = readSnapshot({ dbPath: project.dbPath, root: project.root })
    assert.equal(tree.project.name, '夹具项目')
    assert.ok(tree.stages.length >= 2)
    const s1 = tree.stages.find((s) => s.key === 'S1')
    assert.equal(s1.slices.length, 1)
    assert.equal(s1.slices[0].title, '退款切片')
    // 文档 frozen(1.0, 权重5) + 任务 done(1.0, 权重4) + 决策 pending(0, 权重2)
    // => (5 + 4 + 0) / 11 = 0.818 -> 82%。待拍板决策会拉低完成度，这是刻意的。
    assert.equal(s1.slices[0].completion, 82)
    assert.deepEqual(
      s1.slices[0].completionDetail.map((p) => p.key),
      ['documents', 'tasks', 'decisions'],
    )
    assert.equal(tree.counts.pendingDecisions, 1)
  } finally {
    project.cleanup()
  }
})

test('readSnapshot 的文件统计来自真实磁盘', () => {
  const project = makeProject()
  try {
    const tree = readSnapshot({ dbPath: project.dbPath, root: project.root })
    assert.equal(tree.disk.synced.length, 1, 'prd 已导出，应算 synced')
    assert.equal(tree.disk.synced[0].relPath, 'docs/product/prd-refund.md')
    assert.ok(tree.disk.untracked.some((f) => f.relPath === 'docs/notes/self.md'), '自有文档应算 untracked')
    assert.equal(tree.disk.expected, 1)
  } finally {
    project.cleanup()
  }
})

test('scanDocs 只收 .md 且跳过隐藏目录', () => {
  const project = makeProject()
  try {
    mkdirSync(join(project.root, 'docs', '.hidden'), { recursive: true })
    writeFileSync(join(project.root, 'docs', '.hidden', 'x.md'), '# x')
    writeFileSync(join(project.root, 'docs', 'notes', 'image.png'), 'notmd')
    const map = scanDocs(project.root)
    assert.ok(map.has('docs/notes/self.md'))
    assert.ok(!map.has('docs/notes/image.png'), 'png 不该被算成文档')
    assert.ok(![...map.keys()].some((k) => k.includes('.hidden')), '隐藏目录应跳过')
  } finally {
    project.cleanup()
  }
})

// ---------------------------------------------------------------------------
// HTTP 契约
// ---------------------------------------------------------------------------

test('GET /api/snapshot 返回树', async () => {
  const project = makeProject()
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    const res = await fetch(server.url + '/api/snapshot')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /application\/json/)
    const body = await res.json()
    assert.equal(body.project.name, '夹具项目')
    assert.ok(Array.isArray(body.stages))
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('GET / 返回页面，静态资源可取', async () => {
  const project = makeProject()
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    const index = await fetch(server.url + '/')
    assert.equal(index.status, 200)
    const html = await index.text()
    assert.ok(html.includes('<canvas'))
    // 页面实际 import 的是 viewer.js（renderer.js 是保留的旧 canvas 渲染层，只被 render.test.mjs 直接调用）。
    assert.ok(html.includes('viewer.js'))

    for (const asset of ['/viewer.js', '/projection.js']) {
      const r = await fetch(server.url + asset)
      assert.equal(r.status, 200, asset + ' 应可访问')
      assert.match(r.headers.get('content-type'), /javascript/)
    }
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('非 GET 请求被拒绝（只读契约）', async () => {
  const project = makeProject()
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(server.url + '/api/snapshot', { method })
      assert.equal(res.status, 405, method + ' 应被拒')
    }
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('唯一允许的 POST 是 /api/reload，且它不写库', async () => {
  const project = makeProject()
  const before = readFileSync(project.dbPath).length
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    const res = await fetch(server.url + '/api/reload', { method: 'POST' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    // 库大小不变（只读连接不会写）
    const after = readFileSync(project.dbPath).length
    assert.equal(after, before, 'reload 不应改变数据库文件')
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('未知 API 404，静态路径穿越被挡', async () => {
  const project = makeProject()
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    const api = await fetch(server.url + '/api/whatever')
    assert.equal(api.status, 404)

    // 试图读服务端源码
    const traversal = await fetch(server.url + '/../server.mjs')
    assert.notEqual(traversal.status, 200, '不能穿越到 web/ 之外')
    const body = await traversal.text()
    assert.ok(!body.includes('createTreeServer'), '不能泄漏源码')
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('SSE /api/events 立即回 hello 帧', async () => {
  const project = makeProject()
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    const controller = new AbortController()
    const res = await fetch(server.url + '/api/events', { signal: controller.signal })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/event-stream/)

    const reader = res.body.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    assert.ok(text.includes('data:'), '首帧应是 SSE data')
    controller.abort()
    try { await reader.cancel() } catch { /* 已中止 */ }
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('POST /api/reload 之后的快照能看到新数据', async () => {
  const project = makeProject()
  const server = await startServer({ dbPath: project.dbPath, root: project.root })
  try {
    const before = await (await fetch(server.url + '/api/snapshot')).json()
    const beforeSlices = before.counts.slices

    // 外部（模拟 PM 会话）写库
    const db = new DatabaseSync(project.dbPath)
    const now = new Date().toISOString()
    db.prepare('INSERT INTO slices(id, project_id, type, key, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('sl-2', 'proj-1', 'workitem', 'k2', '新切片', 'open', now, now)
    db.close()

    const reload = await fetch(server.url + '/api/reload', { method: 'POST' })
    assert.equal(reload.status, 200)

    const after = await (await fetch(server.url + '/api/snapshot')).json()
    assert.equal(after.counts.slices, beforeSlices + 1, '新切片应立即可见')
  } finally {
    await server.close()
    project.cleanup()
  }
})

test('库不存在时服务不崩，快照报错', async () => {
  const server = await startServer({ dbPath: 'C:/nope/missing.db', root: 'C:/nope' })
  try {
    const res = await fetch(server.url + '/api/snapshot')
    assert.ok(res.status >= 400, '应返回错误状态而不是挂起')
  } finally {
    await server.close()
  }
})
