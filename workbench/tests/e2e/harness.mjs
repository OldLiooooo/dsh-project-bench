// T5 verify 共享测试夹具：fake Cordis ctx、临时项目根、host 模块加载、断言与报告。
// 只依赖 node: 内置模块；可被 tests/unit/*.test.mjs 与 tests/e2e/* 复用，
// 也可以被 PTC run_code 直接 import 做 in-process 验证（bash 不可用时的验算路径）。
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as requestHttp } from 'node:http'
import { createServer } from 'node:http'
import { Socket } from 'node:net'
import { dirname, join, resolve, isAbsolute, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

export const E2E_DIR = dirname(fileURLToPath(import.meta.url))

// M0 之后权威数据默认落在 $DSH_HOME/storages/（agent 物理碰不到的物理单写）。
// 但**测试进程本身**跑在会话沙箱里，写 ~/.dsh 会 EPERM。测试必须把 DSH_HOME 指到工作区内，
// 否则测的不是插件行为，而是沙箱行为。真实 Host 插件进程不受此限制（裸 node:fs）。
// 想验证「local 兼容模式」的用例可以自行覆盖 PROJECT_WORKBENCH_STORE。
if (!process.env.DSH_HOME || process.env.DSH_HOME === '') {
  process.env.DSH_HOME = join(dirname(fileURLToPath(import.meta.url)), '.artifacts', 'dshhome')
}
if (process.env.PROJECT_WORKBENCH_STORE === undefined) {
  // 测试默认沿用生产语义（home），只是把 home 指到工作区内。
}
export const WORKBENCH_ROOT = resolve(E2E_DIR, '..', '..')
export const WORKSPACE_ROOT = resolve(WORKBENCH_ROOT, '..')
export const ARTIFACTS_DIR = join(E2E_DIR, '.artifacts')
export const TMP_ROOT = join(ARTIFACTS_DIR, 'tmp')
export const KEEP_TMP = process.env.WORKBENCH_E2E_KEEP === '1'

// host 模块清单：name -> workbench 相对路径（缺失时按 optional/required 分类处理）。
export const HOST_MODULES = {
  db: 'host/db.js',
  schema: 'host/schema.js',
  util: 'host/util.js',
  bus: 'host/bus.js',
  defaults: 'host/project-defaults.js',
  store: 'host/store.js',
  docs: 'host/docs.js',
  leases: 'host/leases.js',
  export: 'host/export.js',
  import: 'host/import.js',
  registry: 'host/registry.js',
  project: 'host/project.js',
  snapshot: 'host/snapshot.js',
  http: 'host/http.js',
  context: 'host/context.js',
  roles: 'host/roles.js',
  prompts: 'host/prompts.js',
  tools: 'host/tools/index.js',
  sessionHooks: 'host/session-hooks.js',
  skills: 'host/skills.js',
  cards: 'host/cards.js',
}

const trackedTmp = []

export function ensureDir(path) { mkdirSync(path, { recursive: true }); return path }

/** 在 .artifacts/tmp 下建立一次性目录；默认随 cleanupTracked 清理，KEEP 时保留。 */
export function makeTempDir(prefix = 'run') {
  ensureDir(TMP_ROOT)
  const dir = mkdtempSync(join(TMP_ROOT, prefix + '-'))
  trackedTmp.push(dir)
  return dir
}

/** 建一个“项目工作区”临时根（含 .project 目录占位）。 */
export function makeTempProject(prefix = 'project') {
  const root = makeTempDir(prefix)
  ensureDir(join(root, '.project'))
  return root
}

export function cleanupTracked() {
  if (KEEP_TMP) {
    if (trackedTmp.length > 0) console.error('[harness] keep temp dirs:\n' + trackedTmp.join('\n'))
    return trackedTmp.length
  }
  let removed = 0
  for (const dir of trackedTmp.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); removed += 1 } catch { /* Windows 句柄占用时下次再删 */ }
  }
  return removed
}

/** 导入 workbench/host 下的真实模块；返回 { modules, missing, errors }。 */
export async function loadHostModules() {
  const modules = {}
  const missing = []
  const errors = []
  for (const [name, rel] of Object.entries(HOST_MODULES)) {
    const file = join(WORKBENCH_ROOT, rel)
    if (!existsSync(file)) { missing.push(name); continue }
    try {
      modules[name] = await import(pathToFileURL(file).href)
    } catch (error) {
      errors.push({ name, file, error })
    }
  }
  return { modules, missing, errors }
}

export function hostFile(rel) { return join(WORKBENCH_ROOT, rel) }

export function isMain(importMetaUrl) {
  const entry = process.argv[1]
  if (!entry) return false
  try { return pathToFileURL(resolve(entry)).href === importMetaUrl } catch { return false }
}

