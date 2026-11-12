// Workspace file backfill index (Lead): code/tests/scripts stay workspace files; the DB records
// path + hash + bytes + event so the timeline/cockpit can answer "which files changed".
// Never stores file contents (architecture §5: files are the body, DB keeps references).
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { newId, nowIso } from './util.js'

export const INDEXABLE_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.toml',
  '.md', '.css', '.scss', '.html', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.sql',
  '.sh', '.ps1', '.bat', '.cmd', '.txt', '.env.example',
]

export const DEFAULT_SKIP_DIRS = [
  '.git', '.project', '.devhome', '.poc', '.runtime', '.runtime2', '.pnpm-store', 'node_modules',
  'dist', 'build', 'coverage', '.cache', '.tmp', '.artifacts', '.dsh-poc', 'docs',
]

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_FILES = 5000

function normalize(relativePath) {
  return relativePath.split(sep).join('/')
}

/** Enumerate candidate workspace files (deterministic order, skip rules applied). */
export function listWorkspaceFiles(root, options = {}) {
  const skipDirs = new Set(options.skipDirs || DEFAULT_SKIP_DIRS)
  const extensions = options.extensions || INDEXABLE_EXTENSIONS
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES
  const files = []
  const walk = (dir) => {
    if (files.length >= maxFiles) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) return
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        walk(absolute)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        if (!extensions.some((ext) => lower.endsWith(ext))) continue
        files.push(absolute)
      }
    }
  }
  walk(root)
  return files
}

function hashFile(absolute, maxBytes) {
  try {
    const stat = statSync(absolute)
    if (!stat.isFile()) return undefined
    if (stat.size > maxBytes) {
      return { hash: 'sha256:skipped-large:' + String(stat.size), bytes: stat.size, skipped: true, mtime: stat.mtimeMs }
    }
    const content = readFileSync(absolute)
    return { hash: 'sha256:' + createHash('sha256').update(content).digest('hex'), bytes: content.length, skipped: false, mtime: stat.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * Backfill/refresh the workspace file index as artifacts (kind='file').
 * Idempotent: unchanged files keep their row; changed files get a new hash + event.
 * @returns {{scanned:number, indexed:number, changed:number, skipped:number, removed:number}}
 */
export function indexWorkspaceFiles(db, root, options = {}) {
  const maxBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES
  const actor = options.actorSession || null
  const kind = options.kind || 'file'
  const files = listWorkspaceFiles(root, options)
  const summary = { scanned: files.length, indexed: 0, changed: 0, skipped: 0, removed: 0 }
  const seen = new Set()
  const existing = new Map()
  for (const row of db.db.prepare('SELECT id, path, content_hash, bytes FROM artifacts WHERE project_id = ? AND kind = ?').all(db.projectId, kind)) {
    existing.set(row.path, row)
  }
  return db.tx(() => {
    const insert = db.db.prepare('INSERT INTO artifacts(id, project_id, slice_id, kind, path, content_hash, bytes, metadata_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    const update = db.db.prepare('UPDATE artifacts SET content_hash = ?, bytes = ?, metadata_json = ? WHERE id = ?')
    const remove = db.db.prepare('DELETE FROM artifacts WHERE id = ?')
    const at = nowIso()
    for (const absolute of files) {
      const path = normalize(relative(root, absolute))
      const info = hashFile(absolute, maxBytes)
      if (info === undefined) { summary.skipped += 1; continue }
      seen.add(path)
      const previous = existing.get(path)
      const metadata = { ext: path.slice(path.lastIndexOf('.')), mtime: Math.round(info.mtime), indexed: true }
      if (previous === undefined) {
        insert.run(newId('art'), db.projectId, options.sliceId || null, kind, path, info.hash, info.bytes, JSON.stringify(metadata), at)
        summary.indexed += 1
        summary.changed += 1
      } else if (previous.content_hash !== info.hash || Number(previous.bytes) !== Number(info.bytes)) {
        update.run(info.hash, info.bytes, JSON.stringify(metadata), previous.id)
        summary.changed += 1
      }
    }
    for (const [path, row] of existing) {
      if (seen.has(path)) continue
      remove.run(row.id)
      summary.removed += 1
    }
    if (summary.changed > 0 || summary.removed > 0 || options.forceEvent === true) {
      db.appendEvent({
        kind: 'index/backfill',
        actorSession: actor,
        subjectType: 'project',
        payload: { scanned: summary.scanned, indexed: summary.indexed, changed: summary.changed, removed: summary.removed, skipped: summary.skipped },
      })
    }
    return summary
  })
}
