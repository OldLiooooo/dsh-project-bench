#!/usr/bin/env node
// 端到端治理演练（headless / in-process）：用插件自己的工具治理一个**真实的** lumio 仓库副本。
//
// 这不是 fake ctx：registry → ProjectDb → store/docs/leases → 工具层 → 门禁判据，全部是生产实现。
// 唯一的替身是 ctx.subagents（拉起子会话）与 ctx.agents（唤醒 PM）——它们需要真实 DSH 运行时，
// 这里用记录型替身，且**断言替身收到了正确的开场简报**（而不是假装它成功了）。
//
// 用法：node workbench/tests/probes/governance-e2e.mjs [--repo <path>]
// 退出码：0 全过；1 任一断言失败。
import { copyFile, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'

const HERE = import.meta.dirname
const WORKBENCH_ROOT = resolve(HERE, '..', '..')
const WORKSPACE_ROOT = resolve(WORKBENCH_ROOT, '..')
const LUMIO_SRC = resolve(process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : 'C:/Users/oldap/Documents/lumio')
const SANDBOX = join(WORKSPACE_ROOT, '.sandbox', 'governance-e2e')

// 探针进程=会话沙箱内的进程。真实 $DSH_HOME(storages) 对它是 EPERM —— 这正是 M0 想要的物理隔离。
// 先把它记成证据，再把本探针自己的 store 指到工作区内（否则连探针都跑不起来）。
const REAL_DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const REAL_STORE_PROBE = join(REAL_DSH_HOME, 'storages', 'project-workbench', 'probe-writability')
let sandboxCanWriteRealStore = true
try { await mkdir(REAL_STORE_PROBE, { recursive: true }) } catch { sandboxCanWriteRealStore = false }
process.env.DSH_HOME = join(WORKSPACE_ROOT, '.artifacts', 'governance-dshhome')

async function load(rel) { return import(pathToFileURL(join(WORKBENCH_ROOT, rel)).href) }

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + String(detail).slice(0, 320) : ''))
  return ok
}

// ---------------------------------------------------------------------------
// 0) 准备：把 lumio 复制成沙箱仓库（不碰真实仓库）
// ---------------------------------------------------------------------------
const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.tmp', 'test-results', 'playwright-report', '.next', '.project'])
async function mirror(src, dst) {
  await mkdir(dst, { recursive: true })
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const from = join(src, entry.name), to = join(dst, entry.name)
    if (entry.isDirectory()) await mirror(from, to)
    else if (entry.isFile()) await copyFile(from, to)
  }
}
await rm(SANDBOX, { recursive: true, force: true })
// 幂等：上一轮的 store 也要清掉，否则阶段还停在上一轮推进后的位置（workspaceKey 固定）。
await rm(process.env.DSH_HOME, { recursive: true, force: true })
const t0 = Date.now()
await mirror(LUMIO_SRC, SANDBOX)
check('① 复制真实 lumio 到治理沙箱（不改原仓库）', existsSync(join(SANDBOX, 'tools/engineering/checker.mjs')), 'src=' + LUMIO_SRC + ' ' + String(Date.now() - t0) + 'ms')

// ---------------------------------------------------------------------------
// 1) 装配真实 host 模块 + 记录型 ctx
// ---------------------------------------------------------------------------
const registryMod = await load('host/registry.js')
const defaults = await load('host/project-defaults.js')
const busMod = await load('host/bus.js')
const store = await load('host/store.js')
const leases = await load('host/leases.js')
const projectApi = await load('host/project.js')
const toolsIndex = await load('host/tools/index.js')
const orchestr = await load('host/orchestration.js')

const activations = []
const wakeMessages = []
const ctx = {
  get: (name) => (name === 'workspaceRegistry' ? undefined : undefined),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
  on: () => () => {},
  subagents: {
    async startActivation(spec) {
      activations.push(spec)
      return { childId: spec.childId, result: Promise.resolve({ output: 'ok' }), dispose: async () => {} }
    },
    async sendMessage(sender, target, content) { return 'msg-1' },
  },
  agents: { get: (id) => (id === 'dsh-pm-1' ? { status: 'idle', followup: (m) => wakeMessages.push(m), steer: (m) => wakeMessages.push(m) } : undefined) },
}
const registry = registryMod.createRegistry(ctx)
const bus = busMod.createBus()
const registrations = []
ctx.tools = { register: (definition, options) => { registrations.push({ definition, options }); return () => {} } }
toolsIndex.registerTools(ctx, registry, bus)
const deps = toolsIndex.createToolDeps(ctx, registry, bus)

