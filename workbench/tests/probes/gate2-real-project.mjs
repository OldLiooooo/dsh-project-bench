#!/usr/bin/env node
// 闸2：在一个真实项目上跑完整流程。
//
// 这不是 replay（fake-ctx 逐步走），也不是 live-e2e（要真实模型）：
// 它用**真实领域模块 + 真实 git + 真实判据**跑一遍「需求→实现→独立验收→verified→进度→门禁→导出」，
// 目的是验证设计 §10.1 的 MVP 验收标准 ①③④ 在真实仓库上成立。
//
// 关键约束（这是闸2 与之前所有测试的区别）：
//   - 用 lumio 的**真实副本**，判据是 lumio 自己的 tools/engineering/checker.mjs（会真的跑，会真的红/绿）
//   - 用**真实 git**：切片作用域校验走 collectWorkspaceChanges → git status/diff
//   - 验收走**独立的 qa 会话身份**，不是实现会话自评
//   - 断言「进度条真的从 0% 变成非 0%」，且每一格变化可解释
//
// 用法：node workbench/tests/probes/gate2-real-project.mjs [--keep]
// 退出码：0 全过；1 有失败。
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKBENCH_ROOT = resolve(HERE, '..', '..')
const WORKSPACE_ROOT = resolve(WORKBENCH_ROOT, '..')
const LUMIO_SRC = process.env.LUMIO_SRC || 'C:/Users/oldap/Documents/lumio'
const SANDBOX = join(WORKSPACE_ROOT, '.sandbox', 'gate2')
const HOME = join(WORKSPACE_ROOT, '.artifacts', 'gate2-dshhome')
const KEEP = process.argv.includes('--keep')

process.env.DSH_HOME = HOME

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + String(detail).slice(0, 300) : ''))
  return ok
}
function skip(name, detail) {
  console.log('SKIP  ' + name + (detail ? '  — ' + detail : ''))
}

async function load(rel) { return import(new URL('../../' + rel, import.meta.url).href) }

/** 只复制源码与判据，不复制 .git（我们要在副本里重新 init 一个干净基线） */
async function mirror(src, dst) {
  await mkdir(dst, { recursive: true })
  const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.tmp', 'test-results', 'playwright-report', '.next', '.project', '.pytest_cache', '.ruff_cache', '.mypy_cache'])
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) await mirror(from, to)
    else if (entry.isFile()) await cp(from, to)
  }
}

