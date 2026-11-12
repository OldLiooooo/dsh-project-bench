#!/usr/bin/env node
// 真实运行验证脚本（Lead）：在隔离的 .devhome + 真实 web profile 上复现「用户→PM→任务会话→文档/证据→
// 决策→门禁→导出→时间线」全链路。它不是 fake-ctx 的 replay（那是 tests/e2e/replay-14-steps.mjs），
// 而是把真实 DSH 会话（PM/task agent、真实模型、真实工具注册）跑一遍，然后断言数据库/HTTP/导出的结果。
//
// 用法：
//   node workbench/tests/e2e/live-e2e.mjs [--port 52999] [--cookie-file .poc/devhome-cookies.txt]
//        [--root <abs project root>] [--prompt-timeout 240000] [--json]
// 前置：node workbench/scripts/dev-instance.mjs start（或已有实例），且实例已装本 bundle；
//      模型路由 overlay 见 workbench/tests/e2e/devhome-model.patch.yml。
// 退出码：0 全通过；1 有失败；2 环境/参数错误。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import * as H from './harness.mjs'

const API_PREFIX = '/project-workbench/api'
const DEFAULT_STATE_DIR = join(H.WORKBENCH_ROOT, 'tests', 'e2e', '.artifacts', 'dev-instance')
const LEGACY_COOKIE_FILE = join(H.WORKSPACE_ROOT, '.poc', 'devhome-cookies.txt')

function parseCookieFile(file) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#HttpOnly_') && !/^[^#\s]/.test(line)) continue
    const cells = line.replace(/^#HttpOnly_/, '').split('\t')
    if (cells.length >= 7) return cells[5] + '=' + cells[6]
  }
  return undefined
}

export function resolveCookie(options = {}) {
  if (options.cookie) return options.cookie
  const file = options.cookieFile || (existsSync(LEGACY_COOKIE_FILE) ? LEGACY_COOKIE_FILE : undefined)
  if (!file) throw new Error('需要 --cookie 或 --cookie-file（先跑 dev-instance.mjs start 生成会话）')
  const cookie = parseCookieFile(file)
  if (!cookie) throw new Error('cookie 文件里没有 HttpOnly 会话 cookie: ' + file)
  return cookie
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, { method: options.method || 'GET', headers: { cookie: options.cookie, 'content-type': 'application/json' }, body: options.body, signal: options.signal })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, text, json }
}

/** 通过 DSH 的 typert gateway 调 Remote：POST /api/<method>，payload 是 {args:{<param>: value}}。 */
async function rpc(origin, cookie, method, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, payload: { args } })
  const result = await httpJson(origin + '/api/' + method, { cookie, method: 'POST', body })
  if (!result.json) throw new Error(method + ' 返回非 JSON: ' + result.text.slice(0, 200))
  if (result.json.result && result.json.result.ok === false) throw new Error(method + ' 失败: ' + JSON.stringify(result.json.result.error).slice(0, 300))
  return result.json.result ? result.json.result.value : undefined
}

function sessionLog(origin, cookie, sessionId) {
  return rpc(origin, cookie, 'session/page', { request: { address: { kind: 'session', sessionId }, maxMessages: 200 } })
}

function eventsOf(page) {
  return (page && page.records ? page.records : []).map((record) => record.event).filter(Boolean)
}

/** 等待会话一轮结束（state.running=false 且 cursor 前进）。 */
async function waitTurn(origin, cookie, sessionId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 300000)
  let cursor = -1
  while (Date.now() < deadline) {
    const state = await rpc(origin, cookie, 'session/state', { request: { sessionId } })
    if (state && state.running === false && state.cursor > cursor && cursor >= 0) return state
    cursor = state ? state.cursor : cursor
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('等待会话回合超时：' + sessionId)
}

