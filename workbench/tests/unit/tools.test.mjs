// T4 工具层单测（fake ctx / 真实 ProjectDb + store/docs/leases 领域模块）
// 运行：node --test workbench/tests/unit/tools.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { ensureDir as H_ensureDir } from '../e2e/harness.mjs'
const H = { ensureDir: H_ensureDir }
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
  'period_roll', 'session_spawn_qa', 'session_spawn_task', 'session_task_report', 'slice_create',
  'slice_list', 'slice_scope', 'slice_update', 'slice_verify', 'task_create', 'task_list', 'task_update',
  'weekly_report',
]

/**
 * 校验一个入参是否是 DSH 真正接受的 SubagentActivationSpec。
 * 契约来源：@deepseek-ai/dsh-subagent 0.2.2-rc.5 lib/types/index.js 的
 *   SubagentActivationSpec extends Omit<SubagentStartRequest,'label'|'signal'>
 *   { provider, label, signal, delivery, childId?, name? }
 * 其中 SubagentStartRequest = { cwd?, agentPreset?, label?, prompt, parent, signal, agentOptions?, outputSchema?, maxDepth? }。
 * 关键点：prompt / parent 是**顶层**字段，不存在 request 包装层。
 */
function assertSubagentActivationSpec(spec) {
  assert.ok(spec && typeof spec === 'object', 'startActivation 必须收到 spec 对象')
  if (spec.request !== undefined) {
    throw new Error('startActivation 不能收到 request 包装层：prompt/parent/agentPreset 必须是顶层字段（DSH 会读 spec.parent，包装后为 undefined）')
  }
  assert.equal(typeof spec.provider, 'string', 'spec.provider 必填')
  assert.equal(typeof spec.label, 'string', 'spec.label 必填')
  assert.ok(spec.signal instanceof AbortSignal || (spec.signal && typeof spec.signal.addEventListener === 'function'), 'spec.signal 必填')
  assert.ok(spec.delivery === 'parent' || spec.delivery === 'caller', 'spec.delivery 必须是 parent/caller')
  assert.ok(Array.isArray(spec.prompt) && spec.prompt.length > 0, 'spec.prompt 必须是非空内容块数组')
  assert.ok(spec.parent && spec.parent.session && typeof spec.parent.session.id === 'string', 'spec.parent 必须是带 session.id 的 Agent')
}

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
      // 严格 mock：按 @deepseek-ai/dsh-subagent 的 SubagentActivationSpec 契约校验入参。
      // 为什么必须严格：真实 manager.startLocal 第一行就是 `const parent = spec.parent`，
      // 少了 parent 会在那一行抛 TypeError；旧 mock 什么都收，于是 123 个用例全绿而线上派活 100% 失败。
      startActivation: async (spec) => {
        assertSubagentActivationSpec(spec)
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

function createQaSession(env, slice) {
  const name = '验收-' + slice.key + '-验收'
  const row = store.createSession(env.db, {
    name,
    kind: 'qa',
    role: '测试',
    sliceId: slice.id,
    dshSessionId: 'dsh-qa-1',
  })
  return { row, agent: agentFor('dsh-qa-1', env.root, 'project-qa') }
}

function assertToolError(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error && error.code, code, '期望错误 code=' + code + '，实际 ' + (error && error.code) + ' / ' + (error && error.message))
    return true
  })
}

