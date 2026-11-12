#!/usr/bin/env node
// T5 verify · 隔离 DSH Web 实例管理器（契约 §0 / §11.4）。
// 用途：用 workspace 内 DSH_HOME（默认 <workspace>/.devhome）启动/停止/健康检查 52999 端口上的共享 dev 实例。
// 只依赖 node: 内置模块；不修改 ~/.dsh。
//
// 用法：
//   node workbench/scripts/dev-instance.mjs start  [--port 52999] [--home <dir>] [--force] [--json]
//   node workbench/scripts/dev-instance.mjs stop   [--port 52999] [--json]
//   node workbench/scripts/dev-instance.mjs restart
//   node workbench/scripts/dev-instance.mjs status [--json]
//   node workbench/scripts/dev-instance.mjs wait   [--timeout 120000]
//   node workbench/scripts/dev-instance.mjs url | cookie | logs [--lines 40]
//
// 退出码：0 成功/健康；1 操作失败；2 参数错误；3 实例未运行。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as requestHttp } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const WORKBENCH_ROOT = resolve(SCRIPT_DIR, '..')
export const WORKSPACE_ROOT = resolve(WORKBENCH_ROOT, '..')
export const DEFAULT_HOME = join(WORKSPACE_ROOT, '.devhome')
export const DEFAULT_PORT = 52999
export const DEFAULT_STATE_DIR = join(WORKBENCH_ROOT, 'tests', 'e2e', '.artifacts', 'dev-instance')
export const DEFAULT_EXE = process.env.DSH_DESKTOP_EXE || 'C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
export const DEFAULT_CLI = process.env.DSH_DESKTOP_CLI || 'C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'

export class InstanceError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'InstanceError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function pathsFor(stateDir = DEFAULT_STATE_DIR) {
  return {
    stateDir,
    stateFile: join(stateDir, 'instance.json'),
    logFile: join(stateDir, 'instance.log'),
    urlFile: join(stateDir, 'instance.url'),
    cookieFile: join(stateDir, 'instance.cookie'),
  }
}

function ensureDir(dir) { mkdirSync(dir, { recursive: true }); return dir }

export function readState(stateDir = DEFAULT_STATE_DIR) {
  const { stateFile } = pathsFor(stateDir)
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (!state || !Number.isInteger(state.pid)) return undefined
    return state
  } catch {
    return undefined
  }
}

function writeState(stateDir, state) {
  ensureDir(stateDir)
  writeFileSync(pathsFor(stateDir).stateFile, JSON.stringify(state, null, 2), 'utf8')
}

function clearState(stateDir) {
  const { stateFile, urlFile, cookieFile } = pathsFor(stateDir)
  for (const file of [stateFile, urlFile, cookieFile]) {
    try { rmSync(file, { force: true }) } catch { /* ignore */ }
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error && error.code !== 'ESRCH' }
}

export function sleep(ms) { return new Promise((resolveP) => setTimeout(resolveP, ms)) }

/** 解析 netstat -ano 找到监听该端口的 pid（Windows）。 */
export function listenerPids(port) {
  if (process.platform !== 'win32') return []
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (out.status !== 0 || !out.stdout) return []
  const pids = new Set()
  for (const line of out.stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+:\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line)
    if (!match) continue
    if (Number(match[1]) === Number(port)) pids.add(Number(match[2]))
  }
  return [...pids]
}

export function portFree(port) { return listenerPids(port).length === 0 }

export function killTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    return result.status === 0
  }
  try { process.kill(pid, 'SIGTERM'); return true } catch { return false }
}

export function tailLog(logFile, maxChars = 8000) {
  try {
    const text = readFileSync(logFile, 'utf8')
    return text.length > maxChars ? text.slice(text.length - maxChars) : text
  } catch {
    return ''
  }
}

