// 导入边界（T1）：只从 <root>/.project/inbox 读外部产物，作为文档新版本写入 DB。
// 记录 imports 行 + import/inbox 事件；不做双向同步，不读用 docs/ 导出文件。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fail, projectRootOf } from './db.js'
import { createDocument, findDocumentByLogicalKey, getDocument, writeDocumentVersion } from './docs.js'
import { newId, nowIso, sha256 } from './util.js'

function toPosix(path) {
  return String(path).replace(/\\/g, '/')
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function resolveInboxPath(root, sourcePath) {
  const raw = typeof sourcePath === 'string' ? sourcePath.trim() : ''
  if (!raw) throw fail('INVALID', 'sourcePath 必须是非空字符串')
  const inboxDir = resolve(root, '.project', 'inbox')
  let candidate
  const normalized = raw.replace(/\\/g, '/')
  if (isAbsolute(raw)) candidate = resolve(raw)
  else if (normalized === '.project/inbox' || normalized.startsWith('.project/inbox/')) candidate = resolve(root, raw)
  else if (normalized.startsWith('.project/')) candidate = resolve(root, raw)
  else candidate = resolve(inboxDir, raw)
  if (!existsSync(candidate)) throw fail('NOT_FOUND', 'inbox 文件不存在：' + candidate)
  const real = realpathSync(candidate)
  if (!existsSync(inboxDir)) throw fail('INVALID', '项目不存在 .project/inbox 目录')
  const realInbox = realpathSync(inboxDir)
  if (!isInside(realInbox, real)) throw fail('INVALID', '只允许导入 .project/inbox 下的文件：' + candidate, { inbox: realInbox })
  const stat = statSync(real)
  if (!stat.isFile()) throw fail('INVALID', 'inbox 路径不是文件：' + candidate)
  return {
    absolutePath: real,
    relativePath: toPosix(relative(root, real)),
    inboxDir: inboxDir,
  }
}

function baseNameOf(relativePath) {
  const parts = String(relativePath).split('/')
  const file = parts[parts.length - 1] || 'inbox'
  return file.replace(/\.[^.]+$/, '') || 'inbox'
}

export function mapImport(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    sourcePath: row.source_path,
    contentHash: row.content_hash,
    documentId: row.document_id ?? undefined,
    version: row.version === null || row.version === undefined ? undefined : Number(row.version),
    kind: row.kind,
    importedBy: row.imported_by ?? undefined,
    importedAt: row.imported_at,
  }
}

export function listImports(db, options = {}) {
  let sql = 'SELECT * FROM imports WHERE project_id = ?'
  const params = [db.projectId]
  if (options.documentId) { sql += ' AND document_id = ?'; params.push(options.documentId) }
  sql += ' ORDER BY imported_at DESC LIMIT ?'
  params.push(Math.max(1, Math.min(Number(options.limit) || 100, 500)))
  return db.db.prepare(sql).all(...params).map(mapImport)
}

/**
 * 导入 inbox 文件为文档新版本。
 * input: {sourcePath, docId?, type?, title?, logicalKey?, sliceId?, importedBy}
 * 返回 {doc, version, created, import, sourcePath, contentHash}
 */
export function importInboxFile(db, input = {}) {
  const root = projectRootOf(db)
  if (!root) throw fail('INVALID', '导入需要项目根目录（.project 所在目录）')
  const inbox = resolveInboxPath(root, input.sourcePath)
  let content = readFileSync(inbox.absolutePath, 'utf8')
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  if (!content.trim()) throw fail('INVALID', 'inbox 文件内容为空：' + inbox.relativePath)
  const contentHash = sha256(content)
  const fallbackBase = baseNameOf(inbox.relativePath)
  return db.tx(() => {
    let doc
    if (input.docId) {
      doc = getDocument(db, input.docId)
      if (!doc) throw fail('NOT_FOUND', 'document not found: ' + input.docId)
    } else {
      if (!input.type) throw fail('INVALID', '新建导入文档需要 type（或提供 docId）')
      let logicalKey = input.logicalKey
      if (!logicalKey) logicalKey = String(input.type) + '/' + fallbackBase
      doc = findDocumentByLogicalKey(db, logicalKey)
      if (!doc) {
        doc = createDocument(db, {
          sliceId: input.sliceId,
          type: input.type,
          logicalKey: logicalKey,
          title: input.title || fallbackBase,
          stage: input.stage,
          ownerSession: input.importedBy,
        })
      }
    }
    const result = writeDocumentVersion(db, {
      docId: doc.id,
      content: content,
      authorSession: input.importedBy,
      title: input.title === undefined ? undefined : input.title,
    })
    const at = nowIso()
    const importId = newId('import')
    db.db.prepare('INSERT INTO imports(id, project_id, source_path, content_hash, document_id, version, kind, imported_by, imported_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(importId, db.projectId, inbox.relativePath, contentHash, doc.id, result.version.version, 'inbox', input.importedBy ?? null, at)
    db.appendEvent({
      kind: 'import/inbox',
      sliceId: doc.sliceId,
      subjectType: 'document',
      subjectId: doc.id,
      actorSession: input.importedBy,
      payload: {
        sourcePath: inbox.relativePath,
        contentHash: contentHash,
        documentId: doc.id,
        version: result.version.version,
        importId: importId,
        created: result.created,
      },
    })
    const imported = db.db.prepare('SELECT * FROM imports WHERE id = ?').get(importId)
    return {
      doc: result.doc,
      version: result.version,
      created: result.created,
      import: mapImport(imported),
      sourcePath: inbox.relativePath,
      contentHash: contentHash,
    }
  })
}
