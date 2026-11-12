// 项目运行时注册表（T2 host-api）：工作区 → 项目库。
// 只有 ctx.workspaceRegistry.list() 登记的 workspace 才能作为项目根（realpath 相等校验），
// 一个规范根对应一个 ProjectDb（缓存复用）；ensure() 负责幂等建立 .project/ 布局与 7 阶段行。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ProjectDb } from './db.js'
import { newId, nowIso, parseJson } from './util.js'
import * as projectDefaults from './project-defaults.js'
import { mapSessionRow, listStages } from './snapshot.js'

const PROJECT_DIR = projectDefaults.PROJECT_DIR ?? '.project'
const STAGE_TEMPLATE = projectDefaults.STAGE_TEMPLATE ?? []
const DB_FILE = 'project.db'
const JSON_FILE = 'project.json'
const SUBDIRS = ['exports', join('exports', 'docs'), 'inbox', 'packages']

/** 创建带稳定 code/status 的错误（http 层据此映射状态码）。 */
export function projectError(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function realpathOf(path) {
  try { return realpathSync.native(path) } catch { try { return realpathSync(path) } catch { return undefined } }
}

/** Windows 路径大小写不敏感，其它平台按字节比较。 */
function samePath(left, right) {
  if (!left || !right) return false
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function cacheKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function readProjectJson(file) {
  try { return parseJson(readFileSync(file, 'utf8'), undefined) } catch { return undefined }
}

function writeProjectJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

function buildProjectJson(projectId, name) {
  if (typeof projectDefaults.createProjectJson === 'function') {
    return projectDefaults.createProjectJson({ projectId, name, root: '.' })
  }
  return { format: 1, projectId, name: name || 'project', root: '.', createdAt: nowIso(), stageTemplate: STAGE_TEMPLATE }
}

/**
 * .project/.gitignore：DB / 导出缓存 / 外部工作包不入 git；project.json 入 git（契约 §工作区目录）。
 * 幂等：已存在且包含所需条目时不重写。
 */
export function ensureProjectGitignore(projectDir) {
  const file = join(projectDir, '.gitignore')
  const required = ['project.db', 'project.db-wal', 'project.db-shm', 'exports/', 'inbox/', 'packages/']
  const header = '# 项目运行时（project.json 入 git；DB/导出缓存/工作包不入 git）'
  let current = ''
  try { current = readFileSync(file, 'utf8') } catch { current = '' }
  if (current !== '') {
    const lines = current.split(/\r?\n/)
    const missing = required.filter((entry) => !lines.includes(entry))
    if (missing.length === 0) return file
    writeFileSync(file, current.replace(/\n?$/, '\n') + missing.join('\n') + '\n', 'utf8')
    return file
  }
  writeFileSync(file, header + '\n' + required.join('\n') + '\n', 'utf8')
  return file
}

/** 幂等建阶段行：首次建项目时写 project/init + stage/change 事件；后续只补缺失行。 */
function bootstrapStages(db, workspace) {
  const existing = db.db.prepare('SELECT key FROM stages WHERE project_id = ?').all(db.projectId)
  const seen = new Set(existing.map((row) => row.key))
  const missing = STAGE_TEMPLATE.filter((stage) => !seen.has(stage.key))
  const total = existing.length
  if (missing.length === 0) return false
  db.tx(() => {
    const firstRun = total === 0
    const at = nowIso()
    const insert = db.db.prepare('INSERT OR IGNORE INTO stages(id, project_id, key, name, status, gate, started_at, ended_at, position) VALUES (?,?,?,?,?,?,?,?,?)')
    STAGE_TEMPLATE.forEach((stage, index) => {
      if (seen.has(stage.key)) return
      const active = firstRun && index === 0
      insert.run(newId('stage'), db.projectId, stage.key, stage.name, active ? 'active' : 'pending',
        stage.gate ?? null, active ? at : null, null, index)
    })
    // 没有 active 阶段时（初始化中断/自定义模板）激活第一个阶段，保证 S1 处于 active。
    const active = db.db.prepare("SELECT id, key FROM stages WHERE project_id = ? AND status = 'active' LIMIT 1").get(db.projectId)
    if (!active) {
      const first = db.db.prepare('SELECT id, key FROM stages WHERE project_id = ? ORDER BY position ASC LIMIT 1').get(db.projectId)
      if (first) {
        db.db.prepare("UPDATE stages SET status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?").run(at, first.id)
        db.setMeta('stage.current', first.key)
      }
    }
    if (firstRun) {
      const current = db.db.prepare("SELECT key, gate FROM stages WHERE project_id = ? AND status = 'active' ORDER BY position ASC LIMIT 1").get(db.projectId)
      db.setMeta('initialized_at', at)
      db.appendEvent({
        kind: 'project/init',
        subjectType: 'project',
        subjectId: db.projectId,
        payload: { name: workspace.title, workspaceId: workspace.workspaceId },
      })
      if (current) {
        db.setMeta('stage.current', current.key)
        db.appendEvent({
          kind: 'stage/change',
          subjectType: 'stage',
          subjectId: current.key,
          payload: { from: null, to: current.key, gate: current.gate ?? null, reason: 'project init' },
        })
      }
    }
  })
  return true
}

/** .project 目录布局（项目库、导出、收件箱、外部工作包）。 */
export function projectPaths(root) {
  const projectDir = join(root, PROJECT_DIR)
  return {
    root,
    projectDir,
    dbPath: join(projectDir, DB_FILE),
    jsonPath: join(projectDir, JSON_FILE),
    exportsDir: join(projectDir, 'exports'),
    docsDir: join(projectDir, 'exports', 'docs'),
    timelinePath: join(projectDir, 'exports', 'timeline.md'),
    inboxDir: join(projectDir, 'inbox'),
    packagesDir: join(projectDir, 'packages'),
  }
}

export function createRegistry(ctx) {
  /** @type {Map<string, ProjectDb>} 规范根 → 打开的 ProjectDb */
  const projects = new Map()

  /**
   * 无 GUI 的 profile（headless/CLI）没有 workspaceRegistry：此时以「已初始化的 .project」为唯一准入。
   * 注意：Cordis 的服务代理在 inject 未声明时**读取即抛错**（cannot get property ... without inject），
   * 所以可选服务必须走 ctx.get(name)，不能用属性访问。
   */
  function optionalService(name) {
    try {
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    } catch (error) {
      return undefined
    }
  }

  function workspaces() {
    const service = optionalService('workspaceRegistry')
    if (!service || typeof service.list !== 'function') return []
    const list = service.list()
    return Array.isArray(list) ? list : []
  }

  function hasProjectRuntime(root) {
    return existsSync(join(root, PROJECT_DIR, JSON_FILE)) || existsSync(join(root, PROJECT_DIR, DB_FILE))
  }

  /**
   * 解析项目根：优先 workspaceRegistry 登记项（GUI 场景的唯一定义），
   * 无该服务时（headless/CLI）退化为「目录里已有 .project 运行时」——仍拒绝任意路径，
   * 只允许之前由项目面板/注册表建立过运行时的目录。
   */
  function resolveEntity(reference) {
    const list = workspaces()
    if (list.length === 0) {
      if (typeof reference !== 'string' || reference.trim() === '') return undefined
      const raw = resolve(reference)
      const canonical = realpathOf(raw)
      if (!canonical || !hasProjectRuntime(canonical)) return undefined
      return { id: undefined, path: canonical, title: readProjectJson(join(canonical, PROJECT_DIR, JSON_FILE))?.name || canonical }
    }
    return undefined
  }

  /** workspaceId | rootPath | undefined → {workspaceId, root, title}；root 必须属于已登记 workspace。 */
  function rootForWorkspace(reference) {
    const list = workspaces()
    if (list.length === 0) {
      const fallback = resolveEntity(reference)
      if (!fallback) {
        throw projectError('NOT_REGISTERED_WORKSPACE', 'workspace registry is unavailable and no initialized project runtime was found at: ' + String(reference), 403)
      }
      const canonical = realpathOf(resolve(fallback.path)) || resolve(fallback.path)
      return { workspaceId: fallback.id, root: canonical, title: fallback.title || canonical, unregistered: true }
    }
    let entity
    if (reference === undefined || reference === null || reference === '') {
      if (list.length === 1) entity = list[0]
      else if (list.length === 0) throw projectError('NOT_REGISTERED_WORKSPACE', 'no workspace is registered', 403)
      else throw projectError('MISSING_WORKSPACE', 'root is required when several workspaces are registered', 400)
    } else if (typeof reference !== 'string') {
      throw projectError('INVALID_ROOT', 'root must be a workspace id or an absolute path', 400)
    } else {
      entity = list.find((item) => item.id === reference)
      if (!entity) {
        const wanted = realpathOf(resolve(reference))
        if (wanted) entity = list.find((item) => samePath(realpathOf(item.path) || item.path, wanted))
      }
      if (!entity) throw projectError('NOT_REGISTERED_WORKSPACE', 'workspace root is not registered: ' + reference, 403)
    }
    const raw = resolve(entity.path)
    const canonical = realpathOf(raw)
    if (!canonical) throw projectError('INVALID_ROOT', 'workspace root does not exist on disk: ' + raw, 409)
    return { workspaceId: entity.id, root: canonical, title: entity.title || canonical }
  }

  function openDb(workspace) {
    const paths = projectPaths(workspace.root)
    if (!existsSync(paths.dbPath)) return undefined
    const json = readProjectJson(paths.jsonPath)
    let db
    try {
      db = new ProjectDb(paths.dbPath, {
        projectId: json?.projectId || newId('proj'),
        projectName: json?.name || workspace.title,
        root: workspace.root,
      })
    } catch (error) {
      throw projectError('PROJECT_DB_ERROR', 'cannot open project database at ' + paths.dbPath + ': ' + error.message, 500)
    }
    // 崩溃恢复：补齐 project.json、阶段行与 .gitignore（幂等，不重复写事件）。
    ensureProjectJson(db, paths, workspace, undefined)
    bootstrapStages(db, workspace)
    ensureProjectGitignore(paths.projectDir)
    return db
  }

  function ensureProjectJson(db, paths, workspace, name) {
    const existing = readProjectJson(paths.jsonPath)
    const wantedName = name || existing?.name || workspace.title || 'project'
    if (!existing) {
      writeProjectJson(paths.jsonPath, buildProjectJson(db.projectId, wantedName))
      return
    }
    if (existing.projectId !== db.projectId || existing.format !== 1 || existing.root !== '.') {
      writeProjectJson(paths.jsonPath, { ...existing, format: 1, projectId: db.projectId, root: '.', name: existing.name || wantedName })
    }
  }

  function open(reference, options = {}) {
    const workspace = rootForWorkspace(reference)
    const key = cacheKey(workspace.root)
    const cached = projects.get(key)
    if (cached) return cached
    const db = openDb(workspace)
    if (!db) {
      if (options && options.create) return ensure(workspace.root, { name: options.name, workspaceId: workspace.workspaceId })
      return undefined
    }
    projects.set(key, db)
    return db
  }

  function ensure(reference, options = {}) {
    const workspace = options.workspaceId !== undefined
      ? rootForWorkspace(options.workspaceId)
      : rootForWorkspace(options.root !== undefined ? options.root : reference)
    const key = cacheKey(workspace.root)
    if (projects.has(key)) return projects.get(key)
    const paths = projectPaths(workspace.root)
    for (const sub of SUBDIRS) mkdirSync(join(paths.projectDir, sub), { recursive: true })
    ensureProjectGitignore(paths.projectDir)
    const json = readProjectJson(paths.jsonPath)
    let db
    try {
      db = new ProjectDb(paths.dbPath, {
        projectId: json?.projectId || newId('proj'),
        projectName: options.name || json?.name || workspace.title,
        root: workspace.root,
      })
    } catch (error) {
      throw projectError('PROJECT_DB_ERROR', 'cannot create project database at ' + paths.dbPath + ': ' + error.message, 500)
    }
    ensureProjectJson(db, paths, workspace, options.name)
    bootstrapStages(db, workspace)
    projects.set(key, db)
    return db
  }

  function listProjects() {
    return workspaces().map((entity) => {
      const base = { workspaceId: entity.id, root: entity.path, title: entity.title || entity.path }
      let db
      try {
        db = open(entity.id)
      } catch (error) {
        return { ...base, exists: false, error: { code: error.code || 'PROJECT_DB_ERROR', message: error.message } }
      }
      if (!db) return { ...base, exists: false, initialized: false }
      const project = db.project() || {}
      const stages = listStages(db)
      const current = stages.find((stage) => stage.status === 'active') || stages[stages.length - 1] || null
      const pending = db.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE project_id = ? AND status = 'pending'").get(db.projectId)
      return {
        workspaceId: entity.id,
        root: entity.path,
        title: entity.title || entity.path,
        exists: true,
        initialized: true,
        project: {
          id: db.projectId,
          name: project.name || entity.title,
          stage: current,
          pendingDecisions: Number(pending?.n ?? 0),
          revision: db.revision(),
        },
      }
    })
  }

  function pmSession(reference) {
    const db = open(reference)
    if (!db) return undefined
    const row = db.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND kind = 'pm' AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(db.projectId)
    return row ? mapSessionRow(row) : undefined
  }

  function projectJson(reference) {
    const workspace = rootForWorkspace(reference)
    return readProjectJson(projectPaths(workspace.root).jsonPath)
  }

  function closeAll() {
    for (const db of projects.values()) {
      try { db.close() } catch { /* 已关闭 */ }
    }
    projects.clear()
  }

  return { rootForWorkspace, open, ensure, listProjects, pmSession, projectJson, projectPaths, closeAll }
}
