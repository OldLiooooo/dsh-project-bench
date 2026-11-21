// 失败路径测试（v4）：这个文件存在的理由，是设计逻辑 §7 里那条「所有替身永远成功，catch 分支从未覆盖」。
//
// 每条用例都针对一个**真实的失败形态**，而不是为了覆盖率造异常：
//   1. spawn 失败 → 会话必须带失败原因 + 租约释放 + 任务回滚（不留幽灵指派）
//   2. 租约冲突  → 派活失败要回滚，不能留 active 会话
//   3. 栅栏抢占  → 旧持有者醒来后继续写必须被拒（LEASE_FENCED）
//   4. 重启对账  → 中断要记原因、孤儿租约要清、幽灵任务要回滚
//   5. 判据跑挂  → fail-closed（跑不起来 ≠ 通过）
//   6. 导出失败  → outbox 留 failed 行，可补偿，且不会让「阶段已推进」被回滚
//
// 运行：node --test --test-isolation=none workbench/tests/unit/failure.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectDb } from '../../host/db.js'
import * as store from '../../host/store.js'
import * as docs from '../../host/docs.js'
import * as leases from '../../host/leases.js'
import * as exporters from '../../host/export.js'
import { createToolDeps, registerTools } from '../../host/tools/index.js'
import { spawnTaskSession, reconcileStaleSessions } from '../../host/orchestration.js'
import { runProjectCheckers } from '../../host/checkers.js'
import { resolveDecisionAction } from '../../host/project.js'
import { ensureGuards } from '../../host/schema.js'
import { validateFinish, declareSliceScope, collectWorkspaceChanges, classifyChanges, matchesPattern } from '../../host/scope.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function createEnv(options = {}) {
  const root = mkdtempSync(join(HERE, '.tmp-fail-'))
  const db = new ProjectDb(join(root, '.project', 'project.db'), { projectId: 'proj-fail', projectName: '失败路径', root })
  ensureGuards(db.db)
  const registrations = []
  const registry = {
    rootForWorkspace: () => ({ workspaceId: 'ws-fail', root, title: '失败路径工作区' }),
    open: () => db,
    ensure: () => db,
    listProjects: () => [{ workspaceId: 'ws-fail', root, title: '失败路径工作区', exists: true, initialized: true }],
    projectJson: () => (options.projectJson !== undefined ? options.projectJson : { exportMap: {} }),
    closeAll: () => {},
  }
  const bus = { emit: () => {}, subscribe: () => () => {} }
  const ctx = {
    tools: { register: (definition, opts) => { registrations.push({ definition, options: opts }); return () => {} } },
    logger: { info: () => {}, warn: () => {} },
    on: () => {},
    inject: () => {},
    effect: (fn) => { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    subagents: {
      startActivation: async (spec) => {
        if (options.spawnFails) {
          const error = new Error('spawn 被拒绝（模拟宿主拒绝）')
          error.code = 'EPERM'
          throw error
        }
        return { childId: spec.childId, result: Promise.resolve({ output: 'ok' }), dispose: async () => {} }
      },
      sendMessage: async () => 'message-1',
    },
    agents: { get: () => undefined, list: options.liveAgents || (() => []) },
  }
  const deps = createToolDeps(ctx, registry, bus)
  registerTools(ctx, registry, bus)
  function dispose() {
    try { db.close() } catch (error) { /* 已关闭 */ }
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { /* 尽力 */ }
  }
  return { root, db, registry, bus, ctx, deps, registrations, dispose }
}

function toolOf(env, name) {
  const found = env.registrations.find((item) => item.definition.name === name)
  assert.ok(found, '工具应已注册：' + name)
  return found.definition
}

function agent(sessionId, root, preset) {
  return { session: { id: sessionId, header: { cwd: root, agentPreset: preset } } }
}

function makePm(env) {
  const row = store.createSession(env.db, { kind: 'pm', dshSessionId: 'dsh-pm-fail' })
  return { row, agent: agent('dsh-pm-fail', env.root, 'project-office') }
}

async function expectCode(promise, code) {
  let caught
  try { await promise } catch (error) { caught = error }
  assert.ok(caught, '期望抛出 ' + code)
  assert.equal(caught.code, code, '期望 code=' + code + '，实际 ' + caught.code + '：' + caught.message)
  return caught
}

// ---------------------------------------------------------------------------
// 1. spawn 失败：会话记原因 + 租约释放 + 任务回滚
// ---------------------------------------------------------------------------

