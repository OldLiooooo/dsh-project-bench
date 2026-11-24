// 会话生命周期钩子（T4，契约 §8）：
// - session/created：project-office → 确保项目初始化 + 登记/切换 PM 行；project-task → 绑定预登记 task 行；
// - session/event(model/selection)：记录 sessions.provider/model（不写时间线事件，避免噪音）；
// - agent/pre-step：维护 per-session 注入状态（首步注入 L1/L2，切切片重新注入）；
// - session/disposed：active 任务行标 interrupted（不删数据），释放租约；
// - 插件 apply 时对账：DB 中 active 但无 live agent 的任务会话 → interrupted（PM 保留 active）。
import * as store from './store.js'
import * as leases from './leases.js'
import * as project from './project.js'
import { findProjectRoot } from './util.js'
import {
  resolveActor, isProjectActor, reconcileStaleSessions, invalidateActorCache,
} from './orchestration.js'
import {
  markSessionStartInjection, noteStep, pendingFullInjection, consumeFullInjection, forgetSessionInjection,
} from './context.js'

const PROJECT_PRESETS = ['project-office', 'project-task', 'project-qa']

function presetOf(session) {
  return session && session.header ? session.header.agentPreset : undefined
}

function isProjectPreset(session) {
  return PROJECT_PRESETS.includes(presetOf(session))
}

function cwdOf(session) {
  return session && session.header ? session.header.cwd : undefined
}

/** cwd → 已登记工作区根（fallback：向上找 .project/project.json）。 */
function resolveRoot(registry, cwd) {
  if (!cwd) return undefined
  try { return registry.rootForWorkspace(cwd) } catch (error) { /* 继续 fallback */ }
  const root = findProjectRoot(cwd)
  if (!root) return undefined
  try { return registry.rootForWorkspace(root) } catch (error) { return undefined }
}

function warn(ctx, message) {
  try { ctx.logger.warn('project-workbench: ' + message) } catch (error) { /* logger 不可用 */ }
}

function emitChange(bus, db, root) {
  try {
    if (bus && db && root) bus.emit(root, db.revision())
  } catch (error) { /* 广播失败不影响领域写 */ }
}

function indexOf(sessionIndex, dshSessionId) {
  return sessionIndex.get(dshSessionId)
}

function remember(sessionIndex, session, entry) {
  if (session && session.id) sessionIndex.set(session.id, entry)
}

/** PM 会话创建：初始化项目 + 登记/切换 PM 行（幂等）。 */
function handlePmCreated(ctx, registry, bus, sessionIndex, session) {
  const rootInfo = resolveRoot(registry, cwdOf(session))
  if (!rootInfo) return
  let db
  try {
    project.initProject(registry, { workspaceId: rootInfo.workspaceId })
    db = registry.open(rootInfo.workspaceId)
  } catch (error) {
    warn(ctx, 'PM 会话初始化项目失败：' + String(error && error.message ? error.message : error))
    return
  }
  if (!db) return
  try {
    project.bindPmSession(db, { dshSessionId: session.id })
  } catch (error) {
    warn(ctx, '登记 PM 会话失败：' + String(error && error.message ? error.message : error))
  }
  remember(sessionIndex, session, { root: rootInfo.root, db: db, kind: 'pm' })
  markSessionStartInjection(session.id, undefined)
  invalidateActorCache(session.id)
  emitChange(bus, db, rootInfo.root)
}

