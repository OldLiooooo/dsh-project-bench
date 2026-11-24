// Host entry for the project workbench bundle.
// Composition root only: all behavior lives in host/* modules owned by module leads.
//
// Service split (DSH plugin rule 「可选服务放 inject」): only the services every target profile
// (web / headless / CLI) actually mounts are hard-required. Everything else is acquired lazily:
// - 核心运行时：tools / systemPrompt / agents / sessions / subagents / skills
// - workspaceRegistry：GUI profile 有（用于 workspace→项目准入）；headless/CLI 没有时，
//   registry 退化为「目录里已有 .project 运行时的才准入」（仍拒绝任意路径）。
// - webServer + connection：只有 web profile 有；有则注册面板数据/SSE 通道（先 requestRejection 鉴权）。
// - actionCards：实验服务，未挂载时决策卡 kind 安全跳过（面板/PM 对话里仍可拍板）。
import { createBus } from './host/bus.js'
import { createRegistry } from './host/registry.js'
import { registerSessionHooks } from './host/session-hooks.js'
import { registerPrompts } from './host/prompts.js'
import { registerTools } from './host/tools/index.js'
import { registerHttp } from './host/http.js'
import { registerSkills } from './host/skills.js'
import { registerActionCards } from './host/cards.js'

export const name = 'project-workbench'
export const inject = ['tools', 'systemPrompt', 'agents', 'sessions', 'subagents', 'skills']

export function apply(ctx) {
  const bus = createBus()
  const registry = createRegistry(ctx)
  ctx.effect(() => () => { bus.close(); registry.closeAll() }, 'workbench: dispose runtime')
  // 返回值带一个 reconcile()：apply 这一刻 registry 多半还没就绪（见 session-hooks.js 的说明），
  // 真正的对账要在 workspaceRegistry 注入后补跑一次，否则重启清不掉 active 幽灵。
  const sessionHooks = registerSessionHooks(ctx, registry, bus)
  registerPrompts(ctx, registry, bus)
  registerSkills(ctx, registry)
  // 第三个触发点：第一次真的调用项目工具时补跑对账（见 register.js 的 onFirstUse 说明）。
  // 幂等且只跑一次；失败只记警告，不拦工具调用。
  registerTools(ctx, registry, bus, {
    onFirstUse: function () {
      if (typeof sessionHooks.reconcile === 'function') sessionHooks.reconcile()
    },
  })
  registerActionCards(ctx, registry, bus)

  const state = { panel: false, workspaceRegistry: false }
  if (typeof ctx.inject === 'function') {
    // 面板数据通道：web profile 才有 webServer/connection。
    ctx.inject(['webServer', 'connection'], function (webCtx) {
      try {
        registerHttp(webCtx, registry, bus)
        state.panel = true
      } catch (error) {
        try { ctx.logger.warn('project-workbench: 面板数据通道注册失败：' + String((error && error.message) || error)) } catch (logError) { /* logger 不可用 */ }
      }
    })
    // workspaceRegistry：GUI（web/desktop）profile 有；headless/CLI 里 registry 走 .project 回退。
    ctx.inject(['workspaceRegistry'], function (guiCtx) {
      state.workspaceRegistry = true
      try { guiCtx.logger?.debug?.('project-workbench: workspace registry available') } catch (logError) { /* logger 不可用 */ }
      // v6.5：这才是重启对账**真正生效**的地方 —— apply() 那一刻这个服务还没就绪，
      // 那时跑对账是静默空转（listProjects() 返回 []，一条会话都不处理，也不报错）。
      // 实测代价：lumio 真库里 5 条 qa 会话重启后原样留着，且全库没有一条 HOST_RESTART 记录。
      try {
        if (sessionHooks && typeof sessionHooks.reconcile === 'function') sessionHooks.reconcile()
      } catch (error) {
        try { ctx.logger.warn('project-workbench: 就绪后对账失败：' + String((error && error.message) || error)) } catch (logError) { /* logger 不可用 */ }
      }
    })
    ctx.effect(() => () => { state.panel = false }, 'workbench: panel channel lifecycle')
  }
  ctx.logger?.info?.('project-workbench: project runtime loaded')
}
