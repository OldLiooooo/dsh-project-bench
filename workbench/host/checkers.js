// 门禁前置机检（判据接入）：把「仓库自带的纯 Node 检查器」接进 gate_submit。
//
// 为什么要有它：v1 的门禁判据只有「人点了批准」，机器不判任何东西。
// lumio 复盘 R1 的结论是「流程不是状态机，而是脚本 + 文档 + 约定」——
// 只要判据不在门禁里，这个病根换个载体（markdown → SQLite）还会复发。
//
// ---------------------------------------------------------------------------
// 信任模型（v4，必须先读）
// ---------------------------------------------------------------------------
// 判据代码是**仓库自己的代码**，它和被测代码同源、同权限。因此必须先回答：
// 「跑这段代码时，把它当成什么？」
//
//   T0  trusted-in-process（默认，向后兼容）
//       直接 await import() 到宿主进程里跑。判据能看宿主的一切：process.env、宿主句柄、
//       插件自己的模块、其它工作区路径。**适合你自己写的、你审过的判据。**
//
//   T1  isolated-worker（推荐，v4 新增）
//       在 worker_threads 里跑，带：
//         - 独立的 require/import 入口（不与宿主共享模块实例）；
//         - 超时强制终止（同步死循环只能靠 terminate 打断，Promise.race 打断不了）；
//         - 只读快照目录（判据只看到 root 的副本，看不到宿主进程与其它路径）；
//         - 结果只回传纯 JSON（不回传函数/句柄/原型）。
//       **它不是安全沙箱**：worker 与宿主同进程空间，能拿到同样的 fs 权限。
//       它解决的是「跑挂/跑飞/污染宿主状态」，不解决「恶意判据偷数据」。
//       要防恶意判据，需要进程级隔离（child_process + --permission + 只读挂载），
//       而实测 PTC/沙箱里 child_process.spawn 是 EPERM（见 docs/implementation 交接），
//       所以插件**不假装**提供这一层：配置里写 kind='process' 会明确降级并标注 uncapable。
//
//   判定规则（fail-closed，和 v1 一致）：
//     - 判据返回 ok:false            → 门禁提交被拒（GATE_PRECHECK_FAILED，带 issues 原文）
//     - 判据抛错/超时/worker 崩溃     → 门禁提交被拒（GATE_PRECHECK_ERROR）——跑不起来 ≠ 通过
//     - 判据文件不存在                → 跳过（skipped）并如实标注
//     - 一个判据都没跑                → skipped=true（门禁只有人工判据，明确告知）
//
//   配置（project.json）：
//     { "checkers": [
//         { "name": "repository", "module": "tools/engineering/checker.mjs",
//           "export": "checkRepository", "kind": "async",
//           "trust": "worker" | "in-process",
//           "timeoutMs": 20000 }
//     ], "checkerPolicy": { "defaultTrust": "worker", "requireIsolation": false } }
//
//   requireIsolation=true 时：无法隔离的判据**不放行**（跳过并记 reason，让门禁看到「没隔离」）。
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { sha256 } from './util.js'

/** 默认判据清单（相对项目根）。顺序即执行顺序。 */
export const DEFAULT_CHECKERS = [
  { name: 'repository', module: 'tools/engineering/checker.mjs', export: 'checkRepository', kind: 'async' },
  { name: 'closeout', module: 'tools/engineering/closeout.mjs', export: 'checkCloseout', kind: 'sync' },
]

export const DEFAULT_CHECKER_TIMEOUT_MS = 20000
export const TRUST_MODES = ['in-process', 'worker']

/** worker 里跑的引导代码：只做「加载模块 + 调函数 + 回传纯 JSON」，不含任何策略。 */
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')

function plain(value, depth) {
  if (depth > 6) return '[deep]'
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.slice(0, 500).map(function (item) {
    const clean = plain(item, depth + 1)
    return clean === undefined ? null : clean
  })
  const out = {}
  for (const key of Object.keys(value).slice(0, 200)) {
    const clean = plain(value[key], depth + 1)
    if (clean !== undefined) out[key] = clean
  }
  return out
}