test('工具清单与契约一致（31 个，含 v4 的 slice_scope 与 v5 的 slice_verify/session_spawn_qa/period_roll/weekly_report），且都带 JSON Schema 参数与输出声明', (t) => {
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

test('when 过滤：PM 看 27 个、任务会话看 15 个、验收会话看 9 个、普通/子 agent 看 0 个', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const pmVisible = visibleToolNames(env, pm.agent)
  assert.equal(pmVisible.length, 27)
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
  for (const hidden of ['session_spawn_task', 'session_send_task', 'gate_submit', 'export_project', 'project_init', 'slice_verify']) {
    assert.ok(!taskVisible.includes(hidden), '任务会话不应看到 ' + hidden)
  }
  // v5：验收会话的工具面必须窄 —— 能读、能记证据、能签字，但**不能写文档/收工**。
  const qa = createQaSession(env, slice)
  const qaVisible = visibleToolNames(env, qa.agent)
  assert.deepEqual(qaVisible.slice().sort(), [
    'doc_get', 'doc_list', 'evidence_add', 'project_brief', 'project_recall',
    'project_status', 'slice_list', 'slice_verify', 'task_list',
  ])
  for (const hidden of ['doc_write', 'doc_freeze', 'session_finish_task', 'session_task_report', 'gate_submit', 'slice_create']) {
    assert.ok(!qaVisible.includes(hidden), '验收会话不应看到 ' + hidden)
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
  assert.equal(spec.agentPreset, 'project-task')
  assert.equal(spec.parent, pm.agent)
  assert.equal(spec.agentOptions.provider, 'deepseek')
  const promptText = spec.prompt[0].text
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

test('回归：session_spawn_task 的 spec 必须能被真实 DSH manager 直接消费（不得有 request 包装）', async (t) => {
  // 事故：2026-11-23 线上 session_spawn_task 100% 失败，报 "Cannot read properties of undefined (reading 'id')"。
  // 根因：调用方把 prompt/parent/agentPreset 包进了 { request: {...} }，而
  // @deepseek-ai/dsh-subagent 的 SubagentActivationSpec 要求它们是顶层字段；
  // manager.startLocal 第一行 const parent = spec.parent 拿到 undefined，下一行 parent.session.id 抛 TypeError。
  // 之所以能带着这个 bug 上线：测试里的 mock 照单全收，把错误的形状固化成了断言。
  // 这个用例存在，就是为了让 mocks 再也不能"宽容"地吃掉形状错误。
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const result = await callTool(env, 'session_spawn_task', {
    role: '架构', sliceKey: 'pay-refund', action: '连通性自检', prompt: '只回一句话。',
  }, pm.agent)
  assert.ok(result.dshSessionId)
  const spec = env.activations[0]
  // 1) 无包装层
  assert.equal(spec.request, undefined, 'spec 不得有 request 包装层')
  // 2) DSH 真机会立即解引用这些字段
  assert.equal(typeof spec.parent.session.id, 'string', 'DSH 会读 spec.parent.session.id')
  assert.ok(Array.isArray(spec.prompt) && spec.prompt.length > 0, 'DSH 会读 spec.prompt')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.agentPreset, 'project-task')
  assert.equal(typeof spec.label, 'string')
  assert.ok(spec.childId, '预留 childId 才能后续 sendMessage/session_send_task')
})

test('回归：session_spawn_qa 同样不得用 request 包装（验收链会一起挂）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  await callTool(env, 'session_spawn_qa', { sliceId: slice.id, action: '验收', prompt: '复跑测试' }, pm.agent)
  const spec = env.activations[env.activations.length - 1]
  assert.equal(spec.request, undefined, 'spec 不得有 request 包装层')
  assert.equal(typeof spec.parent.session.id, 'string', 'DSH 会读 spec.parent.session.id')
  assert.ok(Array.isArray(spec.prompt) && spec.prompt.length > 0)
  assert.equal(spec.agentPreset, 'project-qa')
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

// ---------------------------------------------------------------------------
// P1 修复回归：门禁状态机 + 收工租约（独立审查 business-logic-review.zh.md 的 4 条）
// 这些用例锁住「拒绝」本身——不是看它跑通，而是看它在该拒绝的时候确实拒绝了。
// ---------------------------------------------------------------------------

/** 造一个带阶段机的项目（gate_submit 需要 active 阶段 + 阶段门禁匹配）。 */
function projectWithStages(env) {
  const rows = [
    { key: 'S1', name: '产品', gate: 'G1' },
    { key: 'S2', name: 'UX', gate: 'G2' },
    { key: 'S3', name: '架构', gate: 'G3' },
  ]
  env.db.tx(function () {
    rows.forEach(function (row, index) {
      env.db.db.prepare('INSERT INTO stages(id, project_id, key, name, status, gate, position) VALUES (?,?,?,?,?,?,?)')
        .run('stage-' + row.key, env.db.projectId, row.key, row.name, index === 0 ? 'active' : 'pending', row.gate, index + 1)
    })
  })
}

test('P1 门禁：不能把门禁提交给未来阶段（否则会出现两个 active 阶段）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: 'PRD 评审通过' }, task.agent)
  // 当前 active 是 S1/G1：提交到 S3/G3 必须被拒
  await assertToolError(callTool(env, 'gate_submit', {
    gate: 'G3', stage: 'S3', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '跳过前两个阶段',
  }, pm.agent), 'GATE_STAGE_INVALID')
  const activeCount = env.db.db.prepare("SELECT COUNT(*) AS c FROM stages WHERE status = 'active'").get().c
  assert.equal(Number(activeCount), 1, '拒绝后阶段状态不应变化')
})

test('P1 门禁：gate 与当前阶段不匹配被拒', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  // 当前是 S1（门禁 G1），提交 G2 应被拒
  await assertToolError(callTool(env, 'gate_submit', {
    gate: 'G2', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '门禁错配',
  }, pm.agent), 'GATE_STAGE_INVALID')
})

test('P1 门禁：批准时按「提交时的文档集合」冻结，不按 stage 现场重查', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const submitted = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '被提交的 PRD', content: '# 提交的\n' }, task.agent)
  // 同一阶段下另一篇「未被提交」的文档
  const other = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '未被提交的 PRD', content: '# 没提交\n', logicalKey: 'prd/other' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  const gate = await callTool(env, 'gate_submit', {
    gate: 'G1', docIds: [submitted.doc.id], evidenceIds: [evidence.evidence.id], summary: '只提交一篇',
  }, pm.agent)
  const project = await import('../../host/project.js')
  const result = await project.resolveDecisionAction(env.ctx, env.db, { id: gate.decision.id, status: 'approved', confirmed: true }, { root: env.root })
  const frozenIds = result.actions.frozenDocs.map(function (item) { return item.docId })
  assert.deepEqual(frozenIds, [submitted.doc.id], '只应冻结提交的那一篇')
  assert.ok(!frozenIds.includes(other.doc.id), '未被提交的同阶段文档不得被冻结')
  const otherRow = env.db.db.prepare('SELECT status FROM documents WHERE id = ?').get(other.doc.id)
  assert.equal(otherRow.status !== 'frozen', true, '未提交文档应保持原状态')
})

test('P1 门禁：提交后文档改版 → 批准被拒并要求重新提交（STALE_APPROVAL）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# v1\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  const gate = await callTool(env, 'gate_submit', {
    gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '提交 v1',
  }, pm.agent)
  // 提交后追加 v2（未经审批的内容）
  await callTool(env, 'doc_write', { mode: 'new-version', docId: written.doc.id, content: '# v2 未审批的改动\n' }, task.agent)
  const project = await import('../../host/project.js')
  let caught
  try {
    await project.resolveDecisionAction(env.ctx, env.db, { id: gate.decision.id, status: 'approved', confirmed: true }, { root: env.root })
  } catch (error) { caught = error }
  assert.ok(caught, '改版后批准应被拒')
  assert.equal(caught.code, 'STALE_APPROVAL')
  const decision = env.db.db.prepare('SELECT status FROM decisions WHERE id = ?').get(gate.decision.id)
  assert.equal(decision.status, 'pending', '被拒后决策应仍为 pending（未落定）')
})

test('P1 收工：租约被他人接管后不得再收工写库（LEASE_HELD）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const slice = createSlice(env)
  const first = createTaskSession(env, slice)
  const evidence = await callTool(env, 'evidence_add', { kind: 'test', resultSummary: '8/8 通过' }, first.agent)
  assert.ok(evidence.evidence.id)
  // B 会话抢占租约（A 的租约过期）
  const second = store.createSession(env.db, {
    name: '测试-' + slice.key + '-回归', kind: 'task', role: '测试', sliceId: slice.id, dshSessionId: 'dsh-task-2',
  })
  env.db.db.prepare('UPDATE leases SET expires_at = ? WHERE slice_id = ?').run(new Date(Date.now() - 60000).toISOString(), slice.id)
  leases.acquireLease(env.db, { sliceId: slice.id, sessionId: second.id, reason: '接管' })
  await assertToolError(callTool(env, 'session_finish_task', {
    handoff: '交接：我以为还能收工', noOutOfScopeChanges: true,
  }, first.agent), 'LEASE_HELD')
  const sliceRow = env.db.db.prepare('SELECT status FROM slices WHERE id = ?').get(slice.id)
  assert.notEqual(sliceRow.status, 'review', '被拒的收工不得改切片状态')
})

test('P1 收工：返回值取自实际记录（failed → blocked，不是硬编码 review）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  await callTool(env, 'evidence_add', { kind: 'test', resultSummary: '2/3 失败' }, task.agent)
  const finished = await callTool(env, 'session_finish_task', {
    status: 'failed', handoff: '交接：回归失败，转缺陷', noOutOfScopeChanges: true,
  }, task.agent)
  assert.equal(finished.status, 'failed')
  assert.equal(finished.slice.status, 'blocked', '返回值应来自 DB 实际状态')
  const row = env.db.db.prepare('SELECT status FROM slices WHERE id = ?').get(slice.id)
  assert.equal(row.status, 'blocked')
  assert.equal(finished.slice.status, row.status, '返回值与库内一致')
})

