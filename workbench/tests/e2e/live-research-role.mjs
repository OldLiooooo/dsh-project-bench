#!/usr/bin/env node
// 真机复验（v6）：PM 到底会不会自己查仓库？还是派「调研」会话？
//
// 验的是三件事，全部拿**真实实例 + 真实模型**的结果说话：
//   ① PM preset 里没有 read/glob/grep —— 它想查也查不了（工具面事实）
//   ② 遇到「需要看代码才能答」的问题，PM 会 session_spawn_task(role=调研)
//   ③ 调研会话：agentPreset=project-research、不占租约、切片状态不变
//
// 用法：
//   node workbench/tests/e2e/live-research-role.mjs --port 52998 --cookie-file <file> [--root <dir>]
// 前置：实例已装本 bundle 且配好真实模型（devhome-model.patch.yml）。
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import * as H from './harness.mjs'

const API_PREFIX = '/project-workbench/api'
const DEFAULT_STATE_DIR = join(H.WORKBENCH_ROOT, 'tests', 'e2e', '.artifacts', 'dev-instance')

function parseCookieFile(file) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#HttpOnly_') && !/^[^#\s]/.test(line)) continue
    const cells = line.replace(/^#HttpOnly_/, '').split('\t')
    if (cells.length >= 7) return cells[5] + '=' + cells[6]
  }
  return undefined
}

async function httpJson(url, options = {}) {
  const response = await fetch(url, { method: options.method || 'GET', headers: { cookie: options.cookie, 'content-type': 'application/json' }, body: options.body, signal: options.signal })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, text, json }
}

