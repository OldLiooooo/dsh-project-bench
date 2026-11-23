// 客户端数据通道（T2 host-api）：/project-workbench/api 前缀路由 + SSE 变更推送。
// 安全：每个 handler 第一行先过 ctx.connection.requestRejection(req)（Host/Origin 围栏 + 登录 cookie），
// 未认证一律 401/403；POST 只接受人的面板操作（初始化/决策拍板/PM 绑定），agent 没有写入口。
import { projectError } from './registry.js'
import { initProject, resolveDecisionAction, bindPmSession, replayExports } from './project.js'
import { resolveIdentity, listIdentities } from './identity.js'
import { buildSnapshot, sliceDetail, docPreview, timelinePage } from './snapshot.js'

export const API_PREFIX = '/project-workbench/api'
export const HEARTBEAT_MS = 25000
const MAX_BODY_BYTES = 64 * 1024

const GET_ROUTES = new Set(['/', '/projects', '/snapshot', '/slice', '/doc', '/timeline', '/events', '/identities'])
const POST_ROUTES = new Set(['/init', '/decision', '/pm', '/exports/replay'])

const STATUS_BY_CODE = {
  INVALID: 400,
  ANSWER_REQUIRED: 400,
  INVALID_ROOT: 400,
  MISSING_WORKSPACE: 400,
  MISSING_ROOT: 400,
  POLICY_INVALID: 400,
  UNAUTHORIZED: 401,
  NOT_REGISTERED_WORKSPACE: 403,
  FORBIDDEN: 403,
  NOT_PROJECT_SESSION: 403,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CONFIRM_REQUIRED: 409,
  NOT_INITIALIZED: 409,
  DOC_FROZEN: 409,
  LEASE_HELD: 409,
  LEASE_FENCED: 409,
  DUPLICATE_ACTIVE_SESSION: 409,
  DUPLICATE_SLICE: 409,
  DUPLICATE_DOCUMENT: 409,
  DUPLICATE_EVIDENCE: 409,
  DUPLICATE_ARTIFACT: 409,
  OUT_OF_SCOPE_CHANGES: 409,
  GATE_STAGE_INVALID: 409,
  GATE_PRECHECK_FAILED: 409,
  STALE_PRECHECK: 409,
  STALE_APPROVAL: 409,
  STALE_GATE_STAGE: 409,
  STALE_STAGE: 409,
  NO_EVIDENCE: 409,
  STAGE_DELIVERABLE_NOT_ALLOWED: 409,
  SELF_VERIFICATION_DENIED: 403,
  SLICE_VERIFIED_TERMINAL: 409,
  VERIFY_REQUIRES_SIGNER: 409,
  EXPORT_FAILED: 502,
  SPAWN_FAILED: 502,
  DELIVERY_FAILED: 502,
  SESSION_UNREACHABLE: 409,
  PAYLOAD_TOO_LARGE: 413,
  PROJECT_DB_ERROR: 500,
  DATA_LAYER_UNAVAILABLE: 503,
  WORKSPACE_REGISTRY_UNAVAILABLE: 503,
  UNAVAILABLE: 503,
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

/**
 * 错误详情（v4）：旧实现只回 {code, message}，把「真正能修问题的东西」全丢了 ——
 * 门禁失败看不到 issues 原文、租约冲突看不到持有者、栅栏失效看不到 epoch 差、
 * 作用域越界看不到文件清单。于是面板只能显示一句看不懂的话，人只能去翻日志。
 *
 * 现在统一补三块：
 *   - details：领域错误自带的结构化明细（白名单字段，避免把内部对象/大数组丢给浏览器）；
 *   - issues：门禁/判据的逐条问题（原样，含 code/path/message/check）；
 *   - hints：把「下一步该做什么」变成机器可读的动作建议（replay_exports / resubmit_gate / …）。
 * 同时限制体积：宁可截断，也不让一个 5MB 的 issues 把响应撑爆。
 */
const MAX_ISSUES = 40
const MAX_DETAILS_CHARS = 6000
const DETAIL_KEYS = [
  'sliceId', 'sessionId', 'dshSessionId', 'docId', 'decisionId', 'approvalId', 'taskId',
  'holder', 'expiresAt', 'epoch', 'presented', 'gate', 'stage', 'currentStage', 'requestedStage',
  'submittedVersion', 'currentVersion', 'submittedHash', 'currentHash', 'files', 'batchId',
  'attempt', 'failureCode', 'taskRolledBack', 'path', 'kind', 'uri', 'evidenceId', 'artifactId',
]

function trimIssues(issues) {
  if (!Array.isArray(issues)) return undefined
  return issues.slice(0, MAX_ISSUES).map(function (issue) {
    if (!issue || typeof issue !== 'object') return { message: String(issue) }
    const out = {}
    for (const key of ['code', 'path', 'message', 'check']) {
      if (issue[key] !== undefined && issue[key] !== null) out[key] = issue[key]
    }
    return out
  })
}

function pickDetails(error) {
  const details = error && error.details
  if (!details || typeof details !== 'object') return undefined
  const out = {}
  for (const key of DETAIL_KEYS) {
    if (details[key] !== undefined && details[key] !== null) out[key] = details[key]
  }
  if (Object.keys(out).length === 0) return undefined
  try {
    const text = JSON.stringify(out)
    if (text.length > MAX_DETAILS_CHARS) {
      return { truncated: true, chars: text.length, preview: text.slice(0, 400) + '…' }
    }
    return out
  } catch (serializeError) {
    return undefined
  }
}

/** 错误码 → 机器可读的下一步建议（面板可直接渲染成按钮）。 */
const HINTS_BY_CODE = {
  STALE_PRECHECK: [{ action: 'resubmit_gate', hint: '判据在提交后变了：重新 gate_submit 后再批准' }],
  STALE_APPROVAL: [{ action: 'resubmit_gate', hint: '提交内容已过期：重新 gate_submit 后再批准' }],
  STALE_GATE_STAGE: [{ action: 'resubmit_gate', hint: '门禁与当前阶段不再匹配：按当前阶段重新提交' }],
  STALE_STAGE: [{ action: 'inspect_stages', hint: '阶段表不合法（active 阶段数≠1）：先修复阶段表' }],
  GATE_PRECHECK_FAILED: [{ action: 'fix_issues', hint: '先修判据问题，再重新 gate_submit' }],
  LEASE_HELD: [{ action: 'wait_or_takeover', hint: '切片由其它会话持有：等其收工，或等租约过期后重新派活' }],
  LEASE_FENCED: [{ action: 'release_and_respawn', hint: '写作用域已换代（被抢占）：本会话不能再写，请释放并重新派活' }],
  OUT_OF_SCOPE_CHANGES: [{ action: 'review_diff', hint: '存在片外/跨切片改动：由 PM 决定接受（declare 策略）或回滚' }],
  SPAWN_FAILED: [{ action: 'retry_spawn', hint: '派活失败：任务已回滚为 pending，可直接重试或换切片' }],
  EXPORT_FAILED: [{ action: 'replay_exports', hint: '文件没落地：阶段/数据未回滚，用「重新生成导出」补偿' }],
  CONFIRM_REQUIRED: [{ action: 'confirm', hint: '不可逆操作：需要二次确认（confirmed=true）' }],
  NO_EVIDENCE: [{ action: 'add_evidence', hint: '先 evidence_add 记录可复核证据' }],
  STAGE_DELIVERABLE_NOT_ALLOWED: [{ action: 'change_doc_type', hint: '当前阶段只允许特定交付类型：换正确类型，或按流程推进阶段后再写' }],
  SELF_VERIFICATION_DENIED: [{ action: 'use_qa_session', hint: '建造者不验收：请用 session_spawn_qa 拉起独立验收会话' }],
  SLICE_VERIFIED_TERMINAL: [{ action: 'new_slice', hint: '已验收是终态：返工请开新切片（验收记录不可撤回）' }],
  VERIFY_REQUIRES_SIGNER: [{ action: 'provide_verifier', hint: '验收必须记录验收人（verifiedBy）' }],
  DOC_FROZEN: [{ action: 'new_version_flow', hint: '文档已冻结：返工需新决策并新开文档' }],
  NOT_INITIALIZED: [{ action: 'init_project', hint: '先在面板初始化项目' }],
}

function hintsOf(error) {
  const code = error && error.code
  const mapped = HINTS_BY_CODE[code]
  if (mapped) return mapped
  // Epoch 冲突统一给「重新提交」的建议；其它错误不猜。
  return undefined
}

function sendError(res, error) {
  const payload = {
    error: {
      code: error?.code || 'INTERNAL',
      message: error?.message || 'internal error',
    },
  }
  const issues = trimIssues(error && error.issues)
  if (issues && issues.length > 0) payload.error.issues = issues
  const details = pickDetails(error)
  if (details) payload.error.details = details
  const hints = hintsOf(error)
  if (hints) payload.error.hints = hints
  if (error && error.plan) payload.error.plan = error.plan
  sendJson(res, statusOf(error), payload)
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

/**
 * 宿主注入的登录主体（如果宿主提供了）。
 *
 * 这里**不猜**：只有宿主明确给出 subject 时才算 host 身份。
 * 拿不到就返回 undefined，交给 resolveIdentity 退到 declared/local 并如实标注来源。
 * 假装「反正是本人」，正是原实现 decidedBy='user' 的病根。
 */
function hostIdentity(ctx, req) {
  try {
    const connection = ctx && ctx.connection
    if (connection && typeof connection.identity === 'function') {
      const value = connection.identity(req)
      if (value && typeof value === 'object' && typeof value.subject === 'string' && value.subject.trim()) {
        return { subject: value.subject, displayName: value.displayName, source: 'host', clientHint: req.headers?.['user-agent'] }
      }
    }
  } catch (error) { /* 宿主未提供身份能力：退到 declared/local */ }
  const header = req && req.headers ? (req.headers['x-workbench-identity'] || req.headers['x-remote-user']) : undefined
  if (typeof header === 'string' && header.trim()) {
    // 直接来自请求头的身份只能算 declared（客户端可伪造），但至少**记下出处**。
    return { subject: header.trim(), displayName: header.trim(), source: 'declared', clientHint: req.headers?.['user-agent'] }
  }
  return undefined
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

  function handleIdentities(url, res) {
    const { workspace, db } = requireProject(url.searchParams)
    sendJson(res, 200, { identities: listIdentities(db), root: workspace.root, workspaceId: workspace.workspaceId })
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
      case '/identities': handleIdentities(url, res); return
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
        // 身份（v4）：优先宿主注入的主体，其次面板显式 actingAs，最后 decidedBy 字符串/local。
        // 来源会随审批一起落库（approval_signers.source），不再是一个没有出处的 'user'。
        const identity = resolveIdentity({
          identity: hostIdentity(ctx, req),
          decidedBy: body.decidedBy,
          actingAs: body.actingAs,
          clientHint: req.headers?.['user-agent'],
        })
        // 批准门禁会先复跑判据（async），因此这里必须 await。
        const result = await resolveDecisionAction(ctx, db, {
          id: body.id,
          status: body.status,
          rationale: body.rationale,
          answer: body.answer === undefined || body.answer === null ? undefined : String(body.answer),
          confirmed: body.confirmed === true,
          identity: { subject: identity.subject, displayName: identity.displayName, source: identity.source },
          clientHint: identity.clientHint,
        }, { root: workspace.root, exportMap: json?.exportMap, registry, identityObj: identity })
        emitChange(workspace.root, result.revision)
        sendJson(res, 200, {
          ok: true, root: workspace.root, workspaceId: workspace.workspaceId,
          decision: result.decision, actions: result.actions, exportResult: result.exportResult,
          separation: result.separation, wake: result.wake, revision: result.revision,
        })
        return
      }
      case '/exports/replay': {
        // 导出补偿（v4）：把 pending/failed 的导出意图重新落地。
        // 与「重新批准」解耦：阶段推进是人签的字，文件是可再生的派生物。
        const db = registry.open(workspace.root)
        if (!db) throw projectError('NOT_INITIALIZED', 'project is not initialized: ' + workspace.root, 409)
        const result = replayExports(db, {
          root: workspace.root,
          batchId: typeof body.batchId === 'string' && body.batchId.trim() ? body.batchId.trim() : undefined,
        })
        emitChange(workspace.root, result.revision)
        sendJson(res, 200, { ok: true, root: workspace.root, workspaceId: workspace.workspaceId, ...result })
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