test('spawn 失败：会话落失败原因、租约释放、任务回滚为 pending（不留幽灵指派）', async () => {
  const env = createEnv({ spawnFails: true })
  try {
    const { agent: pmAgent } = makePm(env)
    const slice = store.createSlice(env.db, { key: 'fail-spawn', title: '派活失败' })
    const task = store.createTask(env.db, { sliceId: slice.id, title: '实现退款' })
    const actor = { kind: 'pm', db: env.db, root: env.root, session: store.listSessions(env.db, { kind: 'pm' })[0], dshSessionId: 'dsh-pm-fail', rootInfo: { workspaceId: 'ws-fail' } }
    const error = await expectCode(spawnTaskSession(env.ctx, env.deps, {
      actor, role: '码农', slice, task, action: '实现', brief: '实现退款接口',
    }), 'SPAWN_FAILED')

    // ① 失败原因必须落库（原实现只把 SPAWN_FAILED 抛给调用方）
    const sessions = store.listSessions(env.db, { kind: 'task' })
    assert.equal(sessions.length, 1, '应登记了 1 条任务会话')
    const failed = sessions[0]
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failureCode, 'SPAWN_FAILED', '会话必须记录失败码')
    assert.ok(failed.failureDetail && failed.failureDetail.includes('spawn'), '会话必须记录失败详情')
    assert.ok(failed.failureAt, '失败时间必须落库')
    assert.equal(failed.attempt, 1, '首次派活 attempt=1')

    // ② 租约必须释放（否则该切片永远无法再派活）
    assert.equal(leases.getLease(env.db, slice.id), undefined, '失败后租约必须已释放')

    // ③ 任务必须回滚（原实现会挂在已失败的会话上）
    const after = store.getTask(env.db, task.id)
    assert.equal(after.status, 'pending', '任务应回滚为 pending')
    assert.equal(after.assigneeSession, undefined, '任务的指派会话应清空')

    // ④ 错误本身要带回可操作信息
    assert.equal(error.details.failureCode, 'SPAWN_FAILED')
    assert.equal(error.details.taskRolledBack, true, '错误里要告诉 PM 任务已回滚')

    // ⑤ 时间线要留下失败痕迹（可审计）
    const kinds = env.db.listEvents({ limit: 50 }).map((event) => event.kind)
    assert.ok(kinds.includes('session/end'), '应有 session/end 事件')
    const endEvent = env.db.listEvents({ limit: 50 }).find((event) => event.kind === 'session/end')
    assert.equal(endEvent.payload.failureCode, 'SPAWN_FAILED', 'session/end 事件 payload 应带失败码')
  } finally {
    env.dispose()
  }
})

