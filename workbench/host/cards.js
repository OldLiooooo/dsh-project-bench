// actionCards 可选集成（T4）：注册「项目决策」卡片 kind。
// dsh-action-cards 在 web profile 默认未挂载：ctx.inject 只在服务存在时回调；kind 注册用 try/catch 兜底，
// 服务不存在/版本不匹配都不会影响插件启动。卡片动作等价于用户在面板拍板（PM/agent 仍不得代批）。
import * as store from './store.js'
import * as project from './project.js'
import { resolveActor, isProjectActor } from './orchestration.js'
import { DECISION_CARD_SKILL } from './skills.js'

export const DECISION_CARD_ACTION = 'project-decision'
export const DECISION_CARD_KIND = {
  action: DECISION_CARD_ACTION,
  skill: DECISION_CARD_SKILL,
  invitation: '请在下方卡片里批准或驳回该决策；不可逆决策需要二次确认。',
  verbs: ['approve', 'reject'],
}

function refused(reason) {
  return { status: 'refused', reason: reason }
}

function unconfirmed(reason) {
  return { status: 'unconfirmed', reason: reason }
}

/** 极简 details 校验器：actionCards 只要求 safeParse 形状（不 import zod）。 */
function createDetailsValidator() {
  return {
    safeParse: function (value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { success: false, error: { issues: [{ path: ['details'], message: 'details 必须是对象' }] } }
      }
      if (typeof value.decisionId !== 'string' || value.decisionId.trim() === '') {
        return { success: false, error: { issues: [{ path: ['decisionId'], message: 'decisionId 必填' }] } }
      }
      return { success: true, data: value }
    },
  }
}

function createKind(ctx, registry) {
  const deps = { ctx: ctx, registry: registry, store: store, project: project }
  return {
    action: DECISION_CARD_ACTION,
    skill: DECISION_CARD_SKILL,
    invitation: DECISION_CARD_KIND.invitation,
    verbs: DECISION_CARD_KIND.verbs.slice(),
    openPhases: [],
    statusGuidance: ['用户在卡片上批准/驳回项目决策；用 project_status 查看最新待决策。'],
    statusFields: ['status', 'gate'],
    details: createDetailsValidator(),
    async act(agent, card, verb, payload) {
      if (verb !== 'approve' && verb !== 'reject') return refused('unavailable')
      const actor = resolveActor(deps, agent)
      if (!isProjectActor(actor)) return refused('not-live-root')
      const details = card && card.details ? card.details : {}
      const decisionId = details.decisionId
      if (typeof decisionId !== 'string') return refused('unavailable')
      const decision = store.getDecision(actor.db, decisionId)
      if (!decision) return refused('unavailable')
      const confirmed = Boolean(payload && payload.confirmed === true)
      if (decision.irreversible && verb === 'approve' && !confirmed) {
        return unconfirmed('不可逆决策需要用户在卡片上再次确认（confirmed=true）')
      }
      let result
      try {
        result = await project.resolveDecisionAction(ctx, actor.db, {
          id: decisionId,
          status: verb === 'approve' ? 'approved' : 'rejected',
          confirmed: confirmed,
          rationale: payload && typeof payload.rationale === 'string' ? payload.rationale : undefined,
          answer: payload && payload.answer !== undefined && payload.answer !== null ? String(payload.answer) : undefined,
          decidedBy: 'user',
        }, { root: actor.root, registry: registry })
      } catch (error) {
        const code = error && error.code ? error.code : ''
        if (code === 'CONFIRM_REQUIRED') return unconfirmed('不可逆决策需要二次确认')
        return refused('unavailable')
      }
      const phase = verb === 'approve' ? 'approved' : 'rejected'
      const record = {
        callId: card.callId,
        action: DECISION_CARD_ACTION,
        phase: phase,
        data: { status: phase, gate: decision.gate || null, decisionId: decisionId },
      }
      try { ctx.actionCards.record(agent, record) } catch (error) { /* 记录失败不改变已执行的拍板结果 */ }
      return { status: 'settled', decision: record, result: result ? { actions: result.actions || null } : null }
    },
  }
}

/** 插件入口：actionCards 服务存在时注册决策卡 kind（不存在则安全跳过）。 */
export function registerActionCards(ctx, registry, bus) {
  if (!ctx || typeof ctx.inject !== 'function') return { registered: false, reason: 'no-inject' }
  let state = { registered: false, reason: 'actionCards-service-not-mounted' }
  ctx.inject(['actionCards'], function (actionCtx) {
    try {
      actionCtx.actionCards.register(createKind(actionCtx, registry))
      state = { registered: true }
    } catch (error) {
      state = { registered: false, reason: String(error && error.message ? error.message : error) }
      try { ctx.logger.warn('project-workbench: actionCards kind 注册失败：' + state.reason) } catch (logError) { /* logger 不可用 */ }
    }
  })
  return state
}
