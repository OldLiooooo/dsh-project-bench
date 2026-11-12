// 客户端数据通道（T2 host-api）：/project-workbench/api 前缀路由 + SSE 变更推送。
// 安全：每个 handler 第一行先过 ctx.connection.requestRejection(req)（Host/Origin 围栏 + 登录 cookie），
// 未认证一律 401/403；POST 只接受人的面板操作（初始化/决策拍板/PM 绑定），agent 没有写入口。
import { projectError } from './registry.js'
import { initProject, resolveDecisionAction, bindPmSession } from './project.js'
import { buildSnapshot, sliceDetail, docPreview, timelinePage } from './snapshot.js'

export const API_PREFIX = '/project-workbench/api'
export const HEARTBEAT_MS = 25000
const MAX_BODY_BYTES = 64 * 1024

const GET_ROUTES = new Set(['/', '/projects', '/snapshot', '/slice', '/doc', '/timeline', '/events'])
const POST_ROUTES = new Set(['/init', '/decision', '/pm'])

const STATUS_BY_CODE = {
  INVALID: 400,
  INVALID_ROOT: 400,
  MISSING_WORKSPACE: 400,
  MISSING_ROOT: 400,
  UNAUTHORIZED: 401,
  NOT_REGISTERED_WORKSPACE: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFIRM_REQUIRED: 409,
  NOT_INITIALIZED: 409,
  DOC_FROZEN: 409,
  LEASE_HELD: 409,
  DUPLICATE_ACTIVE_SESSION: 409,
  PAYLOAD_TOO_LARGE: 413,
  PROJECT_DB_ERROR: 500,
  DATA_LAYER_UNAVAILABLE: 503,
  WORKSPACE_REGISTRY_UNAVAILABLE: 503,
}

function statusOf(error) {
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) return error.status
  const mapped = STATUS_BY_CODE[error?.code]
  return mapped || 500
}

function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function sendError(res, error) {
  sendJson(res, statusOf(error), {
    error: {
      code: error?.code || 'INTERNAL',
      message: error?.message || 'internal error',
    },
  })
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed; allowed: ' + allow } }))
}

/** 前缀路由匹配：只接受 /project-workbench/api 与 /project-workbench/api/...。 */
function normalizeRoute(pathname) {
  if (pathname === API_PREFIX) return '/'
  if (pathname === API_PREFIX + '/') return '/'
  if (!pathname.startsWith(API_PREFIX + '/')) return null
  return pathname.slice(API_PREFIX.length)
}

/** 鉴权（fail-closed）：connection 服务不可用时也拒绝，而不是放行。 */
function rejectRequest(ctx, req, res) {
  const connection = ctx?.connection
  if (!connection || typeof connection.requestRejection !== 'function') {
    sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'connection service is not available; refusing unauthenticated access' } })
    return true
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch (error) {
    try { ctx?.logger?.warn?.('project-workbench: requestRejection failed: ' + error.message) } catch { /* logger 不可用 */ }
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'request rejected' } })
    return true
  }
  if (rejection === undefined || rejection === null || rejection === false || rejection === 0) return false
  const status = typeof rejection === 'number' ? rejection : 401
  sendJson(res, status, {
    error: {
      code: status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
      message: status === 403 ? 'request rejected by host/origin fence' : 'authentication required',
    },
  })
  return true
}

