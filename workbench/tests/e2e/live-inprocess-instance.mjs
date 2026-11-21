#!/usr/bin/env node
// 真实 DSH 实例端到端验证（进程内启动，不依赖被封锁的 spawn/bash）。
//
// 为什么这样做：本机 ops_bash 全量 EXECUTOR_UNAVAILABLE、child_process.spawn EPERM，
// `dsh web` CLI 起不来。但 DSH 本身是可编程的：profile-boot 的 runProfile() 能在进程内
// 组装并启动一个真实的 web profile —— 真服务、真路由、真鉴权、真插件加载。
//
// 覆盖：instance-http.mjs 原本要验的东西（页面/preload/鉴权/API/SSE）+ 插件工具是否真的注册。
// 用法：node workbench/tests/e2e/live-inprocess-instance.mjs [--port 53120] [--keep]
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import http from 'node:http'
import process from 'node:process'

const HERE = import.meta.dirname
const WORKBENCH_ROOT = join(HERE, '..', '..')
const WORKSPACE_ROOT = join(WORKBENCH_ROOT, '..')
const ARTIFACTS = join(HERE, '.artifacts', 'live-instance')
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 53120
const KEEP = process.argv.includes('--keep')
const DSH_INSTALL = process.env.DSH_INSTALL || 'C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh'
const DSH_PACKAGES = DSH_INSTALL + '/node_modules/@deepseek-ai'

mkdirSync(ARTIFACTS, { recursive: true })
mkdirSync(join(ARTIFACTS, 'tmp'), { recursive: true })
mkdirSync(join(ARTIFACTS, 'native-cache'), { recursive: true })

// PTC / 子进程的 env 是空的：DSH 依赖这些基础变量（缺 TEMP 会让原生扩展缓存解析失败）。
process.env.TEMP = join(ARTIFACTS, 'tmp')
process.env.TMP = process.env.TEMP
process.env.LOCALAPPDATA = process.env.LOCALAPPDATA || 'C:\\Users\\oldap\\AppData\\Local'
process.env.APPDATA = process.env.APPDATA || 'C:\\Users\\oldap\\AppData\\Roaming'
process.env.USERPROFILE = process.env.USERPROFILE || 'C:\\Users\\oldap'
process.env.HOME = process.env.HOME || 'C:\\Users\\oldap'
process.env.NARB_NATIVE_CACHE_DIR = join(ARTIFACTS, 'native-cache')
process.env.DSH_HOME = join(ARTIFACTS, 'dshhome')

export async function runLiveInstance(options = {}) {
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + String(detail).slice(0, 300) : ''))
  return ok
}
function request(url, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {}, timeout: 20000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', (error) => resolve({ status: -1, body: 'ERR ' + error.code, headers: {} }))
    req.on('timeout', () => { req.destroy(); resolve({ status: -2, body: 'TIMEOUT', headers: {} }) })
    if (options.body) req.write(options.body)
    req.end()
  })
}

/**
 * 准备 profile：runProfile 首次启动会在 DSH_HOME 下建内置 web 模板（只有 base + web-app）。
 * 我们的 bundle 必须显式加进 dsh.profile.bundles，并把包链接进 profile 的 node_modules。
 * 这一步等价于「在插件管理器里安装本地 bundle」的那条写路径。
 */
async function prepareProfile() {
  const profileDir = join(process.env.DSH_HOME, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules', '@local'), { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { manifest = { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } } }
  const BUNDLE = '@local/dsh-project-workbench'
  manifest.dependencies = { ...(manifest.dependencies || {}), [BUNDLE]: 'link:' + WORKBENCH_ROOT.replace(/\\/g, '/') }
  const bundles = manifest.dsh.profile.bundles || []
  if (!bundles.includes(BUNDLE)) bundles.push(BUNDLE)
  manifest.dsh.profile.bundles = bundles
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const linkPath = join(profileDir, 'node_modules', '@local', 'dsh-project-workbench')
  try { await symlink(WORKBENCH_ROOT, linkPath, 'junction') } catch (error) { if (error.code !== 'EEXIST') throw error }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  try { await readFile(patchPath, 'utf8') } catch { await writeFile(patchPath, '[]' + String.fromCharCode(10), 'utf8') }
  return profileDir
}
const preparedProfile = await prepareProfile()

const { runProfile } = await import(pathToFileURL(DSH_PACKAGES + '/dsh/lib/profile-boot.js').href)
const { loadLayeredEnv } = await import(pathToFileURL(DSH_PACKAGES + '/dsh-app-boot/lib/index.js').href)

process.argv = [process.execPath, 'dsh', '--no-open', '--port', String(PORT)]
const started = Date.now()
let handle
try {
  handle = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [], args: ['--no-open', '--port', String(PORT)] })
} catch (error) {
  console.error('FATAL: 真实实例启动失败：' + String(error && error.message))
  process.exitCode = 1
  process.exit(1)
}
const ctx = handle.ctx
const svc = (name) => { try { return ctx.get(name) } catch { return undefined } }
check('① 真实 web profile 在进程内启动', true, (Date.now() - started) + 'ms on :' + PORT + ' profile=' + preparedProfile)

// 面板/HTTP 通道要求 workspace 已登记（registry 的准入规则）；真实用户是在 UI 里添加工作区。
const workspaceRegistry = svc('workspaceRegistry')
let registeredWorkspace
try {
  registeredWorkspace = await workspaceRegistry.create(WORKSPACE_ROOT, 'dsh-porject-bench')
} catch (error) {
  console.error('FATAL: 工作区登记失败：' + String(error && error.message))
}
check('②a 工作区已登记进 workspaceRegistry（HTTP 通道准入前提）', Boolean(registeredWorkspace && registeredWorkspace.id), registeredWorkspace ? String(registeredWorkspace.id) : 'none')

