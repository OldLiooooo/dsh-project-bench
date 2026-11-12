// T4 工具层单测（fake ctx / 真实 ProjectDb + store/docs/leases 领域模块）
// 运行：node --test workbench/tests/unit/tools.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '../../host/db.js'
import * as store from '../../host/store.js'
import * as leases from '../../host/leases.js'
import { registerTools, createToolDeps, toolCatalog } from '../../host/tools/index.js'
import {
  compileContext, markSessionStartInjection, pendingFullInjection, noteStep,
  consumeFullInjection, resetInjectionState, injectionDiagnostics,
} from '../../host/context.js'
import { estimateTokens } from '../../host/util.js'
import { registerSessionHooks } from '../../host/session-hooks.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXPECTED_TOOLS = [
  'artifact_add', 'decision_create', 'doc_export', 'doc_freeze', 'doc_get', 'doc_list', 'doc_write',
  'evidence_add', 'export_project', 'file_index', 'gate_submit', 'import_inbox', 'project_brief',
  'project_init', 'project_status', 'project_recall', 'session_finish_task', 'session_send_task',
  'session_spawn_task', 'session_task_report', 'slice_create', 'slice_list', 'slice_update',
  'task_create', 'task_list', 'task_update',
]

function createEnv() {
  const root = mkdtempSync(join(HERE, '.tmp-'))
  const db = new ProjectDb(join(root, '.project', 'project.db'), { projectId: 'proj-test', projectName: '支付退款', root })
  const activations = []
  const messages = []
  const registrations = []
  const listeners = {}
  const lifecycle = { injects: [], effects: 0 }
  const registry = {
    rootForWorkspace: () => ({ workspaceId: 'ws-1', root, title: '工作区' }),
    open: () => db,
    ensure: () => db,
    listProjects: () => [{ workspaceId: 'ws-1', root, title: '工作区', exists: true, initialized: true }],
    projectJson: () => ({ exportMap: {} }),
    closeAll: () => {},
  }
  const bus = { emit: () => {}, subscribe: () => () => {} }
  const ctx = {
    tools: {
      register: (definition, options) => {
        registrations.push({ definition, options })
        return () => {}
      },
    },
    logger: { info: () => {}, warn: () => {} },
    on: (name, handler) => { (listeners[name] = listeners[name] || []).push(handler) },
    inject: (deps, callback) => { lifecycle.injects.push(deps) },
    effect: (fn) => { lifecycle.effects += 1; const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    subagents: {
      startActivation: async (spec) => {
        activations.push(spec)
        return { childId: spec.childId, result: Promise.resolve({ output: 'ok' }), dispose: async () => {} }
      },
      sendMessage: async (sender, targetId, content, options) => {
        messages.push({ sender, targetId, content, options })
        return 'message-1'
      },
    },
    agents: { get: () => undefined, list: () => [] },
  }
  const deps = createToolDeps(ctx, registry, bus)
  registerTools(ctx, registry, bus)
  function dispose() {
    try { db.close() } catch (error) { /* closed */ }
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { /* best effort */ }
  }
  return { root, db, registry, bus, ctx, deps, registrations, activations, messages, listeners, lifecycle, dispose }
}

function agentFor(sessionId, cwd, preset, extraHeader) {
  return { session: { id: sessionId, header: { cwd, agentPreset: preset, ...(extraHeader || {}) } } }
}

function toolRegistration(env, name) {
  const found = env.registrations.find((item) => item.definition.name === name)
  assert.ok(found, '工具应已注册：' + name)
  return found
}

async function callTool(env, name, args, agent) {
  const reg = toolRegistration(env, name)
  return reg.definition.execute(args, { agent, signal: new AbortController().signal })
}

function visibleToolNames(env, agent) {
  return env.registrations
    .filter((item) => {
      try { return item.options.when({ agent }) === true } catch (error) { return false }
    })
    .map((item) => item.definition.name)
    .sort()
}

function createPm(env) {
  const row = store.createSession(env.db, { kind: 'pm', dshSessionId: 'dsh-pm-1', provider: 'deepseek', model: 'deepseek-v4' })
  const agent = agentFor('dsh-pm-1', env.root, 'project-office')
  return { row, agent }
}

function createSlice(env, key) {
  return store.createSlice(env.db, { key: key || 'pay-refund', title: '支付退款', type: 'workitem' })
}

function createTaskSession(env, slice) {
  const name = '码农-' + slice.key + '-实现'
  const row = store.createSession(env.db, {
    name,
    kind: 'task',
    role: '码农',
    sliceId: slice.id,
    dshSessionId: 'dsh-task-1',
    provider: 'deepseek',
    model: 'deepseek-v4',
    context: { taskId: undefined },
  })
  leases.acquireLease(env.db, { sliceId: slice.id, sessionId: row.id, reason: 'test' })
  return { row, agent: agentFor('dsh-task-1', env.root, 'project-task') }
}

function assertToolError(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error && error.code, code, '期望错误 code=' + code + '，实际 ' + (error && error.code) + ' / ' + (error && error.message))
    return true
  })
}