function agentHeader(root, preset) { return { session: { id: preset === 'project-office' ? 'dsh-pm-1' : undefined, header: { cwd: root, agentPreset: preset } } } }
function pmAgent(root) { return { session: { id: 'dsh-pm-1', header: { cwd: root, agentPreset: 'project-office' } } } }
function taskAgent(root, dshId) { return { session: { id: dshId, header: { cwd: root, agentPreset: 'project-task', origin: 'subagent', delegationDepth: 1 } } } }
async function callTool(name, args, agent) {
  const reg = registrations.find((item) => item.definition.name === name)
  if (!reg) throw new Error('tool not registered: ' + name)
  return reg.definition.execute(args, { agent, signal: new AbortController().signal })
}

// ---------------------------------------------------------------------------
// 2) 初始化项目 + 换阶段模板（lumio 生命周期）
// ---------------------------------------------------------------------------
const db = registry.ensure(SANDBOX, { name: 'lumio（治理演练）' })
check('② headless 下能初始化项目（无 workspaceRegistry 也成立）', Boolean(db && db.projectId), 'projectId=' + String(db.projectId))

const storePaths = registryMod.projectPaths(SANDBOX)
check('②a 权威源已外移到 store（不在工作区内）', storePaths.external === true && storePaths.storeRoot !== join(SANDBOX, '.project'), 'store=' + storePaths.storeRoot)
check('②b 工作区里不再有 project.db（agent 碰不到权威源）', !existsSync(join(SANDBOX, '.project', 'project.db')) && !existsSync(join(SANDBOX, '.project', 'project.json')), 'workspace .project 仅剩导出投影')
check('②c 会话沙箱写不进真实 $DSH_HOME/storages（物理单写前提）', sandboxCanWriteRealStore === false, sandboxCanWriteRealStore ? '⚠ 可写：单写未成立' : 'EPERM ✓ ' + REAL_STORE_PROBE)

let remap
try { registry.applyStageRemap(SANDBOX, defaults.LUMIO_STAGE_TEMPLATE) } catch (error) { remap = error }
check('③ 换阶段模板未经确认 → CONFIRM_REQUIRED', remap && remap.code === 'CONFIRM_REQUIRED', remap ? remap.code : 'no error')

const applied = registry.applyStageRemap(SANDBOX, defaults.LUMIO_STAGE_TEMPLATE, { confirmed: true })
const stageRows = applied.stages
const retired = stageRows.filter((row) => row.status === 'retired').map((row) => row.key)
const live = stageRows.filter((row) => row.status !== 'retired').map((row) => row.key)
check('④ 确认后落地 lumio 模板 PRD/DEV/FILE/CODE', live.join(',') === 'PRD,DEV,FILE,CODE', 'live=' + live.join(',') + ' retired=' + retired.join(','))
check('⑤ 旧阶段是被 retire 而不是删除（历史事件不断链）', retired.length === 7 && retired.every((key) => key.startsWith('S')), retired.join(','))
const activeAfter = stageRows.filter((row) => row.status === 'active')
check('⑥ 换模板后 active 阶段恰一个（=PRD）', activeAfter.length === 1 && activeAfter[0].key === 'PRD', activeAfter.map((row) => row.key).join(','))

// ---------------------------------------------------------------------------
// 3) PM 建切片 / 任务，拉起任务会话（subagents 是替身，但断言它收到了什么）
// ---------------------------------------------------------------------------
store.createSession(db, { kind: 'pm', dshSessionId: 'dsh-pm-1', provider: 'deepseek', model: 'deepseek-v4' })
const pm = pmAgent(SANDBOX)
const slice = await callTool('slice_create', { key: 'delivery-lifecycle', title: '全量交付生命周期', type: 'workitem', acceptance: { criteria: ['PRD-AUDIT 通过', '门禁机检绿'] } }, pm)
const task = await callTool('task_create', { sliceKey: 'delivery-lifecycle', title: '补齐 PRD 并过 PRD-AUDIT' }, pm)
check('⑦ PM 能建切片与任务', Boolean(slice.slice.id && task.task.id), slice.slice.key + ' / ' + task.task.title)

