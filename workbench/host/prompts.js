// 系统提示注入（T4，契约 §8）：L0 每步注入；L1/L2 由 session-hooks 维护的 per-session 状态
// （首步 / 切切片）控制。非项目会话返回空串（= 不注入）。总预算由 host/context.js 硬裁剪。
//
// 注意：context.text 在每次 systemPrompt.assemble() 时重算；这里做 200ms 同一步 memo，
// 避免 L0 与 L1L2 两个 context 重复编译（同一 assemble 调用内两个 provider 会各调一次）。
import * as store from './store.js'
import { resolveActor, isProjectActor } from './orchestration.js'
import { compileContext, pendingFullInjection, markDowngrade } from './context.js'

const SNAPSHOT_TTL_MS = 200
const snapshots = new WeakMap()

/** 降级只在每个 session+切片首次发生时记一条 context/downgrade 事件（不刷时间线）。 */
function recordDowngrade(actor, compiled) {
  const token = actor.kind === 'pm' ? 'pm' : (actor.sliceId || 'task')
  if (!markDowngrade(actor.dshSessionId, { sliceId: token })) return
  try {
    actor.db.tx(function () {
      actor.db.appendEvent({
        kind: 'context/downgrade',
        sliceId: actor.sliceId || undefined,
        subjectType: 'session',
        subjectId: actor.session ? actor.session.id : undefined,
        role: actor.role,
        payload: {
          used: compiled.used,
          hardLimit: compiled.budget ? compiled.budget.hardLimit : undefined,
          l1l2: pendingFullInjection(actor.dshSessionId),
        },
      })
    })
  } catch (error) { /* 降级事件失败不影响提示注入 */ }
}

function computeSnapshot(deps, agent) {
  const actor = resolveActor(deps, agent)
  if (!isProjectActor(actor)) return undefined
  const full = pendingFullInjection(actor.dshSessionId)
  const session = actor.session || {}
  const context = session.context && typeof session.context === 'object' ? session.context : {}
  const compiled = compileContext(actor.db, {
    roleKind: actor.kind,
    role: actor.role,
    sessionId: session.id,
    sliceId: actor.sliceId,
    taskId: context.taskId,
    includeL1: full,
    includeL2: full,
    step: undefined,
  })
  if (compiled.degraded && full) recordDowngrade(actor, compiled)
  compiled.full = full
  return compiled
}

function snapshotFor(deps, agent) {
  if (!agent || typeof agent !== 'object') return undefined
  const now = Date.now()
  const cached = snapshots.get(agent)
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.value
  const value = computeSnapshot(deps, agent)
  snapshots.set(agent, { at: now, value: value })
  return value
}

/** 插件入口：注册 L0 与 L1/L2 两个 systemPrompt context。 */
export function registerPrompts(ctx, registry, bus) {
  const deps = { ctx: ctx, registry: registry, bus: bus, store: store }
  const guard = function (fn) {
    return function (context) {
      try {
        return fn(context) || ''
      } catch (error) {
        try { ctx.logger.warn('project-workbench: context provider failed: ' + String(error && error.message ? error.message : error)) } catch (logError) { /* logger 不可用 */ }
        return ''
      }
    }
  }
  // L0：每步注入（项目/阶段/门禁/当前切片/待决策/活跃任务会话）
  ctx.systemPrompt.context({
    name: 'workbench:l0',
    order: 130,
    required: false,
    text: guard(function (context) {
      const snapshot = snapshotFor(deps, context && context.agent)
      return snapshot ? snapshot.parts.l0 : ''
    }),
  })
  // L1/L2：会话启动/切切片时注入（由 session-hooks 的 per-session 状态控制）
  ctx.systemPrompt.context({
    name: 'workbench:l1l2',
    order: 131,
    required: false,
    text: guard(function (context) {
      const snapshot = snapshotFor(deps, context && context.agent)
      if (!snapshot || !snapshot.full) return ''
      return [snapshot.parts.l1, snapshot.parts.l2].filter(function (part) { return part && part.length > 0 }).join('\n\n')
    }),
  })
  return { deps: deps }
}