test('工具清单与契约 §7 一致（26 个，含文件回填索引 file_index），且都带 JSON Schema 参数与输出声明', (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const catalog = toolCatalog(env.ctx, env.deps)
  assert.deepEqual(catalog.map((item) => item.name).sort(), EXPECTED_TOOLS.slice().sort())
  assert.equal(env.registrations.length, EXPECTED_TOOLS.length)
  for (const item of env.registrations) {
    const definition = item.definition
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof item.options.when, 'function')
  }
})

test('when 过滤：PM 看 22 个、任务会话看 15 个、普通/子 agent 看 0 个', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const pmVisible = visibleToolNames(env, pm.agent)
  assert.equal(pmVisible.length, 22)
  assert.ok(pmVisible.includes('session_spawn_task'))
  assert.ok(pmVisible.includes('project_status'))
  assert.ok(pmVisible.includes('gate_submit'))
  assert.ok(pmVisible.includes('file_index'), 'PM 应能看到 file_index（文件回填索引）')
  for (const hidden of ['doc_write', 'evidence_add', 'session_task_report', 'session_finish_task']) {
    assert.ok(!pmVisible.includes(hidden), 'PM 不应看到 ' + hidden)
  }
  const taskVisible = visibleToolNames(env, task.agent)
  assert.equal(taskVisible.length, 15)
  assert.ok(taskVisible.includes('doc_write'))
  assert.ok(taskVisible.includes('session_finish_task'))
  for (const hidden of ['session_spawn_task', 'session_send_task', 'gate_submit', 'export_project', 'project_init']) {
    assert.ok(!taskVisible.includes(hidden), '任务会话不应看到 ' + hidden)
  }
  // 非项目会话（standard preset）与子 agent 整组隐藏
  const plain = agentFor('dsh-plain', env.root, 'standard')
  assert.deepEqual(visibleToolNames(env, plain), [])
  const sub = agentFor('dsh-sub', env.root, 'project-task', { origin: 'subagent' })
  assert.deepEqual(visibleToolNames(env, sub), [])
  // 未登记/已结束会话执行工具 → NOT_PROJECT_SESSION
  await assertToolError(callTool(env, 'project_status', {}, plain), 'NOT_PROJECT_SESSION')
  store.endSession(env.db, { id: task.row.id, status: 'done' })
  // 会话结束后即使 actor 有正缓存，execute 里的读路径也会复核 DB status === 'active'
  await assertToolError(callTool(env, 'project_status', {}, task.agent), 'NOT_PROJECT_SESSION')
})

test('DSH 子会话头不遮蔽任务会话身份（origin=subagent 但 sessions 行 kind=task 仍可见工具）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  // 工作台任务会话同样由 DSH startActivation 创建 → header.origin='subagent'、delegationDepth=1。
  // 身份以项目 sessions 表的 dsh_session_id 行为准，不能被 DSH 的子会话头遮蔽。
  const row = store.createSession(env.db, {
    name: '测试-pay-refund-回归',
    kind: 'task',
    role: '测试',
    sliceId: slice.id,
    dshSessionId: 'dsh-task-sub',
  })
  assert.ok(row.id)
  const taskAgent = agentFor('dsh-task-sub', env.root, 'project-task', { origin: 'subagent', delegationDepth: 1, parentSession: 'dsh-pm-1' })
  const visible = visibleToolNames(env, taskAgent)
  assert.ok(visible.includes('doc_write'))
  assert.ok(visible.includes('session_finish_task'))
  assert.ok(!visible.includes('session_spawn_task'))
  // 任务会话自己拉起的临时子 agent：没有项目登记行 → 整组隐藏
  const childAgent = agentFor('dsh-sub-child', env.root, 'project-task', { origin: 'subagent', delegationDepth: 2, parentSession: 'dsh-task-sub' })
  assert.deepEqual(visibleToolNames(env, childAgent), [])
})

