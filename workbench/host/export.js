// 导出边界（T1）：DB -> 文件，单向只写、不回读。
//
// 规则（合同 §3 / 架构 §5）：
// - exportDocument 写 <root>/docs/<exportMap[type]>/<file>.md，带 generated 标记，记录 exports 行 + doc/export 事件。
// - exportTimeline 写 <root>/.project/exports/timeline.md；exportSnapshot 重建 <root>/.project/exports/docs/ 全量快照 + timeline.md。
// - 文件内容对同一 (doc, version) 是确定性的（不含墙钟时间），保证可重复生成且 hash 稳定。
//
// ---------------------------------------------------------------------------
// v4：事务与补偿模型（必须先读）
// ---------------------------------------------------------------------------
// 旧实现把 writeFileSync 放在 db.tx 里面，于是出现一个无法自洽的组合：
//   文件写失败 → 事务回滚 → 但磁盘上已经写了一半（写成功的那几篇不会自动消失）；
//   事务提交失败 → 文件已经落盘 → DB 里没有 exports 行，人也无从知道该重导哪几篇。
// 文件系统不参与 SQLite 事务，这是物理事实，不能靠「把它们放一个 tx 里」假装解决。
//
// v4 的做法是「意图先行 + 补偿」：
//   ① planExportBatch()  在事务里只写「意图」：export_outbox 每行 = 要写哪个文件、期望 hash；
//   ② applyExportBatch() 事务外逐个写文件（原子 rename），每写一个就回填该行 status/hash；
//   ③ 任一条失败 → 该行 status='failed' + last_error，其余行照常 done；
//   ④ replayPendingExports() 可以把 pending/failed 的行重新走一遍（幂等：内容确定性 → 同 hash）；
//   ⑤ 门禁批准时：outbox 全部 done 才算导出完成；有 failed 就整体拒绝（GATE_EXPORT_INCOMPLETE），
//      不会出现「阶段推进了但文档没导全」。补偿成功后可以重试批准。
//
// 一句话：DB 说「应该有什么」，文件系统说「实际有什么」，outbox 是两者之间的对账表。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fail, projectRootOf, timelineMarkdown } from './db.js'
import { getDocument, getDocVersion, listDocuments } from './docs.js'
import { newId, nowIso, sha256 } from './util.js'
import { renderWeeklyReport } from './report.js'

export { renderWeeklyReport }

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

export const OUTBOX_STATUSES = ['pending', 'done', 'failed']

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
  db.db.prepare('INSERT INTO exports(id, project_id, kind, path, content_hash, version, exported_at, status, error, batch_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, db.projectId, input.kind, input.relativePath, input.hash, input.version === undefined ? null : input.version,
      input.at || nowIso(), input.status || 'ok', input.error ?? null, input.batchId ?? null)
  return id
}

// ---------------------------------------------------------------------------
// outbox：意图 → 落地 → 对账
// ---------------------------------------------------------------------------

function insertOutboxRow(db, batchId, entry) {
  const id = newId('obx')
  db.db.prepare('INSERT INTO export_outbox(id, project_id, batch_id, doc_id, version, kind, path, content_hash, desired_hash, status, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, db.projectId, batchId, entry.docId ?? null, entry.version ?? null, entry.kind || 'document',
      entry.relativePath, entry.hash, entry.hash, 'pending', 0, nowIso())
  return id
}

/** 只为单篇文档建意图（exportDocument 用）。返回 outbox 行 id 与渲染好的内容。 */
function planSingleDocument(db, batchId, root, doc, versionRow, exportMap) {
  const paths = documentExportPath(root, doc, exportMap)
  const content = renderDocumentMarkdown(db.projectId, doc, versionRow)
  const hash = sha256(content)
  const outboxId = insertOutboxRow(db, batchId, { docId: doc.id, version: Number(versionRow.version), kind: 'document', relativePath: paths.relativePath, hash })
  return { outboxId, paths, content, hash, doc }
}

/** 写一条 outbox 的落盘结果（成功/失败都要记账）。 */
function settleOutbox(db, outboxId, result) {
  db.db.prepare('UPDATE export_outbox SET status = ?, content_hash = COALESCE(?, content_hash), attempts = attempts + 1, last_error = ?, settled_at = ? WHERE id = ?')
    .run(result.status, result.hash ?? null, result.error ?? null, nowIso(), outboxId)
}