let spawnError
let spawned
try {
  spawned = await callTool('session_spawn_task', {
    role: '产品', sliceId: slice.slice.id, taskId: task.task.id,
    action: 'PRD补齐', prompt: '把 PRD-W1 到 PRD-AUDIT 补齐，产出可复核证据。',
  }, pm)
} catch (error) { spawnError = error }
check('⑧ PM 拉起任务会话（角色-切片-动作）', Boolean(spawned && spawned.session), spawnError ? String(spawnError.message) : spawned.session.name)
const activationSpec = activations[0]
const activationPrompt = activationSpec && activationSpec.request && Array.isArray(activationSpec.request.prompt) ? activationSpec.request.prompt.map((part) => part.text || '').join('') : ''
check('⑨ subagents.startActivation 收到 project-task preset + 开场简报',
  activations.length === 1 && activationSpec.request && activationSpec.request.agentPreset === 'project-task' && activationPrompt.length > 50,
  activationSpec ? JSON.stringify({ preset: activationSpec.request && activationSpec.request.agentPreset, briefChars: activationPrompt.length, label: activationSpec.label }) : 'no activation')

const spawnedSession = spawned ? store.getSession(db, spawned.session.id) : undefined
const taskDshId = spawnedSession ? spawnedSession.dshSessionId : 'dsh-task-missing'
const taskAgentObj = taskAgent(SANDBOX, taskDshId)

// ---------------------------------------------------------------------------
// 4) 判据：真实 lumio checker 在门禁上生效（红/绿都验）
// ---------------------------------------------------------------------------
const gateRed = await callTool('gate_submit', {
  gate: 'PRD-AUDIT', sliceId: slice.slice.id, docIds: [], evidenceIds: [],
  summary: '（探针）直接提交，不走证据',
}, pm).then(() => undefined).catch((error) => error)
check('⑩ 门禁缺证据 → NO_EVIDENCE（先挡住）', gateRed && gateRed.code === 'NO_EVIDENCE', gateRed ? gateRed.code : 'no error')

// 真实判据此时是红灯（MEMORY_BEHIND）：补证据后再提交应当被机检拒绝
const evidence = await callTool('evidence_add', {
  kind: 'review', resultSummary: 'PRD 评审：链接与目录检查通过', sliceId: slice.slice.id,
}, taskAgentObj)
const gatePrecheck = await callTool('gate_submit', {
  gate: 'PRD-AUDIT', sliceId: slice.slice.id, docIds: [], evidenceIds: [evidence.evidence.id],
  summary: '申请 PRD-AUDIT 门禁',
}, pm).then(() => undefined).catch((error) => error)
check('⑪ 真实判据红灯 → gate_submit 被拒（GATE_PRECHECK_FAILED）', gatePrecheck && gatePrecheck.code === 'GATE_PRECHECK_FAILED', gatePrecheck ? String(gatePrecheck.message).slice(0, 200) : 'no error')
const issueCodes = gatePrecheck && gatePrecheck.details && Array.isArray(gatePrecheck.details.issues) ? [...new Set(gatePrecheck.details.issues.map((item) => item.code))] : []
check('⑫ 拒绝理由带真实判据码（MEMORY_BEHIND 等）', issueCodes.includes('MEMORY_BEHIND'), issueCodes.join(','))

const approvalsAfterReject = db.db.prepare("SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending'").get().c
check('⑬ 被拒后不留 pending approval', Number(approvalsAfterReject) === 0, 'pending=' + String(approvalsAfterReject))

// ---------------------------------------------------------------------------
// 5) 治理动作：修好判据（更新项目记忆）→ 门禁转绿 → 提交成功 → 人批准
// ---------------------------------------------------------------------------
const memoryPath = join(SANDBOX, 'docs/memory/project-context.md')
const memory = await readFile(memoryPath, 'utf8')
const newestWi = (await readdir(join(SANDBOX, 'docs/work-items'))).filter((n) => /^WI-\d{8}-\d{3}.*\.md$/.test(n)).sort().pop()
const wiId = newestWi.match(/^WI-\d{8}-\d{3}/)[0]
// 精准治理：判据要求「恰一个 当前交接 小节，且提到最新 WI」→ 改写已有小节，而不是再堆一节。
const handoffHeading = /^##\s*当前交接\s*$/m
if (!handoffHeading.test(memory)) throw new Error('真实仓库的 project-context.md 没有「当前交接」小节，判据前提变了')
await writeFile(memoryPath, memory.replace(handoffHeading, '## 当前交接' + String.fromCharCode(10) + String.fromCharCode(10) + '- 最新已交付工作项：' + wiId + '（本次由工作台门禁驱动更新）。'), 'utf8')
// M4：工作台在仓库根建了 .project/，而 lumio 的 policy.json 要求每个目录都登记。
// 治理动作是把 .project 显式登记进 ignoredDirectories（可审计的仓库策略变更），不是让判据闭嘴。
const policyPath = join(SANDBOX, 'tools/engineering/policy.json')
const policy = JSON.parse(await readFile(policyPath, 'utf8'))
if (!policy.ignoredDirectories.includes('.project')) {
  policy.ignoredDirectories = policy.ignoredDirectories.concat(['.project']).sort()
  await writeFile(policyPath, JSON.stringify(policy, null, 2) + String.fromCharCode(10), 'utf8')
}
const policyRegistered = JSON.parse(await readFile(policyPath, 'utf8')).ignoredDirectories.includes('.project')
check('⑭a .project 被登记进仓库 policy.json（治理动作可审计）', policyRegistered === true, 'ignoredDirectories 含 .project')

