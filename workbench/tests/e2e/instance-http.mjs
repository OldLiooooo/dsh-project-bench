#!/usr/bin/env node
// T5 verify · 实例级 HTTP/SSE 验证（契约 §11.4；不依赖 headless 浏览器）。
// 对 52999 上的隔离实例做真实请求：页面/preload/client bundle、鉴权负向、/projects、/snapshot、/timeline、SSE。
//
// 用法：
//   node workbench/tests/e2e/instance-http.mjs [--port 52999] [--start] [--json] [--strict]
//        [--state-dir <dir>] [--home <dir>] [--cookie-file <.poc/devhome-cookies.txt>] [--cookie 'name=value']
//        [--root <abs project root>] [--sse-timeout 30000]
//
// 实例来源优先级：--cookie / --cookie-file > 本脚本管理的 state（dev-instance.mjs）> --start 启动新实例 >
// 自动回退到 .poc/devhome-cookies.txt 里保存的旧会话 cookie（外部已启动实例时）。
// 退出码：0 全部通过（strict 时无 pending）；1 有失败或 strict 下有 pending；2 环境/参数错误。
import { existsSync, readFileSync } from 'node:fs'
import { request as requestHttp } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import {
  authenticate, DEFAULT_PORT, DEFAULT_STATE_DIR, DEFAULT_HOME,
  startInstance, readUrl,
} from '../../scripts/dev-instance.mjs'
import * as H from './harness.mjs'
import { installBrowserStubs } from '../../scripts/check-syntax.mjs'

const API_PREFIX = '/project-workbench/api'
const LEGACY_COOKIE_FILE = join(H.WORKSPACE_ROOT, '.poc', 'devhome-cookies.txt')

export function parseCookieFile(file) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#HttpOnly_') && !/^[^#\s]/.test(line)) continue
    const cells = line.replace(/^#HttpOnly_/, '').split('\t')
    if (cells.length >= 7) return cells[5] + '=' + cells[6]
  }
  return undefined
}

function cookieHeader(name, value) {
  if (name === undefined) return value
  return name + '=' + value
}

/** 解析实例访问方式：{origin, cookie, launchUrl?, source}。 */
export async function resolveTarget(options = {}) {
  const port = Number(options.port || DEFAULT_PORT)
  const origin = 'http://127.0.0.1:' + String(port)
  if (options.cookie) return { origin, cookie: cookieHeader(options.cookieName, options.cookie), source: 'arg-cookie', port }
  if (options.cookieFile) {
    if (!existsSync(options.cookieFile)) throw new Error('cookie 文件不存在: ' + options.cookieFile)
    const cookie = parseCookieFile(options.cookieFile)
    if (!cookie) throw new Error('cookie 文件里没有可用的 HttpOnly cookie: ' + options.cookieFile)
    return { origin, cookie, source: 'cookie-file:' + options.cookieFile, port }
  }
  const url = readUrl(options.stateDir || DEFAULT_STATE_DIR)
  if (url) {
    const auth = await authenticate(url)
    return { origin: auth.origin, cookie: auth.cookie, launchUrl: url, source: 'managed-state', port: auth.origin ? Number(new URL(auth.origin).port) : port }
  }
  if (options.start) {
    const started = await startInstance({ port, home: options.home || DEFAULT_HOME, stateDir: options.stateDir || DEFAULT_STATE_DIR, timeoutMs: options.timeoutMs })
    if (started.url) {
      const auth = await authenticate(started.url)
      return { origin: auth.origin, cookie: auth.cookie, launchUrl: started.url, source: 'started', port }
    }
  }
  if (existsSync(LEGACY_COOKIE_FILE)) {
    const cookie = parseCookieFile(LEGACY_COOKIE_FILE)
    if (cookie) {
      const probe = await httpRequest(origin + '/', { headers: { cookie } })
      if (probe.status === 200 && probe.body.includes('__DSH_')) {
        return { origin, cookie, source: 'legacy-cookie-file:' + LEGACY_COOKIE_FILE, port }
      }
    }
  }
  throw new Error('找不到运行中的实例或可用凭据：先执行 node workbench/scripts/dev-instance.mjs start（或传 --cookie-file/--start）')
}

