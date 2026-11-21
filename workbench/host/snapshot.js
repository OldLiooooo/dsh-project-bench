// 快照查询（T2 host-api）：把项目库投影成客户端驾驶舱需要的只读形状。
// 树默认只展开「阶段 → 切片」，子对象按 counts 汇总（点击切片再走 /slice 取全量）；
// 节点总量超过上限时截断切片并返回 truncated 标记。
// 行映射直接复用 T1 的 store/docs 映射函数，保证工具层与面板字段一致。
import {
  mapSlice as mapSliceRow,
  mapTask as mapTaskRow,
  mapSession as mapSessionRow,
  mapDecision as mapDecisionRow,
  mapEvidence as mapEvidenceRow,
} from './store.js'
import {
  mapDocument as mapDocumentRow,
  getDocument,
  getDocVersion,
  listDocVersions,
} from './docs.js'

const TREE_NODE_LIMIT = 200
const TREE_TIMELINE_LIMIT = 8
const SESSION_LIMIT = 500
const EVENT_LIMIT = 200

export { mapSliceRow, mapTaskRow, mapSessionRow, mapDecisionRow, mapEvidenceRow, mapDocumentRow }

export function mapStageRow(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    gate: row.gate ?? null,
    position: Number(row.position ?? 0),
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function countRows(db, table, where = '', params = []) {
  const row = db.db.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE project_id = ?' + (where ? ' AND ' + where : '')).get(db.projectId, ...params)
  return Number(row?.n ?? 0)
}

function groupCounts(db, table) {
  const rows = db.db.prepare('SELECT slice_id AS sliceId, COUNT(*) AS n FROM ' + table + ' WHERE project_id = ? GROUP BY slice_id').all(db.projectId)
  const map = new Map()
  for (const row of rows) if (row.sliceId) map.set(row.sliceId, Number(row.n))
  return map
}

// ---------------------------------------------------------------------------
// 基础查询
// ---------------------------------------------------------------------------

/**
 * 阶段行。默认只返回**活阶段机**（status != 'retired'）：
 * 换过模板的项目里旧阶段会被 retire 但仍留在表里（保留历史事件），
 * 如果把它们混进 active 判定，currentStage/advanceStage 会选错阶段（实测会推进到已退役的 S1）。
 * 需要完整历史时显式传 { includeRetired: true }。
 */
export function listStages(db, options = {}) {
  const rows = db.db
    .prepare('SELECT * FROM stages WHERE project_id = ? ORDER BY position ASC, rowid ASC')
    .all(db.projectId)
  const filtered = options && options.includeRetired === true ? rows : rows.filter((row) => row.status !== 'retired')
  return filtered.map(mapStageRow)
}

export function currentStage(db) {
  const stages = listStages(db)
  return stages.find((stage) => stage.status === 'active') || stages[stages.length - 1] || null
}

export function listSessions(db, options = {}) {
  const limit = clamp(Number(options.limit) || SESSION_LIMIT, 1, SESSION_LIMIT)
  return db.db
    .prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(db.projectId, limit)
    .map(mapSessionRow)
}

export function listPendingDecisions(db) {
  return db.db
    .prepare("SELECT * FROM decisions WHERE project_id = ? AND status = 'pending' ORDER BY created_at DESC")
    .all(db.projectId)
    .map(mapDecisionRow)
}

export function pmEnsure(db) {
  const row = db.db
    .prepare("SELECT * FROM sessions WHERE project_id = ? AND kind = 'pm' AND status = 'active' ORDER BY started_at DESC LIMIT 1")
    .get(db.projectId)
  return row ? mapSessionRow(row) : undefined
}

/** slices 表没有 stage 列：按最近文档/决策的 stage 归组，缺省归到当前阶段。 */
export function sliceStageKey(db, sliceId) {
  if (!sliceId) return currentStage(db)?.key ?? null
  const doc = db.db.prepare('SELECT stage FROM documents WHERE project_id = ? AND slice_id = ? AND stage IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(db.projectId, sliceId)
  if (doc && doc.stage) return doc.stage
  const decision = db.db.prepare('SELECT stage FROM decisions WHERE project_id = ? AND slice_id = ? AND stage IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(db.projectId, sliceId)
  if (decision && decision.stage) return decision.stage
  return currentStage(db)?.key ?? null
}

// ---------------------------------------------------------------------------
// 驾驶舱投影
// ---------------------------------------------------------------------------

/**
 * 项目进度（v5）：唯一口径 = 已验证完成（Verified Done）。
 *
 * 设计 §6.2 的 13 个指标都建在这一个分母上，所以它必须是**可解释的**：
 * 只给一个百分比没有意义，必须能回答「差的那些卡在哪个状态」。
 *
 * 口径约定：
 *   - total：参与统计的切片 = 排除 archived / cut（它们是有意不做的，算进分母会永久拉低进度）；
 *   - verified：status='verified'；
 *   - inFlight：in_progress / review（正在做或等待验收）；
 *   - blocked：blocked（阻塞，PM 该去解的）；
 *   - abandoned：archived / cut（裁剪掉的，单独报，不进分母）。
 * @returns {{total:number, verified:number, inFlight:number, blocked:number, notStarted:number,
 *            abandoned:number, percent:number, basis:string}}
 */
export function projectProgress(db) {
  const rows = db.db.prepare("SELECT status, COUNT(*) AS n FROM slices WHERE project_id = ? GROUP BY status").all(db.projectId)
  const byStatus = new Map()
  for (const row of rows) byStatus.set(String(row.status), Number(row.n))
  const num = (key) => Number(byStatus.get(key) || 0)
  const verified = num('verified')
  const inFlight = num('in_progress') + num('review')
  const blocked = num('blocked')
  const notStarted = num('open')
  const doneUnverified = num('done')
  const abandoned = num('archived') + num('cut')
  const total = verified + inFlight + blocked + notStarted + doneUnverified
  const percent = total === 0 ? 0 : Math.round((verified / total) * 100)
  return {
    total, verified, inFlight, blocked, notStarted,
    /** done 但未验收：这是最容易自我欺骗的一档，单独报出来。 */
    doneUnverified,
    abandoned,
    percent,
    basis: 'verified-only',
  }
}

export function overview(db, root) {
  const project = db.project() || {}
  const stages = listStages(db)
  const stage = stages.find((item) => item.status === 'active') || stages[stages.length - 1] || null
  const pendingDecisions = countRows(db, 'decisions', "status = 'pending'")
  const blockedSlices = countRows(db, 'slices', "status = 'blocked'")
  const documents = countRows(db, 'documents')
  const createdAt = project.created_at || null
  // v5：period 由 period_roll 显式写入（此前只在读侧存在、无人写 → 周期永远是当月）。
  const period = db.getMeta('period.current') || (createdAt ? String(createdAt).slice(0, 7) : new Date().toISOString().slice(0, 7))
  const periodIndex = Number(db.getMeta('period.index') || 0)
  const periodStartedAt = db.getMeta('period.startedAt') || null
  // v5：进度只认 verified。设计 §6.2「唯一原子 = 已验证完成」——done 是交付方自认完成，
  // verified 才是独立验收通过。这里给出分母/分子/百分比，以及可解释的「为什么没满」。
  const progress = projectProgress(db)
  // 健康度：有阻塞 → blocked；有待决策 → attention；有活但没做完 → on_track；
  // 全部验收完（且不是空项目）→ done。
  const health = blockedSlices > 0 ? 'blocked'
    : pendingDecisions > 0 ? 'attention'
    : (progress.total > 0 && progress.verified === progress.total) ? 'done'
    : 'on_track'
  return {
    project: {
      id: db.projectId,
      name: project.name || '',
      root: root || db.root || project.root || '.',
      stage,
      period,
      periodIndex,
      periodStartedAt,
      health,
      createdAt,
    },
    counts: {
      slices: countRows(db, 'slices'),
      tasks: countRows(db, 'tasks'),
      sessions: countRows(db, 'sessions', "status = 'active'"),
      // 契约 §4 用 docs；面板/工具读 documents，两个键保持同值。
      docs: documents,
      documents,
      decisions: countRows(db, 'decisions'),
      evidence: countRows(db, 'evidence'),
      pendingDecisions,
    },
    /** v5：进度（唯一口径 = verified）。面板/工具/PM 都读这一个字段，不各算各的。 */
    progress,
    stage,
    stages,
  }
}

/** 树投影：阶段 → 切片（子对象只给 counts，全量走 sliceDetail）。 */
export function treeGroups(db, options = {}) {
  const maxNodes = clamp(Number(options.maxNodes) || TREE_NODE_LIMIT, 8, 2000)
  const stages = listStages(db)
  const current = stages.find((item) => item.status === 'active') || null
  const slices = db.db.prepare('SELECT * FROM slices WHERE project_id = ? ORDER BY created_at ASC, key ASC').all(db.projectId).map(mapSliceRow)
  const taskCounts = groupCounts(db, 'tasks')
  const sessionCounts = groupCounts(db, 'sessions')
  const docCounts = groupCounts(db, 'documents')
  const decisionCounts = groupCounts(db, 'decisions')
  const evidenceCounts = groupCounts(db, 'evidence')

  const buckets = new Map()
  for (const stage of stages) buckets.set(stage.key, { stage, slices: [] })
  const orphan = { stage: { id: null, key: null, name: '未分阶段', status: 'pending', gate: null, position: stages.length, startedAt: null, endedAt: null }, slices: [] }
  for (const slice of slices) {
    const bucket = buckets.get(sliceStageKey(db, slice.id)) || orphan
    bucket.slices.push(slice)
  }

  const groups = [...buckets.values()]
  if (orphan.slices.length > 0) groups.push(orphan)

  const stageNodes = groups.length
  const maxSlices = Math.max(0, maxNodes - stageNodes)
  let kept = 0
  let truncated = false
  for (const group of groups) {
    const allowed = Math.max(0, maxSlices - kept)
    if (group.slices.length > allowed) truncated = true
    group.slices = group.slices.slice(0, allowed)
    kept += group.slices.length
  }

  const recent = db.listEvents({ limit: 60 })
  const result = groups.map((group) => {
    const ids = new Set(group.slices.map((slice) => slice.id))
    const timeline = recent.filter((event) =>
      (event.sliceId && ids.has(event.sliceId)) ||
      (event.subjectType === 'stage' && event.subjectId === group.stage.key)).slice(0, TREE_TIMELINE_LIMIT)
    return {
      stage: group.stage,
      slices: group.slices.map((slice) => ({
        slice,
        stageKey: group.stage.key,
        counts: {
          tasks: taskCounts.get(slice.id) || 0,
          sessions: sessionCounts.get(slice.id) || 0,
          documents: docCounts.get(slice.id) || 0,
          decisions: decisionCounts.get(slice.id) || 0,
          evidence: evidenceCounts.get(slice.id) || 0,
        },
        tasks: [],
        sessions: [],
        documents: [],
        decisions: [],
        evidence: [],
      })),
      timeline,
    }
  })
  return { groups: result, truncated, nodes: stageNodes + kept, totalSlices: slices.length, currentStageKey: current?.key ?? null }
}

/** 契约 §4 的 tree(db) 形状：阶段分组数组。 */
export function tree(db, options = {}) {
  return treeGroups(db, options).groups
}

function sliceTitleMap(db) {
  const rows = db.db.prepare('SELECT id, key, title FROM slices WHERE project_id = ?').all(db.projectId)
  return new Map(rows.map((row) => [row.id, { id: row.id, key: row.key, title: row.title }]))
}

export function sliceDetail(db, sliceId) {
  if (!sliceId) throw notFound('slice id is required')
  const row = db.db.prepare('SELECT * FROM slices WHERE project_id = ? AND id = ?').get(db.projectId, sliceId)
  if (!row) throw notFound('slice not found: ' + sliceId)
  const slice = mapSliceRow(row)
  const tasks = db.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND slice_id = ? ORDER BY created_at ASC').all(db.projectId, sliceId).map(mapTaskRow)
  const sessions = db.db.prepare('SELECT * FROM sessions WHERE project_id = ? AND slice_id = ? ORDER BY started_at ASC').all(db.projectId, sliceId).map(mapSessionRow)
  const documents = db.db.prepare('SELECT * FROM documents WHERE project_id = ? AND slice_id = ? ORDER BY created_at ASC').all(db.projectId, sliceId).map(mapDocumentRow)
  const decisions = db.db.prepare('SELECT * FROM decisions WHERE project_id = ? AND slice_id = ? ORDER BY created_at ASC').all(db.projectId, sliceId).map(mapDecisionRow)
  const evidence = db.db.prepare('SELECT * FROM evidence WHERE project_id = ? AND slice_id = ? ORDER BY created_at DESC').all(db.projectId, sliceId).map(mapEvidenceRow)
  const artifacts = db.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND slice_id = ? ORDER BY created_at DESC').all(db.projectId, sliceId).map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    path: artifact.path,
    contentHash: artifact.content_hash ?? null,
    bytes: artifact.bytes ?? null,
    createdAt: artifact.created_at,
  }))
  return {
    slice,
    stageKey: sliceStageKey(db, sliceId),
    tasks,
    sessions,
    documents,
    decisions,
    evidence,
    artifacts,
    recentTimeline: db.listEvents({ sliceId, limit: 20 }),
  }
}

