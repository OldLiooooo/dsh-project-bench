// 工具定义公共件（T4）：JSON Schema 小工具、输出声明、actor 守卫、写后通知。
// 所有工具都用原生 JSON Schema 定义参数与输出（不 import @deepseek-ai/*）。
import { fail } from '../db.js'
import { resolveActor, isProjectActor, actorRoot } from '../orchestration.js'

/** 工具输出声明：对象结果，渲染为 JSON 文本（模型可读）。 */
export const OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: function (_args, value) {
    if (typeof value === 'string') return [{ type: 'text', text: value }]
    try {
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    } catch (error) {
      return [{ type: 'text', text: String(value) }]
    }
  },
}

/** 组装参数 schema：对象根 + 显式 additionalProperties:false（子集要求）。 */
export function params(properties, required) {
  const schema = { type: 'object', properties: properties || {}, additionalProperties: false }
  if (Array.isArray(required) && required.length > 0) schema.required = required.slice()
  return schema
}

export function S(description) { return { type: 'string', description: description } }
export function N(description) { return { type: 'number', description: description } }
export function B(description) { return { type: 'boolean', description: description } }
export function A(items, description) { return { type: 'array', items: items, description: description } }
export function STRING_ARRAY(description) { return { type: 'array', items: { type: 'string' }, description: description } }

/** 当前会话的 actor；非 PM/任务会话调用项目工具一律拒绝。 */
export function requireProjectActor(deps, exec, allowed) {
  const agent = exec && exec.agent
  const actor = resolveActor(deps, agent)
  if (!isProjectActor(actor)) {
    throw fail('NOT_PROJECT_SESSION', '当前会话不是项目会话（只有项目办公室 PM 与任务会话能使用项目工具）。请回到 PM 会话操作。')
  }
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(actor.kind)) {
    const who = allowed.includes('pm') && !allowed.includes('task') ? 'PM（项目办公室）' : allowed.join('/')
    throw fail('PERMISSION_DENIED', '该工具仅 ' + who + ' 可用；当前会话是 ' + actor.kind + '。')
  }
  if (!actor.db) throw fail('NOT_PROJECT_SESSION', '当前会话没有已初始化的项目库。请先在项目面板初始化项目。')
  return actor
}

/** 任务会话的切片：显式参数优先，其次会话绑定的切片。 */
export function requireSliceId(actor, requested) {
  const sliceId = requested || actor.sliceId
  if (!sliceId) throw fail('INVALID', '缺少 sliceId（任务会话应绑定切片；PM 请显式传入）')
  return sliceId
}

/** 写后向客户端广播新 revision（SSE 只推 revision，客户端重拉快照）。 */
export function notifyWrite(deps, actor) {
  try {
    if (deps.bus && actor && actor.db) deps.bus.emit(actor.root, actor.db.revision())
  } catch (error) { /* 广播失败不影响领域写 */ }
}

/** 当前阶段行（无则 undefined）。 */
export function currentStageOf(deps, db) {
  try {
    if (deps.project && typeof deps.project.currentStage === 'function') return deps.project.currentStage(db) || undefined
  } catch (error) { /* 查询失败按无阶段处理 */ }
  return undefined
}

/** project.json 的 exportMap（缺失时用默认映射）。 */
export function exportMapOf(deps, actor) {
  try {
    if (deps.registry && typeof deps.registry.projectJson === 'function' && actor.root) {
      const config = deps.registry.projectJson(actor.root)
      if (config && config.exportMap && typeof config.exportMap === 'object') return config.exportMap
    }
  } catch (error) { /* 回退默认值 */ }
  try {
    if (deps.projectDefaults && typeof deps.projectDefaults.defaultExportMap === 'function') return deps.projectDefaults.defaultExportMap()
  } catch (error) { /* 回退默认值 */ }
  return undefined
}

/** 取字符串参数并校验非空。 */
export function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('INVALID', field + ' 必须是非空字符串')
  return value.trim()
}

export function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 判断路径是否在项目根内且不是绝对路径/上级目录（片外零改动声明用）。 */
export function normalizeProjectPath(path, root) {
  const text = requireText(path, 'files[]')
  const normalized = text.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) throw fail('INVALID', 'files[] 必须是项目内相对路径：' + text)
  const parts = normalized.split('/')
  if (parts.some(function (part) { return part === '..' })) throw fail('INVALID', 'files[] 不能包含 .. 上级路径：' + text)
  return normalized
}

export function rootOf(actor) {
  return actorRoot(actor)
}