/** 原始 HTTP 请求：返回 {status, headers, body}。 */
export function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveP, rejectP) => {
    const req = requestHttp(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectP)
    req.setTimeout(20000, () => req.destroy(new Error('request timeout: ' + url)))
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

/** 用 launch token URL 换取浏览器会话 cookie。 */
export async function authenticate(url) {
  const parsed = new URL(url)
  const response = await httpRequest(url, { method: 'GET' })
  const setCookie = response.headers['set-cookie']
  const cookieList = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  const cookie = cookieList.map((value) => String(value).split(';')[0]).filter(Boolean).join('; ')
  if (response.status !== 303 && response.status !== 200) {
    throw new InstanceError('AUTH_FAILED', '启动 URL 鉴权失败: HTTP ' + String(response.status) + '（token 可能已失效，重启实例）')
  }
  if (!cookie) {
    // 已带 cookie 的 URL 也可能 200；从页面/文件兜底取不到就报错，让调用方显式重试。
    throw new InstanceError('AUTH_FAILED', '启动 URL 未返回会话 cookie（HTTP ' + String(response.status) + '）')
  }
  return { origin: parsed.origin, launchToken: parsed.searchParams.get('token') || '', cookie, status: response.status }
}

/** 健康检查：cookie 访问首页应 200 且是 DSH 页面。 */
export async function checkHealth(url, options = {}) {
  const auth = await authenticate(url)
  const index = await httpRequest(auth.origin + '/', { headers: { cookie: auth.cookie } })
  const looksLikeDsh = index.body.includes('__DSH_CONTACT_CONFIG__') || index.body.includes('__DSH_BOOT__') || index.body.includes('<div id="root"')
  return {
    ok: index.status === 200 && looksLikeDsh,
    status: index.status,
    bytes: index.body.length,
    origin: auth.origin,
    cookie: auth.cookie,
    looksLikeDsh,
  }
}

/** 轮询实例日志，得到启动打印的带 launch token 的 URL。 */
export async function waitForUrl(stateDir = DEFAULT_STATE_DIR, options = {}) {
  const timeoutMs = options.timeoutMs || 180000
  const { logFile, urlFile } = pathsFor(stateDir)
  const startedAt = Date.now()
  let lastLog = ''
  while (Date.now() - startedAt < timeoutMs) {
    lastLog = tailLog(logFile, 4000)
    const match = /dsh web:\s*(http:\/\/\S+)/.exec(lastLog)
    if (match) {
      const url = match[1].trim()
      ensureDir(stateDir)
      writeFileSync(urlFile, url, 'utf8')
      return url
    }
    if (/EADDRINUSE|EACCES|startup audit failed|Error:\s/i.test(lastLog)) {
      throw new InstanceError('START_FAILED', '实例启动报错（日志尾部）:\n' + lastLog.slice(-2000))
    }
    const state = readState(stateDir)
    if (state && !isAlive(state.pid)) {
      throw new InstanceError('START_FAILED', '实例进程已退出（日志尾部）:\n' + lastLog.slice(-2000))
    }
    await sleep(250)
  }
  throw new InstanceError('START_TIMEOUT', '等待实例启动 URL 超时（' + String(timeoutMs) + 'ms，日志尾部）:\n' + lastLog.slice(-2000))
}

/** 启动实例；已运行且未 --force 时幂等返回。 */
export async function startInstance(options = {}) {
  const home = resolve(options.home || DEFAULT_HOME)
  const port = Number(options.port || DEFAULT_PORT)
  const stateDir = resolve(options.stateDir || DEFAULT_STATE_DIR)
  const exe = options.exe || DEFAULT_EXE
  const cli = options.cli || DEFAULT_CLI
  const timeoutMs = Number(options.timeoutMs || 180000)
  const force = options.force === true

  for (const [label, file] of [['exe', exe], ['cli', cli]]) {
    if (!existsSync(file)) throw new InstanceError('ENV_MISSING', '找不到 DSH ' + label + ': ' + file + '（可用环境变量 DSH_DESKTOP_EXE / DSH_DESKTOP_CLI 覆盖）')
  }
  if (!existsSync(home)) ensureDir(home)

  const existing = readState(stateDir)
  if (existing && isAlive(existing.pid)) {
    if (!force) {
      const url = readUrl(stateDir)
      return { status: 'already-running', pid: existing.pid, port: existing.port, home: existing.home, url, stateDir }
    }
    await stopInstance({ stateDir })
  } else if (existing) {
    clearState(stateDir)
  }

  const busy = listenerPids(port)
  if (busy.length > 0) {
    if (!force) {
      throw new InstanceError('PORT_BUSY', '端口 ' + String(port) + ' 已被 pid ' + busy.join(',') + ' 占用（可能是手工启动的实例）。可加 --force 结束它，或先手工停止。')
    }
    for (const pid of busy) killTree(pid)
    await sleep(500)
  }

  ensureDir(stateDir)
  const paths = pathsFor(stateDir)
  const logFd = openSync(paths.logFile, 'w')
  const args = ['--expose-internals', cli, '--profile', options.profile || 'web', '--no-open', '--port', String(port)]
  for (const patch of options.patches || []) args.push('--patch', resolve(patch))
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }
  let child
  try {
    child = spawn(exe, args, { env, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true })
  } finally {
    closeSync(logFd)
  }
  if (!child.pid) throw new InstanceError('START_FAILED', 'spawn 未返回 pid：' + exe)
  child.unref()
  const state = { pid: child.pid, port, home, exe, cli, profile: options.profile || 'web', startedAt: new Date().toISOString(), stateDir }
  writeState(stateDir, state)

  try {
    const url = await waitForUrl(stateDir, { timeoutMs })
    const health = await checkHealth(url)
    if (!health.ok) throw new InstanceError('HEALTH_FAILED', '实例首页健康检查失败: HTTP ' + String(health.status) + '，页面字节 ' + String(health.bytes))
    ensureDir(stateDir)
    writeFileSync(paths.cookieFile, health.cookie, 'utf8')
    return { status: 'started', pid: state.pid, port, home, url, stateDir, health: { status: health.status, bytes: health.bytes } }
  } catch (error) {
    try { if (isAlive(state.pid)) killTree(state.pid) } catch { /* ignore */ }
    clearState(stateDir)
    throw error
  }
}