/**
 * 执行一条已计划的 outbox 行：写盘（原子 rename）→ 记账。
 * 幂等：内容确定，重复执行得到同一 hash；失败只影响这一行，不牵连整批。
 * @returns {{status:'done'|'failed', hash?:string, path:string, error?:string}}
 */
function applyOutboxRow(db, root, row, content) {
  const absolutePath = resolve(root, row.path)
  try {
    // 路径守卫：outbox 里的 path 是相对项目根的，绝不接受跑出 root 的路径。
    const rel = relative(root, absolutePath)
    if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw fail('INVALID', '导出路径越界：' + row.path)
    writeAtomicSync(absolutePath, content)
    const hash = sha256(content)
    settleOutbox(db, row.id, { status: 'done', hash })
    return { status: 'done', hash, path: row.path }
  } catch (error) {
    const message = String((error && error.message) || error)
    settleOutbox(db, row.id, { status: 'failed', error: message.slice(0, 500) })
    return { status: 'failed', path: row.path, error: message }
  }
}

/** 按 outbox 行重新渲染内容：文档走版本快照，时间线走当前事件集。 */
function renderOutboxContent(db, row) {
  if (row.kind === 'timeline' || row.kind === 'snapshot-timeline') return renderTimelineMarkdown(db, {})
  const doc = getDocument(db, row.doc_id)
  if (!doc) throw fail('NOT_FOUND', '文档已不存在：' + row.doc_id)
  const version = getDocVersion(db, row.doc_id, row.version)
  if (!version) throw fail('NOT_FOUND', '文档版本已不存在：' + row.doc_id + '@' + row.version)
  return renderDocumentMarkdown(db.projectId, doc, version)
}

/**
 * 重新执行没落地的 outbox 行（补偿）。
 * 内容从 DB 重新渲染（确定性），因此不需要记住上一轮的字节。
 * @returns {{batchId:string|null, replayed:number, done:number, failed:number, remaining:number, results:Array}}
 */
export function replayPendingExports(db, input = {}) {
  const root = resolveProjectRoot(db, input.root)
  const batchId = input.batchId
  let sql = "SELECT * FROM export_outbox WHERE project_id = ? AND status != 'done'"
  const params = [db.projectId]
  if (batchId) { sql += ' AND batch_id = ?'; params.push(batchId) }
  sql += ' ORDER BY created_at ASC, rowid ASC LIMIT ?'
  params.push(Math.max(1, Math.min(Number(input.limit) || 200, 1000)))
  const rows = db.db.prepare(sql).all(...params)
  const results = []
  let done = 0
  let failed = 0
  for (const row of rows) {
    let content
    try {
      content = renderOutboxContent(db, row)
    } catch (error) {
      settleOutbox(db, row.id, { status: 'failed', error: String((error && error.message) || error).slice(0, 500) })
      results.push({ outboxId: row.id, path: row.path, status: 'failed', error: 'render-failed' })
      failed += 1
      continue
    }
    const applied = applyOutboxRow(db, root, row, content)
    const exportRow = db.db.prepare('SELECT id FROM exports WHERE project_id = ? AND path = ? AND version IS ? ORDER BY rowid DESC LIMIT 1')
      .get(db.projectId, row.path, row.version === null || row.version === undefined ? null : row.version)
    if (exportRow) {
      db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
        .run(applied.status === 'done' ? 'ok' : 'failed', applied.hash ?? null, applied.error ?? null, exportRow.id)
    }
    results.push({ outboxId: row.id, ...applied })
    if (applied.status === 'done') done += 1
    else failed += 1
  }
  const remainingRow = batchId
    ? db.db.prepare("SELECT COUNT(*) AS n FROM export_outbox WHERE project_id = ? AND batch_id = ? AND status != 'done'").get(db.projectId, batchId)
    : db.db.prepare("SELECT COUNT(*) AS n FROM export_outbox WHERE project_id = ? AND status != 'done'").get(db.projectId)
  return {
    batchId: batchId ?? null,
    replayed: rows.length,
    done,
    failed,
    remaining: Number(remainingRow && remainingRow.n ? remainingRow.n : 0),
    results,
  }
}

/** 批次对账：还剩几条没落地（门禁批准用它决定「导全了没有」）。 */
export function outboxStatus(db, batchId) {
  const rows = db.db.prepare('SELECT status, COUNT(*) AS n FROM export_outbox WHERE project_id = ? AND batch_id = ? GROUP BY status').all(db.projectId, batchId)
  const counts = { pending: 0, done: 0, failed: 0 }
  for (const row of rows) if (counts[row.status] !== undefined) counts[row.status] = Number(row.n)
  const total = counts.pending + counts.done + counts.failed
  return { batchId, counts, total, settled: total > 0 && counts.pending === 0 && counts.failed === 0, complete: total > 0 && counts.done === total }
}