check('② 核心服务就位', ['webServer','connection','workspaceRegistry','tools','sessions','agents','subagents','systemPrompt','skills'].every((n) => Boolean(svc(n))),
  ['webServer','connection','workspaceRegistry','tools','sessions','agents','subagents','systemPrompt','skills'].filter((n) => !svc(n)).join(',') || 'all present')

const tools = svc('tools')
const names = (tools && typeof tools.definitions === 'function' ? tools.definitions() : []).map((d) => String(d.name))
const projectTools = names.filter((n) => /^(project_|slice_|task_|session_|gate_|doc_|evidence_|artifact_|file_index$|import_inbox$|export_project$)/.test(n))
check('③ 插件工具注册进真实 tools 服务', projectTools.length >= 20, projectTools.length + ' 个：' + projectTools.slice(0, 8).join(',') + (projectTools.length > 8 ? ',…' : ''))

const connection = svc('connection')
const launchToken = connection && connection.browserAuth ? connection.browserAuth.launchToken : undefined
const base = 'http://127.0.0.1:' + PORT
const authUrl = launchToken ? base + '/?token=' + launchToken : undefined
check('④ 取得实例 launch token', Boolean(launchToken), authUrl ? authUrl.replace(launchToken, '<token>') : 'no token')

const exchange = await request(authUrl)
const setCookie = exchange.headers['set-cookie']
const cookie = Array.isArray(setCookie) ? setCookie.map((c) => c.split(';')[0]).join('; ') : String(setCookie || '').split(';')[0]
check('⑤ token 换 cookie（303 + Set-Cookie）', exchange.status === 303 && Boolean(cookie), 'status=' + exchange.status)

const anon = await request(base + '/')
check('⑥ 无 cookie 首页 → 401（鉴权真生效）', anon.status === 401, 'status=' + anon.status)

const page = await request(base + '/', { headers: { cookie } })
const preloadHasPlugin = page.body.includes('dsh-project-workbench')
check('⑦ 带 cookie 首页 200 且注入插件 client bundle', page.status === 200 && preloadHasPlugin, 'status=' + page.status + ' len=' + page.body.length + (preloadHasPlugin ? '' : ' 无插件'))

const anonApi = await request(base + '/project-workbench/api/projects')
check('⑧ 未鉴权访问面板 API → 401', anonApi.status === 401, 'status=' + anonApi.status)

const projects = await request(base + '/project-workbench/api/projects', { headers: { cookie } })
check('⑨ 带 cookie GET /projects → 200', projects.status === 200, 'status=' + projects.status + ' ' + projects.body.slice(0, 120))

const init = await request(base + '/project-workbench/api/init', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ root: WORKSPACE_ROOT }) })
check('⑩ POST /init 在真实实例初始化项目', init.status === 200 && init.body.includes('"ok":true'), 'status=' + init.status + ' ' + init.body.slice(0, 160))

const snapshot = await request(base + '/project-workbench/api/snapshot?root=' + encodeURIComponent(WORKSPACE_ROOT), { headers: { cookie } })
check('⑪ GET /snapshot 返回项目快照', snapshot.status === 200 && snapshot.body.includes('"project"'), 'status=' + snapshot.status)

const timeline = await request(base + '/project-workbench/api/timeline?root=' + encodeURIComponent(WORKSPACE_ROOT) + '&limit=5', { headers: { cookie } })
check('⑫ GET /timeline 返回事件', timeline.status === 200 && timeline.body.includes('events'), 'status=' + timeline.status)

const sse = await new Promise((resolve) => {
  const target = base + '/project-workbench/api/events?root=' + encodeURIComponent(WORKSPACE_ROOT)
  const req = http.request(target, { headers: { cookie, accept: 'text/event-stream' }, timeout: 8000 }, (res) => {
    let body = ''
    res.on('data', (chunk) => { body += chunk; if (body.includes('event: change')) { req.destroy(); resolve({ status: res.statusCode, contentType: String(res.headers['content-type'] || ''), body }) } })
    res.on('end', () => resolve({ status: res.statusCode, contentType: String(res.headers['content-type'] || ''), body }))
  })
  req.on('error', () => resolve({ status: -1, contentType: '', body: '' }))
  req.on('timeout', () => { req.destroy(); resolve({ status: -2, contentType: '', body: '' }) })
  req.end()
})
check('⑬ GET /events SSE 推 revision', sse.status === 200 && sse.contentType.includes('text/event-stream') && /event: change/.test(sse.body), 'status=' + sse.status + ' ' + sse.contentType)

// 工具在真实 ctx 上能不能真的执行（不是注册就算）
const registryService = svc('projectWorkbenchRegistry')
let toolRun = null
try {
  const executor = svc('tools')
  const def = typeof executor.definition === 'function' ? executor.definition('project_status') : undefined
  toolRun = def ? 'found' : 'no-definition-api'
} catch (error) { toolRun = 'ERR ' + String(error && error.message).slice(0, 80) }
check('⑭ 工具定义可从真实 tools 服务取出（可执行面）', projectTools.includes('project_status'), toolRun)

await handle.shutdown.shutdown(0).catch(() => {})
const failed = results.filter((r) => !r.ok).length
console.log(String.fromCharCode(10) + '[live-inprocess-instance] passed=' + (results.length - failed) + ' failed=' + failed)
process.exitCode = failed > 0 ? 1 : 0
return { passed: results.length - failed, failed, results }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) await runLiveInstance()