// ---------------------------------------------------------------------------
// 门禁判据（M2 最小切片）：机检不通过 → gate_submit 直接拒绝；通过 → 落一条 check 证据。
// 这是「门禁第一次由机器判」的那条线，必须锁死拒绝语义。
// ---------------------------------------------------------------------------

/** 在临时项目里放一个假的仓库检查器（模拟 tools/engineering/checker.mjs）。 */
function writeChecker(root, body) {
  const dir = join(root, 'tools', 'engineering')
  H.ensureDir(dir)
  const file = join(dir, 'checker.mjs')
  writeFileSync(file, body, 'utf8')
  const closeout = join(dir, 'closeout.mjs')
  writeFileSync(closeout, 'export function checkCloseout() { return { ok: true, issues: [] } }\n', 'utf8')
}

test('门禁判据：机检 FAIL → gate_submit 直接拒绝并带 issues 原文', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  writeChecker(env.root, [
    'export async function checkRepository() {',
    '  return { ok: false, issues: [{ code: "DIR_UNREGISTERED", path: ".project", message: "Directory is not registered." }], counts: {} }',
    '}',
  ].join('\n'))
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  let caught
  try {
    await callTool(env, 'gate_submit', { gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '提交' }, pm.agent)
  } catch (error) { caught = error }
  assert.ok(caught, '机检失败必须拒绝提交')
  assert.equal(caught.code, 'GATE_PRECHECK_FAILED')
  assert.equal(caught.details.issues[0].code, 'DIR_UNREGISTERED', '错误里要带判据原文')
  const approvals = env.db.db.prepare('SELECT COUNT(*) AS c FROM approvals').get().c
  assert.equal(Number(approvals), 0, '被拒的门禁不得留下 pending approval')
  const gates = env.db.db.prepare("SELECT COUNT(*) AS c FROM decisions WHERE kind = 'gate'").get().c
  assert.equal(Number(gates), 0, '被拒的门禁不得留下决策卡')
})

test('门禁判据：机检 PASS → 落 check 证据并允许生成 pending approval', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  writeChecker(env.root, [
    'export async function checkRepository() {',
    '  return { ok: true, issues: [], counts: { directories: 3, files: 10 } }',
    '}',
  ].join('\n'))
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  const gate = await callTool(env, 'gate_submit', { gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '提交' }, pm.agent)
  assert.ok(gate.approvalId)
  assert.equal(gate.machineCheck.ok, true)
  assert.equal(gate.machineCheck.skipped, false)
  const checkRows = env.db.db.prepare("SELECT * FROM evidence WHERE kind = 'check'").all()
  assert.equal(checkRows.length, 1, '机检结果应落一条 evidence')
  assert.match(String(checkRows[0].result_summary), /机检通过/)
  const snapshot = JSON.parse(env.db.db.prepare('SELECT snapshot_json FROM approvals WHERE id = ?').get(gate.approvalId).snapshot_json)
  assert.ok(Array.isArray(snapshot.checks) && snapshot.checks.length >= 1, '审批快照应记录机检明细')
  assert.ok(snapshot.evidenceIds.includes(checkRows[0].id), '机检证据应进入快照证据集')
})

test('门禁判据：判据模块跑不起来按失败处理（fail-closed，不静默通过）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  writeChecker(env.root, 'export async function checkRepository() { throw new Error("checker 炸了") }\n')
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# x\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  await assertToolError(callTool(env, 'gate_submit', { gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '提交' }, pm.agent), 'GATE_PRECHECK_FAILED')
})

test('门禁判据：没有判据文件时跳过机检但如实标注（不假装通过）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# x\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  const gate = await callTool(env, 'gate_submit', { gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '提交' }, pm.agent)
  assert.equal(gate.machineCheck.skipped, true)
  assert.equal(gate.machineCheck.reason, 'no-checker-executed')
  assert.match(String(gate.note), /未发现可用判据/)
})

// 真实判据：把 lumio 仓库里**现成的** tools/engineering/*.mjs 原样拷进临时项目再提交门禁。
// 这条用例证明的不是「模型/替身会拒绝」，而是「真实仓库的真实判据会让真实门禁代码拒绝」。
// 找不到真实仓库时跳过（CI/他机不应因此失败），并在 skip 原因里写明。
const LUMIO_ENGINEERING = 'C:/Users/oldap/Documents/lumio/tools/engineering'

test('真实判据：lumio 的 checker 让门禁真的红 → gate_submit 拒绝且不留 pending', async (t) => {
  let entries = []
  try { entries = await readdir(LUMIO_ENGINEERING) } catch { entries = [] }
  if (entries.length === 0) { t.skip('本机没有 lumio 仓库（' + LUMIO_ENGINEERING + '）'); return }
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  // 原样拷贝真实判据（checker.mjs + closeout.mjs + policy.json），不做任何改写。
  const target = join(env.root, 'tools', 'engineering')
  H.ensureDir(target)
  for (const name of ['checker.mjs', 'closeout.mjs', 'policy.json']) {
    try { copyFileSync(join(LUMIO_ENGINEERING, name), join(target, name)) } catch { /* 缺哪个就少哪个 */ }
  }
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  let caught
  try {
    await callTool(env, 'gate_submit', { gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '拿真实判据过门禁' }, pm.agent)
  } catch (error) { caught = error }
  assert.ok(caught, '真实判据红灯时门禁必须拒绝')
  assert.equal(caught.code, 'GATE_PRECHECK_FAILED')
  const issues = caught.details && caught.details.issues ? caught.details.issues : []
  assert.ok(issues.length > 0, '拒绝时必须带判据原文')
  // 断言的是「判据原文被带出来」这个语义，**不是某个具体判据码**。
  //
  // 为什么改：原来写死 DIR_UNREGISTERED，而 lumio 的 checker 在不同仓库状态下会先报别的码
  // （本轮实际先报 POLICY_INVALID/FILE_REQUIRED）。判据的规则会随仓库演进而变，
  // 测试锁具体码 = 每次判据升级都要改测试，最后没人敢动判据。
  // 真正要保证的是：拒绝原因来自机器、带 code、可追溯到具体检查项（check 字段）。
  assert.ok(issues.every((issue) => typeof issue.code === 'string' && issue.code.length > 0),
    '每条判据问题都必须带非空 code，实际：' + JSON.stringify(issues.map((i) => i.code)))
  assert.ok(issues.some((issue) => typeof issue.check === 'string' && issue.check.length > 0),
    '判据问题必须能追溯到是哪个 checker 报的，实际：' + JSON.stringify(issues.map((i) => i.check)))
  assert.equal(Number(env.db.db.prepare('SELECT COUNT(*) AS c FROM approvals').get().c), 0, '被拒后不得留 pending approval')
  assert.equal(Number(env.db.db.prepare("SELECT COUNT(*) AS c FROM decisions WHERE kind = 'gate'").get().c), 0, '被拒后不得留门禁决策卡')
})