/** 断言：条件为假时抛出带上下文的错误。 */
export function expect(condition, message) {
  if (!condition) throw new Error('expect failed: ' + message)
}

export function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error('expect equal failed: ' + message + '\n  actual:   ' + JSON.stringify(actual) + '\n  expected: ' + JSON.stringify(expected))
  }
}

export function expectDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error('expect deep equal failed: ' + message + '\n  actual:   ' + a + '\n  expected: ' + b)
}

/** 期待 fn 抛出错误；给了 code 时校验 error.code。返回捕获的错误。 */
export function expectThrows(fn, code, message) {
  let caught
  try { fn() } catch (error) { caught = error }
  if (caught === undefined) throw new Error('expect throw failed: ' + message)
  if (code !== undefined && caught.code !== code) {
    throw new Error('expect throw code failed: ' + message + '\n  expected code: ' + code + '\n  actual code:   ' + String(caught.code) + '\n  message: ' + String(caught.message))
  }
  return caught
}

export async function expectRejects(fn, code, message) {
  let caught
  try { await fn() } catch (error) { caught = error }
  if (caught === undefined) throw new Error('expect reject failed: ' + message)
  if (code !== undefined && caught.code !== code) {
    throw new Error('expect reject code failed: ' + message + '\n  expected code: ' + code + '\n  actual code:   ' + String(caught.code) + '\n  message: ' + String(caught.message))
  }
  return caught
}

export function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)) }

// ---------------------------------------------------------------------------
// fake Cordis ctx：记录插件注册结果；测试直接调用注册出来的工具/路由/提示注入。
// ---------------------------------------------------------------------------

/**
 * 创建 fake ctx。options:
 * - workspaces: [{id,path,title}] 供 ctx.workspaceRegistry.list() 使用；
 * - rejection: connection.requestRejection 的返回值（number）或 (req)=>number；
 * - services: 额外服务覆盖（如 agents/subagents 行为）。
 */
