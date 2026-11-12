// 导出边界（T1）：DB -> 文件，单向只写、不回读。
// 规则（合同 §3 / 架构 §5）：
// - exportDocument 写 <root>/docs/<exportMap[type]>/<file>.md，带 generated 标记，记录 exports 行 + doc/export 事件。
// - exportTimeline 写 <root>/.project/exports/timeline.md；exportSnapshot 重建 <root>/.project/exports/docs/ 全量快照 + timeline.md。
// - 文件内容对同一 (doc, version) 是确定性的（不含墙钟时间），保证可重复生成且 hash 稳定。
// - 文件写入与 DB 记录放在同一 db.tx 内（文件是派生产物，DB 失败可重导出）。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fail, projectRootOf, timelineMarkdown } from './db.js'
import { getDocument, getDocVersion, listDocuments } from './docs.js'
import { newId, nowIso, sha256 } from './util.js'

export const DEFAULT_EXPORT_MAP = {
  prd: 'product',
  ux: 'ux',
  adr: 'architecture',
  design: 'design',
  spec: 'spec',
  report: 'reports',
  handoff: 'handoffs',
  retro: 'retro',
}

function resolveProjectRoot(db, inputRoot) {
  const root = inputRoot || projectRootOf(db)
  if (!root || typeof root !== 'string') throw fail('INVALID', '导出需要项目根目录 root')
  return resolve(root)
}

function sanitizeSegment(value) {
  const cleaned = String(value === undefined || value === null ? '' : value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .slice(0, 120)
  return cleaned || 'file'
}

function toPosix(path) {
  return String(path).replace(/\\/g, '/')
}

function loadExportMap(root, explicit) {
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) return explicit
  try {
    const configPath = join(root, '.project', 'project.json')
    if (!existsSync(configPath)) return {}
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    return config && typeof config.exportMap === 'object' && config.exportMap !== null ? config.exportMap : {}
  } catch (error) {
    return {}
  }
}