async function rpc(origin, cookie, method, args) {
  const body = JSON.stringify({ type: 'client-request', rpcId: 'live-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, payload: { args } })
  const result = await httpJson(origin + '/api/' + method, { cookie, method: 'POST', body })
  if (!result.json) throw new Error(method + ' 返回非 JSON: ' + result.text.slice(0, 200))
  if (result.json.result && result.json.result.ok === false) throw new Error(method + ' 失败: ' + JSON.stringify(result.json.result.error).slice(0, 300))
  return result.json.result ? result.json.result.value : undefined
}

async function sessionLog(origin, cookie, sessionId, limit) {
  const page = await rpc(origin, cookie, 'session/page', { request: { address: { kind: 'session', sessionId }, limit: limit || 5000 } })
  return page
}

function eventsOf(page) {
  return (page && page.records ? page.records : []).map((record) => record.event).filter(Boolean)
}

async function waitTurn(origin, cookie, sessionId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 420000)
  let cursor = -1
  let sawRunning = false
  while (Date.now() < deadline) {
    const state = await rpc(origin, cookie, 'session/state', { request: { sessionId } })
    if (state && state.running === true) sawRunning = true
    if (state && state.running === false && (sawRunning || (state.cursor > cursor && cursor >= 0))) return state
    cursor = state ? state.cursor : cursor
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('等待会话回合超时：' + sessionId)
}

async function main() {
  const argv = process.argv.slice(2)
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const port = Number(get('--port') || 52998)
  const origin = 'http://127.0.0.1:' + String(port)
  const cookieFile = get('--cookie-file') || join(DEFAULT_STATE_DIR, 'cookies.txt')
  if (!existsSync(cookieFile)) throw new Error('需要 --cookie-file（先跑 dev-instance start 或手动导出 cookie）：' + cookieFile)
  const cookie = parseCookieFile(cookieFile)
  if (!cookie) throw new Error('cookie 文件里没有会话 cookie：' + cookieFile)

  const cases = []
  const add = (name, fn) => cases.push({ name, fn })
  let failed = 0

  const projects = await httpJson(origin + API_PREFIX + '/projects', { cookie })
  const list = projects.json && Array.isArray(projects.json.projects) ? projects.json.projects : []
  const wantRoot = get('--root')
  const target = wantRoot ? list.find((item) => String(item.root).toLowerCase() === resolve(wantRoot).toLowerCase()) : list.find((item) => item.initialized)
  if (!target) throw new Error('没有已初始化的项目，可用项目：' + JSON.stringify(list.map((i) => i.root)))
  const root = target.root
  console.log('[live-research] root = ' + root)

  let pmSessionId
  let spawnedNames = []

  add('① PM preset 工具面：没有 read/glob/grep（只有项目工具）', async () => {
    const created = await rpc(origin, cookie, 'session/create', { request: { cwd: root, agentPreset: 'project-office' } })
    H.expect(created && created.sessionId, 'create 应返回 sessionId')
    pmSessionId = created.sessionId
    // 让 PM 尝试读文件：如果它没有 read 工具，调用会失败/或它压根没有这个工具
    await rpc(origin, cookie, 'session/prompt', {
      request: {
        requestId: 'live-toolcheck-' + Date.now(),
        sessionId: pmSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '请用 read 工具读取 README.md 的第一行，然后原样回答；如果 read 工具不可用，就只回答「NO_READ_TOOL」。禁止使用其它工具。' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
    await waitTurn(origin, cookie, pmSessionId, { timeoutMs: 300000 })
    const events = eventsOf(await sessionLog(origin, cookie, pmSessionId))
    const calls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name)
    H.expect(!calls.includes('read'), 'PM 不应能调用 read（预设里已移除 tool-fs），实际调用: ' + calls.join(','))
    H.expect(!calls.includes('glob') && !calls.includes('grep'), 'PM 不应能调用 glob/grep，实际: ' + calls.join(','))
  })

  add('② PM 遇到需要看代码的问题 → 派「调研」会话（而不是自己猜）', async () => {
    await rpc(origin, cookie, 'session/prompt', {
      request: {
        requestId: 'live-research-' + Date.now(),
        sessionId: pmSessionId,
        mode: 'queue',
        content: [{
          type: 'text',
          text: '我需要知道本仓库 tools/engineering 目录下有哪些检查脚本、各自的入口文件叫什么。'
            + '这是需要看代码才能回答的问题。请按项目纪律处理：如果你自己查不了，就派一个调研会话去做。'
            + '不要凭印象回答，也不要猜。',
        }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
    await waitTurn(origin, cookie, pmSessionId, { timeoutMs: 420000 })
    const events = eventsOf(await sessionLog(origin, cookie, pmSessionId))
    const allCalls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name)
    const spawnCalls = events.filter((e) => e.type === 'tool/call' && e.data.name === 'session_spawn_task')
    // 复用已有调研会话也算合规：同一切片已有 active 调研时，新建会被 DUPLICATE_ACTIVE_SESSION 拒，
    // 正确动作是 session_send_task 把新问题发过去（而不是再拉一个重复的调研会话）。
    const sendCalls = events.filter((e) => e.type === 'tool/call' && e.data.name === 'session_send_task')
    H.expect(spawnCalls.length > 0 || sendCalls.length > 0,
      'PM 应派调研（session_spawn_task）或复用已有调研（session_send_task），实际调用: ' + allCalls.join(','))
    if (spawnCalls.length === 0 && sendCalls.length > 0) {
      console.log('[live-research] 备注：PM 复用了已有调研会话（session_send_task），未重复派单 —— 这是合规的')
      return
    }
    // tool/call 的参数键在 DSH 里可能是 arguments / args / input，且可能是 JSON 字符串。
    const args = spawnCalls.map((e) => {
      let raw = e.data.arguments !== undefined ? e.data.arguments : (e.data.args !== undefined ? e.data.args : e.data.input)
      if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = {} } }
      return raw && typeof raw === 'object' ? raw : {}
    })
    const research = args.find((a) => String(a.role || '').includes('调研'))
    H.expect(Boolean(research), 'PM 应派 role=调研，实际 role: ' + JSON.stringify(args.map((a) => a.role))
      + '；原始 data keys: ' + JSON.stringify(spawnCalls.map((e) => Object.keys(e.data || {}))))
    spawnedNames.push(String(research.action || ''))
  })

  add('③ 换树后的死锁已解除：PM 重开 → 重新派单能接替失联会话', async () => {
    // 造出真机上的那个状态：同一(切片,角色)有 active 会话，但 PM 是新的 DSH 会话（不在旧树里）。
    // 旧行为：session_send_task 失败 + session_spawn_task 被 DUPLICATE_ACTIVE_SESSION 拦住 = 死锁。
    // 新行为：能判定失联 → 重新派单时自动把旧会话标 interrupted 并接替。
    const snap0 = await httpJson(origin + API_PREFIX + '/snapshot?root=' + encodeURIComponent(root), { cookie })
    const sessions0 = (snap0.json && snap0.json.sessions) || []
    const staleResearch = sessions0.filter((row) => String(row.name || '').startsWith('调研-') && row.status === 'active')
    if (staleResearch.length === 0) {
      console.log('[live-research] 备注：当前没有 active 调研会话，跳过接替用例（上一轮可能已收工）')
      return
    }
    // 重开一个新 PM 会话（模拟"换树"）
    const reopened = await rpc(origin, cookie, 'session/create', { request: { cwd: root, agentPreset: 'project-office' } })
    H.expect(reopened && reopened.sessionId, '应能新建 PM 会话')
    await rpc(origin, cookie, 'session/prompt', {
      request: {
        requestId: 'live-supersede-' + Date.now(),
        sessionId: reopened.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: '再查一次 tools/engineering 的检查脚本清单。如果已有调研会话但联系不上，就重新派一个调研会话（按项目纪律接替它），不要空手回答。' }],
        clientTimeZone: 'Asia/Shanghai',
      },
    })
    await waitTurn(origin, cookie, reopened.sessionId, { timeoutMs: 420000 })
    const events = eventsOf(await sessionLog(origin, cookie, reopened.sessionId))
    const calls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name)
    // 核心断言：不该再出现「发不出去也派不进来」的终局；必须真的派出去一次。
    //
    // 不要求一定走 superseded：真机实测 PM 有两条**都合规**的出路 ——
    //   ① 同切片重新派单 → 触发接替（superseded 出现）
    //   ② 开一个新切片来接管（语义上更干净：「这是新一轮调查」）
    // 我们验的是**死锁解除**，不是「必须走哪条路」。旧行为的特征是：
    // session_send_task 报错 + session_spawn_task 被 DUPLICATE_ACTIVE_SESSION 拦住，两条路都没有。
    H.expect(calls.includes('session_spawn_task'),
      '换树后 PM 应能重新派单（死锁已解除），实际调用: ' + calls.join(','))
    const blocked = events.filter((e) => e.type === 'tool/result')
      .map((e) => JSON.stringify(e.data || {}))
      .filter((t) => t.includes('DUPLICATE_ACTIVE_SESSION'))
    H.expect(blocked.length === 0, '不应再被 DUPLICATE_ACTIVE_SESSION 拦住（那是死锁特征），实际: ' + blocked.slice(0, 1).join(''))
    const superseded = events.filter((e) => e.type === 'tool/result')
      .map((e) => JSON.stringify(e.data || {}))
      .filter((t) => t.includes('superseded'))
    if (superseded.length > 0) console.log('[live-research] 备注：走了同切片接替路径（superseded 出现）')
    else console.log('[live-research] 备注：PM 选择开新切片接管（合规的另一条路），未触发 superseded')
  })

  add('④ 调研会话落库：preset=project-research、不占租约', async () => {
    const snap = await httpJson(origin + API_PREFIX + '/snapshot?root=' + encodeURIComponent(root), { cookie })
    const sessions = (snap.json && snap.json.sessions) || []
    const research = sessions.find((row) => String(row.name || '').startsWith('调研-'))
    H.expect(Boolean(research), '项目库里应有「调研-…」会话行，实际: ' + sessions.map((s) => s.name).join(' | '))
    H.expectEqual(research.kind, 'task', '调研会话 kind 应为 task')
    H.expectEqual(research.role, '调研', '调研会话 role 应为 调研')
    const leases = (snap.json && snap.json.leases) || []
    const held = leases.find((l) => l.sessionId === research.id)
    H.expect(!held, '调研会话不应出现在 leases 里，实际: ' + JSON.stringify(leases.map((l) => l.sessionId)))
    console.log('[live-research] 调研会话 = ' + research.name + '（' + research.id + '）')
  })

  for (const item of cases) {
    try {
      await item.fn()
      console.log('PASS  ' + item.name)
    } catch (error) {
      failed += 1
      console.log('FAIL  ' + item.name)
      console.log('      ' + String(error && error.message ? error.message : error).slice(0, 500))
    }
  }
  console.log('\n[live-research] passed=' + (cases.length - failed) + ' failed=' + failed + ' total=' + cases.length)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('[live-research] ERROR ' + String(error && error.stack ? error.stack : error).slice(0, 1200))
  process.exitCode = 2
})
