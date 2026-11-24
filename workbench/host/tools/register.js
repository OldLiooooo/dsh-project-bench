// 工具注册（T4）：按契约 §7 汇总全部模型可见工具。
// 每个工具注册时都带 when({agent}) 过滤：非项目会话整组隐藏；PM/任务按权限分离。
// execute 里再解析一次 actor（防御 when 与执行之间的状态变化），未知会话明确报 NOT_PROJECT_SESSION。
import { fail } from '../db.js'
import { resolveActor, isProjectActor } from '../orchestration.js'
import { OBJECT_OUTPUT } from './spec-helpers.js'

/**
 * 工具输出必须是 lossless JSON（DSH 会校验；undefined/函数/循环引用都会让调用失败）。
 * 领域对象里常见 handoff/assignee 之类的 undefined，这里统一清洗：
 * - 去掉 undefined / 函数 / symbol；
 * - Date → ISO 字符串；
 * - 循环引用置为 "[circular]"；
 * - 其它非 JSON 原始值转字符串。
 */
export function toLosslessJson(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Date) return value.toISOString()
  const visited = seen || new Set()
  if (visited.has(value)) return '[circular]'
  visited.add(value)
  try {
    if (Array.isArray(value)) {
      const list = []
      for (const item of value) {
        const clean = toLosslessJson(item, visited)
        list.push(clean === undefined ? null : clean)
      }
      return list
    }
    const out = {}
    for (const key of Object.keys(value)) {
      const clean = toLosslessJson(value[key], visited)
      if (clean !== undefined) out[key] = clean
    }
    return out
  } finally {
    visited.delete(value)
  }
}
import { createReadTools } from './read-tools.js'
import { createPmTools } from './pm-tools.js'
import { createTaskTools } from './task-tools.js'
import { createSharedTools } from './shared-tools.js'

/** 全部工具 spec（不注册，测试/清单用）。 */
export function createToolSpecs(ctx, deps) {
  return [
    ...createReadTools(ctx, deps),
    ...createPmTools(ctx, deps),
    ...createTaskTools(ctx, deps),
    ...createSharedTools(ctx, deps),
  ]
}

/** 模型可见工具全集（名字 → 可见 actor 种类），供测试/文档校验。 */
export function toolCatalog(ctx, deps) {
  return createToolSpecs(ctx, deps).map(function (spec) {
    return { name: spec.name, actors: spec.actors.slice() }
  })
}

function actorAllowed(spec, actor) {
  return isProjectActor(actor) && Array.isArray(spec.actors) && spec.actors.includes(actor.kind)
}

/**
 * 注册全部项目工具。
 * @param {object} ctx Cordis 上下文（需 ctx.tools）
 * @param {object} deps {ctx, registry, bus, store, docs, leases, exporter, importer, project, projectDefaults}
 * @returns {{name:string, dispose:Function}[]}
 */
export function registerToolDefinitions(ctx, deps, options = {}) {
  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    throw new Error('project-workbench: ctx.tools 不可用，无法注册项目工具')
  }
  // 「首次真正用到项目工具时补跑一次重启对账」（v6.5）。
  //
  // 为什么需要第三个触发点：apply() 太早（registry 未就绪），就绪回调理论上够用，
  // 但服务注册顺序不是我们能假定的 —— 如果 inject 回调比 workspaceRegistry 真正可查更早，
  // 对账依然空转。第一次有人**真的调项目工具**时，服务必然已经可用，这时补跑最可靠。
  // 只跑一次：跑过就置位，之后每个工具调用不再付这个开销。
  let reconcilePending = typeof options.onFirstUse === 'function'
  const specs = createToolSpecs(ctx, deps)
  const registered = []
  for (const spec of specs) {
    const definition = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      output: OBJECT_OUTPUT,
      execute: async function (args, exec) {
        if (reconcilePending) {
          reconcilePending = false
          try { options.onFirstUse() } catch (error) { /* 对账失败不能拦住工具调用 */ }
        }
        const actor = resolveActor(deps, exec && exec.agent)
        if (!isProjectActor(actor)) {
          throw fail('NOT_PROJECT_SESSION', '当前会话不是项目会话（PM/任务会话）或项目尚未初始化；项目工具不可用。')
        }
        if (!Array.isArray(spec.actors) || !spec.actors.includes(actor.kind)) {
          throw fail('PERMISSION_DENIED', '工具 ' + spec.name + ' 仅 ' + spec.actors.join('/') + ' 可用；当前是 ' + actor.kind + '。')
        }
        return toLosslessJson(await spec.execute(args || {}, exec, actor, deps, deps.ctx))
      },
    }
    const when = function (context) {
      try {
        const actor = resolveActor(deps, context && context.agent)
        return actorAllowed(spec, actor)
      } catch (error) {
        return false
      }
    }
    const dispose = ctx.tools.register(definition, { when: when })
    registered.push({ name: spec.name, dispose: dispose })
  }
  return registered
}
