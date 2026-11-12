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
  registerSessionHooks(ctx, registry, bus)
  registerPrompts(ctx, registry, bus)
  registerSkills(ctx, registry)
  registerTools(ctx, registry, bus)
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
    })
    ctx.effect(() => () => { state.panel = false }, 'workbench: panel channel lifecycle')
  }
  ctx.logger?.info?.('project-workbench: project runtime loaded')
}