export function httpRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveP, rejectP) => {
    const req = requestHttp(url, { method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectP)
    req.setTimeout(30000, () => req.destroy(new Error('request timeout: ' + url)))
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

function jsonBody(response, fallback) {
  try { return JSON.parse(response.body) } catch { return fallback }
}

// SSE 读取统一使用 tests/e2e/harness.mjs 的 readSse（与路由级测试共用）。

export async function makeSuite(options = {}) {
  const target = await resolveTarget(options)
  const base = target.origin
  const authed = { cookie: target.cookie }
  const cases = []
  const add = (name, fn, extra = {}) => cases.push({ name, fn, ...extra })
  const pending = (reason) => ({ skip: reason })

  const index = await httpRequest(base + '/', { headers: authed })
  const hasBoot = index.body.includes('__DSH_CONTACT_CONFIG__') || index.body.includes('__DSH_BOOT__')
  const preloadHref = (() => {
    const match = /<link[^>]*href="([^"]*@local\/dsh-project-workbench\/client\.js[^"]*)"/.exec(index.body)
    return match ? match[1].replaceAll('&amp;', '&') : undefined
  })()

  add('实例: 首页带 cookie 200 且为 DSH 页面', async () => {
    H.expectEqual(index.status, 200, '首页状态码 (body=' + index.body.slice(0, 120) + ')')
    H.expect(hasBoot, '首页缺 DSH boot 标记')
  })

  add('实例: 页面 preload 含 @local/dsh-project-workbench/client.js', async () => {
    H.expect(preloadHref !== undefined, '页面 preload 中没有 workbench client bundle；检查插件是否安装/启用')
  })

  add('实例: 客户端 bundle 可取回且包含插件入口', async () => {
    H.expect(preloadHref !== undefined, '无 preload href')
    const bundle = await httpRequest(new URL(preloadHref, base + '/').href, { headers: authed })
    H.expectEqual(bundle.status, 200, 'client bundle 状态码')
    H.expect(bundle.body.includes('__ModuleLoader__'), 'bundle 应使用 __ModuleLoader__ 装载')
    H.expect(bundle.body.includes('@local/dsh-project-workbench'), 'bundle 应包含插件 id')
  })

  add('实例: 客户端 bundle 可被浏览器解析（无语法错误）', async () => {
    if (options.parseBundle === false) return
    H.expect(preloadHref !== undefined, '无 preload href')
    const bundle = await httpRequest(new URL(preloadHref, base + '/').href, { headers: authed })
    H.expectEqual(bundle.status, 200, 'client bundle 状态码')
    const captured = installBrowserStubs()
    try {
      const encoded = Buffer.from(bundle.body, 'utf8').toString('base64')
      await import('data:text/javascript;base64,' + encoded)
    } catch (error) {
      if (error && error.name === 'SyntaxError') throw new Error('client bundle 语法错误（浏览器将整包加载失败）: ' + error.message)
      throw new Error('client bundle 解析/顶层执行失败: ' + String((error && error.message) || error))
    }
    H.expect(captured.some((spec) => spec && String(spec.id || '').includes('project-workbench')), 'bundle 应注册 @local/dsh-project-workbench 模块')
  })

  // ---- 鉴权负向 ----
  const getPaths = [
    API_PREFIX + '/projects',
    API_PREFIX + '/snapshot?root=' + encodeURIComponent(base),
    API_PREFIX + '/slice?id=none',
    API_PREFIX + '/doc?id=none',
    API_PREFIX + '/timeline?root=' + encodeURIComponent(base),
    API_PREFIX + '/events?root=' + encodeURIComponent(base),
  ]
  add('auth: 无 cookie 访问全部 GET API → 401/403', async () => {
    for (const path of getPaths) {
      const response = await httpRequest(base + path)
      H.expect([401, 403].includes(response.status), path + ' 无 cookie 应 401/403，实际 ' + String(response.status))
    }
  })

  add('auth: 无 cookie POST /init 与 /decision → 401/403', async () => {
    for (const path of [API_PREFIX + '/init', API_PREFIX + '/decision']) {
      const response = await httpRequest(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      H.expect([401, 403].includes(response.status), path + ' 无 cookie 应 401/403，实际 ' + String(response.status))
    }
  })

  // ---- API 正向（http.js 落地后启用；未注册路由时整体 pending） ----
  const projectsResponse = await httpRequest(base + API_PREFIX + '/projects', { headers: authed })
  const apiRegistered = projectsResponse.status !== 404
  if (!apiRegistered) {
    add('api: GET /projects 200 且返回 projects 数组', async () => {}, pending('API 路由未注册：/projects 返回 ' + String(projectsResponse.status) + '。' +
      '若 http.js 已实现，说明实例仍是启动时加载的旧插件代码，需要重启：node workbench/scripts/dev-instance.mjs restart'))
    add('api: 未注册 root 的 /snapshot 返回 4xx JSON 错误', async () => {}, pending('API 路由尚未注册'))
    add('api: SSE /events 鉴权后建立 text/event-stream', async () => {}, pending('API 路由尚未注册'))
    add('api: 项目 snapshot/timeline/SSE 数据一致性', async () => {}, pending('API 路由尚未注册'))
  } else {
    add('api: GET /projects 200 且返回 projects 数组', async () => {
      H.expectEqual(projectsResponse.status, 200, '/projects 状态码: ' + projectsResponse.body.slice(0, 300))
      const payload = jsonBody(projectsResponse, {})
      H.expect(Array.isArray(payload.projects), '/projects 应返回 {projects:[]}: ' + JSON.stringify(payload).slice(0, 300))
    })

    add('api: 未注册 root 的 /snapshot 返回 4xx JSON 错误', async () => {
      const response = await httpRequest(base + API_PREFIX + '/snapshot?root=' + encodeURIComponent('C:/definitely/not/a/workspace'), { headers: authed })
      H.expect(response.status >= 400 && response.status < 500, '未注册 root 应 4xx，实际 ' + String(response.status))
      const payload = jsonBody(response, undefined)
      H.expect(payload && payload.error && payload.error.code, '错误响应应为 {error:{code,message}}: ' + response.body.slice(0, 300))
    })

    const projectsPayload = jsonBody(await httpRequest(base + API_PREFIX + '/projects', { headers: authed }), { projects: [] })
    const initializedProject = (projectsPayload.projects || []).find((item) => item.initialized && item.exists !== false)
    const noProjectReason = initializedProject ? undefined : '没有已初始化项目：先在 GUI 打开工作区并初始化，或在实例里 POST /init（本脚本不主动改实例数据）'

    add('api: SSE /events 鉴权后建立 text/event-stream', async () => {
      const sse = await H.readSse(base + API_PREFIX + '/events?root=' + encodeURIComponent(initializedProject.root), { cookie: target.cookie, timeoutMs: options.sseTimeoutMs || 30000 })
      H.expectEqual(sse.status, 200, 'SSE 状态码: ' + JSON.stringify(sse).slice(0, 300))
      H.expect(sse.contentType.includes('text/event-stream'), 'SSE content-type: ' + sse.contentType)
    }, noProjectReason ? pending(noProjectReason) : {})

    add('api: 项目 snapshot/timeline 一致且三问可答', async () => {
      const rootQuery = '?root=' + encodeURIComponent(initializedProject.root)
      const snapshot = await httpRequest(base + API_PREFIX + '/snapshot' + rootQuery, { headers: authed })
      H.expectEqual(snapshot.status, 200, '/snapshot 状态码: ' + snapshot.body.slice(0, 300))
      const payload = jsonBody(snapshot, {})
      H.expect(payload.project && payload.project.stage, 'snapshot 应含 project.stage')
      H.expect(Array.isArray(payload.stages), 'snapshot 应含 stages 数组')
      H.expect(payload.revision >= 0, 'snapshot 应含 revision')
      H.expect(payload.tree !== undefined, 'snapshot 应含 tree')
      const timeline = await httpRequest(base + API_PREFIX + '/timeline' + rootQuery + '&limit=20', { headers: authed })
      H.expectEqual(timeline.status, 200, '/timeline 状态码')
      const events = jsonBody(timeline, {})
      H.expect(Array.isArray(events.events), '/timeline 应返回 events 数组')
      // 三问：在做什么/依据/下一步（snapshot 的树 + 最近事件足以回答）。
      // project.stage 是阶段记录（{id,key,name,status,gate}）；也接受字符串键写法。
      const stageValue = payload.project.stage
      const stageLabel = typeof stageValue === 'string'
        ? stageValue
        : (stageValue && (stageValue.key || stageValue.name)) || ''
      H.expect(typeof stageLabel === 'string' && stageLabel.length > 0, '阶段可回答「在做什么」: ' + JSON.stringify(stageValue))
      H.expect(payload.revision >= 0 && (payload.recentTimeline === undefined || Array.isArray(payload.recentTimeline)), 'recentTimeline 可用于「依据」')
      H.expect(Array.isArray(payload.pendingDecisions), '待决策列表可回答「下一步」')
      H.expect(Array.isArray(payload.tree) && payload.tree.length > 0, '树的阶段分支可用于「下一步」导航')
    }, noProjectReason ? pending(noProjectReason) : {})
  }

  return { cases, target, index }
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--start') options.start = true
    else if (arg === '--port') options.port = Number(argv[++i])
    else if (arg === '--home') options.home = resolve(argv[++i])
    else if (arg === '--state-dir') options.stateDir = resolve(argv[++i])
    else if (arg === '--cookie-file') options.cookieFile = resolve(argv[++i])
    else if (arg === '--cookie') options.cookie = argv[++i]
    else if (arg === '--root') options.root = resolve(argv[++i])
    else if (arg === '--no-parse-bundle') options.parseBundle = false
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i])
    else if (arg === '--sse-timeout') options.sseTimeoutMs = Number(argv[++i])
    else options._.push(arg)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  try {
    const { cases, target } = await makeSuite(options)
    if (options.json) {
      const summary = await H.runCases('instance-http', cases, { quiet: true })
      const pendingCount = summary.skipped
      const failed = summary.failed + (options.strict ? pendingCount : 0)
      console.log(JSON.stringify({ target: { origin: target.origin, source: target.source }, strict: Boolean(options.strict), passed: summary.passed, failed: summary.failed, pending: pendingCount, results: summary.results }, null, 2))
      return failed > 0 ? 1 : 0
    }
    console.log('实例: ' + target.origin + '（凭据来源: ' + target.source + '）\n')
    const summary = await H.runCases('instance-http', cases, { quiet: false })
    const failed = summary.failed + (options.strict ? summary.skipped : 0)
    if (failed > 0) {
      console.log('\n实例验证失败：failed=' + String(summary.failed) + ' pending=' + String(summary.skipped) + (options.strict ? '（strict: pending 计为失败）' : ''))
      return 1
    }
    console.log('\n实例验证通过：passed=' + String(summary.passed) + ' pending=' + String(summary.skipped))
    return 0
  } catch (error) {
    if (options.json) console.log(JSON.stringify({ status: 'error', message: String(error && error.message) }, null, 2))
    else console.error('ERROR: ' + String(error && error.message))
    return 2
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) process.exitCode = await main(process.argv.slice(2))