function exportSubdir(doc, exportMap) {
  const mapped = Object.prototype.hasOwnProperty.call(exportMap, doc.type) ? exportMap[doc.type] : DEFAULT_EXPORT_MAP[doc.type]
  const raw = mapped === undefined || mapped === null ? doc.type : mapped
  let cleaned = String(raw).replace(/\\/g, '/').replace(/^\.\//, '')
  cleaned = cleaned.replace(/^docs\//, '')
  const segments = cleaned.split('/').filter(function (part) { return part.length > 0 }).map(sanitizeSegment)
  return segments.length > 0 ? segments.join('/') : 'misc'
}

function documentFileName(doc) {
  const base = String(doc.logicalKey || doc.id).replace(/[\\/]+/g, '-')
  return sanitizeSegment(base) + '.md'
}

/** docs/ 下的导出路径：{absolutePath, relativePath, docsRoot}；越界直接拒绝。 */
function documentExportPath(root, doc, exportMap) {
  const docsRoot = resolve(root, 'docs')
  const subdir = exportSubdir(doc, exportMap)
  const fileName = documentFileName(doc)
  const absolutePath = resolve(docsRoot, subdir, fileName)
  const rel = relative(docsRoot, absolutePath)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw fail('INVALID', '导出路径越界：' + absolutePath)
  }
  return {
    absolutePath: absolutePath,
    relativePath: toPosix(join('docs', subdir, fileName)),
    docsRoot: docsRoot,
  }
}

function generatedHeader(fields) {
  return [
    '<!-- generated: true; generatedBy: dsh-project-workbench; source: project-db; ' + fields.join('; ') + ' -->',
    '<!-- 请勿手工编辑：本文件由项目数据库导出（只写不回读）；修改请通过项目工具 / PM。 -->',
    '',
  ].join('\n')
}

function renderDocumentMarkdown(projectId, doc, version) {
  const header = generatedHeader([
    'projectId: ' + projectId,
    'documentId: ' + doc.id,
    'logicalKey: ' + doc.logicalKey,
    'type: ' + doc.type,
    'version: ' + version.version,
    'contentHash: ' + version.contentHash,
    'versionCreatedAt: ' + version.createdAt,
  ])
  let body = String(version.content || '')
  if (!/^\s*#\s+/m.test(body)) body = '# ' + doc.title + '\n\n' + body
  return header + body.replace(/\s+$/, '') + '\n'
}

function renderTimelineMarkdown(db, input) {
  const header = generatedHeader(['projectId: ' + db.projectId, 'kind: timeline'])
  // 默认排除 export/snapshot 事件，使 timeline.md 对同一项目状态是确定性的（可重复生成、hash 稳定）；
  // 导出历史本身在 exports 表，驾驶舱时间线仍可看到完整事件。
  const excludeKinds = input.excludeKinds === undefined ? ['export/snapshot'] : input.excludeKinds
  const body = timelineMarkdown(db, {
    limit: input.limit === undefined ? 500 : input.limit,
    kinds: input.kinds,
    excludeKinds: excludeKinds,
    sliceId: input.sliceId,
  })
  return header + body
}

function writeAtomicSync(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, file)
}

function insertExportRow(db, input) {
  const id = newId('export')
  db.db.prepare('INSERT INTO exports(id, project_id, kind, path, content_hash, version, exported_at, status) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, db.projectId, input.kind, input.relativePath, input.hash, input.version === undefined ? null : input.version, input.at || nowIso(), 'ok')
  return id
}

/**
 * 导出单个文档版本到 <root>/docs/...。只在冻结/门禁/发布调用（调用方策略，本函数不强制冻结）。
 * 返回 {docId,version,path,relativePath,hash,exportsId}
 */
export function exportDocument(db, input = {}) {
  const documentId = input.docId || input.documentId
  if (typeof documentId !== 'string' || documentId.trim() === '') throw fail('INVALID', 'docId 必须是非空字符串')
  const root = resolveProjectRoot(db, input.root)
  return db.tx(() => {
    const doc = getDocument(db, documentId)
    if (!doc) throw fail('NOT_FOUND', 'document not found: ' + documentId)
    if (!doc.currentVersion) throw fail('NOT_FOUND', 'document has no version to export: ' + documentId)
    const versionNumber = input.version === undefined ? doc.currentVersion : Number(input.version)
    const version = getDocVersion(db, documentId, versionNumber)
    if (!version) throw fail('NOT_FOUND', 'doc version not found: ' + documentId + '@' + versionNumber)
    const exportMap = loadExportMap(root, input.exportMap)
    const paths = documentExportPath(root, doc, exportMap)
    const content = renderDocumentMarkdown(db.projectId, doc, version)
    const hash = sha256(content)
    writeAtomicSync(paths.absolutePath, content)
    const at = nowIso()
    const exportsId = insertExportRow(db, { kind: 'document', relativePath: paths.relativePath, hash: hash, version: versionNumber, at: at })
    db.appendEvent({
      kind: 'doc/export',
      sliceId: doc.sliceId,
      subjectType: 'document',
      subjectId: doc.id,
      payload: { version: versionNumber, path: paths.relativePath, hash: hash, exportsId: exportsId },
    })
    return {
      docId: doc.id,
      version: versionNumber,
      path: paths.absolutePath,
      relativePath: paths.relativePath,
      hash: hash,
      exportsId: exportsId,
    }
  })
}

/** 导出人读时间线到 <root>/.project/exports/timeline.md（确定性内容，可重复生成）。 */
export function exportTimeline(db, input = {}) {
  const root = resolveProjectRoot(db, input.root)
  return db.tx(() => {
    const relativePath = '.project/exports/timeline.md'
    const absolutePath = resolve(root, '.project', 'exports', 'timeline.md')
    const content = renderTimelineMarkdown(db, input)
    const hash = sha256(content)
    writeAtomicSync(absolutePath, content)
    const at = nowIso()
    insertExportRow(db, { kind: 'timeline', relativePath: relativePath, hash: hash, version: null, at: at })
    db.appendEvent({
      kind: 'export/snapshot',
      payload: { kind: 'timeline', path: relativePath, hash: hash },
    })
    return { path: absolutePath, relativePath: relativePath, hash: hash }
  })
}

/**
 * 全量快照：重建 <root>/.project/exports/docs/（先清空再写，保证可重生成）+ timeline.md。
 * exports 表为每个文件记录一行；时间线只写一条 export/snapshot 事件。
 */
export function exportSnapshot(db, input = {}) {
  const root = resolveProjectRoot(db, input.root)
  return db.tx(() => {
    const exportMap = loadExportMap(root, input.exportMap)
    const docsRoot = resolve(root, '.project', 'exports', 'docs')
    if (existsSync(docsRoot)) rmSync(docsRoot, { recursive: true, force: true })
    const documents = listDocuments(db, input.sliceId ? { sliceId: input.sliceId } : {})
    const files = []
    const at = nowIso()
    for (const doc of documents) {
      if (!doc.currentVersion) continue
      const version = getDocVersion(db, doc.id, doc.currentVersion)
      if (!version) continue
      const content = renderDocumentMarkdown(db.projectId, doc, version)
      const hash = sha256(content)
      const subdir = exportSubdir(doc, exportMap)
      const absolutePath = resolve(docsRoot, subdir, documentFileName(doc))
      const relativePath = toPosix(relative(root, absolutePath))
      writeAtomicSync(absolutePath, content)
      insertExportRow(db, { kind: 'snapshot', relativePath: relativePath, hash: hash, version: doc.currentVersion, at: at })
      files.push({
        docId: doc.id,
        version: doc.currentVersion,
        path: absolutePath,
        relativePath: relativePath,
        hash: hash,
      })
    }
    const timelineRelative = '.project/exports/timeline.md'
    const timelineAbsolute = resolve(root, '.project', 'exports', 'timeline.md')
    const timelineContent = renderTimelineMarkdown(db, input)
    const timelineHash = sha256(timelineContent)
    writeAtomicSync(timelineAbsolute, timelineContent)
    insertExportRow(db, { kind: 'snapshot-timeline', relativePath: timelineRelative, hash: timelineHash, version: null, at: at })
    db.appendEvent({
      kind: 'export/snapshot',
      payload: { docs: files.length, dir: '.project/exports/docs', timeline: timelineRelative, timelineHash: timelineHash },
    })
    return {
      root: root,
      dir: docsRoot,
      count: files.length,
      documents: files,
      timeline: { path: timelineAbsolute, relativePath: timelineRelative, hash: timelineHash },
    }
  })
}