test('PM 派任务：session_spawn_task 写 sessions 行 + 租约 + project-task activation', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const result = await callTool(env, 'session_spawn_task', {
    role: '产品',
    sliceKey: 'pay-refund',
    action: 'PRD',
    prompt: '写支付退款 PRD：范围、验收、边界。',
    provider: 'deepseek',
    model: 'deepseek-v4',
  }, pm.agent)
  assert.equal(result.name, '产品-pay-refund-PRD')
  assert.ok(result.dshSessionId)
  const row = store.getSession(env.db, result.session.id)
  assert.equal(row.kind, 'task')
  assert.equal(row.role, '产品')
  assert.equal(row.status, 'active')
  assert.equal(row.sliceId, slice.id)
  const lease = leases.getLease(env.db, slice.id)
  assert.ok(lease)
  assert.equal(lease.sessionId, row.id)
  // activation 参数：project-task preset、childId、parent、prompt 含角色卡与切片简报
  assert.equal(env.activations.length, 1)
  const spec = env.activations[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.childId, result.dshSessionId)
  assert.equal(spec.request.agentPreset, 'project-task')
  assert.equal(spec.request.parent, pm.agent)
  assert.equal(spec.request.agentOptions.provider, 'deepseek')
  const promptText = spec.request.prompt[0].text
  assert.ok(promptText.includes('角色卡'))
  assert.ok(promptText.includes('支付退款'))
  assert.ok(promptText.includes('session_finish_task'))
  assert.ok(promptText.includes('产品'))
  // 重复派活：同(切片,角色) active → DUPLICATE_ACTIVE_SESSION
  await assertToolError(callTool(env, 'session_spawn_task', {
    role: '产品', sliceKey: 'pay-refund', action: 'PRD-2', prompt: '再来一份',
  }, pm.agent), 'DUPLICATE_ACTIVE_SESSION')
  // PM → 任务消息投递
  const sent = await callTool(env, 'session_send_task', { sessionId: row.id, message: '补充：退款需支持部分退款' }, pm.agent)
  assert.equal(sent.delivered, true)
  assert.equal(env.messages.length, 1)
  assert.equal(env.messages[0].targetId, result.dshSessionId)
  assert.equal(env.messages[0].content[0].type, 'text')
  // 任务会话无权派活
  const taskAgent = agentFor(result.dshSessionId, env.root, 'project-task')
  await assertToolError(callTool(env, 'session_spawn_task', {
    role: 'UX', sliceKey: 'pay-refund', action: '交互', prompt: 'x',
  }, taskAgent), 'PERMISSION_DENIED')
})

