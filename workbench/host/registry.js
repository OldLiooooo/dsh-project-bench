// 项目运行时注册表（T2 host-api）：工作区 → 项目库。
// 只有 ctx.workspaceRegistry.list() 登记的 workspace 才能作为项目根（realpath 相等校验），
// 一个规范根对应一个 ProjectDb（缓存复用）；ensure() 负责幂等建立 .project/ 布局与 7 阶段行。
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute as pathIsAbsolute, join, resolve } from 'node:path'
import { ProjectDb, fail } from './db.js'
import { newId, nowIso, parseJson, sha256 } from './util.js'
import * as projectDefaults from './project-defaults.js'
import { mapSessionRow, listStages } from './snapshot.js'

const PROJECT_DIR = projectDefaults.PROJECT_DIR ?? '.project'
// DEFAULT_STAGE_TEMPLATE 只是「project.json 没给模板时」的回退值（W2）。
// 真正生效的模板由 stageTemplateFor(projectJson) 解析：优先 project.json.stageTemplate。
const DEFAULT_STAGE_TEMPLATE = projectDefaults.STAGE_TEMPLATE ?? []
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

/**
 * 解析本项目实际生效的阶段模板（W2）。
 * 契约：project.json.stageTemplate 是唯一可配置入口；缺失或非法时回退默认，
 * 且非法原因要能被调用方看到（由 openDb/ensure 记一条告警），不静默吞掉。
 * @param {object|undefined} projectJson
 * @returns {{template: Array<object>, source: 'project.json'|'default', error?: {code:string,message:string}}}
 */
function stageTemplateFor(projectJson) {
  if (typeof projectDefaults.resolveStageTemplate === 'function') {
    return projectDefaults.resolveStageTemplate(projectJson)
  }
  return { template: DEFAULT_STAGE_TEMPLATE, source: 'default' }
}