// ---------------------------------------------------------------------------
// 对外写入口（意图先行 + 事务外落盘）
// ---------------------------------------------------------------------------

/**
 * 导出单个文档版本到 <root>/docs/...。
 *
 * 事务边界：exports 行 + export_outbox 意图 + doc/export 事件在同一个 tx 里提交；
 * 文件写在事务之后执行，失败只把 outbox 行标 failed 并记 exports.error，不再回滚 DB
 * （DB 认为「应该导热」，磁盘说「没写成」，这个差异正是 outbox 要留痕的东西）。
 *
 * @returns {{docId,version,path,relativePath,hash,exportsId,outboxId,batchId,written,error?}}
 */
export function exportDocument(db, input = {}) {
  const documentId = input.docId || input.documentId
  if (typeof documentId !== 'string' || documentId.trim() === '') throw fail('INVALID', 'docId 必须是非空字符串')
  const root = resolveProjectRoot(db, input.root)
  const batchId = input.batchId || newId('batch')
  const plan = db.tx(() => {
    const doc = getDocument(db, documentId)
    if (!doc) throw fail('NOT_FOUND', 'document not found: ' + documentId)
    if (!doc.currentVersion) throw fail('NOT_FOUND', 'document has no version to export: ' + documentId)
    const versionNumber = input.version === undefined ? doc.currentVersion : Number(input.version)
    const version = getDocVersion(db, documentId, versionNumber)
    if (!version) throw fail('NOT_FOUND', 'doc version not found: ' + documentId + '@' + versionNumber)
    const exportMap = loadExportMap(root, input.exportMap)
    const planned = planSingleDocument(db, batchId, root, doc, version, exportMap)
    const exportsId = insertExportRow(db, {
      kind: 'document', relativePath: planned.paths.relativePath, hash: planned.hash,
      version: versionNumber, status: 'pending', batchId,
    })
    db.appendEvent({
      kind: 'doc/export',
      sliceId: doc.sliceId,
      subjectType: 'document',
      subjectId: doc.id,
      payload: { version: versionNumber, path: planned.paths.relativePath, hash: planned.hash, exportsId, outboxId: planned.outboxId, batchId },
    })
    return { doc, versionNumber, ...planned, exportsId }
  })
  const row = db.db.prepare('SELECT * FROM export_outbox WHERE id = ?').get(plan.outboxId)
  const base = {
    docId: plan.doc.id,
    version: plan.versionNumber,
    relativePath: row.path,
    hash: plan.hash,
    exportsId: plan.exportsId,
    outboxId: plan.outboxId,
    batchId,
  }
  // 延迟写（deferWrite）：调用方正处在自己的事务里（例如门禁批准），
  // 此时**不能**写文件——文件系统不参与回滚，写早了就会留下没人认领的半批文件。
  // 调用方拿 plan 出去，在事务提交后统一 flushPlannedExports()。
  if (input.deferWrite === true) {
    return { ...base, path: resolve(root, row.path), written: false, deferred: true, plan: { outboxId: plan.outboxId, exportsId: plan.exportsId, content: plan.content, relativePath: row.path, batchId } }
  }
  const applied = applyOutboxRow(db, root, row, plan.content)
  db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
    .run(applied.status === 'done' ? 'ok' : 'failed', applied.hash ?? plan.hash, applied.error ?? null, plan.exportsId)
  return {
    ...base,
    path: resolve(root, row.path),
    hash: applied.hash ?? plan.hash,
    written: applied.status === 'done',
    error: applied.error,
  }
}

/**
 * 执行一批「延迟写」的导出计划（事务提交之后调用）。
 * @param {object} db
 * @param {string} root
 * @param {Array<{outboxId:string, exportsId:string, content:string, relativePath:string, batchId?:string}>} plans
 * @returns {{batchId:string|null, applied:number, failed:number, files:Array, status:object}}
 */