export function docPreview(db, docId, options = {}) {
  if (!docId) throw notFound('document id is required')
  const doc = getDocument(db, docId)
  if (!doc) throw notFound('document not found: ' + docId)
  const versions = listDocVersions(db, docId)
  const requested = options.version !== undefined && options.version !== null && options.version !== '' ? Number(options.version) : undefined
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) throw notFound('invalid document version: ' + options.version)
  if (requested === undefined && versions.length === 0) {
    return { doc: { ...doc, frozen: Boolean(doc.frozen) }, versions, version: 0, content: '', contentHash: null, frozen: Boolean(doc.frozen) }
  }
  const version = requested === undefined ? doc.currentVersion : requested
  const row = getDocVersion(db, docId, version)
  if (!row) throw notFound('document version not found: ' + docId + ' v' + version)
  const frozen = Boolean(doc.frozen) || Boolean(row.frozen)
  return {
    doc: { ...doc, frozen },
    versions,
    version: Number(row.version),
    content: row.content,
    contentHash: row.contentHash,
    frozen,
  }
}

export function timelinePage(db, options = {}) {
  const afterSeq = Number(options.afterSeq) || 0
  const limit = clamp(Number(options.limit) || 50, 1, EVENT_LIMIT)
  const events = db.listEvents({
    afterSeq,
    limit,
    kinds: options.kinds,
    sliceId: options.sliceId,
  })
  const newest = events.length > 0 ? Math.max(...events.map((event) => event.seq)) : afterSeq
  return { events, revision: db.revision(), afterSeq: newest }
}

