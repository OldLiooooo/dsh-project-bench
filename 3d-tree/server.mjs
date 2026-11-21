#!/usr/bin/env node
// 3d-tree/server.mjs
//
// 独立只读服务：把 .project/project.db 投影成 3D 树页面，浏览器直接开。
//
// 边界（守死，否则它会变成第二个写入者）：
//   - SQLite 只开 readOnly:true；
//   - 只 GET，唯一的 POST 是 /api/reload（只重算，不写库）；
//   - 不引入任何三方依赖，只用 node: 内置模块；
//   - 默认只监听 127.0.0.1。要给别的机器看，显式 --host 0.0.0.0。
//
// 用法：
//   node 3d-tree/server.mjs --root C:/Users/oldap/Documents/lumio [--port 5777] [--host 127.0.0.1] [--open]
//   node 3d-tree/server.mjs --db <path/to/project.db>          # 直接指库，root 从库项目的 root 推
//   node 3d-tree/server.mjs --list                             # 列出工作区里所有可看的项目库

import { createReadStream, existsSync, readFileSync, readdirSync, statSync, watch } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { buildTree, diffDisk, readProjectRows, safeJson } from './model.mjs'
import { SKIP_DIRS } from './defaults.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATIC_DIR = join(HERE, 'web')

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { port: 5777, host: '127.0.0.1', root: null, db: null, open: false, list: false, help: false, watch: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--port' || arg === '-p') out.port = Number(next())
    else if (arg === '--host') out.host = next()
    else if (arg === '--root' || arg === '-r') out.root = next()
    else if (arg === '--db') out.db = next()
    else if (arg === '--open') out.open = true
    else if (arg === '--list') out.list = true
    else if (arg === '--no-watch') out.watch = false
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (!arg.startsWith('-') && !out.root) out.root = arg
  }
  return out
}

export function usage() {
  return [
    'Usage: node 3d-tree/server.mjs --root <project-dir> [options]',
    '',
    '  --root, -r <dir>   项目根目录（含 .project/project.db）',
    '  --db <file>        直接指定 project.db（root 从库里的 projects.root 推）',
    '  --port, -p <n>     端口，默认 5777',
    '  --host <addr>      监听地址，默认 127.0.0.1（只本机）',
    '  --open             启动后用默认浏览器打开',
    '  --no-watch         关闭文件监听（不自动刷新）',
    '  --list             列出本目录下所有可看的项目',
    '  --help, -h         显示本帮助',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 定位项目库
// ---------------------------------------------------------------------------

/** 从 --root / --db / cwd 推断 {dbPath, root}；找不到返回 error 字段。 */
export function resolveTarget(options) {
  if (options.db) {
    const dbPath = resolve(options.db)
    if (!existsSync(dbPath)) return { error: 'database not found: ' + dbPath }
    return { dbPath, root: readRootFromDb(dbPath) }
  }
  if (options.root) {
    const root = resolve(options.root)
    const dbPath = join(root, '.project', 'project.db')
    if (!existsSync(dbPath)) return { error: 'no .project/project.db under ' + root }
    return { dbPath, root }
  }
  // 无参数：如果 cwd 自己就是项目，直接用。
  const cwd = process.cwd()
  const dbPath = join(cwd, '.project', 'project.db')
  if (existsSync(dbPath)) return { dbPath, root: cwd }
  return { error: 'no project specified; pass --root <project-dir> or run --list' }
}

/** 只读打开库，取 projects.root（装配时就定一次）。 */
export function readRootFromDb(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT root FROM projects LIMIT 1').get()
      return row?.root ? resolve(row.root) : dirname(dirname(dbPath))
    } finally {
      db.close()
    }
  } catch {
    return dirname(dirname(dbPath))
  }
}

/**
 * 列目录下所有含 .project/project.db 的项目（不递归太深）。
 * 给 --list 用，方便找「我到底有几个项目」。
 */
export function listProjects(baseDir, options = {}) {
  const maxDepth = Number(options.maxDepth ?? 4)
  const found = []
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.isDirectory() && e.name === '.project')) {
      const dbPath = join(dir, '.project', 'project.db')
      if (existsSync(dbPath)) found.push({ root: dir, dbPath, name: readProjectName(dbPath) })
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(resolve(baseDir), 0)
  return found
}