export function makeFakeCtx(options = {}) {
  const state = {
    tools: new Map(),
    toolOrder: [],
    prompts: { sections: [], contexts: [] },
    routes: [],
    skills: [],
    cards: [],
    hooks: new Map(),
    effects: [],
    logs: [],
    subagentCalls: [],
    agentCalls: [],
    services: new Map(),
    rejections: 0,
  }

  const log = (level) => (...args) => state.logs.push({ level, args: args.map((a) => (typeof a === 'string' ? a : safeJson(a))) })
  const logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }

  const workspaceEntities = (options.workspaces || []).map((w) => ({
    id: w.id,
    path: w.path,
    title: w.title || w.path,
    sessionIds: w.sessionIds || [],
    async status() { return 'ok' },
  }))

  const agentInstances = new Map()
  const getAgent = (id) => {
    if (!agentInstances.has(id)) {
      agentInstances.set(id, {
        id,
        messages: [],
        followup(msg) { agentInstances.get(id).messages.push({ kind: 'followup', msg }) },
        steer(msg) { agentInstances.get(id).messages.push({ kind: 'steer', msg }) },
      })
    }
    return agentInstances.get(id)
  }

  let childSeq = 0
  const services = {
    tools: {
      register(def, when) {
        expect(def && typeof def.name === 'string' && def.name.length > 0, 'tools.register 需要带 name 的定义')
        expect(typeof def.execute === 'function', '工具 ' + def.name + ' 需要 execute')
        state.tools.set(def.name, { def, when })
        state.toolOrder.push(def.name)
        return () => state.tools.delete(def.name)
      },
    },
    systemPrompt: {
      section(entry) { state.prompts.sections.push(entry); return () => {} },
      context(entry) { state.prompts.contexts.push(entry); return () => {} },
    },
    webServer: {
      protocol: 'http:',
      host: '127.0.0.1',
      port: 0,
      getOrigin() { return 'http://127.0.0.1:0' },
      register(route) {
        expect(route && typeof route.path === 'string', 'webServer.register 需要 path')
        expect(typeof route.handler === 'function', 'webServer.register 需要 handler')
        state.routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection(req) {
        state.rejections += 1
        return typeof options.rejection === 'function' ? options.rejection(req) : options.rejection
      },
      authenticatedUrl(url) { return url + (String(url).includes('?') ? '&' : '?') + 'token=test-token' },
    },
    workspaceRegistry: {
      // 契约 §0：list() 同步返回数组（registry 直接 Array.isArray 判断）。
      list() { return workspaceEntities.map((w) => ({ ...w })) },
    },
    skills: {
      register(skill) { state.skills.push(skill); return () => {} },
    },
    actionCards: {
      register(...args) { state.cards.push(args); return () => {} },
    },
    subagents: {
      async startActivation(spec) {
        // 按 DSH SubagentActivationSpec 真实契约校验：prompt/parent 在顶层，没有 request 包装层。
        // 假 ctx 若照单全收，插件传错形状也只有真机能发现（这就是 2026-11-23 线上派活全挂的成因）。
        if (spec && spec.request !== undefined) throw new Error('startActivation 收到了 request 包装层（DSH 只读 spec.parent/prompt）')
        if (!spec || !Array.isArray(spec.prompt) || spec.prompt.length === 0) throw new Error('startActivation 缺少顶层 prompt')
        if (!spec.parent || !spec.parent.session || typeof spec.parent.session.id !== 'string') throw new Error('startActivation 缺少顶层 parent.session.id')
        childSeq += 1
        const childId = spec.childId ? spec.childId : 'fake-child-' + String(childSeq)
        state.subagentCalls.push({ kind: 'startActivation', spec })
        return { childId, result: Promise.resolve({ text: 'fake subagent result' }), dispose() {} }
      },
      async sendMessage(agent, dshSessionId, content, delivery) {
        state.agentCalls.push({ kind: 'sendMessage', agent, dshSessionId, content, delivery })
      },
    },
    agents: {
      get(id) { return getAgent(id) },
    },
    sessions: options.sessionsService || {},
    layout: options.layoutService || {},
    locale: options.localeService || { register() { return () => {} }, t(key) { return key } },
    uiWorkspace: options.uiWorkspace || {},
    ...(options.services || {}),
  }

  const ctx = {
    state,
    logger,
    get(name) { return services[name] },
    provide(name, value) { services[name] = value; return value },
    inject(_deps, callback) { if (typeof _deps === 'function') { _deps(ctx) } else if (typeof callback === 'function') callback(ctx) },
    on(event, handler) {
      if (!state.hooks.has(event)) state.hooks.set(event, new Set())
      state.hooks.get(event).add(handler)
      return () => state.hooks.get(event)?.delete(handler)
    },
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      if (typeof dispose === 'function') state.effects.push(dispose)
      return dispose
    },
    plugin() {},
    emit(event, ...args) {
      for (const handler of state.hooks.get(event) || []) handler(...args)
      return args
    },
    // 测试便利：注册后的工具/路由查询
    tool(name) { const entry = state.tools.get(name); return entry ? entry.def : undefined },
    routeFor(pathname) {
      const exact = state.routes.find((r) => (r.kind === 'exact' || !r.kind) && r.path === pathname)
      if (exact) return exact
      const prefix = state.routes
        .filter((r) => r.kind === 'prefix' && pathname.startsWith(r.path))
        .sort((a, b) => b.path.length - a.path.length)[0]
      return prefix
    },
    async dispose() {
      for (const dispose of state.effects.splice(0)) { try { await dispose() } catch { /* ignore */ } }
    },
  }
  ctx.tools = services.tools
  ctx.systemPrompt = services.systemPrompt
  ctx.webServer = services.webServer
  ctx.connection = services.connection
  ctx.workspaceRegistry = services.workspaceRegistry
  ctx.skills = services.skills
  ctx.actionCards = services.actionCards
  ctx.subagents = services.subagents
  ctx.agents = services.agents
  ctx.sessions = services.sessions
  ctx.layout = services.layout
  ctx.locale = services.locale
  ctx.uiWorkspace = services.uiWorkspace
  return ctx
}

function safeJson(value) {
  try { return JSON.stringify(value) } catch { return String(value) }
}

/** 构造 tool execute 的第二参：exec.agent.session.id / header.cwd。 */
export function makeExec(input = {}) {
  const label = input.label || 'x'
  const session = {
    id: input.dshSessionId || 'dsh-test-' + label,
    header: { cwd: input.cwd, agentPreset: input.agentPreset },
  }
  const agent = { session }
  if (input.agentId) agent.id = input.agentId
  if (input.provider) session.provider = input.provider
  if (input.model) session.model = input.model
  return { agent, signal: input.signal }
}

/** 直接调用 fake ctx 里注册的工具（execute(args, exec)）。 */
export async function callTool(ctx, name, args, exec = makeExec()) {
  const def = ctx.tool(name)
  if (!def) throw new Error('tool not registered: ' + name)
  const value = await def.execute(args || {}, exec)
  return value
}

// ---------------------------------------------------------------------------
// 用 node:http 模拟 webServer：把 fake ctx 注册的路由真正挂到本机端口，供 HTTP/SSE 测试。
// ---------------------------------------------------------------------------

export function createRouteServer(ctx, options = {}) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const route = ctx.routeFor(url.pathname)
      if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return }
      await route.handler(req, res)
    } catch (error) {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('handler error: ' + String(error && error.message)) }
      else { try { res.end() } catch { /* ignore */ } }
      if (options.onError) options.onError(error)
    }
  })
  return new Promise((resolveP, rejectP) => {
    server.once('error', rejectP)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveP({ server, port: address.port, baseUrl: 'http://127.0.0.1:' + String(address.port) })
    })
  })
}