test('spawn 成功：栅栏令牌写入会话上下文，可供后续写入校验', async () => {
  const env = createEnv()
  try {
    const { row: pmRow, agent: pmAgent } = makePm(env)
    const slice = store.createSlice(env.db, { key: 'ok-spawn', title: '派活成功' })
    const actor = { kind: 'pm', db: env.db, root: env.root, session: pmRow, dshSessionId: 'dsh-pm-fail', rootInfo: { workspaceId: 'ws-fail' } }
    const spawned = await spawnTaskSession(env.ctx, env.deps, {
      actor, role: '码农', slice, action: '实现', brief: '实现退款',
    })
    assert.ok(spawned.lease.epoch >= 1, '租约应有 epoch')
    assert.equal(spawned.fenceEpoch, spawned.lease.epoch, '返回值应带栅栏令牌')
    const row = store.getSession(env.db, spawned.session.id)
    assert.equal(row.context.fenceEpoch, spawned.lease.epoch, '令牌应落进会话上下文')
    assert.equal(row.attempt, 1)
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// 2. 租约冲突：派活失败要回滚会话
// ---------------------------------------------------------------------------

test('租约被他人持有：派活失败并记录原因，不留 active 会话', async () => {
  const env = createEnv()
  try {
    const { row: pmRow } = makePm(env)
    const slice = store.createSlice(env.db, { key: 'held', title: '被占用切片' })
    const holder = store.createSession(env.db, { kind: 'task', name: '码农-held-实现', role: '码农', sliceId: slice.id })
    leases.acquireLease(env.db, { sliceId: slice.id, sessionId: holder.id, ttlMs: 60000 })
    const actor = { kind: 'pm', db: env.db, root: env.root, session: pmRow, dshSessionId: 'dsh-pm-fail', rootInfo: { workspaceId: 'ws-fail' } }
    await expectCode(spawnTaskSession(env.ctx, env.deps, {
      actor, role: '测试', slice, action: '验收', brief: '验收退款',
    }), 'LEASE_HELD')
    const sessions = store.listSessions(env.db, { kind: 'task', status: 'active' })
    assert.equal(sessions.length, 1, '只应剩原来的持租会话，不应留下新的 active 会话')
    assert.equal(sessions[0].id, holder.id)
    const failedRows = store.listSessions(env.db, { kind: 'task', status: 'failed' })
    assert.equal(failedRows.length, 1, '失败的那条会话要留痕')
    assert.equal(failedRows[0].failureCode, 'LEASE_ACQUIRE_FAILED')
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// 3. 栅栏令牌：抢占后旧持有者写入被拒
// ---------------------------------------------------------------------------

test('栅栏令牌：租约被抢占后，旧会话用旧 epoch 写入被拒（LEASE_FENCED）', async () => {
  const env = createEnv()
  try {
    const slice = store.createSlice(env.db, { key: 'fence', title: '栅栏' })
    const sessionA = store.createSession(env.db, { kind: 'task', name: '码农-fence-实现', role: '码农', sliceId: slice.id })
    const sessionB = store.createSession(env.db, { kind: 'task', name: '测试-fence-验收', role: '测试', sliceId: slice.id })
    const leaseA = leases.acquireLease(env.db, { sliceId: slice.id, sessionId: sessionA.id, ttlMs: 25 })
    // 会话 A 记下自己的令牌（等价于 spawn 时写入 context.fenceEpoch）
    store.updateSession(env.db, { id: sessionA.id, context: { fenceEpoch: leaseA.epoch } })
    assert.equal(leases.assertWriteScope(env.db, { sliceId: slice.id, sessionId: sessionA.id }).ok, true, '持租期间应可写')

    await new Promise((resolve) => setTimeout(resolve, 60))
    const leaseB = leases.acquireLease(env.db, { sliceId: slice.id, sessionId: sessionB.id, ttlMs: 60000 })
    assert.ok(leaseB.epoch > leaseA.epoch, '抢占必须换发更大的 epoch（fencing token 单调）')

    // A 醒来继续写：holder 已经不是它 → LEASE_HELD
    await expectCode(Promise.resolve().then(() => leases.assertWriteScope(env.db, { sliceId: slice.id, sessionId: sessionA.id })), 'LEASE_HELD')

    // 关键场景：A 的会话行里仍是旧令牌，即便强行把自己写回 holder 也会被令牌挡住。
    // 这里直接验证令牌比较本身（模拟「检查发生在抢占之前」的 TOCTOU 窗口）。
    env.db.tx(() => {
      env.db.db.prepare('UPDATE leases SET session_id = ? WHERE slice_id = ?').run(sessionA.id, slice.id)
    })
    const fenced = await expectCode(Promise.resolve().then(() => leases.assertWriteScope(env.db, { sliceId: slice.id, sessionId: sessionA.id })), 'LEASE_FENCED')
    assert.equal(fenced.details.epoch, leaseB.epoch, '错误里应带当前 epoch')
    assert.equal(fenced.details.presented, leaseA.epoch, '错误里应带会话出示的 epoch')

    // 换成正确令牌就能写（证明拒绝的是「过期授权」，不是「这个会话」）
    const ok = leases.assertWriteScope(env.db, { sliceId: slice.id, sessionId: sessionA.id, fence: leaseB.epoch })
    assert.equal(ok.ok, true)
  } finally {
    env.dispose()
  }
})

test('栅栏令牌（工具路径）：抢占后旧会话的 doc_write / session_finish_task 都被拒', async () => {
  const env = createEnv({ spawnFails: false })
  try {
    const { row: pmRow } = makePm(env)
    const slice = store.createSlice(env.db, { key: 'fence-tool', title: '工具栅栏' })
    const actor = { kind: 'pm', db: env.db, root: env.root, session: pmRow, dshSessionId: 'dsh-pm-fail', rootInfo: { workspaceId: 'ws-fail' } }
    // 通过真实派活路径拿到令牌（而不是手工塞 context）
    const spawned = await spawnTaskSession(env.ctx, env.deps, { actor, role: '码农', slice, action: '实现', brief: '实现' })
    const taskAgent = agent(spawned.dshSessionId, env.root, 'project-task')
    const docWrite = toolOf(env, 'doc_write')
    const written = await docWrite.execute(
      { mode: 'create', type: 'prd', title: '退款 PRD', content: '# 退款\n内容。' },
      { agent: taskAgent, signal: new AbortController().signal },
    )
    assert.ok(written.doc.id, '持租期间应能写文档')

    // 让租约过期并被另一个会话抢占（模拟「A 卡住、B 接管」）
    env.db.tx(() => {
      env.db.db.prepare('UPDATE leases SET expires_at = ? WHERE slice_id = ?').run(new Date(Date.now() - 1000).toISOString(), slice.id)
    })
    const other = store.createSession(env.db, { kind: 'task', name: '测试-fence-tool-验收', role: '测试', sliceId: slice.id })
    const takeover = leases.acquireLease(env.db, { sliceId: slice.id, sessionId: other.id, ttlMs: 60000 })
    assert.ok(takeover.epoch > spawned.fenceEpoch, '抢占应换发更大的 epoch')

    // A 醒来继续写：工具路径必须拒绝（不是只在入口检查一次）
    let caught
    try {
      await docWrite.execute({ docId: written.doc.id, content: '# 退款\nC 追加的内容。' }, { agent: taskAgent, signal: new AbortController().signal })
    } catch (error) { caught = error }
    assert.ok(caught, '旧持有者的写入必须被拒')
    assert.equal(caught.code, 'LEASE_HELD', 'holder 已经不是它：先命中 LEASE_HELD')

    // 把租约挪回 A（模拟 TOCTOU：检查发生在抢占之前），令牌必须挡住
    env.db.tx(() => {
      env.db.db.prepare('UPDATE leases SET session_id = ? WHERE slice_id = ?').run(spawned.session.id, slice.id)
    })
    let fenced
    try {
      await docWrite.execute({ docId: written.doc.id, content: '# 退款\nD 内容。' }, { agent: taskAgent, signal: new AbortController().signal })
    } catch (error) { fenced = error }
    assert.ok(fenced, '即便 holder 被改回 A，过期令牌也必须被拒')
    assert.equal(fenced.code, 'LEASE_FENCED')
    assert.equal(fenced.details.epoch, takeover.epoch)
    assert.equal(fenced.details.presented, spawned.fenceEpoch)
  } finally {
    env.dispose()
  }
})

test('栅栏令牌：释放后重新获取不复用旧 epoch（否则失效的写会重新变合法）', async () => {
  const env = createEnv()
  try {
    const slice = store.createSlice(env.db, { key: 'epoch-mono', title: '令牌单调' })
    const session = store.createSession(env.db, { kind: 'task', name: '码农-epoch-mono-实现', role: '码农', sliceId: slice.id })
    const first = leases.acquireLease(env.db, { sliceId: slice.id, sessionId: session.id, ttlMs: 60000 })
    leases.releaseLease(env.db, { sliceId: slice.id, sessionId: session.id })
    const second = leases.acquireLease(env.db, { sliceId: slice.id, sessionId: session.id, ttlMs: 60000 })
    assert.ok(second.epoch > first.epoch, '释放后重新获取必须换新令牌：' + first.epoch + ' -> ' + second.epoch)
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// 4. 重启对账
// ---------------------------------------------------------------------------

test('重启对账：中断记原因、孤儿租约清理、幽灵任务回滚', () => {
  const env = createEnv()
  try {
    const slice = store.createSlice(env.db, { key: 'restart', title: '重启' })
    const slice2 = store.createSlice(env.db, { key: 'restart-2', title: '重启2' })
    // ① active 但进程内没有 live agent → interrupted + 原因
    const stale = store.createSession(env.db, { kind: 'task', name: '码农-restart-实现', role: '码农', sliceId: slice.id, dshSessionId: 'dsh-stale' })
    leases.acquireLease(env.db, { sliceId: slice.id, sessionId: stale.id, ttlMs: 60000 })
    // ② 孤儿租约：持租会话已结束
    const ended = store.createSession(env.db, { kind: 'task', name: '测试-restart-2-验收', role: '测试', sliceId: slice2.id })
    leases.acquireLease(env.db, { sliceId: slice2.id, sessionId: ended.id, ttlMs: 60000 })
    store.endSession(env.db, { id: ended.id, status: 'done' })
    // ③ 幽灵任务：in_progress 但指派会话已结束
    const ghostTask = store.createTask(env.db, { sliceId: slice2.id, title: '幽灵任务' })
    store.updateTask(env.db, { id: ghostTask.id, status: 'in_progress', assigneeSession: ended.id })

    const result = reconcileStaleSessions(env.ctx, env.registry, env.deps)
    assert.equal(result.interrupted, 1, '应中断 1 条残留会话')
    assert.equal(result.orphanLeases, 1, '应清理 1 条孤儿租约')
    assert.equal(result.phantomTasks, 1, '应回滚 1 个幽灵任务')

    const staleAfter = store.getSession(env.db, stale.id)
    assert.equal(staleAfter.status, 'interrupted')
    assert.equal(staleAfter.failureCode, 'HOST_RESTART', '中断必须记录原因（原实现只写 status）')
    assert.ok(staleAfter.failureDetail && staleAfter.failureDetail.includes('dsh-stale'), '失败详情应含 dshSessionId')
    assert.equal(leases.getLease(env.db, slice.id), undefined, '被中断会话的租约要释放')
    assert.equal(leases.getLease(env.db, slice2.id), undefined, '孤儿租约要清理')
    const taskAfter = store.getTask(env.db, ghostTask.id)
    assert.equal(taskAfter.status, 'pending', '幽灵任务应回滚为 pending')
    assert.equal(taskAfter.assigneeSession, undefined)
  } finally {
    env.dispose()
  }
})

test('重启对账：live agent 仍在的会话不动（不能误伤正在干活的任务）', () => {
  const env = createEnv({ liveAgents: () => [{ session: { id: 'dsh-live' } }] })
  try {
    const slice = store.createSlice(env.db, { key: 'live', title: '在跑' })
    const row = store.createSession(env.db, { kind: 'task', name: '码农-live-实现', role: '码农', sliceId: slice.id, dshSessionId: 'dsh-live' })
    leases.acquireLease(env.db, { sliceId: slice.id, sessionId: row.id, ttlMs: 60000 })
    const result = reconcileStaleSessions(env.ctx, env.registry, env.deps)
    assert.equal(result.interrupted, 0)
    assert.equal(result.orphanLeases, 0)
    assert.equal(store.getSession(env.db, row.id).status, 'active', '在跑的会话不应被中断')
    assert.ok(leases.getLease(env.db, slice.id), '在跑会话的租约不应被释放')
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// 5. 判据失败关闭（含隔离）
// ---------------------------------------------------------------------------

test('判据失败关闭：抛异常/超时/无导出都算失败，不静默通过', async () => {
  const env = createEnv()
  try {
    const checkers = join(env.root, 'tools', 'engineering')
    mkdirSync(checkers, { recursive: true })
    writeFileSync(join(checkers, 'boom.mjs'), 'export function checkBoom() { throw new Error("判据自己炸了") }')
    writeFileSync(join(checkers, 'loop.mjs'), 'export function checkLoop() { while (true) {} }')
    writeFileSync(join(checkers, 'noexport.mjs'), 'export const nothing = 1')

    const boom = await runProjectCheckers(env.root, { checkers: [{ name: 'boom', module: 'tools/engineering/boom.mjs', export: 'checkBoom', kind: 'sync', trust: 'worker' }] })
    assert.equal(boom.ok, false, '判据抛错必须算失败')
    assert.equal(boom.issues[0].code, 'CHECKER_ERROR')

    const started = Date.now()
    const loop = await runProjectCheckers(env.root, { checkers: [{ name: 'loop', module: 'tools/engineering/loop.mjs', export: 'checkLoop', kind: 'sync', trust: 'worker', timeoutMs: 250 }] })
    assert.equal(loop.ok, false, '死循环必须被超时终止并算失败')
    assert.ok(Date.now() - started < 5000, '超时必须真的打断（不是一直等）')
    assert.equal(loop.checks[0].status, 'error')
    assert.match(loop.checks[0].error, /超时/)

    const noExport = await runProjectCheckers(env.root, { checkers: [{ name: 'noexport', module: 'tools/engineering/noexport.mjs', export: 'checkNoExport', kind: 'sync', trust: 'worker' }] })
    assert.equal(noExport.ok, false, '没有导出函数必须算失败')

    const missing = await runProjectCheckers(env.root, { checkers: [{ name: 'gone', module: 'tools/engineering/gone.mjs', export: 'x', kind: 'sync', trust: 'worker' }] })
    assert.equal(missing.skipped, true, '判据文件不存在时跳过，但必须标注 skipped')
    assert.equal(missing.checks[0].reason, 'module-missing')
  } finally {
    env.dispose()
  }
})

test('判据隔离：worker 与 in-process 的信任级别被如实标注，requireIsolation 失败关闭', async () => {
  const env = createEnv()
  try {
    const checkers = join(env.root, 'tools', 'engineering')
    mkdirSync(checkers, { recursive: true })
    writeFileSync(join(checkers, 'ok.mjs'), 'export function checkOk() { return { ok: true, issues: [] } }')
    const isolated = await runProjectCheckers(env.root, { checkers: [{ name: 'ok', module: 'tools/engineering/ok.mjs', export: 'checkOk', kind: 'sync', trust: 'worker' }] })
    assert.equal(isolated.ok, true)
    assert.equal(isolated.trust.mode, 'worker')
    assert.equal(isolated.checks[0].trust, 'worker', 'check 上要能看到它是在哪跑的')

    const inProc = await runProjectCheckers(env.root, { checkers: [{ name: 'ok', module: 'tools/engineering/ok.mjs', export: 'checkOk', kind: 'sync', trust: 'in-process' }] })
    assert.equal(inProc.trust.degraded, true, '一进程内执行必须标注 degraded')
    assert.match(inProc.trust.note, /未隔离/)

    const strict = await runProjectCheckers(env.root, {
      policy: { requireIsolation: true },
      checkers: [{ name: 'ok', module: 'tools/engineering/ok.mjs', export: 'checkOk', kind: 'sync', trust: 'in-process' }],
    })
    assert.equal(strict.ok, false, '要求隔离但拿不到隔离时必须失败关闭（不能当 skipped 放行）')
    assert.equal(strict.issues[0].code, 'CHECKER_ISOLATION_REQUIRED')
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// 6. 导出补偿
// ---------------------------------------------------------------------------

test('导出失败可补偿：outbox 留 failed 行，replay 只补没落地的行', () => {
  const env = createEnv()
  try {
    const slice = store.createSlice(env.db, { key: 'outbox', title: '导出补偿' })
    const doc = docs.createDocument(env.db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/outbox', title: '导出补偿 PRD' })
    docs.writeDocumentVersion(env.db, { docId: doc.id, content: '# 目的\n验证补偿。' })
    // 制造失败：把 docs/product 建成**文件**（不是目录），写盘必然失败。
    const blocked = join(env.root, 'docs', 'product')
    mkdirSync(join(env.root, 'docs'), { recursive: true })
    writeFileSync(blocked, 'not a directory')

    const failed = exporters.exportDocument(env.db, { docId: doc.id, root: env.root, exportMap: { prd: 'product' } })
    assert.equal(failed.written, false, '写盘失败必须如实返回 written=false')
    assert.ok(failed.error, '失败要带原因')
    const rows = env.db.db.prepare('SELECT * FROM export_outbox WHERE doc_id = ?').all(doc.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'failed', 'outbox 要留下 failed 行（可对账、可补偿）')
    assert.ok(rows[0].last_error, 'outbox 要记录失败原因')
    const exportRow = env.db.db.prepare("SELECT * FROM exports WHERE status = 'failed'").get()
    assert.ok(exportRow, 'exports 行要标 failed（否则人以为导成功了）')
    // DB 侧的状态不该被文件失败回滚：导出意图仍然有效。
    assert.ok(env.db.listEvents({ kinds: ['doc/export'], limit: 5 }).length >= 1, '导出意图应已提交（不因文件失败回滚）')

    // 修好环境后补偿
    rmSync(blocked, { force: true })
    const replay = exporters.replayPendingExports(env.db, { root: env.root })
    assert.equal(replay.replayed, 1, '应重放 1 条')
    assert.equal(replay.done, 1, '补偿后应成功')
    assert.equal(replay.remaining, 0, '补偿后不应再有未落地行')
    const after = exporters.outboxStatus(env.db, rows[0].batch_id)
    assert.equal(after.complete, true, '批次应标记为完整')
  } finally {
    env.dispose()
  }
})

test('门禁批准：导出失败不回滚阶段推进，但会被单独结算并留下可补偿痕迹', async () => {
  const env = createEnv()
  try {
    const { agent: pmAgent } = makePm(env)
    // 阶段机：手工建两行，让 advanceStage 有得推进
    const at = new Date().toISOString()
    env.db.db.prepare("INSERT INTO stages(id, project_id, key, name, status, gate, started_at, ended_at, position) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('st-1', env.db.projectId, 'S1', '产品', 'active', 'G1', at, null, 0)
    env.db.db.prepare("INSERT INTO stages(id, project_id, key, name, status, gate, started_at, ended_at, position) VALUES (?,?,?,?,?,?,?,?,?)")
      .run('st-2', env.db.projectId, 'S2', 'UX', 'pending', 'G2', null, null, 1)

    const slice = store.createSlice(env.db, { key: 'gate-exp', title: '门禁导出' })
    const doc = docs.createDocument(env.db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/gate-exp', title: '门禁 PRD' })
    docs.writeDocumentVersion(env.db, { docId: doc.id, content: '# 门禁\n内容。' })
    const version = docs.getDocVersion(env.db, doc.id, 1)
    const decision = store.createDecision(env.db, {
      kind: 'gate', title: 'G1', question: '批准 G1？', options: ['批准', '驳回'],
      irreversible: true, stage: 'S1', gate: 'G1', createdBy: 'pm',
    })
    env.db.db.prepare('INSERT INTO approvals(id, project_id, stage, gate, decision_id, status, evidence_ids_json, snapshot_json, approved_by, approved_at, epoch) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('appr-gate', env.db.projectId, 'S1', 'G1', decision.id, 'pending', '[]',
        JSON.stringify({ decisionId: decision.id, gate: 'G1', stage: 'S1', docIds: [doc.id], docVersions: [{ docId: doc.id, version: 1, hash: version.contentHash }], evidenceIds: [], checks: [], submittedBy: 'pm' }),
        null, null, 1)
    // 让导出必然失败：把 docs/product 建成文件
    mkdirSync(join(env.root, 'docs'), { recursive: true })
    writeFileSync(join(env.root, 'docs', 'product'), 'not a directory')

    const result = await resolveDecisionAction(env.ctx, env.db, {
      id: decision.id, status: 'approved', confirmed: true, decidedBy: 'alice', rationale: 'ok',
    }, { root: env.root, exportMap: { prd: 'product' } })

    // ① 阶段推进（不可逆签名）必须保留
    assert.equal(result.decision.status, 'approved')
    assert.equal(result.actions.stage.from, 'S1')
    assert.equal(result.actions.stage.to, 'S2')
    const stages = env.db.db.prepare('SELECT key, status FROM stages WHERE project_id = ? ORDER BY position').all(env.db.projectId)
    assert.equal(stages[0].status, 'done')
    assert.equal(stages[1].status, 'active')

    // ② 导出失败必须被单独结算并暴露出来（不能假装成功）
    assert.ok(result.exportResult, '返回值必须带导出结算结果')
    assert.ok(result.exportResult.failed > 0, '导出失败应如实报告：' + JSON.stringify(result.exportResult))
    assert.equal(result.exportResult.status.complete, false)

    // ③ 失败要留一条可审计事件（人来决定补偿）
    const kinds = env.db.listEvents({ limit: 100 }).map((event) => event.kind)
    assert.ok(kinds.includes('gate/export_failed'), '导出失败应写 gate/export_failed 事件')
    // ④ 审批签名者被结构化记录
    const signer = env.db.db.prepare('SELECT * FROM approval_signers WHERE approval_id = ?').get(result.actions.approvalId)
    assert.ok(signer, '应记录审批签名人')
    assert.equal(signer.subject, 'alice')
  } finally {
    env.dispose()
  }
})

test('doc_export 写盘失败必须报错，而不是假装导出成功', async () => {
  const env = createEnv()
  try {
    const { agent: pmAgent } = makePm(env)
    const slice = store.createSlice(env.db, { key: 'export-tool', title: '导出工具' })
    const doc = docs.createDocument(env.db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/export-tool', title: '导出 PRD' })
    docs.writeDocumentVersion(env.db, { docId: doc.id, content: '# 导出\n内容。' })
    // 让写盘必然失败
    mkdirSync(join(env.root, 'docs'), { recursive: true })
    writeFileSync(join(env.root, 'docs', 'product'), 'not a directory')
    const tool = toolOf(env, 'doc_export')
    let caught
    try {
      await tool.execute({ docId: doc.id }, { agent: pmAgent, signal: new AbortController().signal })
    } catch (error) { caught = error }
    assert.ok(caught, '写盘失败时 doc_export 必须抛错（不能静默返回成功）')
    assert.equal(caught.code, 'EXPORT_FAILED')
    assert.ok(caught.details.batchId, '错误里要给出 batchId 以便补偿')
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------------------
// 7. 切片作用域校验（真实 diff）
// ---------------------------------------------------------------------------

test('作用域校验：没有 git 与没有声明时如实标注「无法校验」，不伪造通过', () => {
  const env = createEnv()
  try {
    const slice = store.createSlice(env.db, { key: 'scope-a', title: '作用域A' })
    const check = validateFinish(env.db, { sliceId: slice.id, root: env.root, policy: 'strict' })
    assert.equal(check.ok, true, '不能因为「无法校验」就拒绝收工（非 git 项目也必须能用）')
    assert.equal(check.verifiable, false, '但必须如实标注无法校验')
    assert.match(check.unresolvedReason, /no-git-baseline|no-scope-declared/)
    assert.equal(collectWorkspaceChanges(env.root).basis, 'unavailable')
  } finally {
    env.dispose()
  }
})

test('作用域归因：in-scope / cross-scope / out-of-scope 三类分开（不依赖 git 能否 spawn）', () => {
  const env = createEnv()
  try {
    const a = store.createSlice(env.db, { key: 'scope-a2', title: 'A' })
    const b = store.createSlice(env.db, { key: 'scope-b2', title: 'B' })
    declareSliceScope(env.db, { sliceId: a.id, patterns: ['src/a/**', 'src/shared/a-*.js'] })
    declareSliceScope(env.db, { sliceId: b.id, patterns: ['src/b/**'] })

    // 直接喂一份「diff 结果」，验证归因逻辑本身（diff 采集另有测试）
    const changes = {
      basis: 'git',
      baseline: 'abc1234',
      files: [
        { path: 'src/a/x.js', status: 'M' },
        { path: 'src/shared/a-util.js', status: 'A' },
        { path: 'src/b/x.js', status: 'M' },
        { path: 'README.md', status: 'M' },
        { path: '.project/exports/timeline.md', status: 'M' },
      ],
    }
    const classified = classifyChanges(env.db, changes, a.id)
    assert.deepEqual(classified.inScope.map((f) => f.path).sort(), ['src/a/x.js', 'src/shared/a-util.js'])
    assert.deepEqual(classified.crossScope.map((f) => f.path), ['src/b/x.js'], '别人的地盘算跨域')
    assert.equal(classified.crossScope[0].ownerSliceId, b.id)
    assert.deepEqual(classified.outOfScope.map((f) => f.path), ['README.md'], '没有归属的算域外')
    assert.equal(classified.files.some((f) => f.path.startsWith('.project/')), false, '.project/ 属于插件自己写，归因前就被忽略')

    // 模式匹配的边界：** 跨目录、* 不跨分隔符、目录前缀语义
    assert.equal(matchesPattern('src/a/deep/x.js', 'src/a/**'), true)
    assert.equal(matchesPattern('src/a/x/y/z.js', 'src/a/*'), false, '* 不应跨路径分隔符')
    assert.equal(matchesPattern('src/a/x.js', 'src/a'), true, '目录语义：声明目录覆盖其下文件')
    assert.equal(matchesPattern('src/ab/x.js', 'src/a'), false, '前缀不能误命中相邻目录')
  } finally {
    env.dispose()
  }
})

test('作用域校验（真实 git diff）：跨切片改动被拒、域内改动放行', (t) => {
  const env = createEnv()
  try {
    const a = store.createSlice(env.db, { key: 'scope-a3', title: 'A' })
    const b = store.createSlice(env.db, { key: 'scope-b3', title: 'B' })
    declareSliceScope(env.db, { sliceId: a.id, patterns: ['src/a/**'] })
    declareSliceScope(env.db, { sliceId: b.id, patterns: ['src/b/**'] })
    mkdirSync(join(env.root, 'src', 'a'), { recursive: true })
    mkdirSync(join(env.root, 'src', 'b'), { recursive: true })
    // 沙箱里 child_process.spawn 可能是 EPERM（本会话实测如此）；拿不到 git 就跳过这部分，
    // 因为「无法采集」的语义已由上面的用例覆盖，不该把环境限制当成产品缺陷。
    try {
      execFileSync('git', ['init', '-q'], { cwd: env.root, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: env.root })
      execFileSync('git', ['config', 'user.name', 'test'], { cwd: env.root })
    } catch (error) {
      t.skip('当前环境无法 spawn git（' + String(error && error.code) + '），跳过真实 diff 用例')
      return
    }
    writeFileSync(join(env.root, 'src', 'a', 'x.js'), 'export const a = 1\n')
    writeFileSync(join(env.root, 'src', 'b', 'x.js'), 'export const b = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: env.root })
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: env.root })
    writeFileSync(join(env.root, 'src', 'b', 'x.js'), 'export const b = 2\n')
    writeFileSync(join(env.root, 'src', 'a', 'new.js'), 'export const n = 1\n')

    const check = validateFinish(env.db, { sliceId: a.id, root: env.root, policy: 'strict' })
    assert.equal(check.verifiable, true, '有 git + 有声明时应可判定')
    assert.equal(check.ok, false, '改了别的切片的地盘必须拒绝')
    assert.equal(check.counts.crossScope, 1)
    assert.equal(check.crossScope[0].path, 'src/b/x.js')
    assert.equal(check.counts.inScope, 1, 'src/a/new.js 属于本切片')
    assert.ok(check.issues.some((issue) => issue.code === 'CROSS_SCOPE_CHANGES'))
  } finally {
    env.dispose()
  }
})
