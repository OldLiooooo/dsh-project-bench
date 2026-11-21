#!/usr/bin/env node
// 真实实例上的治理全链路（Round 3）：在进程内启动的真 DSH web 实例里，
// 通过**真实 HTTP + 真鉴权**完成一次完整的门禁治理，并验证插件在被宿主加载的状态下确实管事。
//
// 与 governance-e2e.mjs 的区别：那个直接调 host 模块（绕过宿主）；这个全走宿主：
// 真 ctx → 真 tools 服务 → 真 HTTP 路由 → 真 cookie 鉴权 → 真 workspaceRegistry 准入。
//
// 用法：node workbench/tests/e2e/live-governance-http.mjs [--port 53140]
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdirSync, existsSync } from 'node:fs'
import { readFile, writeFile, symlink, rm, readdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import http from 'node:http'
import process from 'node:process'

const HERE = import.meta.dirname
const WORKBENCH_ROOT = join(HERE, '..', '..')
const WORKSPACE_ROOT = join(WORKBENCH_ROOT, '..')
const ARTIFACTS = join(HERE, '.artifacts', 'live-governance')
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 53140
const DSH_INSTALL = process.env.DSH_INSTALL || 'C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh'
const DSH_PACKAGES = DSH_INSTALL + '/node_modules/@deepseek-ai'
const LUMIO_SRC = process.env.LUMIO_SRC || 'C:/Users/oldap/Documents/lumio'
const REPO = join(ARTIFACTS, 'repo')

mkdirSync(join(ARTIFACTS, 'tmp'), { recursive: true })
mkdirSync(join(ARTIFACTS, 'native-cache'), { recursive: true })
process.env.TEMP = join(ARTIFACTS, 'tmp')
process.env.TMP = process.env.TEMP
process.env.LOCALAPPDATA = process.env.LOCALAPPDATA || 'C:\\Users\\oldap\\AppData\\Local'
process.env.APPDATA = process.env.APPDATA || 'C:\\Users\\oldap\\AppData\\Roaming'
process.env.USERPROFILE = process.env.USERPROFILE || 'C:\\Users\\oldap'
process.env.HOME = process.env.HOME || 'C:\\Users\\oldap'
process.env.NARB_NATIVE_CACHE_DIR = join(ARTIFACTS, 'native-cache')
process.env.DSH_HOME = join(ARTIFACTS, 'dshhome')

// 治理对象：一份真实 lumio 副本（不动原仓库），含它的 tools/engineering 判据。
const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.tmp', 'test-results', 'playwright-report', '.next', '.project'])
async function mirror(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const from = join(src, entry.name), to = join(dst, entry.name)
    if (entry.isDirectory()) await mirror(from, to)
    else if (entry.isFile()) await copyFile(from, to)
  }
}
await rm(REPO, { recursive: true, force: true })
await rm(process.env.DSH_HOME, { recursive: true, force: true })
await mirror(LUMIO_SRC, REPO)

export async function runLiveGovernance(options = {}) {
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + String(detail).slice(0, 320) : ''))
  return ok
}
function request(url, options = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: options.method || 'GET', headers: options.headers || {}, timeout: 60000 }, (res) => {
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

// 等价于「在插件管理器里安装本地 bundle」的文件系统写路径。
async function prepareProfile() {
  const profileDir = join(process.env.DSH_HOME, 'profiles', 'web')
  mkdirSync(join(profileDir, 'node_modules', '@local'), { recursive: true })
  const manifestPath = join(profileDir, 'package.json')
  let manifest
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')) }
  catch { manifest = { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } } }
  const BUNDLE = '@local/dsh-project-workbench'
  manifest.dependencies = { ...(manifest.dependencies || {}), [BUNDLE]: 'link:' + WORKBENCH_ROOT.replace(/\\\\/g, '/') }
  const bundles = manifest.dsh.profile.bundles || []
  if (!bundles.includes(BUNDLE)) bundles.push(BUNDLE)
  manifest.dsh.profile.bundles = bundles
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
  const linkPath = join(profileDir, 'node_modules', '@local', 'dsh-project-workbench')
  try { await symlink(WORKBENCH_ROOT, linkPath, 'junction') } catch (error) { if (error.code !== 'EEXIST') throw error }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) await writeFile(patchPath, '[]' + String.fromCharCode(10), 'utf8')
}
await prepareProfile()