const recheck = await (await load('host/checkers.js')).runProjectCheckers(SANDBOX, { registry })
check('⑭ 补齐记忆后判据转绿（真实的 green，不是绕过）', recheck.ok === true, (await load('host/checkers.js')).summarizeCheckRun(recheck).split(String.fromCharCode(10))[0])

const gateGreen = await callTool('gate_submit', {
  gate: 'PRD-AUDIT', sliceId: slice.slice.id, docIds: [], evidenceIds: [evidence.evidence.id],
  summary: '申请 PRD-AUDIT 门禁（判据已绿）',
}, pm)
check('⑮ 判据绿 → gate_submit 成功并生成 pending approval', Boolean(gateGreen.approvalId) && gateGreen.machineCheck && gateGreen.machineCheck.ok === true, 'approvalId=' + String(gateGreen.approvalId))
const checkEvidence = db.db.prepare("SELECT COUNT(*) AS c FROM evidence WHERE kind = 'check'").get().c
check('⑯ 机检结果落 evidence（可追溯）', Number(checkEvidence) >= 1, 'check evidence=' + String(checkEvidence))

// 人批准（走真实 resolveDecisionAction；不可逆需二次确认）
let approveError
try { await projectApi.resolveDecisionAction(ctx, db, { id: gateGreen.decision.id, status: 'approved' }, { root: SANDBOX, registry }) } catch (error) { approveError = error }
check('⑰ 不可逆门禁缺二次确认 → CONFIRM_REQUIRED', approveError && approveError.code === 'CONFIRM_REQUIRED', approveError ? approveError.code : 'no error')

const approved = await projectApi.resolveDecisionAction(ctx, db, { id: gateGreen.decision.id, status: 'approved', confirmed: true }, { root: SANDBOX, registry })
check('⑱ 二次确认后批准成功并推进阶段', approved.decision.status === 'approved' && approved.actions && approved.actions.stage.to === 'DEV', JSON.stringify(approved.actions && approved.actions.stage))
check('⑲ 批准时复跑判据（precheck 有记录）', Boolean(approved.actions.precheck && approved.actions.precheck.ranAt), approved.actions.precheck ? 'skipped=' + String(approved.actions.precheck.skipped) : 'none')
check('⑳ 批准后唤醒 PM 并带上新阶段', wakeMessages.length >= 1 && /DEV/.test(JSON.stringify(wakeMessages[wakeMessages.length - 1])), 'wakes=' + String(wakeMessages.length))

const timeline = db.listEvents({ limit: 400 }).map((event) => event.kind)
check('㉑ 时间线含治理全过程事件', ['stage/template', 'gate/submit', 'gate/approve', 'stage/change'].every((kind) => timeline.includes(kind)), [...new Set(timeline)].join(',').slice(0, 200))

const finalStages = db.db.prepare('SELECT key, status FROM stages WHERE project_id = ? AND status != ? ORDER BY position').all(db.projectId, 'retired')
check('㉒ 阶段推进后仍恰一个 active（=DEV）', finalStages.filter((row) => row.status === 'active').map((row) => row.key).join(',') === 'DEV', finalStages.map((row) => row.key + ':' + row.status).join(' '))

// 导出：治理产物必须落盘且只写不回读
const exported = await callTool('export_project', { kind: 'snapshot' }, pm).catch((error) => ({ error }))
check('㉓ 导出快照成功（治理产物落盘）', !exported.error, exported.error ? String(exported.error.message) : 'ok')

registry.closeAll()
const failed = results.filter((item) => !item.ok).length
console.log(String.fromCharCode(10) + '[governance-e2e] passed=' + String(results.length - failed) + ' failed=' + String(failed))
process.exitCode = failed > 0 ? 1 : 0