function readProjectName(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare('SELECT name FROM projects LIMIT 1').get()
      return row?.name || null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 快照（每次请求现开现关，避免长连接占着 WAL）
// ---------------------------------------------------------------------------

/**
 * 读一次完整树。**每次重新开库**：这样 WAL 增长能被及时 checkpoint，
 * 也不会因为一个陈旧连接看到旧数据。代价是每次几毫秒，可以接受。
 */
export function readSnapshot(target, options = {}) {
  let db
  try {
    db = new DatabaseSync(target.dbPath, { readOnly: true })
    db.exec('PRAGMA busy_timeout=5000')
    const rows = readProjectRows(db)
    const root = target.root || rows.project?.root || '.'
    const projectJson = loadProjectJson(root, rows.project?.config_json)
    const disk = options.diskFiles ? options.diskFiles : scanDocs(root)
    const tree = buildTree(rows, {
      root,
      projectJson,
      stageTemplate: projectJson.stageTemplate,
      existingFiles: options.existingFiles,
      // 磁盘清单直接喂给投影：未纳管的文件也要成为叶子，否则视图会严重失真
      diskFiles: disk,
    })
    tree.disk = diffDisk(tree, disk)
    tree.dbPath = target.dbPath
    return tree
  } finally {
    if (db) { try { db.close() } catch { /* 已关闭 */ } }
  }
}

/**
 * 读 .project/project.json（exportMap / stageTemplate 的来源）。
 * 兜底顺序：
 *   1. project.json 文件（唯一事实源）；
 *   2. 都没有时用 projects.config_json —— 只是夹具/老库的容错，真实项目一定有文件。
 * 少了这层兜底，导出路径会退回默认 map，把 docs/product 错算成 docs/prd。
 */
export function loadProjectJson(root, configJson) {
  const path = join(root, '.project', 'project.json')
  try {
    const parsed = safeJson(readFileSync(path, 'utf8'), null)
    if (parsed && typeof parsed === 'object') return parsed
  } catch {
    // 文件不存在或不可读 -> 走兜底
  }
  const fromDb = safeJson(configJson, null)
  return fromDb && typeof fromDb === 'object' ? fromDb : {}
}

/** 扫 root/docs，返回 relPath(相对 root, 正斜杠) -> bytes。 */
export function scanDocs(root, options = {}) {
  const map = new Map()
  const docsRoot = join(root, 'docs')
  const maxFiles = Number(options.maxFiles ?? 20000)
  const walk = (dir) => {
    if (map.size >= maxFiles) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (map.size >= maxFiles) return
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        walk(abs)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        try {
          const stat = statSync(abs)
          const rel = abs.slice(resolve(root).length + 1).split(sep).join('/')
          map.set(rel, stat.size)
        } catch { /* 文件刚被删 */ }
      }
    }
  }
  if (existsSync(docsRoot)) walk(docsRoot)
  return map
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 静态文件：只放行 STATIC_DIR 内的白名单扩展名，防穿越。 */
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''))
  const abs = resolve(STATIC_DIR, rel)
  if (!abs.startsWith(resolve(STATIC_DIR) + sep) && abs !== resolve(STATIC_DIR, 'index.html')) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  createReadStream(abs).pipe(res)
}