// ---------------------------------------------------------------------------
// 批准时复跑判据（M2 收尾）：提交时绿 ≠ 批准时绿。
// 这三例锁住「门禁闭环」——批准的必须是刚刚被机器判过的那份现实。
// ---------------------------------------------------------------------------

/** 写一个内容可切换的判据（红灯/绿灯由 .verdict 文件决定）。 */
function writeToggleChecker(root) {
  const dir = join(root, 'tools', 'engineering')
  H.ensureDir(dir)
  writeFileSync(join(root, 'tools', 'engineering', '.verdict'), 'ok', 'utf8')
  writeFileSync(join(dir, 'checker.mjs'), [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'export async function checkRepository(root) {',
    "  const file = path.join(root, 'tools', 'engineering', '.verdict')",
    "  let verdict = 'ok'",
    '  try { verdict = fs.readFileSync(file, "utf8").trim() } catch { /* 默认绿灯 */ }',
    '  if (verdict === "ok") return { ok: true, issues: [], counts: { files: 1 } }',
    '  return { ok: false, issues: [{ code: "SUBMITTED_DRIFT", path: ".", message: "提交后仓库变脏" }], counts: { files: 1 } }',
    '}',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'closeout.mjs'), 'export function checkCloseout() { return { ok: true, issues: [] } }\n', 'utf8')
}

/** 提交一个门禁（此时是绿的），返回 { pm, gate }。 */
async function submitGreenGate(env) {
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const written = await callTool(env, 'doc_write', { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款 PRD\n' }, task.agent)
  const evidence = await callTool(env, 'evidence_add', { kind: 'review', resultSummary: '评审通过' }, task.agent)
  const gate = await callTool(env, 'gate_submit', { gate: 'G1', docIds: [written.doc.id], evidenceIds: [evidence.evidence.id], summary: '提交' }, pm.agent)
  return { pm, gate, doc: written.doc }
}

test('批准时复跑判据：提交后变红 → 批准被拒（STALE_PRECHECK），阶段不动', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  writeToggleChecker(env.root)
  const { gate } = await submitGreenGate(env)
  // 提交之后仓库变脏
  writeFileSync(join(env.root, 'tools', 'engineering', '.verdict'), 'fail', 'utf8')
  const project = await import('../../host/project.js')
  let caught
  try {
    await project.resolveDecisionAction(env.ctx, env.db, { id: gate.decision.id, status: 'approved', confirmed: true }, { root: env.root })
  } catch (error) { caught = error }
  assert.ok(caught, '判据变红后批准必须被拒')
  assert.equal(caught.code, 'STALE_PRECHECK')
  assert.ok(Array.isArray(caught.issues) && caught.issues.some((i) => i.code === 'SUBMITTED_DRIFT'), '应带判据原文')
  const decision = env.db.db.prepare('SELECT status FROM decisions WHERE id = ?').get(gate.decision.id)
  assert.equal(decision.status, 'pending', '被拒后决策应仍 pending')
  const stage = env.db.db.prepare("SELECT key FROM stages WHERE status = 'active'").get()
  assert.equal(stage.key, 'S1', '被拒后阶段不得推进')
  const frozen = env.db.db.prepare("SELECT COUNT(*) AS c FROM doc_versions WHERE frozen = 1").get().c
  assert.equal(Number(frozen), 0, '被拒后不得冻结任何文档')
})

test('批准时复跑判据：提交后仓库规模变化（hash 漂移）→ 批准被拒', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  // 判据读 .count 决定 counts（结论一直是 ok，但 hash 会变）
  const dir = join(env.root, 'tools', 'engineering')
  H.ensureDir(dir)
  writeFileSync(join(env.root, 'tools', 'engineering', '.count'), '1', 'utf8')
  writeFileSync(join(dir, 'checker.mjs'), [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'export async function checkRepository(root) {',
    "  let files = 1",
    '  try { files = Number(fs.readFileSync(path.join(root, "tools", "engineering", ".count"), "utf8").trim()) } catch { /* 默认 1 */ }',
    '  return { ok: true, issues: [], counts: { files } }',
    '}',
  ].join('\n'), 'utf8')
  writeFileSync(join(dir, 'closeout.mjs'), 'export function checkCloseout() { return { ok: true, issues: [] } }\n', 'utf8')
  const { gate } = await submitGreenGate(env)
  // 仍绿，但判定依据变了
  writeFileSync(join(env.root, 'tools', 'engineering', '.count'), '42', 'utf8')
  const project = await import('../../host/project.js')
  let caught
  try {
    await project.resolveDecisionAction(env.ctx, env.db, { id: gate.decision.id, status: 'approved', confirmed: true }, { root: env.root })
  } catch (error) { caught = error }
  assert.ok(caught, '结果漂移后批准必须被拒')
  assert.equal(caught.code, 'STALE_PRECHECK')
  assert.ok(Array.isArray(caught.issues) && caught.issues.some((i) => i.reason === 'result-changed'), '应报告 result-changed')
})