test('任务会话：doc_write 版本链/冻结拒写 + 证据 + 收工硬校验', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  // 首版
  const first = await callTool(env, 'doc_write', {
    mode: 'create', type: 'prd', logicalKey: 'prd/pay-refund', title: '退款 PRD', content: '# 退款 PRD\n\n## 背景\n支付要能退款。\n',
  }, task.agent)
  assert.equal(first.created, true)
  assert.equal(first.version, 1)
  // 新版本
  const second = await callTool(env, 'doc_write', {
    docId: first.doc.id, content: '# 退款 PRD\n\n## 背景\n支付要能退款（含部分退款）。\n',
  }, task.agent)
  assert.equal(second.version, 2)
  assert.equal(second.created, true)
  // 同内容幂等：不新增版本
  const same = await callTool(env, 'doc_write', {
    docId: first.doc.id, content: '# 退款 PRD\n\n## 背景\n支付要能退款（含部分退款）。\n',
  }, task.agent)
  assert.equal(same.created, false)
  assert.equal(same.version, 2)
  // 冻结后拒写
  await callTool(env, 'doc_freeze', { docId: first.doc.id }, task.agent)
  await assertToolError(callTool(env, 'doc_write', { docId: first.doc.id, content: '# 新内容' }, task.agent), 'DOC_FROZEN')
  // 收工：无证据 → NO_EVIDENCE
  await assertToolError(callTool(env, 'session_finish_task', {
    status: 'done', handoff: '实现完成', noOutOfScopeChanges: true,
  }, task.agent), 'NO_EVIDENCE')
  // 证据
  const evidence = await callTool(env, 'evidence_add', {
    kind: 'test', command: 'node --test', resultSummary: '12 passed, 0 failed',
  }, task.agent)
  assert.ok(evidence.evidence.id)
  // 片外零改动声明缺失 → INVALID
  await assertToolError(callTool(env, 'session_finish_task', {
    status: 'done', handoff: '实现完成', evidenceIds: [evidence.evidence.id],
  }, task.agent), 'INVALID')
  // 正常收工
  const finished = await callTool(env, 'session_finish_task', {
    status: 'done',
    handoff: '实现退款接口；测试通过；遗留：无。',
    evidenceIds: [evidence.evidence.id],
    files: ['src/refund.js', 'tests/refund.test.js'],
    noOutOfScopeChanges: true,
  }, task.agent)
  assert.equal(finished.finished, true)
  assert.equal(finished.evidenceCount, 1)
  assert.deepEqual(finished.files, ['src/refund.js', 'tests/refund.test.js'])
  const ended = store.getSession(env.db, task.row.id)
  assert.equal(ended.status, 'done')
  assert.equal(leases.getLease(env.db, slice.id), undefined)
  // handoff 文档已写入
  const handoffDoc = env.db.db.prepare("SELECT * FROM documents WHERE project_id = ? AND type = 'handoff' LIMIT 1").get(env.db.projectId)
  assert.ok(handoffDoc)
  // PM 已收到收工通知
  assert.ok(env.messages.length >= 1)
})

test('PM 决策与门禁：decision_create + gate_submit 生成 pending approval', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const decision = await callTool(env, 'decision_create', {
    title: '退款走异步还是同步',
    question: '退款接口同步返回还是异步回调？',
    options: ['同步', '异步'],
    recommended: '异步（渠道延迟不可控）',
    consequences: '选同步会导致超时与重试风暴',
    irreversible: false,
    sliceId: slice.id,
  }, pm.agent)
  assert.equal(decision.decision.status, 'pending')
  assert.equal(decision.decision.options.length, 2)
  // 门禁需要一个文档 + 证据
  const doc = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n', sliceId: slice.id }, { session: null })
    .catch(() => undefined) // PM 不能写文档：先建 task 会话再写
  assert.equal(doc, undefined)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n\n验收：可退款\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: 'PRD 评审通过' }, task.agent)
  const gate = await callTool(env, 'gate_submit', {
    gate: 'G1',
    docIds: [written.doc.id],
    evidenceIds: [evidence.evidence.id],
    summary: 'PRD v1 完成，评审通过，申请 G1。',
  }, pm.agent)
  assert.ok(gate.approvalId)
  assert.equal(gate.decision.kind, 'gate')
  assert.equal(gate.decision.irreversible, true)
  const approval = env.db.db.prepare('SELECT * FROM approvals WHERE id = ?').get(gate.approvalId)
  assert.equal(approval.status, 'pending')
  assert.equal(approval.gate, 'G1')
  // 门禁提交缺证据 → NO_EVIDENCE
  await assertToolError(callTool(env, 'gate_submit', { gate: 'G2', docIds: [], evidenceIds: [], summary: 'x' }, pm.agent), 'NO_EVIDENCE')
})