const { runProfile } = await import(pathToFileURL(DSH_PACKAGES + '/dsh/lib/profile-boot.js').href)
const { loadLayeredEnv } = await import(pathToFileURL(DSH_PACKAGES + '/dsh-app-boot/lib/index.js').href)
process.argv = [process.execPath, 'dsh', '--no-open', '--port', String(PORT)]
let handle
try {
  handle = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'web', patchFiles: [], args: ['--no-open', '--port', String(PORT)] })
} catch (error) {
  console.error('FATAL: 实例启动失败：' + String(error && error.message))
  process.exit(1)
}
const ctx = handle.ctx
const svc = (name) => { try { return ctx.get(name) } catch { return undefined } }
check('① 真实实例启动且插件已加载', (svc('tools').definitions().map((d) => d.name).includes('gate_submit')), 'port=' + PORT)

await svc('workspaceRegistry').create(REPO, 'lumio（治理沙箱）')
const base = 'http://127.0.0.1:' + PORT
const token = svc('connection').browserAuth.launchToken
const exchange = await request(base + '/?token=' + token)
const setCookie = exchange.headers['set-cookie']
const cookie = Array.isArray(setCookie) ? setCookie.map((c) => c.split(';')[0]).join('; ') : String(setCookie || '').split(';')[0]
check('② token 换 cookie（真实鉴权）', exchange.status === 303 && Boolean(cookie), 'status=' + exchange.status)
const post = (path, body) => request(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
const get = (path) => request(base + path, { headers: { cookie } })

const init = await post('/project-workbench/api/init', { root: REPO })
check('③ POST /init 在真实 lumio 副本上初始化项目', init.status === 200 && init.body.includes('"ok":true'), 'status=' + init.status + ' ' + init.body.slice(0, 140))

// 阶段模板：直接用插件的 registry（同一进程内同一份模块 === 真实实例加载的那份代码）
const registryMod = await import(pathToFileURL(join(WORKBENCH_ROOT, 'host/registry.js')).href)
const defaultsMod = await import(pathToFileURL(join(WORKBENCH_ROOT, 'host/project-defaults.js')).href)
let needConfirm
try { registryMod.createRegistry(ctx).applyStageRemap(REPO, defaultsMod.LUMIO_STAGE_TEMPLATE) } catch (error) { needConfirm = error }
check('④ 换阶段模板未确认 → CONFIRM_REQUIRED', needConfirm && needConfirm.code === 'CONFIRM_REQUIRED', needConfirm ? needConfirm.code : 'no error')
const applied = registryMod.createRegistry(ctx).applyStageRemap(REPO, defaultsMod.LUMIO_STAGE_TEMPLATE, { confirmed: true })
const live = applied.stages.filter((s) => s.status !== 'retired').map((s) => s.key)
check('⑤ 落地 lumio 生命周期 PRD/DEV/FILE/CODE', live.join(',') === 'PRD,DEV,FILE,CODE', live.join(','))

// 真实判据：此时 lumio 的 checker 是红的（.project 未登记 + 记忆落后）
const realCheck = await (await import(pathToFileURL(join(WORKBENCH_ROOT, 'host/checkers.js')).href)).runProjectCheckers(REPO, { registry: registryMod.createRegistry(ctx) })
check('⑥ 真实 lumio 判据在副本上跑出红灯', realCheck.ok === false && realCheck.issues.length > 0, realCheck.issues.length + ' issues: ' + [...new Set(realCheck.issues.map((i) => i.code))].join(','))

// 治理动作：修好判据（登记 .project + 更新记忆）
const policyPath = join(REPO, 'tools/engineering/policy.json')
const policy = JSON.parse(await readFile(policyPath, 'utf8'))
if (!policy.ignoredDirectories.includes('.project')) {
  policy.ignoredDirectories = policy.ignoredDirectories.concat(['.project']).sort()
  await writeFile(policyPath, JSON.stringify(policy, null, 2) + String.fromCharCode(10), 'utf8')
}
const memoryPath = join(REPO, 'docs/memory/project-context.md')
const memory = await readFile(memoryPath, 'utf8')
const newestWi = (await readdir(join(REPO, 'docs/work-items'))).filter((n) => /^WI-\d{8}-\d{3}.*\.md$/.test(n)).sort().pop()
const wiId = newestWi.match(/^WI-\d{8}-\d{3}/)[0]
await writeFile(memoryPath, memory.replace(/^##\s*当前交接\s*$/m, '## 当前交接' + String.fromCharCode(10, 10) + '- 最新已交付工作项：' + wiId + '（由工作台门禁驱动更新）。'), 'utf8')
const recheck = await (await import(pathToFileURL(join(WORKBENCH_ROOT, 'host/checkers.js')).href)).runProjectCheckers(REPO, { registry: registryMod.createRegistry(ctx) })
check('⑦ 治理后判据真实转绿', recheck.ok === true, recheck.issues.map((i) => i.code).join(',') || 'clean')

// 门禁：通过真实 HTTP 提交 → 人批准 → 阶段推进
const registry = registryMod.createRegistry(ctx)
const db = registry.open(REPO)
const store = await import(pathToFileURL(join(WORKBENCH_ROOT, 'host/store.js')).href)
const docsMod = await import(pathToFileURL(join(WORKBENCH_ROOT, 'host/docs.js')).href)
const pmRow = store.createSession(db, { kind: 'pm', dshSessionId: 'live-pm-1', provider: 'deepseek', model: 'deepseek-v4' })
const slice = store.createSlice(db, { key: 'live-governance', title: '真实实例治理演练', type: 'workitem' })
const doc = docsMod.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/live', title: '治理 PRD', stage: 'PRD' })
docsMod.writeDocumentVersion(db, { docId: doc.id, content: '# 治理 PRD' + String.fromCharCode(10) + '真实实例链路。' })
const evidence = store.addEvidence(db, { kind: 'review', sliceId: slice.id, resultSummary: 'PRD 评审通过', createdBy: pmRow.id })

// 用真实工具定义执行 gate_submit（等价模型调用），走的是被宿主加载的那份代码
const toolsSvc = svc('tools')
const pmAgent = { session: { id: 'live-pm-1', header: { cwd: REPO, agentPreset: 'project-office' } } }
const gateDef = toolsSvc.definitions().find((d) => d.name === 'gate_submit')
let gateError
let gateResult
try {
  gateResult = await gateDef.execute({ gate: 'PRD-AUDIT', docIds: [doc.id], evidenceIds: [evidence.id], summary: '真实实例门禁' }, { agent: pmAgent, signal: new AbortController().signal })
} catch (error) { gateError = error }
check('⑧ 真实 tools 服务里的 gate_submit 可执行且机检通过', Boolean(gateResult && gateResult.approvalId), gateError ? String(gateError.message).slice(0, 200) : 'approvalId=' + String(gateResult && gateResult.approvalId))

const decisionId = gateResult ? gateResult.decision.id : ''
const unsigned = await post('/project-workbench/api/decision', { root: REPO, id: decisionId, status: 'approved' })
check('⑨ 不可逆门禁缺二次确认 → 409 CONFIRM_REQUIRED', unsigned.status === 409 && unsigned.body.includes('CONFIRM_REQUIRED'), 'status=' + unsigned.status)

const approved = await post('/project-workbench/api/decision', { root: REPO, id: decisionId, status: 'approved', confirmed: true })
check('⑩ 真实 HTTP 批准 → 阶段 PRD→DEV', approved.status === 200 && approved.body.includes('"to":"DEV"'), 'status=' + approved.status + ' ' + approved.body.slice(0, 160))

const snap = await get('/project-workbench/api/snapshot?root=' + encodeURIComponent(REPO))
check('⑪ 真实 HTTP /snapshot 反映新阶段', snap.status === 200 && snap.body.includes('DEV'), 'status=' + snap.status)
const tl = await get('/project-workbench/api/timeline?root=' + encodeURIComponent(REPO) + '&limit=50')
check('⑫ 时间线含 gate/approve + stage/change', tl.status === 200 && /gate\/approve/.test(tl.body) && /stage\/change/.test(tl.body), 'status=' + tl.status)

// 单写：权威源在 agent 碰不到的地方
const paths = registryMod.projectPaths(REPO)
check('⑬ 权威源已外移（工作区无 project.db）', paths.external === true && !existsSync(join(REPO, '.project', 'project.db')), 'store=' + paths.storeRoot)

await handle.shutdown.shutdown(0).catch(() => {})
const failed = results.filter((r) => !r.ok).length
console.log(String.fromCharCode(10) + '[live-governance-http] passed=' + (results.length - failed) + ' failed=' + failed)
return { passed: results.length - failed, failed, results }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) {
  const summary = await runLiveGovernance()
  process.exitCode = summary.failed > 0 ? 1 : 0
}