test('批准时复跑判据：提交后仍一致 → 放行且把复跑结果写进审批', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  projectWithStages(env)
  writeToggleChecker(env.root)
  const { gate } = await submitGreenGate(env)
  const project = await import('../../host/project.js')
  const result = await project.resolveDecisionAction(env.ctx, env.db, { id: gate.decision.id, status: 'approved', confirmed: true }, { root: env.root })
  assert.equal(result.decision.status, 'approved')
  assert.ok(result.actions && result.actions.precheck, '批准动作应带回判据复跑结果')
  assert.equal(result.actions.precheck.ok, true)
  assert.equal(result.actions.precheck.skipped, false)
  assert.ok(Array.isArray(result.actions.precheck.checks) && result.actions.precheck.checks.length >= 1)
  const approval = env.db.db.prepare('SELECT snapshot_json FROM approvals WHERE decision_id = ? AND status = ?').get(gate.decision.id, 'approved')
  const snapshot = JSON.parse(approval.snapshot_json)
  assert.ok(snapshot.precheck && snapshot.precheck.ranAt, '审批行应记录复跑时间')
  const gateEvent = env.db.listEvents({ limit: 300 }).filter((e) => e.kind === 'gate/approve').pop()
  assert.ok(gateEvent && gateEvent.payload && gateEvent.payload.precheck, 'gate/approve 事件应带判据复跑摘要')
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

test('角色卡 L1 注入：9 个角色都有完整文案，且不出现 undefined', async (t) => {
  const roles = await import('../../host/roles.js')
  const words = ['PM', ...roles.TASK_ROLES]
  assert.equal(words.length, 9, 'PM + 8 个任务角色（v6 加「调研」）')
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

test('角色卡外置：10 张卡都从 roles/*.md 读出来，且带「职责」节', async () => {
  const roles = await import('../../host/roles.js')
  const words = ['PM', 'QA', ...roles.TASK_ROLES]
  assert.equal(words.length, 10, 'PM + QA + 8 个任务角色（v6 加「调研」）')
  for (const word of words) {
    // 来源必须是 file：走了兜底说明 roles/ 目录缺文件或 frontmatter 坏了
    assert.equal(roles.ROLE_CARD_SOURCES.get(word), 'file', word + ' 的角色卡应从文件读取，实际走了兜底')
    const text = roles.roleCardText(word)
    assert.ok(text.includes('职责：'), word + ' 的角色卡应含「职责」节（外置卡新增）')
  }
  assert.deepEqual(roles.ROLE_CARD_ERRORS, [], '启动时不应有读卡失败')
})

test('角色卡外置：文件缺失时回退内置兜底卡（降级但绝不注入空串）', async () => {
  const roles = await import('../../host/roles.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const HERE = dirname(fileURLToPath(import.meta.url))
  const dir = mkdtempSync(join(HERE, '.tmp-rolecards-'))
  try {
    // 只放一张卡，其余 8 个文件缺失
    writeFileSync(join(dir, 'coder.md'), '# 坏卡（没有 frontmatter 也没有六节）\n')
    const loaded = roles.loadRoleCards(dir)
    for (const word of Object.keys(roles.ROLE_FILES)) {
      assert.equal(loaded.source.get(word), 'fallback', word + ' 缺文件时必须走兜底')
      assert.ok(loaded.cards.get(word), word + ' 兜底卡不能是 undefined')
    }
    assert.ok(loaded.errors.length >= 8, '缺失文件要如实报出来，不能静默')
    // 兜底卡仍能拼出完整文案（宁可旧文案，也不能让会话开场拿到空角色卡）
    const text = roles.roleCardText('码农')
    assert.ok(text.startsWith('角色：码农（') && text.includes('红线：'), '兜底卡也要能注入')
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

test('角色卡外置：parseRoleCard 解析 frontmatter 与六节，坏输入不抛异常', async () => {
  const roles = await import('../../host/roles.js')
  const good = roles.parseRoleCard([
    '---',
    'word: 测试角色',
    'title: 测试标题',
    'stage: S9',
    '---',
    '',
    '## 职责',
    '做一件事',
    '',
    '## 读',
    '读 A',
    '',
    '## 写',
    '写 B',
    '',
    '## 开工',
    '- 第一步',
    '- 第二步',
    '',
    '## 收工',
    '- 收工一',
    '',
    '## 红线',
    '别乱来',
  ].join('\n'))
  assert.equal(good.word, '测试角色')
  assert.equal(good.title, '测试标题')
  assert.equal(good.stage, 'S9')
  assert.equal(good.duty, '做一件事')
  assert.deepEqual(good.start, ['第一步', '第二步'])
  assert.deepEqual(good.finish, ['收工一'])
  assert.equal(good.guardrails, '别乱来')
  // 空串/乱码都不抛：外置文件坏掉不能把会话开场一起弄崩
  for (const bad of ['', 'not a card', '---\nword: x\n---\n## 职责\n']) {
    const parsed = roles.parseRoleCard(bad)
    assert.equal(typeof parsed, 'object')
    assert.ok(Array.isArray(parsed.start) && Array.isArray(parsed.finish))
  }
})


// ---------------------------------------------------------------------------
// v5：Verified Done —— 「进度唯一口径」的写入点
// ---------------------------------------------------------------------------

test('v5 验收：review → verified 记录签名人；建造者不验收；verified 是终态', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const qa = createQaSession(env, slice)
  // 先让切片处于可验收状态（任务收工会写 review）
  store.updateSliceStatus(env.db, { id: slice.id, status: 'review' })

  // ① 建造者不验收：以该切片最近一次实现会话（task）的身份验收 → 拒
  await assertToolError(callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '码农本人' }, task.agent), 'PERMISSION_DENIED')
  // 即使绕过工具 actors（领域层直调）也必须拒 —— 双保险
  assert.throws(
    () => store.verifySlice(env.db, { id: slice.id, verifiedBy: '码农本人', verifierSession: 'dsh-task-1' }),
    (error) => error.code === 'SELF_VERIFICATION_DENIED'
  )
  assert.equal(store.getSlice(env.db, slice.id).status, 'review', '被拒后切片状态不变')

  // ② 独立验收会话验收 → 成功，记录签名人与时间
  const result = await callTool(env, 'slice_verify', {
    sliceId: slice.id, verifiedBy: '老李', resultSummary: '复跑 99 例全绿，接口契约对齐',
  }, qa.agent)
  assert.equal(result.slice.status, 'verified')
  assert.equal(result.slice.verifiedBy, '老李')
  assert.ok(result.slice.verifiedAt, '验收时间必须落库')

  // ③ verified 是终态：普通状态更新不能把它改回去（DB 触发器兜底）
  assert.throws(
    () => store.updateSliceStatus(env.db, { id: slice.id, status: 'in_progress' }),
    (error) => /SLICE_VERIFIED_TERMINAL/.test(String(error.message))
  )
  // ④ 不能重复验收
  await assertToolError(callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, qa.agent), 'INVALID')

  // ⑤ 时间线留痕：slice/verify 事件与 slice/status 分开，进度统计按前者算
  const verifyEvents = env.db.listEvents({ kinds: ['slice/verify'] })
  assert.equal(verifyEvents.length, 1)
  assert.equal(verifyEvents[0].payload.verifiedBy, '老李')
})

test('v5 验收：普通 slice_update 不能直写 verified（否则 verified 只是改名）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  store.updateSliceStatus(env.db, { id: slice.id, status: 'review' })
  await assertToolError(callTool(env, 'slice_update', { id: slice.id, status: 'verified' }, pm.agent), 'INVALID')
  assert.equal(store.getSlice(env.db, slice.id).status, 'review')
})

test('v5 验收：只有 review/done 能验收，open/in_progress 拒绝（没交付就验收 = 走过场）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  await assertToolError(callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, pm.agent), 'INVALID')
  store.updateSliceStatus(env.db, { id: slice.id, status: 'in_progress' })
  await assertToolError(callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, pm.agent), 'INVALID')
  store.updateSliceStatus(env.db, { id: slice.id, status: 'done' })
  const ok = await callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, pm.agent)
  assert.equal(ok.slice.status, 'verified')
})