/** 任务会话创建：绑定 PM 预登记的 task 行（按 dshSessionId），准备首步注入。 */
function handleTaskCreated(ctx, registry, bus, sessionIndex, session) {
  const rootInfo = resolveRoot(registry, cwdOf(session))
  if (!rootInfo) return
  let db
  try { db = registry.open(rootInfo.workspaceId) } catch (error) { db = undefined }
  if (!db) return
  let row
  try { row = store.findSessionByDshId(db, session.id) } catch (error) { row = undefined }
  if (!row) {
    const header = session.header || {}
    // 任务会话自己拉起的子 agent 也继承 project-task preset，但没有项目登记行 —— 属预期，不告警。
    if (header.origin !== 'subagent' && !(typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) {
      warn(ctx, '任务会话没有预登记行（可能不是由 session_spawn_task 启动）：' + session.id)
    }
    return
  }
  remember(sessionIndex, session, { root: rootInfo.root, db: db, kind: 'task', dbSessionId: row.id })
  markSessionStartInjection(session.id, row.sliceId)
  invalidateActorCache(session.id)
  emitChange(bus, db, rootInfo.root)
}

/** model/selection：把会话实际使用的 provider/model 同步到 sessions 行（无事件）。 */
function handleModelSelection(ctx, registry, bus, sessionIndex, session, event) {
  const data = event && event.data ? event.data : {}
  if (!data || typeof data.provider !== 'string' || typeof data.model !== 'string') return
  const known = indexOf(sessionIndex, session.id)
  if (!known) {
    const header = session.header || {}
    if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) return
  }
  let db = known ? known.db : undefined
  let root = known ? known.root : undefined
  if (!db) {
    const rootInfo = resolveRoot(registry, cwdOf(session))
    if (!rootInfo) return
    root = rootInfo.root
    try { db = registry.open(rootInfo.workspaceId) } catch (error) { db = undefined }
    if (!db) return
    remember(sessionIndex, session, { root: root, db: db, kind: presetOf(session) === 'project-office' ? 'pm' : 'task' })
  }
  let row
  try { row = store.findSessionByDshId(db, session.id) } catch (error) { row = undefined }
  if (!row) return
  const patch = { id: row.id, provider: data.provider, model: data.model }
  if (typeof data.reasoningEffort === 'string') patch.reasoningEffort = data.reasoningEffort
  try {
    store.updateSession(db, patch)
    invalidateActorCache(session.id)
    emitChange(bus, db, root)
  } catch (error) {
    warn(ctx, '同步会话模型失败：' + String(error && error.message ? error.message : error))
  }
}

/** 会话释放：active 任务会话 → interrupted + 释放租约；PM 行保留 active。 */
function handleDisposed(ctx, registry, bus, sessionIndex, session) {
  const known = indexOf(sessionIndex, session.id)
  if (!known) {
    const header = session.header || {}
    if (header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)) return
  }
  let db = known ? known.db : undefined
  let root = known ? known.root : undefined
  if (!db) {
    const rootInfo = resolveRoot(registry, cwdOf(session))
    if (rootInfo) {
      root = rootInfo.root
      try { db = registry.open(rootInfo.workspaceId) } catch (error) { db = undefined }
    }
  }
  if (db) {
    let row
    try { row = store.findSessionByDshId(db, session.id) } catch (error) { row = undefined }
    // v6.3：task 之外也要结束 qa —— 验收会话原先不在任何兜底路径里，DSH 会话释放后
    // DB 行仍是 active，重启对账（见 orchestration.reconcileStaleSessions）同样只扫 task，
    // 于是 QA 行一旦创建就是终态 active，同切片再也拉不起验收（lumio 真库 P0-3）。
    // qa 不持租约，所以下面按 sliceId 释放租约那段对它天然不生效。
    if (row && (row.kind === 'task' || row.kind === 'qa') && row.status === 'active') {
      try {
        store.endSession(db, { id: row.id, status: 'interrupted' })
        if (row.sliceId) {
          try {
            const lease = leases.getLease(db, row.sliceId)
            if (lease && lease.sessionId === row.id) leases.releaseLease(db, { sliceId: row.sliceId, sessionId: row.id })
          } catch (error) { /* 租约已被回收 */ }
        }
        emitChange(bus, db, root)
      } catch (error) {
        warn(ctx, '标记任务会话 interrupted 失败：' + String(error && error.message ? error.message : error))
      }
    }
  }
  sessionIndex.delete(session.id)
  forgetSessionInjection(session.id)
  invalidateActorCache(session.id)
}

/**
 * 重启/插件重载对账（v6.5）。
 *
 * 为什么从 apply() 里搬出来：apply() 是同步执行的，那一刻 workspaceRegistry 尚未就绪，
 * 于是 registry.listProjects() 返回 []，对账循环一次都不进 —— 它是**静默空转**，
 * 既不清会话也不报错。实测证据（lumio 真库）：库里 5 条 kind='qa' 的 active 会话，
 * 重启后原样还在；全部 4 条 interrupted 记录的 failureCode 都是 INTERRUPTED
 * （session/disposed 那条路径写的），**没有任何一条是 HOST_RESTART** ——
 * 也就是说这条对账从未在这台机器上成功跑过一次。
 *
 * 现在的做法：三个触发点，谁先就绪谁跑，且**幂等**（重复跑不会误伤，见 reconcileStaleSessions
 * 里的 live-agent 判定）：
 *   1. apply 时先跑一次 —— headless/CLI profile 没有 workspaceRegistry，靠这一条；
 *   2. workspaceRegistry 注入就绪后再跑一次 —— GUI profile 真正生效的就是这一条；
 *   3. 首次真正用到项目工具时补跑一次 —— 兜住「就绪回调比服务可用更早」的极端顺序。
 * 空转时不许安静：listProjects() 为空也要 warn 出来，否则下次还是没人知道它没跑。
 */