function buildProjectJson(projectId, name) {
  if (typeof projectDefaults.createProjectJson === 'function') {
    return projectDefaults.createProjectJson({ projectId, name, root: '.' })
  }
  return { format: 1, projectId, name: name || 'project', root: '.', createdAt: nowIso(), stageTemplate: DEFAULT_STAGE_TEMPLATE }
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

/**
 * 幂等建阶段行：首次建项目时写 project/init + stage/change 事件；后续只补缺失行。
 * 模板来自 project.json（W2）；只补缺失的 key，**绝不删除或改写已有阶段行**——
 * 换模板是显式操作（planStageRemap + 人确认），不在打开项目时悄悄发生。
 * @param {object} db ProjectDb
 * @param {object} workspace {title, workspaceId}
 * @param {Array<object>} template 已规范化的阶段模板
 */
function bootstrapStages(db, workspace, template) {
  const stageTemplate = Array.isArray(template) && template.length > 0 ? template : DEFAULT_STAGE_TEMPLATE
  const existing = db.db.prepare('SELECT key FROM stages WHERE project_id = ?').all(db.projectId)
  const seen = new Set(existing.map((row) => row.key))
  const missing = stageTemplate.filter((stage) => !seen.has(stage.key))
  const total = existing.length
  if (missing.length === 0) return { created: 0, skipped: seen.size }
  db.tx(() => {
    const firstRun = total === 0
    const at = nowIso()
    const insert = db.db.prepare('INSERT OR IGNORE INTO stages(id, project_id, key, name, status, gate, started_at, ended_at, position) VALUES (?,?,?,?,?,?,?,?,?)')
    stageTemplate.forEach((stage, index) => {
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
  return { created: missing.length, skipped: seen.size }
}

// ---------------------------------------------------------------------------
// 权威源位置（M0）：单写的物理前提
//
// 为什么必须搬：DSH 沙箱只有 allow-list（workspace-write = 工作区根 + tmp），
// 没有 deny-list，所以「工作区可写但 <workspace>/.project 不可写」表达不出来。
// 只要 DB 留在工作区，任务会话的 bash/fs/PTC 就能直连改写——应用层校验形同虚设。
//
// 搬到 agent 物理碰不到的地方（$DSH_HOME/storages/，实测对会话是 EPERM），
// 插件在 Host 进程里用裸 node:fs 读写，天然成为唯一写者。
//
// 三种模式（PROJECT_WORKBENCH_STORE）：
//   home （默认）→ $DSH_HOME/storages/project-workbench/<workspaceKey>/   ← 推荐，单写成立
//   local        → <workspace>/.project/                                   ← 兼容旧库；单写不成立
//   <绝对路径>   → 该目录作为 store 根（自管位置）
// ---------------------------------------------------------------------------
export const STORE_LAYOUT = 'store'

/** store 模式（调用时读取，便于测试/运维切换）。 */
export function storeMode() {
  const raw = process.env.PROJECT_WORKBENCH_STORE
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'home'
  return String(raw).trim()
}

/** $DSH_HOME：优先环境变量，其次 ~/.dsh（与 DSH 自身一致）。 */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  if (explicit && String(explicit).trim() !== '') return explicit.trim()
  try {
    return join(homedir(), '.dsh')
  } catch (error) {
    return join(process.cwd(), '.dsh')
  }
}

/** 工作区规范根的稳定短标识（同一根永远同一 key；不泄露完整路径到目录名）。 */
export function workspaceKey(root) {
  const canonical = realpathOf(root) || resolve(root)
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical
  return sha256(normalized).slice(0, 16)
}

/**
 * 权威源根目录（DB / inbox / packages 所在处）与工作区的「共享面」（导出产物）。
 * 注意：即使 DB 搬走，`docs/` 导出**仍然写在工作区**——那是给人看/进 git 的投影，本来就该在工作区。
 */
export function projectStore(root, options = {}) {
  const mode = options.mode || storeMode()
  const localRoot = join(root, PROJECT_DIR)
  if (mode === 'local') return { mode: 'local', storeRoot: localRoot, workspaceRoot: root, external: false }
  if (mode !== 'home' && isAbsolutePath(mode)) return { mode: 'custom', storeRoot: resolve(mode), workspaceRoot: root, external: true }
  const storeRoot = join(dshHome(), 'storages', 'project-workbench', workspaceKey(root))
  return { mode: 'home', storeRoot, workspaceRoot: root, external: true }
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
}

/**
 * 目录布局。`storeRoot` 放权威数据；导出产物落在工作表（`workspace.exportsDir`）。
 * 返回的 dbPath/jsonPath 指向 store；exportsDir/docsDir/timelinePath 指向工作区。
 */
export function projectPaths(root, options = {}) {
  const placement = options.placement || projectStore(root, options)
  const storeRoot = placement.storeRoot
  const workspaceRoot = placement.workspaceRoot
  // 导出始终在工作区（人看 / 进 git 的投影）；local 模式下两者同一个目录。
  const workspaceProjectDir = join(workspaceRoot, PROJECT_DIR)
  return {
    root: workspaceRoot,
    placement,
    external: placement.external,
    storeRoot,
    projectDir: workspaceProjectDir, // 向后兼容：仍指工作区的 .project（布局文件/忽略规则）
    dbPath: join(storeRoot, DB_FILE),
    jsonPath: join(storeRoot, JSON_FILE),
    legacyLocalDir: join(workspaceProjectDir),
    exportsDir: join(workspaceProjectDir, 'exports'),
    docsDir: join(workspaceProjectDir, 'exports', 'docs'),
    timelinePath: join(workspaceProjectDir, 'exports', 'timeline.md'),
    inboxDir: join(storeRoot, 'inbox'),
    packagesDir: join(storeRoot, 'packages'),
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

  /**
   * 建目录布局：权威数据在 store（DB/json/inbox/packages），导出投影在工作区 docs/。
   * 搬走权威源后，工作区只剩「给人看」的导出目录——这正是单写成立后应有的形状。
   */
  function mkdirLayout(paths) {
    mkdirSync(paths.storeRoot, { recursive: true })
    mkdirSync(paths.inboxDir, { recursive: true })
    mkdirSync(paths.packagesDir, { recursive: true })
    mkdirSync(paths.exportsDir, { recursive: true })
    mkdirSync(paths.docsDir, { recursive: true })
    // 工作区仍然需要 .project/ 目录来放导出投影与忽略规则（DB 不在里面）。
    mkdirSync(paths.projectDir, { recursive: true })
  }

  /** 该工作区是否已有项目运行时（外部 store 或旧的工作区内 .project 都算）。 */
  function hasProjectRuntime(root) {
    const paths = projectPaths(root)
    return existsSync(paths.jsonPath) || existsSync(paths.dbPath) ||
      existsSync(join(root, PROJECT_DIR, JSON_FILE)) || existsSync(join(root, PROJECT_DIR, DB_FILE))
  }

  /**
   * 旧库迁移检测：store 已外移但数据还在工作区 .project/ 里 → 需要显式迁移（不静默复制）。
   * 返回 { needsMigration, legacyDir, storeRoot }。
   */
  function migrationStatus(root) {
    const paths = projectPaths(root)
    if (!paths.external && paths.storeRoot === paths.legacyLocalDir) {
      return { needsMigration: false, mode: 'local', reason: 'already-local' }
    }
    if (paths.storeRoot === paths.legacyLocalDir) return { needsMigration: false, mode: 'local' }
    const legacyHasData = existsSync(join(paths.legacyLocalDir, DB_FILE)) || existsSync(join(paths.legacyLocalDir, JSON_FILE))
    const storeHasData = existsSync(paths.dbPath) || existsSync(paths.jsonPath)
    return {
      needsMigration: legacyHasData && !storeHasData,
      legacyDir: paths.legacyLocalDir,
      storeRoot: paths.storeRoot,
      storeHasData,
      legacyHasData,
    }
  }

  /**
   * 把工作区 .project/ 里的权威数据搬到外部 store（M0 迁移）。默认只**复制并保留**原件，
   * 只有在 options.removeLegacy === true 时才删除旧目录——迁移是幂等可回滚的操作，不该有惊喜。
   */
  function migrateLegacyStore(root, options = {}) {
    const paths = projectPaths(root)
    const status = migrationStatus(root)
    if (paths.storeRoot === paths.legacyLocalDir) throw projectError('STORE_LOCAL_MODE', '当前是 local 模式（PROJECT_WORKBENCH_STORE=local），不需要迁移', 409)
    if (status.storeHasData && options.overwrite !== true) {
      throw projectError('STORE_ALREADY_EXISTS', '目标 store 已有项目数据：' + paths.storeRoot + '（如需覆盖请 overwrite=true）', 409)
    }
    mkdirSync(paths.storeRoot, { recursive: true })
    const moved = []
    const copyIfExists = (from, to) => {
      if (!existsSync(from)) return false
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(from))
      moved.push(to)
      return true
    }
    copyIfExists(join(paths.legacyLocalDir, DB_FILE), paths.dbPath)
    copyIfExists(join(paths.legacyLocalDir, DB_FILE + '-wal'), paths.dbPath + '-wal')
    copyIfExists(join(paths.legacyLocalDir, DB_FILE + '-shm'), paths.dbPath + '-shm')
    copyIfExists(join(paths.legacyLocalDir, JSON_FILE), paths.jsonPath)
    if (options.removeLegacy === true) {
      for (const name of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm', JSON_FILE]) {
        try { rmSync(join(paths.legacyLocalDir, name), { force: true }) } catch (error) { /* 保留现场 */ }
      }
    }
    return { migrated: moved.length > 0, storeRoot: paths.storeRoot, legacyDir: paths.legacyLocalDir, files: moved, legacyRemoved: options.removeLegacy === true }
  }

  /**
   * 解析项目根：优先 workspaceRegistry 登记项（GUI 场景的唯一定义），
   * 无该服务时（headless/CLI）退化为「目录里已有 .project 运行时」——仍拒绝任意路径，
   * 只允许之前由项目面板/注册表建立过运行时的目录。
   */
  function resolveEntity(reference, options = {}) {
    const list = workspaces()
    if (list.length === 0) {
      if (typeof reference !== 'string' || reference.trim() === '') return undefined
      const raw = resolve(reference)
      const canonical = realpathOf(raw)
      if (!canonical) return undefined
      // 无 workspaceRegistry（headless/CLI）：默认只准入「已有 .project 运行时」的目录。
      // 但 ensure() 正是用来创建运行时的——没有 allowCreate 就会死锁，headless 永远初始化不了项目。
      // allowCreate 仍要求目录真实存在（realpath 成功），只是不要求已经初始化。
      if (!hasProjectRuntime(canonical) && options.allowCreate !== true) return undefined
      if (options.allowCreate === true && !isDirectoryPath(canonical)) return undefined
      return { id: undefined, path: canonical, title: readProjectJson(join(canonical, PROJECT_DIR, JSON_FILE))?.name || canonical }
    }
    return undefined
  }

  /** 目录存在性检查（allowCreate 准入用；不递归、不跟随链接）。 */
  function isDirectoryPath(path) {
    try { return statSync(path).isDirectory() } catch { return false }
  }

  /** workspaceId | rootPath | undefined → {workspaceId, root, title}；root 必须属于已登记 workspace。 */
  function rootForWorkspace(reference, options = {}) {
    const list = workspaces()
    if (list.length === 0) {
      const fallback = resolveEntity(reference, options)
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
    // 老库兼容：数据还在工作区 .project/，外部 store 是空的 → 自动搬一次（**复制**，旧数据保留）。
    // 不静默升级库结构，只换位置；原件保留意味着随时可回滚（rm store 即回到旧布局）。
    if (paths.external && !existsSync(paths.dbPath) && existsSync(join(paths.legacyLocalDir, DB_FILE))) {
      try { migrateLegacyStore(workspace.root, { overwrite: false }) } catch (error) { /* 迁移失败则按未初始化处理 */ }
    }
    if (!existsSync(paths.dbPath)) return undefined
    mkdirLayout(paths)
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
    bootstrapStages(db, workspace, stageTemplateFor(readProjectJson(paths.jsonPath)).template)
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
    const wantsCreate = Boolean(options && options.create)
    // open({create:true}) 等价 ensure：未初始化的 workspace 也要能进（否则永远走不到创建分支）。
    const workspace = rootForWorkspace(reference, wantsCreate ? { allowCreate: true } : {})
    const key = cacheKey(workspace.root)
    const cached = projects.get(key)
    if (cached) return cached
    const db = openDb(workspace)
    if (!db) {
      if (wantsCreate) return ensure(workspace.root, { name: options.name, workspaceId: workspace.workspaceId })
      return undefined
    }
    projects.set(key, db)
    return db
  }

  function ensure(reference, options = {}) {
    // ensure = 显式初始化请求，允许在 headless 下创建运行时（open 不传 allowCreate，保持严格）。
    const workspace = options.workspaceId !== undefined
      ? rootForWorkspace(options.workspaceId, { allowCreate: true })
      : rootForWorkspace(options.root !== undefined ? options.root : reference, { allowCreate: true })
    const key = cacheKey(workspace.root)
    if (projects.has(key)) return projects.get(key)
    const paths = projectPaths(workspace.root)
    mkdirLayout(paths)
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
    bootstrapStages(db, workspace, stageTemplateFor(readProjectJson(paths.jsonPath)).template)
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

  // v6.3 配置写入入口：改 project.json 的若干字段（浅合并，原子写）。
  // 为什么需要它：scopePolicy 以前全仓只有读（scope.js:scopePolicyOf），默认 project.json 也不产出
  // 这个键 —— 于是文档承诺的 declare 策略在真实项目里不可达，session_finish_task 的
  // acceptedOutOfScope 变成死参数（lumio 真库反馈 P0-2）。入口放在 registry 而不是某个工具里，
  // 是为了让「谁能改配置」在工具层显式声明（actors）。
  // 语义：读 -> 浅合并 -> 原子写。文件不存在时报错，而不是凭空造一个缺了 stageTemplate/
  // exportMap 的 project.json（那会把项目配置写残）。
  function updateProjectJson(reference, patch) {
    const workspace = rootForWorkspace(reference)
    const jsonPath = projectPaths(workspace.root).jsonPath
    const before = readProjectJson(jsonPath)
    if (!before || typeof before !== 'object') throw fail('NOT_FOUND', 'project.json 不存在或不可解析：' + jsonPath)
    const after = { ...before, ...(patch && typeof patch === 'object' ? patch : {}) }
    const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]))
    if (changed.length === 0) return { jsonPath, before, after, changed: [] }
    writeProjectJson(jsonPath, after)
    return { jsonPath, before, after, changed }
  }

  /**
   * 本项目实际生效的阶段模板（W2）。同时把「project.json 里的模板非法」这一情况带出去，
   * 让调用方（面板/PM）能提示用户，而不是让它悄悄回退默认。
   */
  function activeStageTemplate(reference) {
    const workspace = rootForWorkspace(reference)
    return stageTemplateFor(readProjectJson(projectPaths(workspace.root).jsonPath))
  }

  /**
   * 只读的「换模板影响评估」（W2）：对比当前 stages 行与目标模板，不改任何数据。
   * 换模板是显式操作——调用方拿到计划后必须由人确认，再另行执行。
   */
  function stageRemapPlan(reference, targetTemplate) {
    const db = open(reference)
    if (!db) throw projectError('NOT_INITIALIZED', 'project is not initialized: ' + String(reference), 409)
    const normalized = projectDefaults.normalizeStageTemplate(targetTemplate)
    if (!normalized.ok) throw projectError(normalized.code, normalized.message, 400)
    const rows = db.db.prepare('SELECT key, name, gate, status, position FROM stages WHERE project_id = ? ORDER BY position ASC').all(db.projectId)
    return { current: rows, target: normalized.template, plan: projectDefaults.planStageRemap(rows, normalized.template) }
  }

  /**
   * 落实「换阶段模板」（W2 的写路径）。**必须由人确认后显式调用**，openDb 绝不自动做。
   *
   * 为什么不删行：events 是 append-only 的，历史 stage/change 事件指向旧阶段 key。
   * 直接 DELETE 会造出「事件指向不存在的主体」（W1 已经踩过一次）。因此：
   *   - 缺失的阶段 → 插入（position 取自模板顺序）
   *   - 名字/门禁变了 → 更新
   *   - 不在新模板里的阶段 → status 置 'retired'（保留行与历史），不删除
   *   - active 阶段如果被 retire，把新模板的第一个阶段激活（并写 stage/change）
   * 全过程在一个事务里，并写一条 stage/template 事件记录这次变更。
   */
  function applyStageRemap(reference, targetTemplate, options = {}) {
    const workspace = rootForWorkspace(reference, { allowCreate: true })
    const db = open(workspace.root) || ensure(workspace.root, { name: options.name })
    const normalized = projectDefaults.normalizeStageTemplate(targetTemplate)
    if (!normalized.ok) throw projectError(normalized.code, normalized.message, 400)
    const template = normalized.template
    const before = db.db.prepare('SELECT key, name, gate, status, position FROM stages WHERE project_id = ? ORDER BY position ASC').all(db.projectId)
    const plan = projectDefaults.planStageRemap(before, template)
    if (!plan.needsConfirmation) return { applied: false, plan, stages: before }
    if (options.confirmed !== true) {
      const error = projectError('CONFIRM_REQUIRED', '换阶段模板需要显式确认（confirmed=true）：' + JSON.stringify(plan), 409)
      error.plan = plan
      throw error
    }
    const targetKeys = new Set(template.map((stage) => stage.key))
    db.tx(() => {
      const at = nowIso()
      const insert = db.db.prepare('INSERT INTO stages(id, project_id, key, name, status, gate, started_at, ended_at, position) VALUES (?,?,?,?,?,?,?,?,?)')
      const update = db.db.prepare('UPDATE stages SET name = ?, gate = ?, position = ? WHERE project_id = ? AND key = ?')
      template.forEach((stage, index) => {
        const row = before.find((item) => item.key === stage.key)
        if (row) update.run(stage.name, stage.gate ?? null, index, db.projectId, stage.key)
        else insert.run(newId('stage'), db.projectId, stage.key, stage.name, 'pending', stage.gate ?? null, null, null, index)
      })
      for (const row of before) {
        if (targetKeys.has(row.key)) continue
        if (row.status === 'retired') continue
        db.db.prepare("UPDATE stages SET status = 'retired', ended_at = COALESCE(ended_at, ?) WHERE project_id = ? AND key = ?").run(at, db.projectId, row.key)
      }
      // active 阶段必须恰有一个；被 retire 掉就激活新模板的第一个
      const active = db.db.prepare("SELECT id, key FROM stages WHERE project_id = ? AND status = 'active' LIMIT 1").get(db.projectId)
      if (!active) {
        const first = db.db.prepare("SELECT id, key, gate FROM stages WHERE project_id = ? AND status != 'retired' ORDER BY position ASC LIMIT 1").get(db.projectId)
        if (first) {
          db.db.prepare("UPDATE stages SET status = 'active', started_at = COALESCE(started_at, ?) WHERE id = ?").run(at, first.id)
          db.setMeta('stage.current', first.key)
          db.appendEvent({
            kind: 'stage/change',
            subjectType: 'stage',
            subjectId: first.key,
            payload: { from: null, to: first.key, gate: first.gate ?? null, reason: 'stage template remap' },
          })
        }
      }
      db.appendEvent({
        kind: 'stage/template',
        subjectType: 'project',
        subjectId: db.projectId,
        payload: { added: plan.added, removed: plan.removed, renamed: plan.renamed, regated: plan.regated, retired: plan.removed },
      })
    })
    const after = db.db.prepare('SELECT key, name, gate, status, position FROM stages WHERE project_id = ? ORDER BY position ASC').all(db.projectId)
    return { applied: true, plan, stages: after }
  }

  function closeAll() {
    for (const db of projects.values()) {
      try { db.close() } catch { /* 已关闭 */ }
    }
    projects.clear()
  }

  return {
    rootForWorkspace, open, ensure, listProjects, pmSession, projectJson, updateProjectJson, projectPaths,
    activeStageTemplate, stageRemapPlan, applyStageRemap,
    storeLayout: (reference) => projectPaths(rootForWorkspace(reference, { allowCreate: true }).root),
    migrationStatus, migrateLegacyStore,
    closeAll,
  }
}