test('2k 上下文：预算内不降级；构造大切片内容时降级且硬上限 2000', (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const bigAcceptance = { criteria: Array.from({ length: 40 }, function (_item, index) { return '验收项' + index + '：' + '退款金额/状态/幂等/对账必须可复核。'.repeat(20) }).join(' ') }
  const slice = store.createSlice(env.db, { key: 'big-slice', title: '超大切片验证', acceptance: bigAcceptance })
  // 大 handoff + 多篇长文档 + 大量事件
  store.updateSliceStatus(env.db, { id: slice.id, currentHandoff: '交接摘要：' + '退款细节与边界条件。'.repeat(200) })
  for (let index = 0; index < 6; index += 1) {
    const doc = env.db.tx(function () {
      return env.db.db.prepare('SELECT 1').get()
    })
    void doc
    const document = env.db.db.prepare("INSERT INTO documents(id, project_id, slice_id, type, logical_key, title, status, current_version, owner_session, stage, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    const at = new Date().toISOString()
    document.run('doc-big-' + index, env.db.projectId, slice.id, 'prd', 'prd/big-' + index, '大文档 ' + index, 'draft', 1, null, 'S1', at, at)
    env.db.db.prepare('INSERT INTO doc_versions(id, document_id, version, content, content_hash, author_session, event_id, frozen, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('docv-big-' + index, 'doc-big-' + index, 1, '# 大文档\n\n' + '这是一篇很长的文档正文，用于验证 2k 预算裁剪。'.repeat(80), 'hash-' + index, null, null, 0, at)
  }
  for (let index = 0; index < 12; index += 1) {
    env.db.tx(function () {
      env.db.appendEvent({ kind: 'slice/status', sliceId: slice.id, subjectType: 'slice', subjectId: slice.id, payload: { index: index, note: '事件正文'.repeat(20) } })
    })
  }
  const normal = compileContext(env.db, { roleKind: 'pm' })
  assert.ok(normal.used <= 2000)
  assert.equal(normal.degraded, false)
  const task = compileContext(env.db, { roleKind: 'task', role: '码农', sliceId: slice.id })
  assert.ok(task.used <= 2000, '硬上限 2000，实际 ' + task.used)
  assert.equal(task.degraded, true)
  assert.ok(task.text.includes('上下文已降级'), '降级时必须注入提示行')
  assert.ok(estimateTokens(task.parts.l2) <= 900)
  assert.ok(estimateTokens(task.parts.l0) <= 400)
  assert.ok(normal.text.includes('工作台 L0'))
})

test('session-hooks：PM 会话登记/模型同步/任务会话 disposed 标 interrupted', (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const hooksResult = registerSessionHooks(env.ctx, env.registry, env.bus)
  assert.ok(hooksResult && typeof hooksResult.interrupted === 'number')
  assert.ok(Array.isArray(env.listeners['session/created']))
  assert.ok(Array.isArray(env.listeners['session/event']))
  assert.ok(Array.isArray(env.listeners['agent/pre-step']))
  assert.ok(Array.isArray(env.listeners['session/disposed']))
  // 1) PM 会话创建：自动初始化项目 + 登记 kind=pm 行
  const pmSession = { id: 'dsh-pm-new', header: { cwd: env.root, agentPreset: 'project-office' } }
  env.listeners['session/created'][0](pmSession)
  const pmRows = store.listSessions(env.db, { kind: 'pm', status: 'active' })
  assert.equal(pmRows.length, 1)
  assert.equal(pmRows[0].dshSessionId, 'dsh-pm-new')
  assert.equal(pmRows[0].name, '项目办公室')
  // 2) model/selection：同步 sessions.provider/model（不写事件噪音）
  env.listeners['session/event'][0](pmSession, { type: 'model/selection', data: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' } })
  const synced = store.getSession(env.db, pmRows[0].id)
  assert.equal(synced.provider, 'deepseek')
  assert.equal(synced.model, 'deepseek-v4')
  assert.equal(synced.reasoningEffort, 'high')
  // 3) 任务会话创建（DSH origin=subagent 也要绑定预登记行）+ disposed → interrupted
  const slice = createSlice(env)
  const taskRow = store.createSession(env.db, { name: '码农-pay-refund-实现', kind: 'task', role: '码农', sliceId: slice.id, dshSessionId: 'dsh-task-hook' })
  const taskSession = { id: 'dsh-task-hook', header: { cwd: env.root, agentPreset: 'project-task', origin: 'subagent', delegationDepth: 1, parentSession: 'dsh-pm-new' } }
  env.listeners['session/created'][0](taskSession)
  env.listeners['session/disposed'][0](taskSession)
  const interrupted = store.getSession(env.db, taskRow.id)
  assert.equal(interrupted.status, 'interrupted')
})

test('注入状态机：首步注入 L1/L2，切切片后重新注入', (t) => {
  resetInjectionState()
  t.after(() => resetInjectionState())
  markSessionStartInjection('dsh-state', 'slice-1')
  assert.equal(pendingFullInjection('dsh-state'), true)
  // 首步 pre-step：L1/L2 已在组装时注入，pre-step 落账
  noteStep('dsh-state', { step: 1, sliceId: 'slice-1' })
  assert.equal(injectionDiagnostics('dsh-state').pendingFull, true)
  consumeFullInjection('dsh-state', 'slice-1')
  assert.equal(pendingFullInjection('dsh-state'), false)
  // 同切片后续步骤不再注入
  noteStep('dsh-state', { step: 2, sliceId: 'slice-1' })
  assert.equal(pendingFullInjection('dsh-state'), false)
  // 切切片：下一次注入 L1/L2
  noteStep('dsh-state', { step: 3, sliceId: 'slice-2' })
  assert.equal(pendingFullInjection('dsh-state'), true)
  consumeFullInjection('dsh-state', 'slice-2')
  assert.equal(pendingFullInjection('dsh-state'), false)
})
test('工具输出必须是 lossless JSON（真实运行发现：undefined 会让调用失败）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  // 1) 每个注册工具的执行结果都能 JSON.stringify 后再解析且不丢字段类型
  const status = await callTool(env, 'project_status', {}, pm.agent)
  const round = JSON.parse(JSON.stringify(status))
  assert.deepEqual(round, status)
  // 2) 含可选字段（handoff/assignee 常为 undefined）的对象也必须干净
  const listed = await callTool(env, 'slice_list', {}, pm.agent)
  assert.deepEqual(JSON.parse(JSON.stringify(listed)), listed)
  const tasks = await callTool(env, 'task_list', {}, pm.agent)
  assert.deepEqual(JSON.parse(JSON.stringify(tasks)), tasks)
  // 3) 直接构造带 undefined/Date/循环引用的值，清洗后是纯 JSON
  const { toLosslessJson } = await import('../../host/tools/register.js')
  const circular = { a: 1, when: new Date('2026-01-02T03:04:05.000Z') }
  circular.self = circular
  circular.missing = undefined
  circular.fn = () => 1
  const clean = toLosslessJson(circular)
  assert.equal(clean.a, 1)
  assert.equal(clean.when, '2026-01-02T03:04:05.000Z')
  assert.equal(clean.self, '[circular]')
  assert.ok(!('missing' in clean))
  assert.ok(!('fn' in clean))
  assert.deepEqual(JSON.parse(JSON.stringify(clean)), clean)
})

test('角色卡 L1 注入：8 个角色都有完整文案，且不出现 undefined', async (t) => {
  const roles = await import('../../host/roles.js')
  const words = ['PM', ...roles.TASK_ROLES]
  assert.equal(words.length, 8, 'PM + 7 个任务角色')
  for (const word of words) {
    const text = roles.roleCardText(word)
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 40, word + ' 的角色卡应非空')
    assert.ok(!text.includes('undefined'), word + ' 的角色卡不得出现 undefined: ' + text.slice(0, 120))
    assert.ok(text.startsWith('角色：'), word + ' 应以「角色：」开头')
    assert.ok(text.includes('开工：') && text.includes('收工：'), word + ' 应包含开工/收工清单')
    assert.ok(text.includes('红线：'), word + ' 应包含红线')
  }
  // PM 卡的角色词是 PM，任务卡用词表 key
  assert.ok(roles.roleCardText('PM').startsWith('角色：PM（'))
  assert.ok(roles.roleCardText('码农').startsWith('角色：码农（'))
  // 未知角色返回空串（不注入垃圾）
  assert.equal(roles.roleCardText('不存在的角色'), '')
  // L1 与实际编译出的上下文一致（compileContext 走同一条路径）
  const { compileContext } = await import('../../host/context.js')
  const { ProjectDb } = await import('../../host/db.js')
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const root = mkdtempSync(join(HERE, '.tmp-roles-'))
  t.after(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })
  const db = new ProjectDb(join(root, '.project', 'project.db'), { projectId: 'proj-roles', projectName: '回归', root })
  db.tx(() => db.appendEvent({ kind: 'project/init' }))
  const compiled = compileContext(db, { roleKind: 'task', role: '测试', includeL1: true, includeL2: false })
  assert.ok(!compiled.parts.l1.includes('undefined'), 'L1 编译结果不得含 undefined')
  assert.ok(compiled.used <= 2000, '2k 硬上限')
})