export function readUrl(stateDir = DEFAULT_STATE_DIR) {
  const { urlFile } = pathsFor(stateDir)
  try { return readFileSync(urlFile, 'utf8').trim() || undefined } catch { return undefined }
}

/** 停止实例（含进程树），等待端口释放。 */
export async function stopInstance(options = {}) {
  const stateDir = resolve(options.stateDir || DEFAULT_STATE_DIR)
  const port = Number(options.port || DEFAULT_PORT)
  const timeoutMs = Number(options.timeoutMs || 20000)
  let pid = options.pid
  const state = readState(stateDir)
  if (!pid && state && isAlive(state.pid)) pid = state.pid
  let pids = []
  if (pid) pids.push(pid)
  for (const listener of listenerPids(port)) if (!pids.includes(listener)) pids.push(listener)
  if (pids.length === 0) {
    clearState(stateDir)
    return { status: 'not-running', port, stateDir }
  }
  for (const target of pids) killTree(target)
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const alive = pids.filter((target) => isAlive(target))
    const listeners = listenerPids(port)
    if (alive.length === 0 && listeners.length === 0) break
    await sleep(250)
  }
  const stillAlive = pids.filter((target) => isAlive(target))
  const stillListening = listenerPids(port)
  if (stillAlive.length > 0 || stillListening.length > 0) {
    throw new InstanceError('STOP_FAILED', '实例未完全停止: alive=' + JSON.stringify(stillAlive) + ' listeners=' + JSON.stringify(stillListening))
  }
  clearState(stateDir)
  return { status: 'stopped', port, pids, stateDir }
}

/** 实例状态 + 可选健康检查。 */
export async function statusInstance(options = {}) {
  const stateDir = resolve(options.stateDir || DEFAULT_STATE_DIR)
  const port = Number(options.port || DEFAULT_PORT)
  const state = readState(stateDir)
  const running = Boolean(state && isAlive(state.pid))
  const listeners = listenerPids(port)
  const url = readUrl(stateDir)
  let health
  if (url) {
    try { health = await checkHealth(url) } catch (error) { health = { ok: false, error: String(error && error.message) } }
  }
  return {
    running,
    port,
    stateDir,
    pid: state ? state.pid : undefined,
    home: state ? state.home : undefined,
    startedAt: state ? state.startedAt : undefined,
    listeners,
    url,
    health,
  }
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--force') options.force = true
    else if (arg === '--port') options.port = Number(argv[++i])
    else if (arg === '--home') options.home = resolve(argv[++i])
    else if (arg === '--state-dir') options.stateDir = resolve(argv[++i])
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i])
    else if (arg === '--lines') options.lines = Number(argv[++i])
    else if (arg === '--patch') (options.patches = options.patches || []).push(argv[++i])
    else options._.push(arg)
  }
  return options
}

