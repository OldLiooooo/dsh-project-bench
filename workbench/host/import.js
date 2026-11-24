// 导入边界（T1）：只从 <root>/.project/inbox 读外部产物，作为文档新版本写入 DB。
// 记录 imports 行 + import/inbox 事件；不做双向同步，不读用 docs/ 导出文件。
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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

/**
 * 允许导入的 inbox 目录（v6.4，lumio 反馈 P2-2）。
 *
 * 原先有两个目录，但只有工作区那个被读：
 *   - `registry.projectPaths().inboxDir` 建的是 store 里的 `<storeRoot>/inbox`（权威数据搬到 store 之后应该在这里）；
 *   - `import.js` 读的却是 `<root>/.project/inbox`。
 * 结果：store 里那个目录永远是空的，而 DB 外移之后「权威数据在哪」这件事在导入路径上又退回了工作区。
 *
 * 现在两个都认，store 优先（它就是 registry 建的那个），工作区那个作为历史兼容保留 ——
 * 已有项目的文件在工作区里，直接切过去会静默失效。
 */
function inboxDirsOf(db, root) {
  const dirs = []
  // store 根 = DB 文件所在目录（project.db 就在 storeRoot 下），不用 import registry 也能算出来。
  try {
    const dbFile = db && db.file
    if (dbFile && dbFile !== ':memory:') dirs.push(resolve(dirname(dbFile), 'inbox'))
  } catch (error) { /* 算不出来就只用工作区那个 */ }
  dirs.push(resolve(root, '.project', 'inbox'))
  return dirs
}

function resolveInboxPath(root, sourcePath, options = {}) {
  const raw = typeof sourcePath === 'string' ? sourcePath.trim() : ''
  if (!raw) throw fail('INVALID', 'sourcePath 必须是非空字符串')
  const inboxDirs = Array.isArray(options.inboxDirs) && options.inboxDirs.length > 0
    ? options.inboxDirs
    : [resolve(root, '.project', 'inbox')]
  const inboxDir = inboxDirs[0]
  const normalized = raw.replace(/\\/g, '/')
  // 逐个候选目录试：先按相对路径找，找不到再试其它 inbox 目录。
  const candidates = []
  if (isAbsolute(raw)) candidates.push(resolve(raw))
  else if (normalized.startsWith('.project/inbox/')) candidates.push(resolve(root, raw))
  else if (normalized.startsWith('.project/')) candidates.push(resolve(root, raw))
  else for (const dir of inboxDirs) candidates.push(resolve(dir, raw))
  const existing = candidates.find((item) => existsSync(item))
  if (!existing) throw fail('NOT_FOUND', 'inbox 文件不存在（已查 ' + candidates.join(' | ') + '）')
  const real = realpathSync(existing)
  // 允许的根：所有存在的 inbox 目录。不在其中一律拒绝（路径穿越防护不放宽）。
  const realInboxes = inboxDirs.filter((dir) => existsSync(dir)).map((dir) => realpathSync(dir))
  if (realInboxes.length === 0) throw fail('INVALID', '项目不存在 inbox 目录（已查 ' + inboxDirs.join(' | ') + '）')
  const owner = realInboxes.find((dir) => isInside(dir, real))
  if (!owner) throw fail('INVALID', '只允许导入 inbox 目录下的文件：' + existing, { inboxes: realInboxes })
  const stat = statSync(real)
  if (!stat.isFile()) throw fail('INVALID', 'inbox 路径不是文件：' + existing)
  // relativePath 用于 imports.source_path。store 里的文件用 store 相对路径，工作区的保持原样（历史兼容）。
  const workspaceInbox = resolve(root, '.project', 'inbox')
  const relativePath = owner === realpathSync(workspaceInbox)
    ? toPosix(relative(root, real))
    : toPosix(relative(dirname(owner), real))
  return {
    absolutePath: real,
    relativePath: relativePath,
    inboxDir: owner,
    inboxDirs: realInboxes,
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
  const inbox = resolveInboxPath(root, input.sourcePath, { inboxDirs: inboxDirsOf(db, root) })
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