test('v5 验收：证据的 verified_by 被回填（B5：此前只读不写）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const evidence = await callTool(env, 'evidence_add', {
    kind: 'test', resultSummary: 'node --test → 99 pass',
  }, task.agent)
  assert.equal(evidence.evidence.verifiedBy, undefined, '验收前证据没有验收人')
  store.updateSliceStatus(env.db, { id: slice.id, status: 'review' })
  await callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, pm.agent)
  const after = store.getEvidence(env.db, evidence.evidence.id)
  assert.equal(after.verifiedBy, '老李', '验收后证据的 verified_by 必须被回填')
  assert.ok(after.verifiedAt, '证据验收时间也要有')
})

test('v5 验收会话：session_spawn_qa 拉起 project-qa，不占租约、命名带「验收-」', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const spawned = await callTool(env, 'session_spawn_qa', {
    sliceId: slice.id, action: '验收', prompt: '复跑测试并核对契约',
  }, pm.agent)
  assert.equal(spawned.name, '验收-' + slice.key + '-验收')
  const activation = env.activations[env.activations.length - 1]
  assert.equal(activation.agentPreset, 'project-qa', '验收会话必须用 project-qa preset')
  // 不占租约：该切片的租约表里不应该出现验收会话
  const lease = env.db.db.prepare('SELECT * FROM leases WHERE slice_id = ?').get(slice.id)
  assert.equal(lease, undefined, '验收会话不应占租约')
  // 同切片第二个验收会话被拒
  await assertToolError(callTool(env, 'session_spawn_qa', {
    sliceId: slice.id, action: '复验', prompt: 'x',
  }, pm.agent), 'DUPLICATE_ACTIVE_SESSION')
})




// ---------------------------------------------------------------------------
// v6：调研角色（把「调查」从 PM 手里收走，变成可派单的活）
// ---------------------------------------------------------------------------

/** 建一个调研会话（绑定 dsh 会话 id，便于用 agent 调工具）。 */
function createResearchSession(env, slice, dshSessionId) {
  const row = store.createSession(env.db, {
    name: '调研-' + slice.key + '-查配置',
    kind: 'task',
    role: '调研',
    sliceId: slice.id,
    dshSessionId: dshSessionId || 'dsh-research-1',
  })
  return { row, agent: agentFor(dshSessionId || 'dsh-research-1', env.root, 'project-research') }
}

test('v6 调研：session_spawn_task(role=调研) 用 project-research preset，且**不占租约**', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const result = await callTool(env, 'session_spawn_task', {
    role: '调研',
    sliceKey: slice.key,
    action: '查配置来源',
    prompt: '查清 policy.json 的 ignoredDirectories 由谁读、改动影响哪些 checker 用例。',
  }, pm.agent)
  assert.equal(result.name, '调研-' + slice.key + '-查配置来源')
  const activation = env.activations[env.activations.length - 1]
  assert.equal(activation.agentPreset, 'project-research', '调研会话必须用只读 preset，不能复用 project-task')
  // 关键：调研不占写作用域租约（否则同切片的实现会话会被挡在门外）
  const lease = env.db.db.prepare('SELECT * FROM leases WHERE slice_id = ?').get(slice.id)
  assert.equal(lease, undefined, '调研是只读动作，不应占切片租约')
  // 但会话行本身要落库并 active
  const row = store.getSession(env.db, result.session.id)
  assert.equal(row.kind, 'task')
  assert.equal(row.role, '调研')
  assert.equal(row.status, 'active')
})

test('v6 调研：写者角色仍然占租约（不能把「不占租约」扩散成普遍行为）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  await callTool(env, 'session_spawn_task', {
    role: '码农', sliceKey: slice.key, action: '实现', prompt: '改代码',
  }, pm.agent)
  const lease = env.db.db.prepare('SELECT * FROM leases WHERE slice_id = ?').get(slice.id)
  assert.ok(lease, '码农会话必须持租约（写作用域锁）')
})

test('v6 调研：调研会话可以写报告与证据，但不能用 session_finish_task 推进切片', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  const research = createResearchSession(env, slice)
  // 能写调研报告（且不受阶段交付类型约束：S1 只允许 prd，但调研在任何阶段都写 report）
  const report = await callTool(env, 'doc_write', {
    mode: 'create', type: 'report', title: '配置来源调研',
    content: '# 配置来源\n\n结论：由 host/scope.js 读。出处：host/scope.js:41',
  }, research.agent)
  assert.equal(report.doc.type, 'report')
  // 能记证据
  const evidence = await callTool(env, 'evidence_add', {
    kind: 'command', command: 'grep -rn ignoredDirectories tools/', resultSummary: '3 处命中',
  }, research.agent)
  assert.ok(evidence.evidence.id)
  // 不能收工推进切片（那会让「只查不改」的角色改状态）
  await assertToolError(callTool(env, 'session_finish_task', {
    handoff: '调研完了', noOutOfScopeChanges: true,
  }, research.agent), 'PERMISSION_DENIED')
  assert.notEqual(store.getSlice(env.db, slice.id).status, 'review', '切片状态不应被调研推进')
})

test('v6 调研：report 即收工 —— 交结果后会话结束，但切片状态保持不变', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  const research = createResearchSession(env, slice)
  const before = store.getSlice(env.db, slice.id).status
  const reported = await callTool(env, 'session_task_report', {
    message: '结论：配置由 host/scope.js 读取；未解问题：policy 归属待 PM 决定。',
  }, research.agent)
  assert.equal(reported.reported, true)
  assert.equal(reported.finished, true, '调研交结果即收工（否则会留一条永远 active 的会话）')
  const row = store.getSession(env.db, research.row.id)
  assert.equal(row.status, 'done')
  assert.equal(store.getSlice(env.db, slice.id).status, before, '调研不推进切片状态')
  // 收工后可以再派一次同切片的调研（同(切片,角色)唯一性不再被僵尸会话挡住）
  const second = await callTool(env, 'session_spawn_task', {
    role: '调研', sliceKey: slice.key, action: '复查', prompt: '复查',
  }, createPm2(env).agent)
  assert.ok(second.session.id)
})

/** 已存在 PM 时复用它（createPm 会因唯一约束失败）。 */
function createPm2(env) {
  const rows = store.listSessions(env.db, { kind: 'pm', status: 'active' })
  const row = rows[0]
  return { row, agent: agentFor(row.dshSessionId, env.root, 'project-office') }
}

// ---------------------------------------------------------------------------
// v5：决策超时（B4）与周期推进（B6）
// ---------------------------------------------------------------------------