function print(io, value) {
  if (io.json) console.log(JSON.stringify(value, null, 2))
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

export async function main(argv = process.argv.slice(2), io = { json: false }) {
  const command = argv[0]
  const options = parseArgs(argv.slice(1))
  const json = Boolean(options.json || io.json)
  const common = { stateDir: options.stateDir, port: options.port, home: options.home, json }
  const emit = (value) => print({ json }, value)
  try {
    switch (command) {
      case 'start': {
        const result = await startInstance({ ...common, force: options.force, profile: options.profile, patches: options.patches, timeoutMs: options.timeoutMs })
        emit(result)
        if (result.url) console.error('dsh web: ' + result.url)
        return 0
      }
      case 'stop': {
        emit(await stopInstance(common))
        return 0
      }
      case 'restart': {
        const stopped = await stopInstance(common)
        const started = await startInstance({ ...common, force: false, profile: options.profile, patches: options.patches, timeoutMs: options.timeoutMs })
        emit({ stopped, started })
        if (started.url) console.error('dsh web: ' + started.url)
        return 0
      }
      case 'status': {
        const result = await statusInstance(common)
        emit(result)
        if (!result.running) return 3
        return result.health && result.health.ok ? 0 : 1
      }
      case 'wait': {
        const stateDir = resolve(options.stateDir || DEFAULT_STATE_DIR)
        const url = readUrl(stateDir) || (await waitForUrl(stateDir, { timeoutMs: options.timeoutMs || 180000 }))
        const health = await checkHealth(url)
        if (!health.ok) throw new InstanceError('HEALTH_FAILED', '健康检查失败')
        emit({ status: 'ready', url, health: { status: health.status, bytes: health.bytes } })
        return 0
      }
      case 'url': {
        const url = readUrl(options.stateDir ? resolve(options.stateDir) : DEFAULT_STATE_DIR)
        if (!url) throw new InstanceError('NO_URL', '尚无实例 URL；先执行 start')
        emit(url)
        return 0
      }
      case 'cookie': {
        const url = readUrl(options.stateDir ? resolve(options.stateDir) : DEFAULT_STATE_DIR)
        if (!url) throw new InstanceError('NO_URL', '尚无实例 URL；先执行 start')
        const auth = await authenticate(url)
        emit({ origin: auth.origin, cookie: auth.cookie })
        console.error('cookie=' + auth.cookie)
        return 0
      }
      case 'logs': {
        const stateDir = resolve(options.stateDir || DEFAULT_STATE_DIR)
        const text = tailLog(pathsFor(stateDir).logFile, 200000)
        const lines = text.split(/\r?\n/)
        const limit = options.lines || 40
        emit(lines.slice(-limit).join('\n'))
        return 0
      }
      case 'health': {
        const url = readUrl(options.stateDir ? resolve(options.stateDir) : DEFAULT_STATE_DIR)
        if (!url) throw new InstanceError('NO_URL', '尚无实例 URL；先执行 start')
        const health = await checkHealth(url)
        emit({ status: health.ok ? 'ok' : 'unhealthy', health: { status: health.status, bytes: health.bytes } })
        return health.ok ? 0 : 1
      }
      default:
        console.error(USAGE)
        return 2
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'ERROR'
    if (json) console.log(JSON.stringify({ status: 'error', code, message: String(error && error.message) }, null, 2))
    else console.error('ERROR[' + code + '] ' + String(error && error.message))
    return 1
  }
}

export const USAGE = [
  'node workbench/scripts/dev-instance.mjs <start|stop|restart|status|wait|url|cookie|health|logs>',
  '  --port <n>        端口（默认 ' + String(DEFAULT_PORT) + '）',
  '  --home <dir>      DSH_HOME（默认 <workspace>/.devhome）',
  '  --state-dir <dir> pid/log/url 状态目录（默认 workbench/tests/e2e/.artifacts/dev-instance）',
  '  --force           端口被占用时结束占用进程；start 时先停旧实例再启动',
  '  --timeout <ms>    启动/停止等待上限（默认 180000/20000）',
  '  --json            机器可读输出',
].join('\n')

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