export function createTreeServer(target, options = {}) {
  const subscribers = new Set()
  const state = { version: 0, lastError: null }

  const broadcast = (payload) => {
    const data = 'data: ' + JSON.stringify(payload) + '\n\n'
    for (const res of subscribers) {
      try { res.write(data) } catch { subscribers.delete(res) }
    }
  }

  const push = () => {
    try {
      const tree = readSnapshot(target)
      state.version += 1
      state.lastError = null
      broadcast({ type: 'snapshot', version: state.version, tree })
    } catch (error) {
      state.lastError = String(error && error.message ? error.message : error)
      broadcast({ type: 'error', message: state.lastError })
    }
  }

  const server = createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))
    } catch {
      sendJson(res, 400, { error: 'bad url' })
      return
    }
    const path = url.pathname

    if (req.method !== 'GET' && req.method !== 'HEAD' && !(path === '/api/reload' && req.method === 'POST')) {
      sendJson(res, 405, { error: 'read-only: only GET is allowed' })
      return
    }

    try {
      if (path === '/api/snapshot') {
        sendJson(res, 200, readSnapshot(target))
        return
      }
      if (path === '/api/meta') {
        sendJson(res, 200, {
          dbPath: target.dbPath,
          root: target.root,
          version: state.version,
          lastError: state.lastError,
          watch: options.watch !== false,
        })
        return
      }
      if (path === '/api/reload' && req.method === 'POST') {
        push()
        sendJson(res, 200, { ok: true, version: state.version })
        return
      }
      if (path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write('retry: 2000\n\n')
        res.write('data: ' + JSON.stringify({ type: 'hello', version: state.version }) + '\n\n')
        subscribers.add(res)
        const keepAlive = setInterval(() => {
          try { res.write(': ping\n\n') } catch { /* 断开由 close 事件清理 */ }
        }, 25000)
        req.on('close', () => {
          clearInterval(keepAlive)
          subscribers.delete(res)
        })
        return
      }
      if (path.startsWith('/api/')) {
        sendJson(res, 404, { error: 'unknown api: ' + path })
        return
      }
      serveStatic(res, path)
    } catch (error) {
      sendJson(res, 500, { error: String(error && error.message ? error.message : error) })
    }
  })

  // 文件监听：DB 变了就推一次（合并 150ms 内的连抖）。
  let watcher = null
  let timer = null
  const startWatch = () => {
    if (options.watch === false) return
    const dir = dirname(target.dbPath)
    try {
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : ''
        if (name && !name.startsWith('project.db')) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { timer = null; push() }, 150)
      })
    } catch {
      watcher = null // 平台不支持就只保留手动刷新
    }
  }

  return {
    server,
    state,
    push,
    startWatch,
    stopWatch() {
      if (timer) { clearTimeout(timer); timer = null }
      if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = null }
    },
    close() {
      this.stopWatch()
      for (const res of subscribers) { try { res.end() } catch { /* ignore */ } }
      subscribers.clear()
      server.close()
    },
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)

  if (options.help) {
    console.log(usage())
    return 0
  }

  if (options.list) {
    const base = options.root ? resolve(options.root) : process.cwd()
    const found = listProjects(base)
    if (found.length === 0) {
      console.log('no projects with .project/project.db under ' + base)
      return 1
    }
    for (const item of found) console.log((item.name || '(unnamed)') + '\t' + item.root)
    return 0
  }

  const target = resolveTarget(options)
  if (target.error) {
    console.error('error: ' + target.error)
    console.error('')
    console.error(usage())
    return 2
  }

  const app = createTreeServer(target, { watch: options.watch })
  app.startWatch()

  await new Promise((done, fail) => {
    app.server.once('error', fail)
    app.server.listen(options.port, options.host, done)
  }).catch((error) => {
    console.error('listen failed: ' + (error && error.message ? error.message : error))
    process.exitCode = 1
  })

  if (process.exitCode === 1) return 1

  const shown = options.host === '0.0.0.0' ? '127.0.0.1' : options.host
  const url = 'http://' + shown + ':' + options.port + '/'
  console.log('3D tree view ready')
  console.log('  project : ' + (target.root || target.dbPath))
  console.log('  db      : ' + target.dbPath)
  console.log('  url     : ' + url)
  console.log('  watch   : ' + (options.watch ? 'on (auto refresh on db change)' : 'off'))
  if (options.host === '0.0.0.0') console.log('  note    : listening on all interfaces — read-only, but network-exposed')

  if (options.open) openBrowser(url)

  const shutdown = () => {
    app.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return 0
}

function openBrowser(url) {
  const platform = process.platform
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    import('node:child_process').then(({ spawn }) => {
      spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
    })
  } catch { /* 打不开就让用户自己点 */ }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().then((code) => { if (code) process.exit(code) }).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
