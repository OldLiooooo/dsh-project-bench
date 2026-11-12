// 文档领域（T1）：documents / doc_versions / doc_sections / doc_fts。
// 不变量：
// - 文档版本只增不改；旧版本内容永不更新（只有 derived 的 doc_sections 可重建）。
// - 冻结（frozen）后拒绝写新版本 -> DOC_FROZEN；返工 = 解冻决策后新版本。
// - 同内容 hash 幂等：重复写相同内容返回已有版本，不新增版本、不写事件。
// - 检索走 FTS5 trigram；查询 <3 字符（中文两字词等）用 LIKE 兜底；结果只返回章节片段，不返回全文。
import { fail, requireProjectId } from './db.js'
import { newId, nowIso, sha256, parseMarkdownSections } from './util.js'

export const DOCUMENT_TYPES = ['prd', 'ux', 'adr', 'design', 'spec', 'report', 'handoff', 'retro']
export const DOCUMENT_STATUSES = ['draft', 'review', 'approved', 'frozen']

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('INVALID', field + ' 必须是非空字符串')
  return value.trim()
}

function limitOf(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

function requireSlice(db, sliceId) {
  const row = db.db.prepare('SELECT id FROM slices WHERE id = ? AND project_id = ?').get(sliceId, requireProjectId(db))
  if (!row) throw fail('NOT_FOUND', 'slice not found: ' + sliceId)
  return row.id
}

export function mapDocument(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    sliceId: row.slice_id ?? undefined,
    type: row.type,
    logicalKey: row.logical_key,
    title: row.title,
    status: row.status,
    currentVersion: Number(row.current_version || 0),
    ownerSession: row.owner_session ?? undefined,
    stage: row.stage ?? undefined,
    frozen: row.status === 'frozen',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function mapDocVersion(row, options = {}) {
  if (!row) return undefined
  const result = {
    id: row.id,
    documentId: row.document_id,
    version: Number(row.version),
    contentHash: row.content_hash,
    authorSession: row.author_session ?? undefined,
    frozen: Boolean(row.frozen),
    createdAt: row.created_at,
  }
  if (options.withContent !== false) result.content = row.content
  if (row.chars !== undefined) result.chars = Number(row.chars)
  return result
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

export function getDocument(db, documentId) {
  if (!documentId) return undefined
  const row = db.db.prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?').get(documentId, requireProjectId(db))
  return mapDocument(row)
}

export function findDocumentByLogicalKey(db, logicalKey) {
  if (!logicalKey) return undefined
  const row = db.db.prepare('SELECT * FROM documents WHERE project_id = ? AND logical_key = ?').get(requireProjectId(db), String(logicalKey))
  return mapDocument(row)
}

export function createDocument(db, input = {}) {
  const projectId = requireProjectId(db)
  const type = requiredText(input.type, 'type')
  if (!DOCUMENT_TYPES.includes(type)) throw fail('INVALID', 'document type 必须是 ' + DOCUMENT_TYPES.join('/'))
  const logicalKey = requiredText(input.logicalKey, 'logicalKey')
  const title = requiredText(input.title, 'title')
  const sliceId = input.sliceId ?? null
  if (sliceId) requireSlice(db, sliceId)
  return db.tx(() => {
    const dup = db.db.prepare('SELECT id FROM documents WHERE project_id = ? AND logical_key = ?').get(projectId, logicalKey)
    if (dup) throw fail('DUPLICATE_DOCUMENT', 'logicalKey 已存在：' + logicalKey, { documentId: dup.id, logicalKey: logicalKey })
    const id = newId('doc')
    const at = nowIso()
    db.db.prepare('INSERT INTO documents(id, project_id, slice_id, type, logical_key, title, status, current_version, owner_session, stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, sliceId, type, logicalKey, title, 'draft', 0, input.ownerSession ?? null, input.stage ?? null, at, at)
    db.appendEvent({
      kind: 'doc/create',
      sliceId: sliceId || undefined,
      subjectType: 'document',
      subjectId: id,
      actorSession: input.ownerSession ?? undefined,
      payload: { type: type, logicalKey: logicalKey, title: title, stage: input.stage || undefined },
    })
    return getDocument(db, id)
  })
}

export function listDocuments(db, options = {}) {
  let sql = 'SELECT * FROM documents WHERE project_id = ?'
  const params = [requireProjectId(db)]
  if (options.sliceId) { sql += ' AND slice_id = ?'; params.push(options.sliceId) }
  if (options.type) { sql += ' AND type = ?'; params.push(options.type) }
  if (options.status) { sql += ' AND status = ?'; params.push(options.status) }
  sql += ' ORDER BY created_at ASC, logical_key ASC'
  return db.db.prepare(sql).all(...params).map(mapDocument)
}

// ---------------------------------------------------------------------------
// doc_versions（只增）
// ---------------------------------------------------------------------------

export function getLatestDocVersion(db, documentId) {
  const row = db.db.prepare('SELECT * FROM doc_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1').get(documentId)
  return mapDocVersion(row)
}

export function getDocVersion(db, documentId, version) {
  let target = version
  if (target === undefined || target === null) {
    const doc = getDocument(db, documentId)
    if (!doc || !doc.currentVersion) return undefined
    target = doc.currentVersion
  }
  const row = db.db.prepare('SELECT * FROM doc_versions WHERE document_id = ? AND version = ?').get(documentId, Number(target))
  return mapDocVersion(row)
}

export function listDocVersions(db, documentId) {
  if (!documentId) return []
  const rows = db.db.prepare('SELECT id, document_id, version, content_hash, author_session, event_id, frozen, created_at, length(content) AS chars FROM doc_versions WHERE document_id = ? ORDER BY version ASC').all(documentId)
  return rows.map(function (row) { return mapDocVersion(row, { withContent: false }) })
}

export function writeDocumentVersion(db, input = {}) {
  const documentId = requiredText(input.docId || input.documentId, 'docId')
  if (typeof input.content !== 'string' || input.content.length === 0) throw fail('INVALID', 'content 必须是非空字符串')
  return db.tx(() => {
    const doc = getDocument(db, documentId)
    if (!doc) throw fail('NOT_FOUND', 'document not found: ' + documentId)
    if (doc.frozen) throw fail('DOC_FROZEN', '文档已冻结，不能写新版本：' + documentId, { documentId: documentId, currentVersion: doc.currentVersion })
    const content = input.content
    const hash = sha256(content)
    const latest = getLatestDocVersion(db, documentId)
    if (latest && latest.contentHash === hash) {
      // 幂等：同内容重复写 -> 返回已有版本，不新增版本、不写事件。
      return { doc: doc, version: latest, created: false }
    }
    const title = input.title === undefined ? doc.title : requiredText(input.title, 'title')
    const status = input.status === undefined ? doc.status : requiredText(input.status, 'status')
    if (!DOCUMENT_STATUSES.includes(status)) throw fail('INVALID', 'document status 必须是 ' + DOCUMENT_STATUSES.join('/'))
    if (status === 'frozen') throw fail('INVALID', '冻结文档请使用 freezeDocument')
    const versionNumber = doc.currentVersion + 1
    const at = nowIso()
    db.db.prepare('INSERT INTO doc_versions(id, document_id, version, content, content_hash, author_session, event_id, frozen, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newId('docv'), documentId, versionNumber, content, hash, input.authorSession ?? null, null, 0, at)
    db.db.prepare('UPDATE documents SET title = ?, status = ?, current_version = ?, updated_at = ? WHERE id = ?')
      .run(title, status, versionNumber, at, documentId)
    const derived = rebuildDocSections(db, documentId)
    db.appendEvent({
      kind: 'doc/version',
      sliceId: doc.sliceId,
      subjectType: 'document',
      subjectId: documentId,
      actorSession: input.authorSession ?? undefined,
      payload: { version: versionNumber, contentHash: hash, title: title, status: status, sections: derived.sections },
    })
    return { doc: getDocument(db, documentId), version: getDocVersion(db, documentId, versionNumber), created: true }
  })
}

export function freezeDocument(db, input = {}) {
  const documentId = requiredText(input.docId || input.documentId, 'docId')
  return db.tx(() => {
    const doc = getDocument(db, documentId)
    if (!doc) throw fail('NOT_FOUND', 'document not found: ' + documentId)
    const targetVersion = input.version === undefined ? doc.currentVersion : Number(input.version)
    if (!Number.isFinite(targetVersion) || targetVersion <= 0) throw fail('NOT_FOUND', 'document has no version to freeze: ' + documentId)
    const versionRow = getDocVersion(db, documentId, targetVersion)
    if (!versionRow) throw fail('NOT_FOUND', 'doc version not found: ' + documentId + '@' + targetVersion)
    if (doc.frozen && versionRow.frozen) return doc
    const at = nowIso()
    db.db.prepare('UPDATE doc_versions SET frozen = 1 WHERE document_id = ? AND version = ?').run(documentId, targetVersion)
    db.db.prepare("UPDATE documents SET status = 'frozen', updated_at = ? WHERE id = ?").run(at, documentId)
    db.appendEvent({
      kind: 'doc/freeze',
      sliceId: doc.sliceId,
      subjectType: 'document',
      subjectId: documentId,
      actorSession: input.actorSession ?? undefined,
      payload: { version: targetVersion },
    })
    return getDocument(db, documentId)
  })
}

// ---------------------------------------------------------------------------
// doc_sections / doc_fts（派生层，可重复重建；不写事件，因为由 doc/version 事件覆盖）
// ---------------------------------------------------------------------------

export function rebuildDocSections(db, docId) {
  const documentId = requiredText(docId, 'docId')
  return db.tx(() => {
    const doc = getDocument(db, documentId)
    if (!doc) throw fail('NOT_FOUND', 'document not found: ' + documentId)
    db.db.prepare('DELETE FROM doc_sections WHERE document_id = ?').run(documentId)
    db.db.prepare('DELETE FROM doc_fts WHERE document_id = ?').run(documentId)
    if (!doc.currentVersion) return { docId: documentId, version: 0, sections: 0 }
    const latest = getDocVersion(db, documentId, doc.currentVersion)
    if (!latest) throw fail('NOT_FOUND', 'doc version not found: ' + documentId + '@' + doc.currentVersion)
    const sections = parseMarkdownSections(latest.content)
    const insertSection = db.db.prepare('INSERT INTO doc_sections(id, document_id, version, ordinal, heading, content, content_hash) VALUES (?,?,?,?,?,?,?)')
    const insertFts = db.db.prepare('INSERT INTO doc_fts(document_id, version, heading, content) VALUES (?,?,?,?)')
    let ordinal = 0
    for (const section of sections) {
      const heading = section.heading || '正文'
      const body = section.content || ''
      insertSection.run(newId('sec'), documentId, latest.version, ordinal, heading, body, sha256(body))
      insertFts.run(documentId, latest.version, heading, body)
      ordinal += 1
    }
    return { docId: documentId, version: latest.version, sections: sections.length }
  })
}

// ---------------------------------------------------------------------------
// 检索：trigram FTS + 两字 LIKE 兜底，只返回章节片段
// ---------------------------------------------------------------------------

function buildFtsQuery(query) {
  const terms = String(query || '').split(/\s+/).filter(function (term) { return Array.from(term).length >= 3 })
  if (terms.length === 0) return ''
  return terms.map(function (term) { return '"' + term.replace(/"/g, '""') + '"' }).join(' AND ')
}

function escapeLike(text) {
  return String(text).replace(/[#%_]/g, function (ch) { return '#' + ch })
}

function buildSnippet(content, query, before, after) {
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const lowered = text.toLowerCase()
  const terms = String(query || '').split(/\s+/).filter(Boolean)
  let index = lowered.indexOf(String(query || '').trim().toLowerCase())
  let matchLength = String(query || '').trim().length
  if (index < 0) {
    for (const term of terms) {
      const found = lowered.indexOf(term.toLowerCase())
      if (found >= 0) { index = found; matchLength = term.length; break }
    }
  }
  if (index < 0) return text.length > 120 ? text.slice(0, 117) + '…' : text
  const start = Math.max(0, index - before)
  const end = Math.min(text.length, index + matchLength + after)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = '…' + snippet
  if (end < text.length) snippet = snippet + '…'
  return snippet
}

/**
 * 章节检索。返回 [{documentId,title,version,heading,snippet,score}]；
 * snippet 是命中片段（≤约 200 字符），绝不返回全文。
 */
export function searchDocSections(db, input = {}) {
  const projectId = requireProjectId(db)
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const limit = limitOf(input.limit, 5, 20)
  if (!query) return []
  const rows = []
  const seen = new Set()

  function pushRow(row, score, snippet) {
    const key = row.document_id + '|' + row.heading
    if (seen.has(key)) return
    seen.add(key)
    rows.push({
      documentId: row.document_id,
      title: row.title,
      version: Number(row.version),
      heading: row.heading,
      snippet: snippet,
      score: score,
    })
  }

  const ftsQuery = buildFtsQuery(query)
  if (ftsQuery) {
    try {
      let sql = 'SELECT doc_fts.document_id AS document_id, doc_fts.version AS version, doc_fts.heading AS heading, doc_fts.content AS content, d.title AS title, bm25(doc_fts) AS rank FROM doc_fts JOIN documents d ON d.id = doc_fts.document_id WHERE doc_fts MATCH ? AND d.project_id = ? AND doc_fts.version = d.current_version'
      const params = [ftsQuery, projectId]
      if (input.sliceId) { sql += ' AND d.slice_id = ?'; params.push(input.sliceId) }
      sql += ' ORDER BY rank LIMIT ?'
      params.push(limit * 5)
      const found = db.db.prepare(sql).all(...params)
      for (const row of found) {
        if (rows.length >= limit) break
        pushRow(row, Number.isFinite(Number(row.rank)) ? Number((-Number(row.rank)).toFixed(6)) : 0, buildSnippet(row.content, query, 40, 80))
      }
    } catch (error) {
      // trigram 对特殊字符/过短查询可能报语法错误，交给 LIKE 兜底；其它异常继续抛出。
      const message = String(error && error.message ? error.message : error)
      if (message.indexOf('fts5') < 0 && message.indexOf('MATCH') < 0) throw error
    }
  }

  if (rows.length < limit) {
    const terms = String(query).split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      const where = []
      const params = [projectId]
      for (const term of terms) {
        where.push("(s.heading LIKE ? ESCAPE '#' OR s.content LIKE ? ESCAPE '#')")
        const pattern = '%' + escapeLike(term) + '%'
        params.push(pattern, pattern)
      }
      let sql = 'SELECT s.document_id AS document_id, s.version AS version, s.heading AS heading, s.content AS content, d.title AS title FROM doc_sections s JOIN documents d ON d.id = s.document_id WHERE d.project_id = ? AND s.version = d.current_version AND ' + where.join(' AND ')
      if (input.sliceId) { sql += ' AND d.slice_id = ?'; params.push(input.sliceId) }
      sql += ' ORDER BY s.ordinal ASC LIMIT ?'
      params.push(limit * 5)
      const found = db.db.prepare(sql).all(...params)
      for (const row of found) {
        if (rows.length >= limit) break
        pushRow(row, 0.5, buildSnippet(row.content, query, 40, 80))
      }
    }
  }

  return rows.slice(0, limit)
}
