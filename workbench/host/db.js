// ProjectDb: the single-writer SQLite handle. Every mutation runs in one IMMEDIATE transaction
// together with its append-only event, so the timeline can always be replayed (architecture invariant 1).
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { migrate } from './schema.js'
import { newId, nowIso, jsonText, parseJson } from './util.js'

/**
 * ProjectError factory. Domain modules throw plain Error objects with a stable `code`;
 * tool/HTTP layers translate them to `{error:{code,message}}` without string matching.
 */
export function fail(code, message, details) {
  const error = new Error(message || code)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

/** Every domain write must know which project row it belongs to. */
export function requireProjectId(db) {
  if (!db || !db.projectId) throw fail('INVALID', 'project database is not initialised (no project row)')
  return db.projectId
}

/** Project root of the .project/ directory that owns this database. */
export function projectRootOf(db) {
  if (!db) return undefined
  if (db.root) return db.root
  return inferProjectRoot(db.file)
}

function inferProjectRoot(file) {
  if (!file || file === ':memory:') return undefined
  const dir = dirname(file)
  if (basename(dir) === '.project') return dirname(dir)
  return dir
}

export class ProjectDb {
  constructor(file, options = {}) {
    if (file && file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.file = file
    this.txDepth = 0
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    migrate(this.db)
    if (options.projectId) {
      this.ensureProject(options)
    } else {
      const row = this.db.prepare('SELECT id FROM projects LIMIT 1').get()
      if (row) this.projectId = row.id
    }
    this.root = options.root || inferProjectRoot(file)
  }

  close() { try { this.db.close() } catch (e) { /* already closed */ } }

  ensureProject(options) {
    const row = this.db.prepare('SELECT id FROM projects LIMIT 1').get()
    if (row) { this.projectId = row.id; return this.projectId }
    const id = options.projectId
    this.projectId = id
    this.db.prepare('INSERT INTO projects(id, name, root, stage_template_json, config_json, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, options.projectName || 'project', options.root || '', '[]', '{}', nowIso())
    return id
  }

  /** Current committed revision (max event seq) for client change detection. */
  revision() {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE project_id = ?').get(this.projectId)
    return row && row.s ? Number(row.s) : 0
  }

  project() { return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(this.projectId) }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO project_meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
  }

  getMeta(key) {
    try {
      const row = this.db.prepare('SELECT value FROM project_meta WHERE key = ?').get(key)
      return row ? row.value : undefined
    } catch (e) { return undefined }
  }

  /** Run fn inside BEGIN IMMEDIATE; nested calls reuse the outer transaction. */
  tx(fn) {
    if (this.txDepth > 0) return fn()
    this.txDepth = 1
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (e) { /* rollback failure is reported through the original error */ }
      throw error
    } finally { this.txDepth = 0 }
  }

  /**
   * Append one event. Must be called inside tx() for atomicity with the write it records.
   * seq is allocated from MAX(seq)+1 in the same transaction (append-only, no gaps).
   */
  appendEvent(input) {
    const at = input.at || nowIso()
    const last = this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE project_id = ?').get(this.projectId)
    const seq = (last && last.s ? Number(last.s) : 0) + 1
    const id = newId('evt')
    this.db.prepare('INSERT INTO events(id, project_id, seq, at, kind, actor_session, role, slice_id, subject_type, subject_id, payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, this.projectId, seq, at, input.kind ?? 'event/unknown', input.actorSession ?? null, input.role ?? null, input.sliceId ?? null,
        input.subjectType ?? null, input.subjectId ?? null, jsonText(input.payload ?? {}))
    return { id, seq, at }
  }

  listEvents(options = {}) {
    const afterSeq = options.afterSeq || 0
    const limit = Math.max(1, Math.min(Number(options.limit) || 50, 500))
    let sql = 'SELECT * FROM events WHERE project_id = ? AND seq > ?'
    const params = [this.projectId, afterSeq]
    if (options.kinds && options.kinds.length > 0) {
      sql += ' AND kind IN (' + options.kinds.map(() => '?').join(',') + ')'
      params.push(...options.kinds)
    }
    if (options.excludeKinds && options.excludeKinds.length > 0) {
      sql += ' AND kind NOT IN (' + options.excludeKinds.map(() => '?').join(',') + ')'
      params.push(...options.excludeKinds)
    }
    if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
    if (options.subjectType) { sql += ' AND subject_type = ?'; params.push(options.subjectType) }
    if (options.subjectId) { sql += ' AND subject_id = ?'; params.push(options.subjectId) }
    sql += ' ORDER BY seq DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params).map(mapEvent)
  }

  findEvent(id) {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id)
    return row ? mapEvent(row) : undefined
  }
}

