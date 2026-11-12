// T5 verify · 实例/安装脚本自测（不依赖真实 DSH 进程：用本地 fake HTTP 服务验证 token/cookie/健康/等待逻辑）。
// 运行：node --test workbench/tests/e2e/dev-instance.test.mjs
import test from 'node:test'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as H from './harness.mjs'

const isNodeTest = process.env.NODE_TEST_CONTEXT !== undefined
const BASE = 'C:/Users/oldap/Documents/dsh-porject-bench/'

/** 启动伪造的 DSH Web 实例（token→303+cookie，cookie→200 DSH 页面）。 */
export function startFakeInstance(options = {}) {
  const token = options.token || 'tok-test-1'
  const cookieValue = options.cookieValue || 'v1.fake-cookie'
  const page = options.page || '<!doctype html><html><script>globalThis["__DSH_CONTACT_CONFIG__"] = {}</script></html>'
  const server = createServer((req, res) => {
    let url
    try { url = new URL(req.url || '/', 'http://127.0.0.1') } catch { url = new URL('/', 'http://127.0.0.1') }
    if (url.pathname !== '/') { res.writeHead(404); res.end('not found'); return }
    if (url.searchParams.get('token') === token) {
      res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-fake=' + cookieValue + '; Path=/; HttpOnly' })
      res.end()
      return
    }
    if (String(req.headers.cookie || '').includes('dsh-auth-fake=' + cookieValue)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('dsh web authentication required')
  })
  return new Promise((resolveP, rejectP) => {
    server.once('error', rejectP)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolveP({ server, port, url: 'http://127.0.0.1:' + String(port) + '/?token=' + token, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

export async function makeSuite() {
  const D = await import('../../scripts/dev-instance.mjs')
  const I = await import('../../scripts/dev-install.mjs')
  const IH = await import('./instance-http.mjs')
  const cases = []
  const add = (name, fn) => cases.push({ name, fn })

  add('dev-instance: token→cookie 鉴权与健康检查', async () => {
    const fake = await startFakeInstance()
    try {
      const auth = await D.authenticate(fake.url)
      H.expectEqual(auth.cookie, 'dsh-auth-fake=v1.fake-cookie', 'authenticate 应拿到会话 cookie')
      H.expectEqual(auth.origin, 'http://127.0.0.1:' + String(fake.port), 'origin 应来自 token URL')
      const health = await D.checkHealth(fake.url)
      H.expectEqual(health.ok, true, '健康检查应通过')
      H.expectEqual(health.looksLikeDsh, true, '应识别 DSH 页面标记')
      H.expectEqual(health.status, 200, '首页状态码')
    } finally { await fake.close() }
  })

  add('dev-instance: 非 DSH 页面/无 token 判为不健康', async () => {
    const fake = await startFakeInstance({ page: '<html><body>hello</body></html>' })
    try {
      const health = await D.checkHealth(fake.url)
      H.expectEqual(health.ok, false, '无 DSH 标记应判为不健康')
      const badUrl = 'http://127.0.0.1:' + String(fake.port) + '/?token=wrong'
      let code
      try { await D.authenticate(badUrl) } catch (error) { code = error.code }
      H.expectEqual(code, 'AUTH_FAILED', '错误 token 应抛 AUTH_FAILED')
    } finally { await fake.close() }
  })

  add('dev-instance: 从启动日志解析带 token URL 并落地 state', async () => {
    const fake = await startFakeInstance()
    const stateDir = H.makeTempDir('inst-state')
    const logFile = D.pathsFor(stateDir).logFile
    const fs = await import('node:fs')
    fs.writeFileSync(logFile, 'booting...\ndsh web: ' + fake.url + '\nready\n', 'utf8')
    try {
      const url = await D.waitForUrl(stateDir, { timeoutMs: 3000 })
      H.expectEqual(url, fake.url, '应从日志解析 URL')
      H.expectEqual(D.readUrl(stateDir), fake.url, 'URL 应写入 state 目录')
      // status：构造 pid=当前进程的 state（健康检查走 fake 服务）
      fs.writeFileSync(D.pathsFor(stateDir).stateFile, JSON.stringify({ pid: process.pid, port: fake.port, home: join(stateDir, 'home'), startedAt: new Date().toISOString() }), 'utf8')
      const status = await D.statusInstance({ stateDir, port: fake.port })
      H.expectEqual(status.running, true, 'pid 存活应判 running')
      H.expectEqual(status.health && status.health.ok, true, 'status 健康检查应通过')
    } finally {
      const fs2 = await import('node:fs')
      try { fs2.rmSync(D.pathsFor(stateDir).stateFile, { force: true }) } catch { /* ignore */ }
      await fake.close()
    }
  })

  add('dev-instance: 启动前置校验与空 state 停止语义', async () => {
    const stateDir = H.makeTempDir('inst-empty')
    // 关键：本用例会调用 stopInstance，而它按端口结束监听进程；绝不能指向共享 dev 实例的 52999，
    // 否则测试会顺手杀掉正在运行的实例（之前的偶发失败就是这个原因）。这里用一个必然空闲的高位端口。
    const port = 53987
    H.expectEqual(D.listenerPids(port).length, 0, '测试端口应空闲（' + String(port) + '）')
    let code
    try {
      await D.startInstance({ exe: 'C:/definitely/missing/DeepSeek.exe', cli: 'C:/definitely/missing/cli.js', home: stateDir, stateDir, port })
    } catch (error) { code = error.code }
    H.expectEqual(code, 'ENV_MISSING', '可执行文件缺失应报 ENV_MISSING')
    const stopped = await D.stopInstance({ stateDir, port })
    H.expectEqual(stopped.status, 'not-running', '空 state 停止应为 not-running')
  })

  add('dev-install: bundle/profile 检查全部通过（隔离 devhome）', async () => {
    const devhome = join(H.WORKSPACE_ROOT, '.devhome')
    H.expect(existsSync(devhome), '工作区应有 .devhome（隔离实例 DSH_HOME）')
    const checks = I.collectChecks({ home: devhome, profile: 'web' })
    const failures = checks.filter((item) => !item.ok)
    H.expectEqual(failures.length, 0, '检查失败项: ' + failures.map((item) => item.name).join(', '))
    H.expect(checks.length >= 15, '检查项数量应 >=15，实际 ' + String(checks.length))
    H.expectEqual(I.main(['check', '--home', devhome, '--profile', 'web']), 0, 'check 退出码应为 0')
  })

  add('dev-install: desktop 保留 profile 拒绝 CLI 安装 + plan/instructions 正确', async () => {
    const plan = I.planInstall({ profile: 'desktop' })
    H.expectEqual(plan.reservedProfile, true, 'desktop 应标记为保留 profile')
    let code
    try { I.runInstall(plan) } catch (error) { code = error.code }
    H.expectEqual(code, 'RESERVED_PROFILE', 'desktop 安装应抛 RESERVED_PROFILE')
    const devPlan = I.planInstall({ profile: 'web' })
    H.expectEqual(devPlan.reservedProfile, false, 'web 不是保留 profile')
    H.expect(devPlan.install.args.includes('plugin') && devPlan.install.args.includes('add'), 'plan 应给出 plugin add 命令')
    const text = I.instructions()
    H.expect(text.includes('设置') && (text.includes('重新打开') || text.includes('重启')), '安装说明应包含 app 内设置与重启步骤')
    H.expectEqual(I.main(['instructions']), 0, 'instructions 退出码应为 0')
  })

  add('instance-http: cookie 文件解析与 target 解析', async () => {
    const cookieFile = join(H.WORKSPACE_ROOT, '.poc', 'devhome-cookies.txt')
    if (!existsSync(cookieFile)) return // 无历史 PoC cookie 时不强求
    const cookie = IH.parseCookieFile(cookieFile)
    H.expect(cookie && cookie.startsWith('dsh-auth-'), '应解析出 dsh-auth-* cookie，实际 ' + String(cookie).slice(0, 40))
    const target = await IH.resolveTarget({ cookieFile })
    H.expectEqual(target.source.indexOf('cookie-file:'), 0, '凭据来源应为 cookie-file')
    H.expect(target.origin.startsWith('http://127.0.0.1:'), 'origin 应为本机地址')
  })

  return cases
}

if (isNodeTest) {
  const cases = await makeSuite()
  for (const item of cases) test(item.name, item.fn)
} else if (H.isMain(import.meta.url)) {
  const cases = await makeSuite()
  const summary = await H.runCases('dev-instance.test', cases)
  H.cleanupTracked()
  process.exitCode = H.summaryExitCode(summary)
}