test('v5 决策：deadline 与 defaultOption 落库，非法时间被拒', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const created = await callTool(env, 'decision_create', {
    title: '是否延期三天', question: '对账要不要进本周期？',
    options: ['A 延期 3 天', 'B 不延期'], recommended: 'A',
    deadline: '2026-12-01T18:00:00+08:00', defaultOption: 'A 延期 3 天',
  }, pm.agent)
  assert.ok(created.decision.deadline, 'deadline 必须落库')
  assert.equal(created.decision.defaultOption, 'A 延期 3 天')
  // 非法时间不许静默丢弃
  await assertToolError(callTool(env, 'decision_create', {
    title: 'x', question: 'y', options: ['A'], deadline: '不是时间',
  }, pm.agent), 'INVALID')
})

test('v5 周期：period_roll 写 meta 与事件，并把上一周期的验证数定格', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  store.updateSliceStatus(env.db, { id: slice.id, status: 'review' })
  await callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, pm.agent)

  const first = await callTool(env, 'period_roll', { note: '第一个周期收尾' }, pm.agent)
  assert.equal(first.period.index, 1)
  assert.equal(first.previous.current, null, '首次推进前没有周期')
  assert.equal(env.db.getMeta('period.current'), first.period.current)
  const rollEvents = env.db.listEvents({ kinds: ['period/roll'] })
  assert.equal(rollEvents.length, 1)
  assert.equal(Number(rollEvents[0].payload.index), 1)

  const second = await callTool(env, 'period_roll', {}, pm.agent)
  assert.equal(second.period.index, 2)
  assert.equal(second.previous.current, first.period.current)
  // 概览里的 period 跟随 period_roll，而不是"当前月"
  const overview = env.deps.project.overview(env.db, env.root)
  assert.equal(overview.project.period, second.period.current)
  assert.equal(overview.project.periodIndex, 2)
})

test('v5 进度：只认 verified，done 单列一档，archived/cut 不进分母', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const mk = (key) => store.createSlice(env.db, { key, title: key })
  const a = mk('a'), b = mk('b'), c = mk('c'), d = mk('d')
  // a 验收；b done 未验收；c 进行中；d 裁剪
  store.updateSliceStatus(env.db, { id: a.id, status: 'review' })
  await callTool(env, 'slice_verify', { sliceId: a.id, verifiedBy: '老李' }, pm.agent)
  store.updateSliceStatus(env.db, { id: b.id, status: 'done' })
  store.updateSliceStatus(env.db, { id: c.id, status: 'in_progress' })
  store.updateSliceStatus(env.db, { id: d.id, status: 'cut' })
  const progress = env.deps.project.overview(env.db, env.root).progress
  assert.equal(progress.total, 3, '分母 = verified + inFlight + blocked + notStarted + doneUnverified')
  assert.equal(progress.verified, 1)
  assert.equal(progress.doneUnverified, 1, 'done 未验收必须单列，不能算进已验收')
  assert.equal(progress.abandoned, 1)
  assert.equal(progress.percent, 33, '1/3 → 33%')
})

test('v5 进度：空项目 percent=0 且不崩', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const progress = env.deps.project.overview(env.db, env.root).progress
  assert.equal(progress.total, 0)
  assert.equal(progress.percent, 0)
})



// ---------------------------------------------------------------------------
// v5 B3：阶段可交付类型（deliverableTypes）真的生效
// ---------------------------------------------------------------------------

test('v5 B3：S1 阶段只允许写 prd，写 report 被拒且不带 pending 副作用', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  // 必须先有阶段行：checkDeliverableType 的语义是「能判定才判定」，
  // 没有 active 阶段时不做类型约束（旧库/headless 的宽松路径，与门禁阶段守卫一致）。
  projectWithStages(env)
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  // 默认模板 S1 的 deliverableTypes 是 ['prd']；此时 active 阶段就是 S1
  const ok = await callTool(env, 'doc_write', {
    mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款\n',
  }, task.agent)
  assert.equal(ok.doc.type, 'prd')
  await assertToolError(callTool(env, 'doc_write', {
    mode: 'create', type: 'report', title: '不该写的报告', content: '# x\n',
  }, task.agent), 'STAGE_DELIVERABLE_NOT_ALLOWED')
  // 被拒后没有留下文档
  const docs = deps_listDocs(env)
  assert.equal(docs.filter((d) => d.type === 'report').length, 0)
})

test('v5 B3：给已有文档追加新版本不受类型约束（否则正常返工被卡死）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  const created = await callTool(env, 'doc_write', {
    mode: 'create', type: 'prd', title: '退款 PRD', content: '# v1\n',
  }, task.agent)
  const v2 = await callTool(env, 'doc_write', {
    docId: created.doc.id, content: '# v2\n',
  }, task.agent)
  assert.equal(v2.doc.currentVersion, 2)
})

test('v5 B3：阶段没声明 deliverableTypes 时不约束（能判定才判定）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  // 把 project.json 的阶段模板改成没有 deliverableTypes 的形态
  const original = env.registry.projectJson
  env.registry.projectJson = () => ({ stageTemplate: [{ key: 'S1', name: '产品', gate: 'G1' }] })
  t.after(() => { env.registry.projectJson = original })
  const written = await callTool(env, 'doc_write', {
    mode: 'create', type: 'report', title: '任意类型', content: '# x\n',
  }, task.agent)
  assert.equal(written.doc.type, 'report', '阶段没声明类型时应放行（不伪造约束）')
})

function deps_listDocs(env) {
  return env.db.db.prepare('SELECT * FROM documents WHERE project_id = ?').all(env.db.projectId)
}



// ---------------------------------------------------------------------------
// 闸1：v5 能力必须"接进流程"，不是只存在于工具列表里
// ---------------------------------------------------------------------------

test('闸1: L0 注入含进度（已验收 x/y），PM 不必现场查就能答「到哪了」', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const a = createSlice(env)
  const b = store.createSlice(env.db, { key: 'slice-b', title: '第二个切片' })
  // a 验收掉，b 留着
  store.updateSliceStatus(env.db, { id: a.id, status: 'review' })
  await callTool(env, 'slice_verify', { sliceId: a.id, verifiedBy: '老李' }, pm.agent)
  const { buildL0 } = await import('../../host/context.js')
  const l0 = buildL0(env.db, { roleKind: 'pm' })
  assert.match(l0, /进度：已验收 1\/2（50%）/, 'L0 必须带进度，实际：' + l0)
})

test('闸1: L0 提示「已交付未验收」—— 最容易自欺的一档要显式暴露', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const s = createSlice(env)
  store.updateSliceStatus(env.db, { id: s.id, status: 'done' })
  const { buildL0 } = await import('../../host/context.js')
  const l0 = buildL0(env.db, { roleKind: 'pm' })
  assert.match(l0, /已交付未验收 1/, 'done 未验收必须在 L0 单列，实际：' + l0)
  assert.match(l0, /已验收 0\/1（0%）/, 'done 不计入已验收')
})