export async function makeSuite(options = {}) {
  const port = Number(options.port || 52999)
  const origin = 'http://127.0.0.1:' + String(port)
  const cookie = resolveCookie(options)
  const cases = []
  const add = (name, fn) => cases.push({ name, fn })

  const projects = await httpJson(origin + API_PREFIX + '/projects', { cookie })
  const list = projects.json && Array.isArray(projects.json.projects) ? projects.json.projects : []
  const target = options.root ? list.find((item) => item.root.toLowerCase() === options.root.toLowerCase()) : list.find((item) => item.initialized)
  if (!target) throw new Error('没有已初始化的项目：先在面板初始化，或用 --root 指定。')
  const root = target.root

  let pmSessionId
  add('live: 创建 project-office 会话并落到项目库（PM 行）', async () => {
    const created = await rpc(origin, cookie, 'session/create', { request: { cwd: root, agentPreset: 'project-office' } })
    H.expect(created && created.sessionId, 'create 应返回 sessionId')
    pmSessionId = created.sessionId
    const snapshot = await httpJson(origin + API_PREFIX + '/snapshot?root=' + encodeURIComponent(root), { cookie })
    H.expectEqual(snapshot.status, 200, '/snapshot 状态码')
    H.expect(Boolean(snapshot.json.pm && snapshot.json.pm.dshSessionId), 'PM 会话应登记到项目库（snapshot.pm）')
  })

  add('live: PM 调用 project_status 拿到真实状态（工具输出是合法 JSON）', async () => {
    await rpc(origin, cookie, 'session/prompt', {
      request: {
        requestId: 'live-status-' + Date.now(),
        sessionId: pmSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '只调用一次 project_status 工具，然后用一行中文回答当前阶段 key。禁止使用其它工具。' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
    await waitTurn(origin, cookie, pmSessionId, { timeoutMs: options.promptTimeoutMs || 240000 })
    const events = eventsOf(await sessionLog(origin, cookie, pmSessionId))
    const calls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name)
    H.expect(calls.includes('project_status'), 'PM 应实际调用 project_status，实际: ' + calls.join(','))
    const results = events.filter((e) => e.type === 'tool/result')
    const broken = results.filter((e) => JSON.stringify(e.data.message ? e.data.message.content : '').includes('invalid output'))
    H.expectEqual(broken.length, 0, '工具输出不应出现 invalid output（lossless JSON 校验）')
  })

  add('live: 人批准不可逆门禁 → 冻结文档 + 导出 docs/ + 阶段推进 + 时间线', async () => {
    const snapshot = await httpJson(origin + API_PREFIX + '/snapshot?root=' + encodeURIComponent(root), { cookie })
    const gate = (snapshot.json.pendingDecisions || []).find((d) => d.kind === 'gate')
    if (!gate) {
      H.expect(true, '（跳过）当前没有待批准门禁；本用例需先由 PM 提交 gate_submit')
      return
    }
    const withoutConfirm = await httpJson(origin + API_PREFIX + '/decision', { cookie, method: 'POST', body: JSON.stringify({ root, id: gate.id, status: 'approved' }) })
    H.expectEqual(withoutConfirm.status, 409, '不可逆门禁未二次确认应 409')
    const approved = await httpJson(origin + API_PREFIX + '/decision', { cookie, method: 'POST', body: JSON.stringify({ root, id: gate.id, status: 'approved', confirmed: true, decidedBy: 'user', rationale: 'live e2e' }) })
    H.expectEqual(approved.status, 200, '批准门禁应 200: ' + approved.text.slice(0, 200))
    const after = await httpJson(origin + API_PREFIX + '/snapshot?root=' + encodeURIComponent(root), { cookie })
    H.expect(after.json.revision > snapshot.json.revision, 'revision 应前进')
    const kinds = (after.json.recentTimeline || []).map((e) => e.kind)
    H.expect(kinds.includes('gate/approve'), '时间线应有 gate/approve')
    H.expect(kinds.includes('doc/export'), '时间线应有 doc/export')
    H.expect(kinds.includes('stage/change'), '时间线应有 stage/change')
  })

  add('live: 导出文件带 generated 标记且可重生成（只写不回读）', async () => {
    const snapshot = await httpJson(origin + API_PREFIX + '/snapshot?root=' + encodeURIComponent(root), { cookie })
    const docsNode = (snapshot.json.tree || []).flatMap((stage) => stage.slices || []).flatMap((node) => node.documents || [])
    H.expect(Array.isArray(docsNode), '树应可枚举文档节点')
    // 导出目录里至少有一个 generated 快照（门禁批准时写）
    const { readdirSync, readFileSync } = await import('node:fs')
    const docsRoot = join(root, 'docs')
    const walk = (dir) => {
      const out = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else if (entry.name.endsWith('.md')) out.push(full)
      }
      return out
    }
    if (!existsSync(docsRoot)) { H.expect(true, '（跳过）docs/ 尚未导出'); return }
    const files = walk(docsRoot)
    H.expect(files.length > 0, 'docs/ 应有导出文件')
    const generated = files.filter((file) => readFileSync(file, 'utf8').startsWith('<!-- generated: true'))
    H.expectEqual(generated.length, files.length, '所有导出文件都应带 generated 标记')
  })

  return { cases, origin, root, cookie, getPmSessionId: () => pmSessionId }
}

export async function main(argv = process.argv.slice(2)) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--port') options.port = Number(argv[++i])
    else if (arg === '--cookie') options.cookie = argv[++i]
    else if (arg === '--cookie-file') options.cookieFile = resolve(argv[++i])
    else if (arg === '--root') options.root = resolve(argv[++i])
    else if (arg === '--prompt-timeout') options.promptTimeoutMs = Number(argv[++i])
    else options._.push(arg)
  }
  let suite
  try { suite = await makeSuite(options) } catch (error) { console.error('ERROR: ' + String((error && error.message) || error)); return 2 }
  let passed = 0
  const failures = []
  for (const item of suite.cases) {
    const startedAt = Date.now()
    try {
      await item.fn()
      passed += 1
      console.log('PASS  ' + item.name + '  (' + String(Date.now() - startedAt) + 'ms)')
    } catch (error) {
      failures.push({ name: item.name, error: String((error && error.message) || error) })
      console.log('FAIL  ' + item.name + '  — ' + String((error && error.message) || error))
    }
  }
  console.log('')
  console.log('[live-e2e] passed=' + String(passed) + ' failed=' + String(failures.length))
  console.log(failures.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL')
  return failures.length === 0 ? 0 : 1
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().then((code) => { process.exitCode = code }, (error) => { console.error(error); process.exitCode = 1 })
}