/** 读取有上限的请求体（超过上限直接 413，不把 body 读进内存）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const onData = (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        reject(projectError('PAYLOAD_TOO_LARGE', 'request body is too large', 413))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks, size).toString('utf8')) } }
    const onError = (error) => { if (!settled) { settled = true; reject(error) } }
    if (typeof req.on !== 'function') { onEnd(); return }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

async function readJsonBody(req) {
  const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
  if (contentType && contentType !== 'application/json') {
    throw projectError('INVALID', 'content-type must be application/json', 415)
  }
  const text = await readBody(req)
  if (!text || !text.trim()) throw projectError('INVALID', 'request body must be a JSON object')
  let parsed
  try { parsed = JSON.parse(text) } catch { throw projectError('INVALID', 'request body must be valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw projectError('INVALID', 'request body must be a JSON object')
  return parsed
}

function referenceOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function queryReference(query) {
  return referenceOf(query.get('root')) ?? referenceOf(query.get('workspaceId'))
}

function revisionOf(payload) {
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload
  if (payload && typeof payload.revision === 'number' && Number.isFinite(payload.revision)) return payload.revision
  return undefined
}

/**
 * 创建 API 实例（测试可直接调用 handler / 替换 ctx）。
 * @param {object} ctx 宿主 ctx（connection/webServer/agents/logger/effect）
 * @param {object} registry createRegistry(ctx) 的返回
 * @param {object} [bus] createBus() 的返回（SSE 订阅）
 */
