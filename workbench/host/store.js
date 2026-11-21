// 领域写操作（T1）：slices / tasks / sessions / decisions / evidence / artifacts。
// 约定：
// - 所有领域写操作都在 db.tx(() => { ...; db.appendEvent(...) }) 内完成（同事务 atomic）。
// - 失败抛 Error + error.code（INVALID / NOT_FOUND / DUPLICATE_* / ...），工具层/HTTP 层按 code 映射。
// - 时间线由 db.js 的 timeline / timelineMarkdown 提供，这里 re-export，调用方只依赖 store.js 亦可。
import { fail, requireProjectId, timeline, timelineMarkdown } from './db.js'
import { newId, nowIso, jsonText, parseJson } from './util.js'

export { timeline, timelineMarkdown }

export const SESSION_ROLES = ['产品', 'UX', '架构', '码农', '测试', '发布', '复盘']
export const PM_SESSION_NAME = '项目办公室'
export const SESSION_KINDS = ['pm', 'task', 'subagent']
export const SLICE_TYPES = ['workitem', 'module']
export const SESSION_END_STATUSES = ['done', 'failed', 'interrupted', 'ended']

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('INVALID', field + ' 必须是非空字符串')
  return value.trim()
}

function optionalText(value) {
  if (value === undefined || value === null) return undefined
  return String(value)
}