/** 面板一次拉取的完整快照（客户端收到 SSE change 后重新 GET 本接口）。 */
export function buildSnapshot(db, options = {}) {
  const root = options.root
  const timelineLimit = clamp(Number(options.timelineLimit) || 20, 1, 100)
  const treeResult = treeGroups(db, { maxNodes: options.maxNodes })
  const slices = sliceTitleMap(db)
  const sessions = listSessions(db).map((session) => ({
    ...session,
    sliceTitle: session.sliceId ? (slices.get(session.sliceId)?.title ?? null) : null,
  }))
  const pendingDecisions = listPendingDecisions(db).map((decision) => ({
    ...decision,
    sliceTitle: decision.sliceId ? (slices.get(decision.sliceId)?.title ?? null) : null,
  }))
  const ov = overview(db, root)
  return {
    initialized: true,
    revision: db.revision(),
    project: { ...ov.project, counts: ov.counts, progress: ov.progress },
    progress: ov.progress,
    stages: ov.stages,
    tree: treeResult.groups,
    truncated: treeResult.truncated,
    sessions,
    pm: pmEnsure(db) ?? null,
    pendingDecisions,
    recentTimeline: db.listEvents({ limit: timelineLimit }),
  }
}

export function notFound(message) {
  const error = new Error(message)
  error.code = 'NOT_FOUND'
  error.status = 404
  return error
}