export function flushPlannedExports(db, root, plans) {
  const list = Array.isArray(plans) ? plans : []
  const files = []
  let failed = 0
  let batchId = null
  for (const plan of list) {
    if (!plan || !plan.outboxId) continue
    batchId = plan.batchId || batchId
    const row = db.db.prepare('SELECT * FROM export_outbox WHERE id = ?').get(plan.outboxId)
    if (!row) continue
    const applied = applyOutboxRow(db, root, row, plan.content)
    if (plan.exportsId) {
      db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
        .run(applied.status === 'done' ? 'ok' : 'failed', applied.hash ?? null, applied.error ?? null, plan.exportsId)
    }
    if (applied.status !== 'done') failed += 1
    files.push({
      docId: row.doc_id ?? undefined,
      version: row.version === null || row.version === undefined ? undefined : Number(row.version),
      path: applied.path,
      hash: applied.hash ?? null,
      written: applied.status === 'done',
      error: applied.error,
    })
  }
  return {
    batchId,
    applied: files.filter((file) => file.written).length,
    failed,
    files,
    status: batchId ? outboxStatus(db, batchId) : { batchId: null, counts: {}, total: 0, settled: true, complete: true },
  }
}

/** 导出人读时间线到 <root>/.project/exports/timeline.md（确定性内容，可重复生成）。 */
export function exportTimeline(db, input = {}) {
  const root = resolveProjectRoot(db, input.root)
  const batchId = input.batchId || newId('batch')
  const content = renderTimelineMarkdown(db, input)
  const hash = sha256(content)
  const relativePath = '.project/exports/timeline.md'
  const absolutePath = resolve(root, '.project', 'exports', 'timeline.md')
  const plan = db.tx(() => {
    const outboxId = insertOutboxRow(db, batchId, { kind: 'timeline', relativePath, hash })
    const exportsId = insertExportRow(db, { kind: 'timeline', relativePath, hash, version: null, status: 'pending', batchId })
    db.appendEvent({
      kind: 'export/snapshot',
      payload: { kind: 'timeline', path: relativePath, hash: hash, batchId, outboxId },
    })
    return { outboxId, exportsId }
  })
  const row = db.db.prepare('SELECT * FROM export_outbox WHERE id = ?').get(plan.outboxId)
  const applied = applyOutboxRow(db, root, row, content)
  db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
    .run(applied.status === 'done' ? 'ok' : 'failed', applied.hash ?? hash, applied.error ?? null, plan.exportsId)
  return {
    path: absolutePath,
    relativePath,
    hash: applied.hash ?? hash,
    exportsId: plan.exportsId,
    batchId,
    written: applied.status === 'done',
    error: applied.error,
  }
}

/**
 * 导出周报到 <root>/.project/exports/weekly.md（MVP 验收标准 ⑤：可直接贴进 GitHub Issue）。
 *
 * 与 exportTimeline 遵循同一套 outbox 规则（意图先行 + 事务外落盘 + 可补偿），
 * 因为「写文件」这件事的失败形态是一样的，不该因为文件叫 weekly 就换一套。
 *
 * 为什么不默认写进 docs/：周报是**派生视图**（同一状态可重复生成），
 * 而 docs/ 里放的是需要版本链管理的交付文档。混在一起会让文档版本链长出噪音。
 * 需要进 Issue 时，由人/PM 复制内容即可 —— 或者 docs/ 里另建一篇 report 文档引用它。
 */
export function exportWeekly(db, input = {}) {
  const root = resolveProjectRoot(db, input.root)
  const batchId = input.batchId || newId('batch')
  const content = input.content || renderWeeklyReport(db, input)
  const hash = sha256(content)
  const relativePath = '.project/exports/weekly.md'
  const absolutePath = resolve(root, '.project', 'exports', 'weekly.md')
  const plan = db.tx(() => {
    const outboxId = insertOutboxRow(db, batchId, { kind: 'weekly', relativePath, hash })
    const exportsId = insertExportRow(db, { kind: 'weekly', relativePath, hash, version: null, status: 'pending', batchId })
    db.appendEvent({
      kind: 'export/snapshot',
      payload: { kind: 'weekly', path: relativePath, hash: hash, batchId, outboxId },
    })
    return { outboxId, exportsId }
  })
  const row = db.db.prepare('SELECT * FROM export_outbox WHERE id = ?').get(plan.outboxId)
  const applied = applyOutboxRow(db, root, row, content)
  db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
    .run(applied.status === 'done' ? 'ok' : 'failed', applied.hash ?? hash, applied.error ?? null, plan.exportsId)
  return {
    path: absolutePath,
    relativePath,
    hash: applied.hash ?? hash,
    exportsId: plan.exportsId,
    batchId,
    written: applied.status === 'done',
    error: applied.error,
    content,
  }
}