function limitOf(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function asJsonField(value, fallback) {
  return value === undefined || value === null ? fallback : value
}

// ---------------------------------------------------------------------------
// 行映射（供 T2/T4 直接复用字段命名，避免各处手写 snake_case）
// ---------------------------------------------------------------------------

export function mapSlice(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    key: row.key,
    title: row.title,
    parentId: row.parent_id ?? undefined,
    status: row.status,
    /** 写作用域是否已显式声明（未声明时收工只能做「无基线」校验，见 host/scope.js）。 */
    scopeDeclared: Boolean(row.scope_declared),
    ownerRole: row.owner_role ?? undefined,
    ownerSession: row.owner_session ?? undefined,
    currentHandoff: row.current_handoff ?? undefined,
    acceptance: parseJson(row.acceptance_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapTask(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    sliceId: row.slice_id,
    title: row.title,
    status: row.status,
    assigneeSession: row.assignee_session ?? undefined,
    acceptance: parseJson(row.acceptance_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapSession(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    role: row.role ?? undefined,
    sliceId: row.slice_id ?? undefined,
    dshSessionId: row.dsh_session_id ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    handoffId: row.handoff_id ?? undefined,
    context: parseJson(row.context_json, {}),
    /** 派活第几次（同切片同角色重复派活时区分新旧，重试/对账用）。 */
    attempt: Number(row.attempt === undefined || row.attempt === null ? 1 : row.attempt),
    /** 失败原因（v4）：会话失败必须能回答「为什么」，而不是只留一个 status='failed'。 */
    failureCode: row.failure_code ?? undefined,
    failureDetail: row.failure_detail ?? undefined,
    failureAt: row.failure_at ?? undefined,
  }
}

export function mapDecision(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    sliceId: row.slice_id ?? undefined,
    kind: row.kind,
    title: row.title,
    question: row.question,
    options: parseJson(row.options_json, []),
    recommended: row.recommended ?? undefined,
    consequences: row.consequences ?? undefined,
    /** 人选的选项 value（A/B/C/D 或自定义）；无选项的门禁决策为 undefined。 */
    answer: row.answer ?? undefined,
    status: row.status,
    irreversible: Boolean(row.irreversible),
    deadline: row.deadline ?? undefined,
    decidedBy: row.decided_by ?? undefined,
    rationale: row.rationale ?? undefined,
    stage: row.stage ?? undefined,
    gate: row.gate ?? undefined,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
  }
}

export function mapEvidence(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    sliceId: row.slice_id ?? undefined,
    taskId: row.task_id ?? undefined,
    kind: row.kind,
    uri: row.uri ?? undefined,
    contentHash: row.content_hash ?? undefined,
    command: row.command ?? undefined,
    resultSummary: row.result_summary,
    createdBy: row.created_by ?? undefined,
    verifiedBy: row.verified_by ?? undefined,
    createdAt: row.created_at,
  }
}

export function mapArtifact(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    sliceId: row.slice_id ?? undefined,
    kind: row.kind,
    path: row.path,
    contentHash: row.content_hash ?? undefined,
    bytes: row.bytes === null || row.bytes === undefined ? undefined : Number(row.bytes),
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// 切片 slices
// ---------------------------------------------------------------------------

export function getSlice(db, sliceId) {
  if (!sliceId) return undefined
  const row = db.db.prepare('SELECT * FROM slices WHERE id = ? AND project_id = ?').get(sliceId, requireProjectId(db))
  return mapSlice(row)
}

function requireSlice(db, sliceId) {
  const slice = getSlice(db, sliceId)
  if (!slice) throw fail('NOT_FOUND', 'slice not found: ' + sliceId)
  return slice
}

export function listSlices(db, options = {}) {
  let sql = 'SELECT * FROM slices WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.status) { sql += ' AND status = ?'; params.push(options.status) }
  if (options.type) { sql += ' AND type = ?'; params.push(options.type) }
  if (options.parentId) { sql += ' AND parent_id = ?'; params.push(options.parentId) }
  sql += ' ORDER BY created_at ASC, key ASC'
  return db.db.prepare(sql).all(...params).map(mapSlice)
}

export function createSlice(db, input = {}) {
  const projectId = requireProjectId(db)
  const key = requiredText(input.key, 'key')
  const title = requiredText(input.title, 'title')
  const type = input.type === undefined ? 'workitem' : requiredText(input.type, 'type')
  if (!SLICE_TYPES.includes(type)) throw fail('INVALID', 'slice type 必须是 ' + SLICE_TYPES.join('/'))
  const parentId = input.parentId ?? null
  if (parentId) requireSlice(db, parentId)
  return db.tx(() => {
    const dup = db.db.prepare('SELECT id FROM slices WHERE project_id = ? AND key = ?').get(projectId, key)
    if (dup) throw fail('DUPLICATE_SLICE', 'slice key 已存在：' + key, { sliceId: dup.id, key: key })
    const id = newId('slice')
    const at = nowIso()
    db.db.prepare('INSERT INTO slices(id, project_id, type, key, title, parent_id, status, acceptance_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, type, key, title, parentId, 'open', jsonText(asJsonField(input.acceptance, {})), at, at)
    db.appendEvent({
      kind: 'slice/create',
      sliceId: id,
      subjectType: 'slice',
      subjectId: id,
      payload: { key: key, title: title, type: type, parentId: parentId || undefined },
    })
    return getSlice(db, id)
  })
}

export function updateSliceStatus(db, input = {}) {
  const id = requiredText(input.id || input.sliceId, 'id')
  const patch = {}
  if (input.status !== undefined) patch.status = requiredText(input.status, 'status')
  if (input.ownerRole !== undefined) patch.owner_role = optionalText(input.ownerRole)
  if (input.ownerSession !== undefined) patch.owner_session = optionalText(input.ownerSession)
  if (input.currentHandoff !== undefined) patch.current_handoff = optionalText(input.currentHandoff)
  if (input.title !== undefined) patch.title = requiredText(input.title, 'title')
  if (input.acceptance !== undefined) patch.acceptance_json = jsonText(input.acceptance)
  if (Object.keys(patch).length === 0) throw fail('INVALID', 'updateSliceStatus 需要至少一个可变字段')
  return db.tx(() => {
    const before = getSlice(db, id)
    if (!before) throw fail('NOT_FOUND', 'slice not found: ' + id)
    const sets = []
    const params = []
    for (const column of Object.keys(patch)) { sets.push(column + ' = ?'); params.push(patch[column]) }
    sets.push('updated_at = ?')
    params.push(nowIso())
    params.push(id)
    db.db.prepare('UPDATE slices SET ' + sets.join(', ') + ' WHERE id = ?').run(...params)
    db.appendEvent({
      kind: 'slice/status',
      sliceId: id,
      subjectType: 'slice',
      subjectId: id,
      role: input.role,
      payload: {
        from: before.status,
        to: patch.status !== undefined ? patch.status : before.status,
        fields: Object.keys(patch),
        ownerRole: patch.owner_role !== undefined ? patch.owner_role : before.ownerRole,
      },
    })
    return getSlice(db, id)
  })
}

// ---------------------------------------------------------------------------
// 任务 tasks
// ---------------------------------------------------------------------------

export function getTask(db, taskId) {
  if (!taskId) return undefined
  const row = db.db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(taskId, requireProjectId(db))
  return mapTask(row)
}

function requireTask(db, taskId) {
  const task = getTask(db, taskId)
  if (!task) throw fail('NOT_FOUND', 'task not found: ' + taskId)
  return task
}

export function createTask(db, input = {}) {
  const projectId = requireProjectId(db)
  const sliceId = requiredText(input.sliceId, 'sliceId')
  const title = requiredText(input.title, 'title')
  requireSlice(db, sliceId)
  return db.tx(() => {
    const id = newId('task')
    const at = nowIso()
    db.db.prepare('INSERT INTO tasks(id, project_id, slice_id, title, status, assignee_session, acceptance_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, sliceId, title, 'pending', input.assigneeSession ?? null, jsonText(asJsonField(input.acceptance, {})), at, at)
    db.appendEvent({
      kind: 'task/create',
      sliceId: sliceId,
      subjectType: 'task',
      subjectId: id,
      payload: { title: title, sliceId: sliceId },
    })
    return getTask(db, id)
  })
}

export function updateTask(db, input = {}) {
  const id = requiredText(input.id || input.taskId, 'id')
  const patch = {}
  if (input.status !== undefined) patch.status = requiredText(input.status, 'status')
  if (input.assigneeSession !== undefined) patch.assignee_session = optionalText(input.assigneeSession)
  if (input.title !== undefined) patch.title = requiredText(input.title, 'title')
  if (input.acceptance !== undefined) patch.acceptance_json = jsonText(input.acceptance)
  if (Object.keys(patch).length === 0) throw fail('INVALID', 'updateTask 需要至少一个可变字段')
  return db.tx(() => {
    const before = requireTask(db, id)
    const sets = []
    const params = []
    for (const column of Object.keys(patch)) { sets.push(column + ' = ?'); params.push(patch[column]) }
    sets.push('updated_at = ?')
    params.push(nowIso())
    params.push(id)
    db.db.prepare('UPDATE tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...params)
    db.appendEvent({
      kind: 'task/status',
      sliceId: before.sliceId,
      subjectType: 'task',
      subjectId: id,
      role: input.role,
      payload: {
        from: before.status,
        to: patch.status !== undefined ? patch.status : before.status,
        fields: Object.keys(patch),
        assigneeSession: patch.assignee_session !== undefined ? patch.assignee_session : before.assigneeSession,
      },
    })
    return getTask(db, id)
  })
}

export function listTasks(db, options = {}) {
  let sql = 'SELECT * FROM tasks WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
  if (options.status) { sql += ' AND status = ?'; params.push(options.status) }
  if (options.assigneeSession) { sql += ' AND assignee_session = ?'; params.push(options.assigneeSession) }
  sql += ' ORDER BY created_at ASC'
  return db.db.prepare(sql).all(...params).map(mapTask)
}

// ---------------------------------------------------------------------------
// 会话 sessions
// ---------------------------------------------------------------------------

function validateTaskSessionName(name, role, sliceKey) {
  let resolved = role
  if (!resolved) resolved = SESSION_ROLES.find(function (item) { return name.startsWith(item + '-') })
  if (!resolved || !SESSION_ROLES.includes(resolved)) {
    throw fail('INVALID', '任务会话名必须以角色开头（' + SESSION_ROLES.join('/') + '）：' + name)
  }
  if (role && role !== resolved) throw fail('INVALID', '会话 name 与 role 不一致：' + name + ' / ' + role)
  if (sliceKey) {
    const prefix = resolved + '-' + sliceKey + '-'
    if (!name.startsWith(prefix) || name.length <= prefix.length) {
      throw fail('INVALID', '任务会话名必须是 角色-切片-动作 三段且切片 key 匹配：' + name, { expectedPrefix: prefix })
    }
  } else {
    const rest = name.slice(resolved.length + 1)
    const parts = rest.split('-').filter(function (part) { return part.length > 0 })
    if (parts.length < 2) throw fail('INVALID', '任务会话名必须是 角色-切片-动作 三段：' + name)
  }
  return resolved
}

function mapSessionConstraint(error) {
  const message = String(error && error.message ? error.message : error)
  if (message.indexOf('dsh_session_id') >= 0) {
    return fail('DUPLICATE_DSH_SESSION', 'DSH 会话已绑定其它项目会话', { cause: message })
  }
  if (message.indexOf('sessions') >= 0) {
    return fail('DUPLICATE_ACTIVE_SESSION', '会话唯一约束冲突（同切片/角色 active，或同名 active）', { cause: message })
  }
  return error
}

export function getSession(db, sessionId) {
  if (!sessionId) return undefined
  const row = db.db.prepare('SELECT * FROM sessions WHERE id = ? AND project_id = ?').get(sessionId, requireProjectId(db))
  return mapSession(row)
}

/**
 * 派活次数：同 (切片, 角色) 的历史会话数 + 1。
 * 为什么需要它：失败重试会产生第二条同名/同角色会话，若账上只有「一条 active」，
 * 对账就无法回答「这是第几次尝试、上一次为什么失败」，人也没法判断该不该再信它。
 */
function nextAttempt(db, projectId, sliceId, role, kind) {
  if (kind !== 'task' || !sliceId || !role) return 1
  const row = db.db
    .prepare('SELECT COALESCE(MAX(attempt), 0) AS n FROM sessions WHERE project_id = ? AND slice_id = ? AND role = ? AND kind = ?')
    .get(projectId, sliceId, role, kind)
  return Number(row && row.n ? row.n : 0) + 1
}

export function createSession(db, input = {}) {
  const projectId = requireProjectId(db)
  const kind = input.kind === undefined ? 'task' : requiredText(input.kind, 'kind')
  if (!SESSION_KINDS.includes(kind)) throw fail('INVALID', 'session kind 必须是 ' + SESSION_KINDS.join('/'))
  let name = input.name === undefined || input.name === null ? '' : String(input.name).trim()
  let role = input.role === undefined || input.role === null ? undefined : String(input.role)
  const sliceId = input.sliceId ?? null
  if (kind === 'pm') {
    // 合同规定 PM 会话名固定为「项目办公室」；忽略外部传入，避免同一项目 PM 名字漂移。
    name = PM_SESSION_NAME
  } else if (kind === 'task') {
    let sliceKey
    if (sliceId) sliceKey = requireSlice(db, sliceId).key
    role = validateTaskSessionName(name, role, sliceKey)
  } else if (!name) {
    throw fail('INVALID', '会话名称不能为空')
  }
  const dshSessionId = input.dshSessionId ?? null
  return db.tx(() => {
    if (kind === 'task' && sliceId) {
      const dup = db.db.prepare("SELECT id FROM sessions WHERE project_id = ? AND slice_id = ? AND role = ? AND status = 'active' AND kind = 'task'").get(projectId, sliceId, role)
      if (dup) {
        throw fail('DUPLICATE_ACTIVE_SESSION', '同一(切片,角色)已有 active 任务会话：' + dup.id, { sessionId: dup.id, sliceId: sliceId, role: role })
      }
    }
    if (kind === 'pm') {
      const dupPm = db.db.prepare("SELECT id FROM sessions WHERE project_id = ? AND kind = 'pm' AND status = 'active'").get(projectId)
      if (dupPm) throw fail('DUPLICATE_ACTIVE_SESSION', '项目已存在 active PM 会话：' + dupPm.id, { sessionId: dupPm.id })
    }
    const id = newId('session')
    const at = nowIso()
    const attempt = Number.isFinite(Number(input.attempt)) && Number(input.attempt) > 0
      ? Number(input.attempt)
      : nextAttempt(db, projectId, sliceId, role, kind)
    try {
      db.db.prepare('INSERT INTO sessions(id, project_id, name, kind, role, slice_id, dsh_session_id, parent_session_id, provider, model, reasoning_effort, status, started_at, context_json, attempt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, name, kind, role ?? null, sliceId, dshSessionId, input.parentSessionId ?? null,
          input.provider ?? null, input.model ?? null, input.reasoningEffort ?? null, 'active', at, jsonText(asJsonField(input.context, {})), attempt)
    } catch (error) {
      throw mapSessionConstraint(error)
    }
    db.appendEvent({
      kind: 'session/create',
      sliceId: sliceId || undefined,
      subjectType: 'session',
      subjectId: id,
      actorSession: dshSessionId || undefined,
      role: role || undefined,
      payload: {
        name: name,
        kind: kind,
        role: role || undefined,
        sliceId: sliceId || undefined,
        dshSessionId: dshSessionId || undefined,
        provider: input.provider || undefined,
        model: input.model || undefined,
        attempt: attempt,
      },
    })
    return getSession(db, id)
  })
}

export function findSessionByDshId(db, dshSessionId) {
  if (!dshSessionId) return undefined
  const row = db.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND dsh_session_id = ?').get(requireProjectId(db), dshSessionId)
  return mapSession(row)
}

export function listSessions(db, options = {}) {
  let sql = 'SELECT * FROM sessions WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.kind) { sql += ' AND kind = ?'; params.push(options.kind) }
  if (options.status) { sql += ' AND status = ?'; params.push(options.status) }
  if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
  if (options.role) { sql += ' AND role = ?'; params.push(options.role) }
  sql += ' ORDER BY started_at DESC'
  return db.db.prepare(sql).all(...params).map(mapSession)
}

/**
 * 结束会话（含失败）。
 *
 * v4 起「失败」是一个**带原因的终态**：
 *   - status='failed'/'interrupted' 必须给 failureCode（缺省 FAILED_UNSPECIFIED / INTERRUPTED）；
 *   - failure_code / failure_detail / failure_at 落列，可被 project_status、重启对账与面板查询；
 *   - 已结束的会话再次 endSession 是幂等的，**但不得洗掉原有的失败原因**
 *     （原实现遇到非 active 直接 return，会把 failed 会话的失败原因永久留在调用方日志里）。
 * @returns {object} 结束后的会话行
 */
export function endSession(db, input = {}) {
  const id = requiredText(input.id || input.sessionId, 'id')
  const status = input.status === undefined ? 'done' : requiredText(input.status, 'status')
  if (!SESSION_END_STATUSES.includes(status)) throw fail('INVALID', 'session end status 必须是 ' + SESSION_END_STATUSES.join('/'))
  const failed = status === 'failed' || status === 'interrupted'
  const failureCode = input.failureCode === undefined || input.failureCode === null || input.failureCode === ''
    ? (failed ? (status === 'failed' ? 'FAILED_UNSPECIFIED' : 'INTERRUPTED') : undefined)
    : String(input.failureCode)
  const failureDetail = input.failureDetail === undefined || input.failureDetail === null
    ? (failed ? String(input.failureDetailHint || '') || undefined : undefined)
    : String(input.failureDetail)
  return db.tx(() => {
    const before = getSession(db, id)
    if (!before) throw fail('NOT_FOUND', 'session not found: ' + id)
    if (before.status !== 'active') {
      // 幂等返回，但**补齐缺失的失败原因**（旧代码路径可能只写了 status=failed）。
      if (failed && !before.failureCode && failureCode) {
        db.db.prepare('UPDATE sessions SET failure_code = ?, failure_detail = ?, failure_at = ? WHERE id = ?')
          .run(failureCode, failureDetail ?? null, nowIso(), id)
        return getSession(db, id)
      }
      return before
    }
    const handoffId = input.handoffId ?? before.handoffId ?? null
    const at = nowIso()
    db.db.prepare('UPDATE sessions SET status = ?, ended_at = ?, handoff_id = ?, failure_code = ?, failure_detail = ?, failure_at = ? WHERE id = ?')
      .run(status, at, handoffId, failed ? failureCode : null, failed ? (failureDetail ?? null) : null, failed ? at : null, id)
    db.appendEvent({
      kind: 'session/end',
      sliceId: before.sliceId,
      subjectType: 'session',
      subjectId: id,
      actorSession: before.dshSessionId,
      role: before.role,
      payload: {
        name: before.name,
        status: status,
        handoffId: handoffId || undefined,
        attempt: before.attempt || undefined,
        failureCode: failed ? failureCode : undefined,
        failureDetail: failed && failureDetail ? failureDetail.slice(0, 500) : undefined,
      },
    })
    return getSession(db, id)
  })
}

/**
 * 修正/绑定会话元数据（模型、provider、DSH 会话 id 等）。
 * 合同 §8 明确这类每轮同步不产生时间线噪音，因此默认不写 event（状态结束请用 endSession）。
 */
export function updateSession(db, input = {}) {
  const id = requiredText(input.id || input.sessionId, 'id')
  const columns = {}
  if (input.dshSessionId !== undefined) columns.dsh_session_id = input.dshSessionId
  if (input.provider !== undefined) columns.provider = input.provider
  if (input.model !== undefined) columns.model = input.model
  if (input.reasoningEffort !== undefined) columns.reasoning_effort = input.reasoningEffort
  if (input.context !== undefined) columns.context_json = jsonText(input.context)
  if (input.parentSessionId !== undefined) columns.parent_session_id = input.parentSessionId
  if (input.handoffId !== undefined) columns.handoff_id = input.handoffId
  if (input.name !== undefined) columns.name = requiredText(input.name, 'name')
  if (Object.keys(columns).length === 0) {
    const existing = getSession(db, id)
    if (!existing) throw fail('NOT_FOUND', 'session not found: ' + id)
    return existing
  }
  return db.tx(() => {
    const before = getSession(db, id)
    if (!before) throw fail('NOT_FOUND', 'session not found: ' + id)
    const sets = []
    const params = []
    for (const column of Object.keys(columns)) { sets.push(column + ' = ?'); params.push(columns[column]) }
    params.push(id)
    db.db.prepare('UPDATE sessions SET ' + sets.join(', ') + ' WHERE id = ?').run(...params)
    return getSession(db, id)
  })
}

// ---------------------------------------------------------------------------
// 决策 decisions
// ---------------------------------------------------------------------------

export function getDecision(db, decisionId) {
  if (!decisionId) return undefined
  const row = db.db.prepare('SELECT * FROM decisions WHERE id = ? AND project_id = ?').get(decisionId, requireProjectId(db))
  return mapDecision(row)
}

export function createDecision(db, input = {}) {
  const projectId = requireProjectId(db)
  const title = requiredText(input.title, 'title')
  const question = requiredText(input.question, 'question')
  const kind = input.kind === undefined ? 'decision' : requiredText(input.kind, 'kind')
  const sliceId = input.sliceId ?? null
  if (sliceId) requireSlice(db, sliceId)
  const options = input.options === undefined ? [] : input.options
  if (!Array.isArray(options)) throw fail('INVALID', 'options 必须是数组')
  const irreversible = input.irreversible === true
  return db.tx(() => {
    const id = newId('decision')
    const at = nowIso()
    db.db.prepare('INSERT INTO decisions(id, project_id, slice_id, kind, title, question, options_json, recommended, consequences, status, irreversible, deadline, stage, gate, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, sliceId, kind, title, question, jsonText(options), input.recommended ?? null, input.consequences ?? null,
        'pending', irreversible ? 1 : 0, input.deadline ?? null, input.stage ?? null, input.gate ?? null, input.createdBy ?? null, at)
    db.appendEvent({
      kind: 'decision/create',
      sliceId: sliceId || undefined,
      subjectType: 'decision',
      subjectId: id,
      actorSession: input.createdBy ?? undefined,
      payload: { title: title, kind: kind, irreversible: irreversible, gate: input.gate || undefined, stage: input.stage || undefined },
    })
    return getDecision(db, id)
  })
}

/**
 * One option's machine value. Mirrors the client's `decisionOptions` fallback chain so the
 * value the user clicks is exactly the value stored in decisions.answer:
 * 字符串选项 → A/B/C…；对象选项 → value ?? id ?? A/B/C…。
 * @param option - raw option from options_json.
 * @param index - zero-based position (used for the letter fallback).
 * @returns the stored value.
 */
export function optionValueOf(option, index) {
  const letter = String.fromCharCode(65 + (index % 26))
  if (option && typeof option === 'object') {
    if (option.value !== undefined) return String(option.value)
    if (option.id !== undefined) return String(option.id)
    return letter
  }
  return letter
}

export function resolveDecision(db, input = {}) {
  const id = requiredText(input.id || input.decisionId, 'id')
  const status = requiredText(input.status, 'status')
  if (status !== 'approved' && status !== 'rejected') throw fail('INVALID', '决策结果必须是 approved/rejected')
  const confirmedInput = input.confirmed === true || (input.payload && input.payload.confirmed === true)
  return db.tx(() => {
    const before = getDecision(db, id)
    if (!before) throw fail('NOT_FOUND', 'decision not found: ' + id)
    if (before.status !== 'pending') throw fail('INVALID', '决策已落定（' + before.status + '），不能重复裁决：' + id)
    if (before.irreversible && (!input.decidedBy || !confirmedInput)) {
      throw fail('INVALID', '不可逆决策必须由人确认：decidedBy 非空且 confirmed=true', { decisionId: id })
    }
    // answer = 人选的那一项。有选项的决策必须点名选了哪个，否则「批准」在语义上无法落地
    // （批准了「哪一条」是决策的核心信息，不能只记 approved/rejected）。
    const options = Array.isArray(before.options) ? before.options : []
    const rawAnswer = input.answer === undefined || input.answer === null ? '' : String(input.answer).trim()
    let answer = null
    if (rawAnswer !== '') {
      const allowed = new Set(options.map((option, index) => optionValueOf(option, index)))
      if (!allowed.has(rawAnswer)) {
        throw fail('INVALID', '选项不存在：' + rawAnswer + '（可选：' + Array.from(allowed).join('/') + '）', { decisionId: id, answer: rawAnswer })
      }
      answer = rawAnswer
    }
    // 注意分层：这里**不**强制 answer。
    // 「多选一时必须点名选了哪一条」的强制放在人操作的那一层（决策卡按钮在没选时 disabled），
    // 因为那才是歧义真正产生的地方；API 层保持向后兼容，不误伤既有调用方与历史数据。
    // 但只要给了 answer，就必须是真实存在的选项（上面已校验）。
    const at = nowIso()
    db.db.prepare('UPDATE decisions SET status = ?, decided_by = ?, rationale = ?, answer = ?, decided_at = ? WHERE id = ?')
      .run(status, input.decidedBy ?? null, input.rationale ?? null, answer, at, id)
    db.appendEvent({
      kind: 'decision/resolve',
      sliceId: before.sliceId,
      subjectType: 'decision',
      subjectId: id,
      payload: {
        title: before.title,
        status: status,
        decidedBy: input.decidedBy ?? undefined,
        rationale: input.rationale ?? undefined,
        answer: answer ?? undefined,
        confirmed: confirmedInput,
        irreversible: before.irreversible,
        gate: before.gate || undefined,
      },
    })
    return getDecision(db, id)
  })
}

export function listDecisions(db, options = {}) {
  let sql = 'SELECT * FROM decisions WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.status) { sql += ' AND status = ?'; params.push(options.status) }
  if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
  if (options.kind) { sql += ' AND kind = ?'; params.push(options.kind) }
  sql += ' ORDER BY created_at DESC'
  return db.db.prepare(sql).all(...params).map(mapDecision)
}

// ---------------------------------------------------------------------------
// 证据 evidence
// ---------------------------------------------------------------------------

export function getEvidence(db, evidenceId) {
  if (!evidenceId) return undefined
  const row = db.db.prepare('SELECT * FROM evidence WHERE id = ? AND project_id = ?').get(evidenceId, requireProjectId(db))
  return mapEvidence(row)
}

export function addEvidence(db, input = {}) {
  const projectId = requireProjectId(db)
  const kind = requiredText(input.kind, 'kind')
  const sliceId = input.sliceId ?? null
  if (sliceId) requireSlice(db, sliceId)
  if (input.taskId) requireTask(db, input.taskId)
  // 一个事实一行：同 (project, kind, uri) 只允许一条。DB 层有唯一索引兜底，
  // 这里先查一次是为了给出可读原因与既有 id（而不是让调用方看 SQLite 约束串）。
  const uri = input.uri === undefined || input.uri === null ? null : String(input.uri)
  if (uri !== null) {
    const existing = db.db.prepare('SELECT id FROM evidence WHERE project_id = ? AND kind = ? AND uri = ?').get(projectId, kind, uri)
    if (existing) {
      throw fail('DUPLICATE_EVIDENCE', '同一证据已登记（kind=' + kind + '，uri=' + uri + '）：' + existing.id + '。补充新结论请换 uri 或追加新版本。', { evidenceId: existing.id, uri: uri, kind: kind })
    }
  }
  return db.tx(() => {
    const id = newId('evidence')
    const at = nowIso()
    db.db.prepare('INSERT INTO evidence(id, project_id, slice_id, task_id, kind, uri, content_hash, command, result_summary, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, sliceId, input.taskId ?? null, kind, input.uri ?? null, input.contentHash ?? null,
        input.command ?? null, input.resultSummary === undefined ? '' : String(input.resultSummary), input.createdBy ?? null, at)
    db.appendEvent({
      kind: 'evidence/add',
      sliceId: sliceId || undefined,
      subjectType: 'evidence',
      subjectId: id,
      actorSession: input.createdBy ?? undefined,
      payload: { kind: kind, uri: input.uri || undefined, contentHash: input.contentHash || undefined, command: input.command || undefined, resultSummary: input.resultSummary || undefined },
    })
    return getEvidence(db, id)
  })
}

export function listEvidence(db, options = {}) {
  let sql = 'SELECT * FROM evidence WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
  if (options.taskId) { sql += ' AND task_id = ?'; params.push(options.taskId) }
  if (options.kind) { sql += ' AND kind = ?'; params.push(options.kind) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limitOf(options.limit, 100, 500))
  return db.db.prepare(sql).all(...params).map(mapEvidence)
}

// ---------------------------------------------------------------------------
// 产物 artifacts
// ---------------------------------------------------------------------------

export function getArtifact(db, artifactId) {
  if (!artifactId) return undefined
  const row = db.db.prepare('SELECT * FROM artifacts WHERE id = ? AND project_id = ?').get(artifactId, requireProjectId(db))
  return mapArtifact(row)
}

export function addArtifact(db, input = {}) {
  const projectId = requireProjectId(db)
  const kind = requiredText(input.kind, 'kind')
  const path = requiredText(input.path, 'path')
  const sliceId = input.sliceId ?? null
  if (sliceId) requireSlice(db, sliceId)
  const bytes = input.bytes === undefined || input.bytes === null ? null : Number(input.bytes)
  if (bytes !== null && (!Number.isFinite(bytes) || bytes < 0)) throw fail('INVALID', 'bytes 必须是非负数')
  // 一个事实一行：同 (project, kind, path) 只允许一条。理由同 addEvidence。
  const projectIdForDup = requireProjectId(db)
  const existingArtifact = db.db.prepare('SELECT id FROM artifacts WHERE project_id = ? AND kind = ? AND path = ?').get(projectIdForDup, kind, path)
  if (existingArtifact) {
    throw fail('DUPLICATE_ARTIFACT', '同一产物已登记（kind=' + kind + '，path=' + path + '）：' + existingArtifact.id + '。内容变更请更新该行或用 artifact_add 的新 kind。', { artifactId: existingArtifact.id, path: path, kind: kind })
  }
  return db.tx(() => {
    const id = newId('artifact')
    const at = nowIso()
    db.db.prepare('INSERT INTO artifacts(id, project_id, slice_id, kind, path, content_hash, bytes, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, sliceId, kind, path, input.contentHash ?? null, bytes, jsonText(asJsonField(input.metadata, {})), at)
    db.appendEvent({
      kind: 'artifact/add',
      sliceId: sliceId || undefined,
      subjectType: 'artifact',
      subjectId: id,
      payload: { kind: kind, path: path, contentHash: input.contentHash || undefined, bytes: bytes === null ? undefined : bytes },
    })
    return getArtifact(db, id)
  })
}

export function listArtifacts(db, options = {}) {
  let sql = 'SELECT * FROM artifacts WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
  if (options.kind) { sql += ' AND kind = ?'; params.push(options.kind) }
  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limitOf(options.limit, 100, 500))
  return db.db.prepare(sql).all(...params).map(mapArtifact)
}