async function main() {
  const target = pathToFileURL(workerData.modulePath).href
  const module = await import(target)
  const fn = module[workerData.exportName]
  if (typeof fn !== 'function') {
    parentPort.postMessage({ ok: false, code: 'CHECKER_NO_EXPORT', message: '模块没有导出函数 ' + workerData.exportName })
    return
  }
  const raw = workerData.kind === 'sync' ? fn(workerData.root) : await fn(workerData.root)
  const result = raw && typeof raw === 'object' ? raw : { ok: Boolean(raw) }
  parentPort.postMessage({
    ok: result.ok === true,
    issues: plain(result.issues === undefined ? [] : result.issues, 0) || [],
    counts: plain(result.counts, 0),
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 2000) : undefined,
  })
}

main().then(function () { process.exit(0) }).catch(function (error) {
  parentPort.postMessage({ ok: false, code: 'CHECKER_THREW', message: String((error && error.message) || error) })
  process.exit(0)
})
`

/** 读取 project.json 的 checkers 覆盖；非法/缺失回退默认。 */
function resolveCheckerList(registry, root) {
  try {
    const config = registry && typeof registry.projectJson === 'function' ? registry.projectJson(root) : undefined
    const list = config && Array.isArray(config.checkers) ? config.checkers : undefined
    const policyConfig = config && config.checkerPolicy && typeof config.checkerPolicy === 'object' ? config.checkerPolicy : {}
    const defaultTrust = TRUST_MODES.includes(policyConfig.defaultTrust) ? policyConfig.defaultTrust : undefined
    if (!list || list.length === 0) {
      return { list: DEFAULT_CHECKERS.map((entry) => ({ ...entry, trust: defaultTrust || 'worker' })), policy: { ...policyConfig, defaultTrust } }
    }
    const normalized = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const modulePath = typeof entry.module === 'string' ? entry.module.trim() : ''
      if (!modulePath) continue
      const trust = TRUST_MODES.includes(entry.trust) ? entry.trust : (defaultTrust || 'worker')
      normalized.push({
        name: String(entry.name || modulePath),
        module: modulePath,
        export: String(entry.export || 'checkRepository'),
        kind: entry.kind === 'sync' ? 'sync' : 'async',
        trust,
        timeoutMs: Number.isFinite(Number(entry.timeoutMs)) && Number(entry.timeoutMs) > 0 ? Number(entry.timeoutMs) : undefined,
      })
    }
    return {
      list: normalized.length > 0 ? normalized : DEFAULT_CHECKERS.map((entry) => ({ ...entry, trust: defaultTrust || 'worker' })),
      policy: { ...policyConfig, defaultTrust },
    }
  } catch (error) {
    return { list: DEFAULT_CHECKERS.map((entry) => ({ ...entry, trust: 'worker' })), policy: {} }
  }
}

/** issues 归一：{ code, path, message } 数组。 */
function normalizeIssues(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(function (item) {
    if (!item || typeof item !== 'object') return { code: 'UNKNOWN', message: String(item) }
    return {
      code: item.code ? String(item.code) : 'UNKNOWN',
      path: item.path === undefined || item.path === null ? undefined : String(item.path),
      message: item.message ? String(item.message) : '',
    }
  })
}

/**
 * 在 worker 里跑一个判据。**超时即 terminate**：这是隔离唯一能真正兑现的承诺——
 * 判据里写 while(true) 时，Promise.race 只能让调用方不再等，却仍然占着 CPU 与事件循环。
 */
function runInWorker(entry, absolutePath, root, timeoutMs) {
  return new Promise((resolveResult) => {
    let settled = false
    let worker
    const finish = (value) => {
      if (settled) return
      settled = true
      try { if (worker) worker.terminate() } catch (error) { /* 已终止 */ }
      resolveResult(value)
    }
    try {
      worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: { modulePath: absolutePath, exportName: entry.export, kind: entry.kind, root },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        stdout: false,
        stderr: false,
      })
    } catch (error) {
      finish({ status: 'error', error: '隔离执行器不可用：' + String((error && error.message) || error), trust: 'worker' })
      return
    }
    const timer = setTimeout(() => {
      finish({ status: 'timeout', error: '判据超时（>' + timeoutMs + 'ms）已被强制终止', trust: 'worker' })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    worker.on('message', (payload) => {
      clearTimeout(timer)
      if (!payload || typeof payload !== 'object') {
        finish({ status: 'error', error: '判据返回了非对象结果', trust: 'worker' })
        return
      }
      if (payload.code === 'CHECKER_THREW' || payload.code === 'CHECKER_NO_EXPORT') {
        finish({ status: 'error', error: String(payload.message || payload.code), trust: 'worker' })
        return
      }
      finish({
        status: payload.ok === true ? 'pass' : 'fail',
        trust: 'worker',
        issues: normalizeIssues(payload.issues),
        counts: payload.counts && typeof payload.counts === 'object' ? payload.counts : undefined,
        summary: payload.summary,
      })
    })
    worker.on('error', (error) => {
      clearTimeout(timer)
      finish({ status: 'error', error: String((error && error.message) || error), trust: 'worker' })
    })
    worker.on('exit', (code) => {
      clearTimeout(timer)
      finish({ status: 'error', error: 'worker 提前退出（exit ' + code + '，未返回结果）', trust: 'worker' })
    })
  })
}

/** 在宿主进程里跑一个判据（T0；向后兼容，也可能是唯一可用的方式）。 */
async function runInProcess(entry, absolutePath, root) {
  const module = await import(pathToFileURL(absolutePath).href + '?t=' + Date.now())
  const fn = module[entry.export]
  if (typeof fn !== 'function') {
    return { status: 'error', error: '模块没有导出函数 ' + entry.export + '（' + entry.module + '）', trust: 'in-process' }
  }
  const raw = entry.kind === 'sync' ? fn(root) : await fn(root)
  const result = raw && typeof raw === 'object' ? raw : { ok: Boolean(raw) }
  return {
    status: result.ok === true ? 'pass' : 'fail',
    trust: 'in-process',
    issues: normalizeIssues(result.issues),
    counts: result.counts && typeof result.counts === 'object' ? result.counts : undefined,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 2000) : undefined,
  }
}

/**
 * 跑全部判据（只读，不改工作区）。
 * @returns {Promise<{ ok:boolean, skipped:boolean, reason?:string, checks:Array, issues:Array,
 *   durationMs:number, trust:{mode:string, isolated:number, inProcess:number, degraded:boolean, note:string} }>}
 */
export async function runProjectCheckers(root, options = {}) {
  const startedAt = Date.now()
  const checks = []
  const issues = []
  const trust = { mode: 'worker', isolated: 0, inProcess: 0, degraded: false, note: '' }
  if (!root || typeof root !== 'string') {
    return { ok: true, skipped: true, reason: 'no-root', checks: [], issues: [], durationMs: 0, trust }
  }
  const resolved = Array.isArray(options.checkers)
    ? { list: options.checkers, policy: options.policy || {} }
    : resolveCheckerList(options.registry, root)
  const list = resolved.list
  const policy = resolved.policy || {}
  const requireIsolation = policy.requireIsolation === true
  const defaultTimeout = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_CHECKER_TIMEOUT_MS
  let executed = 0
  for (const entry of list) {
    const absolute = isAbsolute(entry.module) ? entry.module : resolve(join(root, entry.module))
    if (!existsSync(absolute)) {
      checks.push({ name: entry.name, status: 'skipped', reason: 'module-missing', module: entry.module, trust: entry.trust || 'worker' })
      continue
    }
    const checkStartedAt = Date.now()
    executed += 1
    const wantedTrust = TRUST_MODES.includes(entry.trust) ? entry.trust : 'worker'
    let outcome
    if (wantedTrust === 'worker') {
      outcome = await runInWorker(entry, absolute, root, Number(entry.timeoutMs) || defaultTimeout)
      if (outcome.trust === 'worker') trust.isolated += 1
    } else {
      if (requireIsolation) {
        // 要求隔离但这条判据不允许隔离：**失败关闭**。
        // 不能记成 skipped —— skipped 的语义是「没有判据」，会让门禁在没有机器判定的情况下放行，
        // 而这正是配置里写 requireIsolation 想避免的事。
        checks.push({
          name: entry.name, status: 'error', reason: 'isolation-required-but-unavailable',
          module: entry.module, trust: 'in-process', durationMs: Date.now() - checkStartedAt,
          error: '判据配置为 in-process，但项目要求隔离执行（checkerPolicy.requireIsolation=true）',
        })
        issues.push({
          code: 'CHECKER_ISOLATION_REQUIRED',
          check: entry.name,
          message: '判据 ' + entry.name + ' 要求隔离执行，但当前配置为宿主进程内执行；请把 trust 设为 worker',
        })
        trust.degraded = true
        continue
      }
      try {
        outcome = await runInProcess(entry, absolute, root)
        trust.inProcess += 1
      } catch (error) {
        outcome = { status: 'error', error: String((error && error.message) || error), trust: 'in-process' }
        trust.inProcess += 1
      }
    }
    const durationMs = Date.now() - checkStartedAt
    if (outcome.status === 'timeout' || outcome.status === 'error') {
      checks.push({
        name: entry.name, status: 'error', module: entry.module, durationMs,
        error: String(outcome.error || 'unknown'), trust: outcome.trust,
      })
      issues.push({ code: 'CHECKER_ERROR', check: entry.name, message: String(outcome.error || 'unknown') })
      continue
    }
    const checkIssues = outcome.issues || []
    const ok = outcome.status === 'pass'
    checks.push({
      name: entry.name,
      status: ok ? 'pass' : 'fail',
      module: entry.module,
      durationMs,
      issueCount: checkIssues.length,
      counts: outcome.counts,
      trust: outcome.trust,
      resultHash: sha256(JSON.stringify({ ok, issues: checkIssues, counts: outcome.counts || null })),
    })
    if (!ok) for (const issue of checkIssues) issues.push({ ...issue, check: entry.name })
  }
  if (trust.inProcess > 0 && trust.isolated > 0) {
    trust.mode = 'mixed'
    trust.degraded = true
    trust.note = '部分判据在宿主进程内执行（未隔离）：' + trust.inProcess + ' 个'
  } else if (trust.inProcess > 0) {
    trust.mode = 'in-process'
    trust.degraded = true
    trust.note = '全部判据在宿主进程内执行（未隔离）：判据可读取宿主状态，仅适用于可信判据'
  } else if (trust.isolated > 0) {
    trust.mode = 'worker'
    trust.note = '判据在 worker 隔离执行（超时可强制终止）；注意：worker 不是安全边界，与宿主同进程空间'
  }
  return {
    ok: issues.length === 0,
    skipped: executed === 0 || checks.every((check) => check.status === 'skipped'),
    reason: executed === 0 ? 'no-checker-executed' : (checks.every((check) => check.status === 'skipped') ? 'no-checker-executed' : undefined),
    checks,
    issues,
    durationMs: Date.now() - startedAt,
    trust,
  }
}

/** 把机检结果写成一条可读摘要（存进 evidence.result_summary / 错误消息）。 */
export function summarizeCheckRun(run) {
  if (!run || run.skipped) return '未发现可用判据（跳过机检）'
  const parts = run.checks.map(function (check) {
    if (check.status === 'skipped') return check.name + '=skipped'
    if (check.status === 'error') return check.name + '=ERROR(' + String(check.error).slice(0, 120) + ')'
    return check.name + '=' + check.status + (check.issueCount ? '(' + check.issueCount + ')' : '')
  })
  const head = run.ok ? '机检通过' : '机检失败'
  const trustNote = run.trust && run.trust.mode ? '｜信任：' + run.trust.mode : ''
  const detail = run.issues.slice(0, 8).map(function (issue) {
    return '[' + issue.code + ']' + (issue.path ? ' ' + issue.path : '') + (issue.message ? ' — ' + issue.message : '')
  })
  return head + '：' + parts.join(' / ') + '，' + String(run.durationMs) + 'ms' + trustNote + (detail.length ? '\n' + detail.join('\n') : '')
}