test('闸1: 收工回执带 nextStep=spawn_qa，PM 不用猜下一步', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  await callTool(env, 'evidence_add', { kind: 'test', resultSummary: 'node --test → 111 pass' }, task.agent)
  const finished = await callTool(env, 'session_finish_task', {
    handoff: '做完了退款状态机，测试全绿', noOutOfScopeChanges: true,
  }, task.agent)
  assert.equal(finished.slice.status, 'review', '成功收工切片应进入 review')
  assert.equal(finished.nextStep.action, 'spawn_qa', '回执应指引 PM 拉验收会话，实际：' + JSON.stringify(finished.nextStep))
  assert.match(finished.nextStep.hint, /session_spawn_qa/)
  assert.match(finished.nextStep.hint, /不要.*slice_update/, '必须明确劝阻直接改状态')
  // PM 收到的消息里也要有下一步（它先看到的是消息，不是工具返回值）
  const lastMessage = env.messages[env.messages.length - 1]
  assert.match(JSON.stringify(lastMessage.content), /下一步/, '唤醒 PM 的消息必须带下一步')
})

test('闸1: 收工失败的回执指引解阻塞，而不是拉验收', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  const task = createTaskSession(env, slice)
  await callTool(env, 'evidence_add', { kind: 'command', resultSummary: '依赖未就绪：EPERM' }, task.agent)
  const finished = await callTool(env, 'session_finish_task', {
    handoff: '被外部依赖挡住', noOutOfScopeChanges: true, status: 'failed', failureCode: 'BLOCKED_DEPENDENCY',
  }, task.agent)
  assert.equal(finished.slice.status, 'blocked')
  assert.equal(finished.nextStep.action, 'resolve_blocker', '失败收工不该指引验收')
})

test('闸1: QA 会话有 L1 角色卡（v5 之前是空串，会话不知道自己是来验收的）', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  createQaSession(env, slice)
  const { compileContext } = await import('../../host/context.js')
  const compiled = compileContext(env.db, { roleKind: 'qa', sliceId: slice.id })
  assert.ok(compiled.parts.l1.length > 0, 'qa 的 L1 不能是空的')
  assert.match(compiled.parts.l1, /验收/, 'qa 卡必须说明它在验收')
  assert.match(compiled.parts.l1, /slice_verify/, 'qa 卡必须告诉它能签字')
})

test('闸1: 三种角色（pm/task/qa）的注入都不超预算、都不降级', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  createPm(env)
  const slice = createSlice(env)
  createTaskSession(env, slice)
  createQaSession(env, slice)
  for (const spec of [
    { roleKind: 'pm' },
    { roleKind: 'task', role: '码农', sliceId: slice.id },
    { roleKind: 'qa', sliceId: slice.id },
  ]) {
    const { compileContext } = await import('../../host/context.js')
    const compiled = compileContext(env.db, spec)
    assert.ok(compiled.used <= 2000, spec.roleKind + ' 超 2k 硬上限：' + compiled.used)
    assert.equal(compiled.degraded, false, spec.roleKind + ' 不应降级（角色卡写太长会把每步注入都判降级）')
  }
})



// ---------------------------------------------------------------------------
// MVP ⑤：周报生成器（必须自动生成，不是模型现写）
// ---------------------------------------------------------------------------

test('MVP⑤ 周报：从项目库自动渲染，含进度/待决策/阻塞，且确定性可重复', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const a = createSlice(env)
  const b = store.createSlice(env.db, { key: 'slice-blocked', title: '被阻塞的切片' })
  // a 验收；b 阻塞；再挂一个待决策
  store.updateSliceStatus(env.db, { id: a.id, status: 'review' })
  await callTool(env, 'slice_verify', { sliceId: a.id, verifiedBy: '老李', resultSummary: '复跑全绿' }, pm.agent)
  store.updateSliceStatus(env.db, { id: b.id, status: 'blocked' })
  await callTool(env, 'decision_create', {
    title: '要不要延期', question: '延期三天还是砍范围？', options: ['A 延期', 'B 砍范围'],
    recommended: 'A', deadline: '2026-12-01T18:00:00+08:00', irreversible: true,
  }, pm.agent)

  const preview = await callTool(env, 'weekly_report', { mode: 'preview' }, pm.agent)
  assert.equal(preview.mode, 'preview')
  assert.match(preview.content, /^# /m, '周报必须是 Markdown，有标题')
  assert.match(preview.content, /进度 \*\*1\/2\*\*（50%）/, '必须含唯一口径进度，实际：' + preview.content.slice(0, 400))
  assert.match(preview.content, /需要拍板的决策（1）/, '必须列待决策')
  assert.match(preview.content, /不可逆/, '不可逆决策必须标出来')
  assert.match(preview.content, /阻塞项（1）/, '必须列阻塞项')
  assert.match(preview.content, /本期完成（已独立验收）/, '必须列本期完成')
  assert.match(preview.content, /不是手写/, '必须声明是自动生成的')

  // 确定性：同一状态渲染两次内容一致（否则「可重生成」是空话）
  const again = await callTool(env, 'weekly_report', { mode: 'preview' }, pm.agent)
  assert.equal(again.content, preview.content, '同一项目状态下周报内容必须完全一致')
})

test('MVP⑤ 周报：write 模式落盘到 .project/exports/weekly.md', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const slice = createSlice(env)
  store.updateSliceStatus(env.db, { id: slice.id, status: 'review' })
  await callTool(env, 'slice_verify', { sliceId: slice.id, verifiedBy: '老李' }, pm.agent)
  const written = await callTool(env, 'weekly_report', { mode: 'write' }, pm.agent)
  assert.equal(written.mode, 'write')
  assert.equal(written.path, '.project/exports/weekly.md')
  assert.equal(written.written, true, '写盘应成功：' + String(written.error))
  const { existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const file = join(env.root, '.project', 'exports', 'weekly.md')
  assert.ok(existsSync(file), '文件必须真的落盘：' + file)
  assert.match(readFileSync(file, 'utf8'), /进度 \*\*1\/1\*\*（100%）/)
})

test('MVP⑤ 周报：空项目不崩，且明确说「还没有切片」', async (t) => {
  const env = createEnv()
  t.after(() => env.dispose())
  const pm = createPm(env)
  const preview = await callTool(env, 'weekly_report', { mode: 'preview' }, pm.agent)
  assert.match(preview.content, /进度 \*\*0\/0\*\*/)
  assert.ok(preview.chars > 100)
})