/** 原始 HTTP 请求（返回 status/headers/body text），供路由级测试使用。 */
export function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveP, rejectP) => {
    const req = requestHttp(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectP)
    req.setTimeout(20000, () => req.destroy(new Error('request timeout: ' + url)))
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

/**
 * 读取 SSE 首块：返回 {status, contentType, bodyPrefix, chunks, timedOut}。
 * 用于 http 路由级与真实实例级 SSE 冒烟（不依赖浏览器 EventSource）。
 */
export function readSse(url, { cookie, timeoutMs = 30000 } = {}) {
  return new Promise((resolveP) => {
    let settled = false
    let buffer = ''
    let timer
    let req
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try { req && req.destroy() } catch { /* ignore */ }
      resolveP(result)
    }
    req = requestHttp(url, { headers: cookie ? { cookie, accept: 'text/event-stream' } : { accept: 'text/event-stream' } }, (res) => {
      const result = { status: res.statusCode, contentType: String(res.headers['content-type'] || ''), bodyPrefix: '', chunks: 0, timedOut: false }
      if (res.statusCode !== 200) {
        res.setEncoding('utf8')
        res.on('data', (chunk) => { result.bodyPrefix += chunk })
        res.on('end', () => finish(result))
        return
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        result.chunks += 1
        buffer += chunk
        result.bodyPrefix = buffer.slice(0, 8000)
        if (buffer.includes('data:') || buffer.includes(': heartbeat')) finish(result)
      })
      res.on('end', () => finish(result))
    })
    req.on('error', (error) => finish({ status: 0, error: String(error && error.message) }))
    timer = setTimeout(() => { finish({ status: 200, contentType: '', bodyPrefix: buffer, chunks: 0, timedOut: true }) }, timeoutMs)
    req.end()
  })
}

/** 挑一个空闲端口（用于必须真实监听端口的测试）。 */
export function findFreePort() {
  return new Promise((resolveP, rejectP) => {
    const server = createServer()
    server.once('error', rejectP)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolveP(port))
    })
  })
}

export function portIsOpen(port, timeoutMs = 300) {
  return new Promise((resolveP) => {
    const socket = new Socket()
    let settled = false
    const done = (value) => { if (!settled) { settled = true; socket.destroy(); resolveP(value) } }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(port, '127.0.0.1')
  })
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

/**
 * cases: [{ name, fn, skip? }]，fn 可以为 async。
 * 返回 { title, passed, failed, skipped, results }；failed>0 时调用方应置退出码 1。
 */
export async function runCases(title, cases, options = {}) {
  const results = []
  const startedAt = Date.now()
  for (const item of cases) {
    if (item.skip) {
      results.push({ name: item.name, status: 'skip', reason: typeof item.skip === 'string' ? item.skip : '' })
      if (!options.quiet) console.log('SKIP  ' + item.name + (typeof item.skip === 'string' ? ' — ' + item.skip : ''))
      continue
    }
    try {
      await item.fn()
      results.push({ name: item.name, status: 'pass' })
      if (!options.quiet) console.log('PASS  ' + item.name)
    } catch (error) {
      results.push({ name: item.name, status: 'fail', error: error && error.stack ? String(error.stack) : String(error) })
      if (!options.quiet) console.error('FAIL  ' + item.name + '\n' + String((error && error.message) || error))
    }
  }
  const passed = results.filter((r) => r.status === 'pass').length
  const failed = results.filter((r) => r.status === 'fail').length
  const skipped = results.filter((r) => r.status === 'skip').length
  const summary = { title, passed, failed, skipped, total: results.length, durationMs: Date.now() - startedAt, results }
  if (!options.quiet) {
    console.log('\n[' + title + '] passed=' + String(passed) + ' failed=' + String(failed) + ' skipped=' + String(skipped) + ' in ' + String(summary.durationMs) + 'ms')
    if (failed > 0) console.log('RESULT: FAIL')
    else if (skipped > 0) console.log('RESULT: PASS (with skips)')
    else console.log('RESULT: PASS')
  }
  return summary
}

export function summaryExitCode(summary) { return summary.failed > 0 ? 1 : 0 }

/** 读取文件；不存在返回 undefined。 */
export function readText(file) {
  try { return readFileSync(file, 'utf8') } catch { return undefined }
}

/** 写 JSON 文件（测试夹具用）。 */
export function writeJson(file, value) {
  ensureDir(dirname(file))
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  return file
}

export function relativeToWorkspace(path) {
  return relative(WORKSPACE_ROOT, path)
}

export function isAbsolutePath(path) { return isAbsolute(path) }