export function mapEvent(row) {
  return {
    id: row.id,
    seq: Number(row.seq),
    at: row.at,
    kind: row.kind,
    actorSession: row.actor_session ?? undefined,
    role: row.role ?? undefined,
    sliceId: row.slice_id ?? undefined,
    subjectType: row.subject_type ?? undefined,
    subjectId: row.subject_id ?? undefined,
    payload: parseJson(row.payload_json, {}),
  }
}

/** Human labels for event kinds (timeline markdown / UI fallback). Keep keys identical to contracts §3. */
export const EVENT_KIND_LABELS = {
  'project/init': '项目初始化',
  'stage/change': '阶段变更',
  'slice/create': '创建切片',
  'slice/status': '切片状态',
  'task/create': '创建任务',
  'task/status': '任务状态',
  'session/create': '会话开始',
  'session/end': '会话结束',
  'doc/create': '创建文档',
  'doc/version': '文档新版本',
  'doc/freeze': '冻结文档',
  'doc/export': '导出文档',
  'decision/create': '创建决策',
  'decision/resolve': '决策落定',
  'gate/submit': '提交门禁',
  'gate/approve': '门禁通过',
  'gate/reject': '门禁驳回',
  'evidence/add': '新增证据',
  'artifact/add': '新增产物',
  'lease/acquire': '获取租约',
  'lease/release': '释放租约',
  'import/inbox': '导入外部产物',
  'export/snapshot': '导出快照',
  'context/downgrade': '上下文降级',
}

/** Event page in the shape the cockpit/timeline expects: newest first, seq continuation. */
export function timeline(db, options = {}) {
  return db.listEvents(options)
}

function summarizePayload(payload) {
  if (payload === undefined || payload === null) return ''
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  if (!text || text === '{}' || text === 'null') return ''
  return text.length > 160 ? text.slice(0, 157) + '…' : text
}

function timelineLine(event) {
  const bits = ['-', `#${event.seq}`, event.at, `${event.kind}`]
  if (event.role) bits.push(`[${event.role}]`)
  else if (event.actorSession) bits.push(`[${event.actorSession}]`)
  if (event.sliceId) bits.push(`slice:${event.sliceId}`)
  const subject = event.subjectType ? `${event.subjectType}:${event.subjectId ?? ''}` : ''
  if (subject) bits.push(subject)
  const summary = summarizePayload(event.payload)
  if (summary) bits.push(summary)
  return bits.join(' · ')
}

/**
 * Markdown rendering of the append-only timeline: DB -> text only (never read back).
 * Deterministic for a given event set so re-export produces the same bytes.
 */
export function timelineMarkdown(db, options = {}) {
  const events = db.listEvents({
    afterSeq: options.afterSeq ?? 0,
    limit: options.limit ?? 500,
    kinds: options.kinds,
    excludeKinds: options.excludeKinds,
    sliceId: options.sliceId,
  }).reverse()
  const project = db.project()
  const lines = []
  lines.push('# 项目时间线')
  lines.push('')
  lines.push('- 项目：' + ((project && project.name) || '') + '（' + (db.projectId || '') + '）')
  lines.push('- 事件数：' + events.length)
  lines.push('- 说明：本文件由项目数据库 events 表导出，按 seq 升序排列；只写文件，不回读。')
  lines.push('')
  if (events.length === 0) {
    lines.push('（暂无事件）')
  } else {
    for (const event of events) lines.push(timelineLine(event))
  }
  lines.push('')
  return lines.join('\n')
}