/**
 * 全量快照：重建 <root>/.project/exports/docs/（先清空再写，保证可重生成）+ timeline.md。
 * 清空目录这一步不参加事务：它是「重建」的前置动作，失败会在写第一行时暴露；
 * 每个文件的意图照常先落 outbox，因此部分失败仍然可补偿、可查询。
 */
export function exportSnapshot(db, input = {}) {
  const root = resolveProjectRoot(db, input.root)
  const batchId = input.batchId || newId('batch')
  const exportMap = loadExportMap(root, input.exportMap)
  const docsRoot = resolve(root, '.project', 'exports', 'docs')
  const plan = db.tx(() => {
    const documents = listDocuments(db, input.sliceId ? { sliceId: input.sliceId } : {})
    const entries = []
    for (const doc of documents) {
      if (!doc.currentVersion) continue
      const version = getDocVersion(db, doc.id, doc.currentVersion)
      if (!version) continue
      const content = renderDocumentMarkdown(db.projectId, doc, version)
      const hash = sha256(content)
      const subdir = exportSubdir(doc, exportMap)
      const absolutePath = resolve(docsRoot, subdir, documentFileName(doc))
      const relativePath = toPosix(relative(root, absolutePath))
      const outboxId = insertOutboxRow(db, batchId, {
        docId: doc.id, version: doc.currentVersion, kind: 'snapshot', relativePath, hash,
      })
      const exportsId = insertExportRow(db, { kind: 'snapshot', relativePath, hash, version: doc.currentVersion, status: 'pending', batchId })
      entries.push({ doc, version: doc.currentVersion, relativePath, absolutePath, hash, content, outboxId, exportsId })
    }
    const timelineRelative = '.project/exports/timeline.md'
    const timelineContent = renderTimelineMarkdown(db, input)
    const timelineHash = sha256(timelineContent)
    const timelineOutboxId = insertOutboxRow(db, batchId, { kind: 'snapshot-timeline', relativePath: timelineRelative, hash: timelineHash })
    const timelineExportsId = insertExportRow(db, { kind: 'snapshot-timeline', relativePath: timelineRelative, hash: timelineHash, version: null, status: 'pending', batchId })
    return { entries, timelineRelative, timelineContent, timelineHash, timelineOutboxId, timelineExportsId }
  })
  // —— 事务外：清空 + 逐条落盘 ——
  if (existsSync(docsRoot)) rmSync(docsRoot, { recursive: true, force: true })
  const files = []
  let failed = 0
  for (const entry of plan.entries) {
    const row = db.db.prepare('SELECT * FROM export_outbox WHERE id = ?').get(entry.outboxId)
    const applied = applyOutboxRow(db, root, row, entry.content)
    db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
      .run(applied.status === 'done' ? 'ok' : 'failed', applied.hash ?? entry.hash, applied.error ?? null, entry.exportsId)
    if (applied.status !== 'done') failed += 1
    files.push({
      docId: entry.doc.id, version: entry.version, path: entry.absolutePath,
      relativePath: entry.relativePath, hash: applied.hash ?? entry.hash, written: applied.status === 'done',
    })
  }
  const timelineRow = db.db.prepare('SELECT * FROM export_outbox WHERE id = ?').get(plan.timelineOutboxId)
  const timelineApplied = applyOutboxRow(db, root, timelineRow, plan.timelineContent)
  db.db.prepare('UPDATE exports SET status = ?, content_hash = ?, error = ? WHERE id = ?')
    .run(timelineApplied.status === 'done' ? 'ok' : 'failed', timelineApplied.hash ?? plan.timelineHash, timelineApplied.error ?? null, plan.timelineExportsId)
  if (timelineApplied.status !== 'done') failed += 1
  db.tx(() => {
    db.appendEvent({
      kind: 'export/snapshot',
      payload: {
        docs: files.length, dir: '.project/exports/docs', timeline: plan.timelineRelative,
        timelineHash: timelineApplied.hash ?? plan.timelineHash, batchId, failed,
      },
    })
  })
  return {
    root: root,
    dir: docsRoot,
    count: files.length,
    failed,
    batchId,
    documents: files,
    timeline: { path: resolve(root, '.project', 'exports', 'timeline.md'), relativePath: plan.timelineRelative, hash: timelineApplied.hash ?? plan.timelineHash, written: timelineApplied.status === 'done' },
  }
}
