/**
 * 最小 Host 插件骨架（DSH 插件 = 导出 apply 的 Cordis 插件模块）。
 *
 * 约定：
 * - 所有注册都挂在 ctx 上，插件卸载时自动清理；需要手写清理的资源用 ctx.effect(() => cleanup)。
 * - 需要使用其他服务（tools / llm 等）时声明 `export const inject = ['tools']`。
 * - 可调参数放进 `export const Config`（Schemastery schema），不要硬编码。
 */
export const name = 'my-host-plugin'

export function apply(ctx) {
  // 在这里注册能力，例如：
  //   ctx.tools.register(defineTool({ ... }))
  //   ctx.on('some/event', handler)
  ctx.effect(() => {
    // 插件加载时执行；返回的函数在插件卸载时调用。
    return () => {}
  })
}