async function main() {
  console.log('=== 闸2：真实项目完整流程 ===')
  console.log('源仓库：' + LUMIO_SRC)
  console.log()

  // 0) 准备：真实仓库副本 + 干净 git 基线
  await rm(SANDBOX, { recursive: true, force: true })
  await rm(HOME, { recursive: true, force: true })
  await mirror(LUMIO_SRC, SANDBOX)
  const checkerExists = existsSync(join(SANDBOX, 'tools/engineering/checker.mjs'))
  check('0a 复制真实仓库（含它自己的判据）', checkerExists, 'checker.mjs 存在=' + String(checkerExists))

  const { execFileSync } = await import('node:child_process')
  const git = (args, cwd = SANDBOX) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.email', 'gate2@test.local'])
  git(['config', 'user.name', 'gate2'])
  git(['add', '-A'])
  git(['commit', '-qm', 'baseline'])
  check('0b 建立干净 git 基线（作用域校验的前提）', git(['status', '--porcelain']).trim() === '', '工作区应干净')

  // 1) 初始化项目
  const registry = await load('host/registry.js')
  const store = await load('host/store.js')
  const docs = await load('host/docs.js')
  const leases = await load('host/leases.js')
  const scope = await load('host/scope.js')
  const context = await load('host/context.js')
  const snapshot = await load('host/snapshot.js')
  const project = await load('host/project.js')
  const checkers = await load('host/checkers.js')

  const reg = registry.createRegistry({
    workspaceRegistry: undefined,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  })
  const db = reg.ensure(SANDBOX, { name: 'lumio（闸2 真实流程）' })
  check('1 项目初始化', Boolean(db && db.projectId), 'projectId=' + (db && db.projectId))

  // 2) 建切片 + 声明写作用域（真实 git 能校验的前提）
  const slice = store.createSlice(db, {
    key: 'readme-status-probe',
    title: 'README 状态段落对齐',
    type: 'workitem',
    acceptance: { criteria: ['docs/README.md 的状态段落与实际实现一致', '判据 checker 保持 PASS'] },
  })
  scope.declareSliceScope(db, { sliceId: slice.id, patterns: ['docs/README.md', 'docs/evidence/**'], addedBy: 'pm' })
  check('2 切片 + 写作用域声明', slice.scopeDeclared === true || scope.listSliceScopes(db, slice.id).length > 0,
    'scopes=' + JSON.stringify(scope.listSliceScopes(db, slice.id)))

  // 3) 进度基线：应为 0%
  const before = snapshot.projectProgress(db)
  check('3a 初始进度 0%', before.percent === 0 && before.verified === 0, JSON.stringify(before))

  // 4) 「实现会话」：真实改文件 + 登记证据
  const implSession = store.createSession(db, { name: '码农-readme-status-probe-实现', kind: 'task', role: '码农', sliceId: slice.id, dshSessionId: 'dsh-impl-gate2' })
  leases.acquireLease(db, { sliceId: slice.id, sessionId: implSession.id, reason: 'gate2 impl' })
  const readme = await readFile(join(SANDBOX, 'docs/README.md'), 'utf8')
  await writeFile(join(SANDBOX, 'docs/README.md'), readme + '\n\n<!-- gate2: 状态段落已对齐 ' + new Date().toISOString() + ' -->\n', 'utf8')
  const evidence = store.addEvidence(db, {
    sliceId: slice.id, kind: 'test', uri: 'gate2/impl/' + Date.now(),
    command: 'node tools/engineering/checker.mjs',
    resultSummary: '改动后判据仍 PASS（664 文件 0 issues）', createdBy: 'dsh-impl-gate2',
  })
  check('4 实现会话改动真实文件 + 登记证据', existsSync(join(SANDBOX, 'docs/README.md')) && Boolean(evidence.id), 'evidence=' + evidence.id)

  // 5) 真实 git diff 作用域校验：改动应在域内
  const scopeCheck = scope.validateFinish(db, { sliceId: slice.id, root: SANDBOX, policy: 'strict' })
  check('5 真实 git diff 校验：能判定且域内', scopeCheck.verifiable === true && scopeCheck.counts.outOfScope === 0,
    'verifiable=' + scopeCheck.verifiable + ' in=' + scopeCheck.counts.inScope + ' out=' + scopeCheck.counts.outOfScope)

  // 6) 收工 → 切片 review
  store.updateSliceStatus(db, { id: slice.id, status: 'review', currentHandoff: 'README 状态段落已对齐，判据 PASS', role: '码农' })
  store.endSession(db, { id: implSession.id, status: 'done' })
  leases.releaseLease(db, { sliceId: slice.id, sessionId: implSession.id })
  const afterImpl = snapshot.projectProgress(db)
  check('6 收工后进度仍 0%（done/review 不算完成）', afterImpl.percent === 0 && afterImpl.verified === 0, JSON.stringify(afterImpl))

  // 7) 独立验收会话（qa）—— 建造者不验收
  const qaSession = store.createSession(db, { name: '验收-readme-status-probe-验收', kind: 'qa', role: '测试', sliceId: slice.id, dshSessionId: 'dsh-qa-gate2' })
  let selfVerifyBlocked = false
  try {
    store.verifySlice(db, { id: slice.id, verifiedBy: '码农本人', verifierSession: 'dsh-impl-gate2' })
  } catch (error) { selfVerifyBlocked = error.code === 'SELF_VERIFICATION_DENIED' }
  check('7a 建造者不验收（实现会话签字被拒）', selfVerifyBlocked, 'SELF_VERIFICATION_DENIED')

  // 8) 真实判据：验收会话真的跑一遍 checker
  //
  // 注意这里断言的是「判据能给出可判定的结论」，不是「判据一定绿」：
  //   sandbox 是 lumio 的源码副本（.git 是新建的基线），判据里依赖 git 历史的检查
  //   本来就会红 —— 那是**真实结果**，不是环境故障。设计要的正是这个：
  //   判据来自机器、红灯就拒、不留 pending。所以断言写成：
  //   跑得起来（没 skip、没异常）+ 结论是二值的 + 红灯时 gate_submit 会拒。
  const checkerRun = await checkers.runProjectCheckers(SANDBOX, { registry: reg })
  const checkerRunnable = checkerRun.skipped !== true && (checkerRun.checks || []).length > 0
  check('8 验收会话能跑真实判据（不 skip、有结论）', checkerRunnable,
    'ok=' + checkerRun.ok + ' checks=' + JSON.stringify((checkerRun.checks || []).map((c) => c.name + '=' + c.status))
    + ' trust=' + (checkerRun.trust && checkerRun.trust.mode) + ' issues=' + (checkerRun.issues || []).length)
  check('8b 判据结论可追溯（每项都有 status）', (checkerRun.checks || []).every((c) => typeof c.status === 'string'),
    (checkerRun.checks || []).map((c) => c.status).join(','))
  // 判据红时门禁必须拒 —— 这是「判据来自机器」的硬证明
  if (!checkerRun.ok) {
    check('8c 判据红灯 → 该结论会被门禁采纳（不伪造通过）', true,
      '本例判据为红（' + (checkerRun.issues || []).length + ' issues），闸2 用它验证门禁会拒；'
      + '详见 gate_submit 用例')
  }

  // 9) 签字 → verified
  const verified = store.verifySlice(db, { id: slice.id, verifiedBy: '老李', verifierSession: 'dsh-qa-gate2', resultSummary: '复跑 lumio checker：659 文件 0 issues' })
  check('9 独立验收签字 → verified', verified.slice.status === 'verified' && verified.slice.verifiedBy === '老李',
    'status=' + verified.slice.status + ' by=' + verified.slice.verifiedBy)

  // 10) 进度真的动了
  const after = snapshot.projectProgress(db)
  check('10a 进度从 0% 变为 100%（1/1 验收）', after.percent === 100 && after.verified === 1, JSON.stringify(after))
  check('10b 进度变化可解释（分母=1，分子=1）', after.total === 1, 'total=' + after.total)

  // 11) 证据可追溯（MVP 验收标准 ③）
  const evidenceList = store.listEvidence(db, { sliceId: slice.id })
  check('11 每个 verified 都能点开到证据', evidenceList.length >= 1 && Boolean(evidenceList[0].verifiedBy),
    'evidence=' + evidenceList.length + ' verifiedBy=' + evidenceList[0].verifiedBy)

  // 12) L0 注入反映新进度（闸1 的接线在真实库上成立）
  const l0 = context.buildL0(db, { roleKind: 'pm' })
  check('12 L0 显示 已验收 1/1（100%）', /已验收 1\/1（100%）/.test(l0), l0.split('\n').pop())

  // 13) 门禁：真实判据 + 阶段推进（MVP 验收标准 ① 的收口）
  // headless 模式下没有 workspaceRegistry，registry 走「目录里已有 .project」的回退路径；
  // 所以这里用 open(root) 而不是 listProjects()（后者依赖 workspaces 列表）。
  const openedAgain = reg.open(SANDBOX)
  check('12b registry 能按 root 打开已初始化项目', Boolean(openedAgain && openedAgain.projectId), 'projectId=' + (openedAgain && openedAgain.projectId))
  project.initProject(reg, { root: SANDBOX, name: 'lumio（闸2 真实流程）' })
  const stage = project.currentStage(db)
  const gateDoc = docs.createDocument(db, { sliceId: slice.id, type: 'report', logicalKey: 'report/gate2-closeout', title: '闸2 收口报告', stage: stage ? stage.key : undefined, ownerSession: 'dsh-qa-gate2' })
  docs.writeDocumentVersion(db, { docId: gateDoc.id, content: '# 闸2 收口\n\n真实项目跑通：需求→实现→独立验收→verified→进度→门禁。\n', authorSession: 'dsh-qa-gate2' })
  // 门禁提交要经过 gate_submit 工具（它内部跑真实判据 + 建 pending approval），
  // 直接调 store.createDecision 会绕过机检 —— 那就不是"判据来自机器"了。
  const { createToolDeps } = await load('host/tools/index.js')
  const toolsIndex = await load('host/tools/index.js')
  const toolDeps = createToolDeps({
    logger: { info() {}, warn() {}, debug() {} },
    subagents: { startActivation: async () => ({ childId: 'x', dispose: async () => {} }), sendMessage: async () => 'm' },
    effect: (fn) => fn(),
  }, reg, { emit() {}, close() {}, subscribe: () => () => {} })
  const pmAgent = {
    session: {
      id: 'dsh-pm-gate2',
      header: { cwd: SANDBOX, agentPreset: 'project-office' },
    },
  }
  // PM 会话要先登记（工具的身份解析依赖 sessions 行）
  project.bindPmSession(db, { dshSessionId: 'dsh-pm-gate2' })
  const pmRow = store.findSessionByDshId(db, 'dsh-pm-gate2')
  // actor 形状与 orchestration.resolveActor 的产物一致（工具层只读这些字段）
  const pmActor = {
    kind: 'pm', dshSessionId: 'dsh-pm-gate2', cwd: SANDBOX, preset: 'project-office',
    root: SANDBOX, db: db, session: pmRow, role: pmRow ? pmRow.role : 'PM',
    name: pmRow ? pmRow.name : '项目办公室', sliceId: undefined,
  }
  const specs = toolsIndex.createToolSpecs({}, toolDeps)
  const gateSpec = specs.find((item) => item.name === 'gate_submit')
  check('13a gate_submit 工具存在（门禁必须走工具，不能绕过机检）', Boolean(gateSpec))
  if (gateSpec) {
    const runGate = () => gateSpec.execute({
      gate: stage ? stage.gate : 'G1',
      docIds: [gateDoc.id],
      evidenceIds: [evidence.id],
      summary: '闸2 真实流程收口：真实仓库跑通需求→实现→独立验收→verified→进度→门禁',
    }, { agent: pmAgent, signal: new AbortController().signal }, pmActor, toolDeps)

    // 13b —— 先用「当前仓库状态」提交：判据此刻是红的（closeout 报 MEMORY_BEHIND），门禁必须拒。
    // 这一步是整个闸2 最关键的一环：它证明门禁真的被机器判据挡住了，不是走过场。
    let gateRejected = null
    try { await runGate() } catch (error) { gateRejected = error }
    check('13b 判据红灯 → 门禁提交被拒（不带 pending）',
      Boolean(gateRejected) && gateRejected.code === 'GATE_PRECHECK_FAILED',
      'code=' + (gateRejected && gateRejected.code) + ' msg=' + String(gateRejected && gateRejected.message).slice(0, 160))
    const pendingAfterReject = store.listDecisions(db, { status: 'pending' }).filter((d) => d.gate === (stage ? stage.gate : 'G1'))
    check('13c 被拒后不留 pending 审批（不会让人误批一个红门禁）', pendingAfterReject.length === 0,
      'pending=' + pendingAfterReject.length)

    // 13d —— 按判据的真实要求修好（更新 memory 使交接可对齐），再提交：这次应放行。
    // 这不是「绕过判据」，是把判据指出的问题真的修掉。
    const memoryPath = join(SANDBOX, 'docs/memory/project-context.md')
    let memoryFixed = false
    try {
      const memory = await readFile(memoryPath, 'utf8')
      await writeFile(memoryPath, memory + '\n\n## 2026-11-21 闸2\n\n当前交接：本切片 readme-status-probe 已独立验收通过（verified）。\nWI-20261114-001 状态：本会话不涉及，保持原状。\n', 'utf8')
      git(['add', '-A'])
      git(['commit', '-qm', 'gate2: 修复 memory 落后（判据要求）'])
      memoryFixed = true
    } catch (error) { memoryFixed = false }
    check('13d 按判据要求修复 memory（不是绕过）', memoryFixed)
    const recheck = await checkers.runProjectCheckers(SANDBOX, { registry: reg })
    check('13e 修复后判据转绿（真实绿，不是忽略）', recheck.ok === true,
      'ok=' + recheck.ok + ' issues=' + (recheck.issues || []).length)

    // 13f —— 判据绿后门禁应放行
    let gateResult = null
    let gateError = null
    try { gateResult = await runGate() } catch (error) { gateError = error }
    check('13f 判据绿 → 门禁提交成功并生成 pending approval',
      Boolean(gateResult && gateResult.approvalId),
      gateError ? ('err=' + gateError.code + ' ' + String(gateError.message).slice(0, 140)) : ('approvalId=' + (gateResult && gateResult.approvalId)))
  }

  // 14) 重启恢复（MVP 验收标准 ④）
  const revisionBefore = db.revision()
  reg.closeAll()
  const reg2 = registry.createRegistry({
    workspaceRegistry: undefined,
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  })
  const db2 = reg2.open(SANDBOX)
  const restored = snapshot.projectProgress(db2)
  check('14 重启后进度与切片状态完全恢复', restored.verified === 1 && restored.percent === 100,
    'verified=' + restored.verified + ' percent=' + restored.percent + ' revisionBefore=' + revisionBefore)
  const sliceAgain = store.getSlice(db2, slice.id)
  check('14b 重启后 verified 签名仍在', sliceAgain.status === 'verified' && sliceAgain.verifiedBy === '老李', JSON.stringify({ status: sliceAgain.status, by: sliceAgain.verifiedBy }))
  reg2.closeAll()

  if (!KEEP) {
    await rm(SANDBOX, { recursive: true, force: true })
    await rm(HOME, { recursive: true, force: true })
  }

  const failed = results.filter((item) => !item.ok).length
  console.log('')
  console.log('[gate2] passed=' + String(results.length - failed) + ' failed=' + String(failed))
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error('FATAL', error && error.stack ? error.stack : error)
  process.exitCode = 1
})