export function createApi(ctx, registry, bus) {
  const streams = new Set()

  function emitChange(root, revision) {
    try { bus?.emit?.(root, { revision }) } catch (error) {
      try { ctx?.logger?.warn?.('project-workbench: bus emit failed: ' + error.message) } catch { /* logger 不可用 */ }
    }
  }

  function resolveProject(query) {
    const workspace = registry.rootForWorkspace(queryReference(query))
    return { workspace, db: registry.open(workspace.root) }
  }

  function requireProject(query) {
    const resolved = resolveProject(query)
    if (!resolved.db) throw projectError('NOT_INITIALIZED', 'project is not initialized: ' + resolved.workspace.root, 409)
    return resolved
  }

  // -------------------------------------------------------------------------
  // GET
  // -------------------------------------------------------------------------

  function handleProjects(res) {
    const projects = registry.listProjects().map((item) => ({
      workspaceId: item.workspaceId,
      root: item.root,
      title: item.title,
      exists: Boolean(item.exists),
      initialized: Boolean(item.exists),
      projectId: item.project?.id ?? null,
      name: item.project?.name ?? item.title,
      stage: item.project?.stage ?? null,
      pendingDecisions: item.project?.pendingDecisions ?? 0,
      revision: item.project?.revision ?? 0,
      error: item.error ?? null,
    }))
    sendJson(res, 200, { projects })
  }

  function handleSnapshot(url, res) {
    const { workspace, db } = resolveProject(url.searchParams)
    if (!db) {
      sendJson(res, 200, {
        initialized: false, revision: 0, project: null, stages: [], tree: [], truncated: false,
        sessions: [], pm: null, pendingDecisions: [], recentTimeline: [],
        root: workspace.root, workspaceId: workspace.workspaceId,
      })
      return
    }
    const limit = Number(url.searchParams.get('limit'))
    const snapshot = buildSnapshot(db, { root: workspace.root, timelineLimit: Number.isFinite(limit) && limit > 0 ? limit : undefined })
    sendJson(res, 200, { ...snapshot, root: workspace.root, workspaceId: workspace.workspaceId })
  }

  function handleSlice(url, res) {
    const { workspace, db } = requireProject(url.searchParams)
    const detail = sliceDetail(db, url.searchParams.get('id'))
    sendJson(res, 200, { ...detail, root: workspace.root, workspaceId: workspace.workspaceId })
  }

  function handleDoc(url, res) {
    const { workspace, db } = requireProject(url.searchParams)
    const version = url.searchParams.get('version')
    const preview = docPreview(db, url.searchParams.get('id'), { version: version === null ? undefined : version })
    sendJson(res, 200, { ...preview, root: workspace.root, workspaceId: workspace.workspaceId })
  }

  function handleTimeline(url, res) {
    const { workspace, db } = requireProject(url.searchParams)
    const after = Number(url.searchParams.get('after'))
    const limit = Number(url.searchParams.get('limit'))
    const kindsParam = url.searchParams.get('kinds')
    const kinds = kindsParam ? kindsParam.split(',').map((kind) => kind.trim()).filter(Boolean) : undefined
    const page = timelinePage(db, {
      afterSeq: Number.isFinite(after) && after > 0 ? after : 0,
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      kinds,
      sliceId: referenceOf(url.searchParams.get('sliceId')) ?? referenceOf(url.searchParams.get('slice')),
    })
    sendJson(res, 200, { ...page, root: workspace.root, workspaceId: workspace.workspaceId })
  }

  /** SSE：event: change / data:{revision}，25s 心跳，断连清理订阅。 */
  function handleEvents(req, res, url) {
    const { workspace, db } = resolveProject(url.searchParams)
    const after = Number(url.searchParams.get('after'))
    let lastSent = Number.isFinite(after) && after > 0 ? after : 0
    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-cache, no-transform')
    res.setHeader('connection', 'keep-alive')
    res.setHeader('x-accel-buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write('retry: 3000\n\n')
    const initial = db ? db.revision() : 0
    if (initial > lastSent) {
      lastSent = initial
      res.write('event: change\ndata: ' + JSON.stringify({ revision: initial }) + '\n\n')
    }
    const listener = (payload) => {
      if (res.writableEnded) return
      let revision = revisionOf(payload)
      if (revision === undefined) {
        try { revision = db ? db.revision() : lastSent + 1 } catch { revision = lastSent + 1 }
      }
      if (revision <= lastSent) return
      lastSent = revision
      res.write('event: change\ndata: ' + JSON.stringify({ revision }) + '\n\n')
    }
    // 订阅规范化根的多种等价写法，容忍 emitter 使用 realpath/大小写不同的 root。
    const roots = new Set([workspace.root])
    if (process.platform === 'win32') roots.add(workspace.root.toLowerCase())
    const unsubscribers = []
    for (const root of roots) {
      try {
        const off = bus?.subscribe?.(root, listener)
        if (typeof off === 'function') unsubscribers.push(off)
      } catch (error) {
        try { ctx?.logger?.warn?.('project-workbench: bus subscribe failed: ' + error.message) } catch { /* logger 不可用 */ }
      }
    }
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return
      try { res.write(': heartbeat\n\n') } catch { /* 连接已断 */ }
    }, HEARTBEAT_MS)
    if (typeof heartbeat.unref === 'function') heartbeat.unref()
    const entry = { close() {} }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      streams.delete(entry)
      for (const off of unsubscribers) { try { off() } catch { /* 已移除 */ } }
      try { if (!res.writableEnded) res.end() } catch { /* 已断开 */ }
    }
    entry.close = close
    streams.add(entry)
    if (typeof res.on === 'function') {
      res.on('close', close)
      res.on('error', close)
    }
    if (typeof req.on === 'function') {
      req.on('close', close)
      req.on('aborted', close)
    }
  }

  async function handleGet(route, url, req, res) {
    switch (route) {
      case '/':
        sendJson(res, 200, { ok: true, name: 'project-workbench', api: API_PREFIX, version: 1 })
        return
      case '/projects': handleProjects(res); return
      case '/snapshot': handleSnapshot(url, res); return
      case '/slice': handleSlice(url, res); return
      case '/doc': handleDoc(url, res); return
      case '/timeline': handleTimeline(url, res); return
      case '/events': handleEvents(req, res, url); return
      default:
        sendError(res, projectError('NOT_FOUND', 'unknown route: ' + route, 404))
    }
  }

  // -------------------------------------------------------------------------
  // POST（人操作）
  // -------------------------------------------------------------------------

  async function handlePost(route, req, res) {
    const body = await readJsonBody(req)
    const reference = referenceOf(body.root) ?? referenceOf(body.workspaceId)
    const workspace = registry.rootForWorkspace(reference)
    switch (route) {
      case '/init': {
        const overview = initProject(registry, { root: workspace.root, name: body.name })
        const db = registry.open(workspace.root)
        const revision = db ? db.revision() : 0
        emitChange(workspace.root, revision)
        sendJson(res, 200, { ok: true, initialized: true, root: workspace.root, workspaceId: workspace.workspaceId, overview, revision })
        return
      }
      case '/decision': {
        const db = registry.open(workspace.root)
        if (!db) throw projectError('NOT_INITIALIZED', 'project is not initialized: ' + workspace.root, 409)
        const json = registry.projectJson(workspace.root)
        const result = resolveDecisionAction(ctx, db, {
          id: body.id,
          status: body.status,
          rationale: body.rationale,
          confirmed: body.confirmed === true,
        }, { root: workspace.root, exportMap: json?.exportMap })
        emitChange(workspace.root, result.revision)
        sendJson(res, 200, { ok: true, root: workspace.root, workspaceId: workspace.workspaceId, decision: result.decision, actions: result.actions, wake: result.wake, revision: result.revision })
        return
      }
      case '/pm': {
        const db = registry.open(workspace.root)
        if (!db) throw projectError('NOT_INITIALIZED', 'project is not initialized: ' + workspace.root, 409)
        const session = bindPmSession(db, {
          dshSessionId: body.dshSessionId,
          name: body.name,
          provider: body.provider,
          model: body.model,
          reasoningEffort: body.reasoningEffort,
        })
        const revision = db.revision()
        emitChange(workspace.root, revision)
        sendJson(res, 200, { ok: true, root: workspace.root, workspaceId: workspace.workspaceId, session, revision })
        return
      }
      default:
        sendError(res, projectError('NOT_FOUND', 'unknown route: ' + route, 404))
    }
  }

  async function handler(req, res) {
    if (rejectRequest(ctx, req, res)) return
    try {
      const url = new URL(String(req.url || '/'), 'http://localhost')
      const route = normalizeRoute(url.pathname)
      if (route === null) { sendError(res, projectError('NOT_FOUND', 'unknown route: ' + url.pathname, 404)); return }
      const method = String(req.method || 'GET').toUpperCase()
      const knownGet = GET_ROUTES.has(route)
      const knownPost = POST_ROUTES.has(route)
      if (!knownGet && !knownPost) {
        sendError(res, projectError('NOT_FOUND', 'unknown route: ' + route, 404))
        return
      }
      if (method === 'GET' || method === 'HEAD') {
        if (!knownGet) { sendMethodNotAllowed(res, knownPost ? 'POST' : 'GET'); return }
        await handleGet(route, url, req, res)
        return
      }
      if (method === 'POST') {
        if (!knownPost) { sendMethodNotAllowed(res, knownGet ? 'GET' : 'GET, POST'); return }
        await handlePost(route, req, res)
        return
      }
      sendMethodNotAllowed(res, 'GET, POST')
    } catch (error) {
      if (res.headersSent) {
        try { res.destroy?.() } catch { /* 已断开 */ }
        return
      }
      try { ctx?.logger?.warn?.('project-workbench: api error: ' + (error?.stack || error?.message || String(error))) } catch { /* logger 不可用 */ }
      sendError(res, error)
    }
  }

  function dispose() {
    for (const entry of [...streams]) {
      try { entry.close() } catch { /* 已关闭 */ }
    }
    streams.clear()
  }

  return { handler, dispose, streams }
}

/** 注册 /project-workbench/api 前缀路由（kind:'prefix'）。 */
export function registerHttp(ctx, registry, bus) {
  const api = createApi(ctx, registry, bus)
  if (ctx?.webServer && typeof ctx.webServer.register === 'function') {
    const route = { kind: 'prefix', path: API_PREFIX, handler: api.handler }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const disposeRoute = ctx.webServer.register(route)
        return () => {
          try { disposeRoute?.() } catch { /* 路由已移除 */ }
          api.dispose()
        }
      }, 'project-workbench: ' + API_PREFIX + ' routes')
    } else {
      ctx.webServer.register(route)
    }
  }
  return api
}