export function reconcileOnReady(ctx, registry, deps, bus, options = {}) {
  const tag = options.tag || 'startup'
  let result = { projects: 0, checked: 0, interrupted: 0, leasesReleased: 0 }
  try {
    result = reconcileStaleSessions(ctx, registry, deps)
  } catch (error) {
    warn(ctx, '重启对账失败（' + tag + '）：' + String(error && error.message ? error.message : error))
    return result
  }
  if (result.projects === 0) {
    // 没有项目 = registry 还没就绪（或确实没有项目）。区别对待：前者要能被看见。
    warn(ctx, '重启对账空转（' + tag + '）：registry.listProjects() 返回 0 个项目，本次没有对账任何会话')
  }
  if (result.interrupted > 0) {
    let projects = []
    try { projects = registry.listProjects() } catch (error) { projects = [] }
    for (const item of projects) {
      if (!item || !item.exists) continue
      try {
        const db = registry.open(item.workspaceId !== undefined ? item.workspaceId : item.root)
        if (db) emitChange(bus, db, item.root)
      } catch (error) { /* 单个项目失败忽略 */ }
    }
  }
  return result
}
/**
 * 注册全部会话钩子。重启对账只是**尝试**一次（真正生效见 reconcileOnReady）。
 * @returns {{projects:number, checked:number, interrupted:number, leasesReleased:number}}
 */
export function registerSessionHooks(ctx, registry, bus) {
  const deps = { ctx: ctx, registry: registry, bus: bus, store: store, leases: leases, project: project }
  const sessionIndex = new Map()

  ctx.on('session/created', function (session) {
    try {
      if (!isProjectPreset(session)) return
      if (presetOf(session) === 'project-office') handlePmCreated(ctx, registry, bus, sessionIndex, session)
      else handleTaskCreated(ctx, registry, bus, sessionIndex, session)
    } catch (error) {
      warn(ctx, 'session/created 处理失败：' + String(error && error.message ? error.message : error))
    }
  })

  ctx.on('session/event', function (session, event) {
    try {
      if (!isProjectPreset(session)) return
      if (!event || event.type !== 'model/selection') return
      handleModelSelection(ctx, registry, bus, sessionIndex, session, event)
    } catch (error) {
      warn(ctx, 'session/event 处理失败：' + String(error && error.message ? error.message : error))
    }
  })

  // waterfall：必须返回 next()（或决策），这里只观察 + 维护注入状态。
  ctx.on('agent/pre-step', async function (payload, next) {
    try {
      const agent = payload && payload.agent
      const session = agent && agent.session
      if (session && isProjectPreset(session)) {
        const actor = resolveActor(deps, agent)
        if (isProjectActor(actor)) {
          const wasPending = pendingFullInjection(session.id)
          noteStep(session.id, { step: payload.step, sliceId: actor.sliceId })
          // 本步的 L1/L2 已在 prompt 组装时注入（pendingFull=true）；落账后为下一步收紧。
          if (wasPending) consumeFullInjection(session.id, actor.sliceId)
        }
      }
    } catch (error) {
      warn(ctx, 'agent/pre-step 处理失败：' + String(error && error.message ? error.message : error))
    }
    return next()
  })

  ctx.on('session/disposed', function (session) {
    try {
      if (!isProjectPreset(session)) return
      handleDisposed(ctx, registry, bus, sessionIndex, session)
    } catch (error) {
      warn(ctx, 'session/disposed 处理失败：' + String(error && error.message ? error.message : error))
    }
  })

  // 重启/插件重载对账：没有 live agent 的 active 任务会话标 interrupted。
  // 这里只是**第一次**尝试——此刻 registry 很可能还没就绪（见 reconcileOnReady 的说明）。
  // 真正的生效点在 index.js 的 workspaceRegistry 注入回调与首次工具调用。
  const reconcile = reconcileOnReady(ctx, registry, deps, bus, { tag: 'apply' })
  // 把对账能力交给调用方（index.js），供就绪回调/首用补跑。
  return Object.assign(reconcile, { reconcile: () => reconcileOnReady(ctx, registry, deps, bus, { tag: 'ready' }) })
}
