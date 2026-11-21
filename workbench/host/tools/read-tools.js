// 只读工具（T4）：project_status / project_brief / project_recall / doc_list / doc_get /
// task_list / slice_list。PM 与任务会话都可用；子 agent/普通会话不可见。
import { fail } from '../db.js'
import { estimateTokens, truncateToTokens } from '../util.js'
import { compileContext } from '../context.js'
import { resolveSlice } from '../orchestration.js'
import { params, S, N, requireProjectActor } from './spec-helpers.js'

const RECALL_BUDGET_DEFAULT = 500

function escapeLike(text) {
  return String(text).replace(/[#%_]/g, function (ch) { return '#' + ch })
}

function minimalDocument(doc) {
  return {
    id: doc.id,
    logicalKey: doc.logicalKey,
    type: doc.type,
    title: doc.title,
    status: doc.status,
    version: doc.currentVersion,
    sliceId: doc.sliceId,
    stage: doc.stage,
    updatedAt: doc.updatedAt,
  }
}

function minimalTask(task) {
  return {
    id: task.id,
    sliceId: task.sliceId,
    title: task.title,
    status: task.status,
    assigneeSession: task.assigneeSession,
    acceptance: task.acceptance,
    updatedAt: task.updatedAt,
  }
}

function minimalSlice(slice) {
  return {
    id: slice.id,
    key: slice.key,
    title: slice.title,
    type: slice.type,
    status: slice.status,
    ownerRole: slice.ownerRole,
    ownerSession: slice.ownerSession,
    parentId: slice.parentId,
    handoff: slice.currentHandoff ? String(slice.currentHandoff).slice(0, 200) : undefined,
    updatedAt: slice.updatedAt,
  }
}

/** project_status：项目/阶段/切片/待决策/活跃任务会话（读）。 */
export const projectStatus = {
  name: 'project_status',
  description: '查看当前项目状态：项目名、阶段与门禁、在办切片、待决策、活跃任务会话、你的角色身份。任何项目会话可调用，用于每步确认全局状态。',
  parameters: params({}, []),
  actors: ['pm', 'task', 'qa'],
  execute: async function (_args, _exec, actor, deps) {
    const overview = deps.project.overview(actor.db, actor.root)
    const decisions = deps.store.listDecisions(actor.db, { status: 'pending' }).slice(0, 10).map(function (decision) {
      return {
        id: decision.id,
        title: decision.title,
        question: decision.question,
        options: decision.options,
        recommended: decision.recommended,
        irreversible: decision.irreversible,
        gate: decision.gate,
        stage: decision.stage,
        sliceId: decision.sliceId,
      }
    })
    const sessions = deps.store.listSessions(actor.db, { status: 'active' }).map(function (session) {
      return {
        id: session.id,
        name: session.name,
        kind: session.kind,
        role: session.role,
        sliceId: session.sliceId,
        provider: session.provider,
        model: session.model,
        status: session.status,
      }
    })
    return {
      project: overview.project,
      counts: overview.counts,
      // v5：进度只报 verified 口径。PM 用它回答「到哪了」，而不是数 done。
      progress: overview.progress,
      stages: overview.stages ? overview.stages.map(function (stage) { return { key: stage.key, name: stage.name, status: stage.status, gate: stage.gate } }) : [],
      pendingDecisions: decisions,
      activeSessions: sessions,
      self: { actorKind: actor.kind, role: actor.role, name: actor.name, sliceId: actor.sliceId, root: actor.root },
    }
  },
}

/** project_brief：当前切片 L2 简报（PM 可指定 sliceId/sliceKey）。 */
export const projectBrief = {
  name: 'project_brief',
  description: '获取切片简报（L2）：切片状态、验收、交接摘要、相关文档标题与摘要、待决策、最近事件。任务会话默认本切片；PM 可传 sliceId/sliceKey。',
  parameters: params({
    sliceId: S('切片 id（可选；任务会话默认本切片）'),
    sliceKey: S('切片 key（可选，PM 用）'),
  }, []),
  actors: ['pm', 'task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    let sliceId = args.sliceId
    if (!sliceId && args.sliceKey) sliceId = resolveSlice(deps, actor, { sliceKey: args.sliceKey }).id
    if (!sliceId && actor.kind === 'task') sliceId = actor.sliceId
    const compiled = compileContext(actor.db, {
      roleKind: actor.kind,
      role: actor.role,
      sessionId: actor.session ? actor.session.id : undefined,
      sliceId: sliceId,
      taskId: actor.session && actor.session.context ? actor.session.context.taskId : undefined,
      includeL1: false,
      includeL2: true,
    })
    return { sliceId: sliceId || null, brief: compiled.parts.l2 || compiled.text, used: compiled.used, degraded: compiled.degraded }
  },
}

/** project_recall：≤500 token 片段检索（文档章节/决策/事件）。 */
export const projectRecall = {
  name: 'project_recall',
  description: '按需检索项目记忆，返回 ≤500 token 的片段与出处（文档章节/决策/事件），不返回全文。用于 2k 注入不够时补充上下文。',
  parameters: params({
    query: S('检索词（中文两字也可，走 LIKE 兜底）'),
    hint: S('检索方向提示：doc/decision/event（可选）'),
    limit: N('最大命中数，默认 5，最多 10'),
  }, ['query']),
  actors: ['pm', 'task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) throw fail('INVALID', 'query 必须是非空字符串')
    const limit = Math.max(1, Math.min(Number(args.limit) || 5, 10))
    const hint = typeof args.hint === 'string' ? args.hint.trim().toLowerCase() : ''
    const lines = []
    let hits = 0
    const addLine = function (line) {
      if (lines.length >= limit) return
      lines.push(line)
      hits += 1
    }
    if (hint === '' || hint.indexOf('doc') >= 0) {
      let sections = []
      try { sections = deps.docs.searchDocSections(actor.db, { query: query, limit: limit }) } catch (error) { sections = [] }
      for (const section of sections) {
        if (lines.length >= limit) break
        addLine('[doc] ' + section.title + '｜' + section.heading + '｜v' + section.version + '｜' + section.snippet + '｜ref:doc:' + section.documentId + '@' + section.version)
      }
    }
    if (hint === '' || hint.indexOf('decision') >= 0) {
      try {
        const like = '%' + escapeLike(query) + '%'
        const rows = actor.db.db.prepare("SELECT * FROM decisions WHERE project_id = ? AND (title LIKE ? ESCAPE '#' OR question LIKE ? ESCAPE '#') ORDER BY created_at DESC LIMIT 3").all(actor.db.projectId, like, like)
        for (const row of rows) {
          if (lines.length >= limit) break
          addLine('[decision] ' + row.title + '｜' + String(row.question || '').slice(0, 120) + '｜status=' + row.status + '｜ref:decision:' + row.id)
        }
      } catch (error) { /* 检索失败跳过该来源 */ }
    }
    if (hint === '' || hint.indexOf('event') >= 0) {
      try {
        const events = actor.db.listEvents({ limit: 200 })
        const found = events.filter(function (event) {
          const text = (event.kind || '') + ' ' + (event.payload ? JSON.stringify(event.payload) : '')
          return text.indexOf(query) >= 0
        })
        for (const event of found.slice(0, 3)) {
          if (lines.length >= limit) break
          addLine('[event] #' + event.seq + ' ' + event.kind + '｜' + String(event.at || '') + '｜' + JSON.stringify(event.payload || {}).slice(0, 120))
        }
      } catch (error) { /* 检索失败跳过该来源 */ }
    }
    if (lines.length === 0) return { query: query, results: '', hits: 0, used: 0, note: '没有命中；可换关键词或直接用 doc_list/doc_get。' }
    const body = lines.join('\n')
    const results = truncateToTokens(body, RECALL_BUDGET_DEFAULT)
    return { query: query, results: results, hits: hits, used: estimateTokens(results), truncated: results !== body }
  },
}

/** doc_list：文档列表（可按切片/类型/状态过滤）。 */
export const docList = {
  name: 'doc_list',
  description: '列出项目文档（id/类型/logicalKey/标题/状态/当前版本）。可按 sliceId、type、status 过滤。',
  parameters: params({
    sliceId: S('切片 id（可选）'),
    type: S('文档类型：prd|ux|adr|design|spec|report|handoff|retro（可选）'),
    status: S('文档状态：draft|review|approved|frozen（可选）'),
  }, []),
  actors: ['pm', 'task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    const filter = {}
    if (args.sliceId) filter.sliceId = args.sliceId
    if (args.type) filter.type = args.type
    if (args.status) filter.status = args.status
    const documents = deps.docs.listDocuments(actor.db, filter).map(minimalDocument)
    return { count: documents.length, documents: documents }
  },
}

/** doc_get：按 id 或 logicalKey 读取指定版本（默认最新版），内容超长会截断。 */
export const docGet = {
  name: 'doc_get',
  description: '读取文档指定版本（默认最新版）。返回正文但会截断到约 1500 token；需要更细请用 project_recall 检索章节。',
  parameters: params({
    id: S('文档 id（与 logicalKey 二选一）'),
    logicalKey: S('文档逻辑键，如 prd/payment-refund（与 id 二选一）'),
    version: N('版本号（可选，默认最新版）'),
  }, []),
  actors: ['pm', 'task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    let doc
    if (args.id) doc = deps.docs.getDocument(actor.db, args.id)
    else if (args.logicalKey) doc = deps.docs.findDocumentByLogicalKey(actor.db, args.logicalKey)
    else throw fail('INVALID', '需要 id 或 logicalKey')
    if (!doc) throw fail('NOT_FOUND', '文档不存在：' + (args.id || args.logicalKey))
    const versionNumber = args.version === undefined || args.version === null ? doc.currentVersion : Number(args.version)
    const version = deps.docs.getDocVersion(actor.db, doc.id, versionNumber)
    if (!version) throw fail('NOT_FOUND', '文档版本不存在：' + doc.id + ' v' + versionNumber)
    const capped = truncateToTokens(version.content || '', 1500)
    return {
      doc: minimalDocument(doc),
      version: { version: version.version, contentHash: version.contentHash, frozen: version.frozen, createdAt: version.createdAt },
      content: capped,
      truncated: capped !== (version.content || ''),
      used: estimateTokens(capped),
    }
  },
}

/** task_list：任务列表。 */
export const taskList = {
  name: 'task_list',
  description: '列出任务（id/切片/标题/状态/验收）。可按 sliceId、status 过滤。',
  parameters: params({
    sliceId: S('切片 id（可选）'),
    status: S('任务状态（可选）'),
  }, []),
  actors: ['pm', 'task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    const filter = {}
    if (args.sliceId) filter.sliceId = args.sliceId
    if (args.status) filter.status = args.status
    const tasks = deps.store.listTasks(actor.db, filter).map(minimalTask)
    return { count: tasks.length, tasks: tasks }
  },
}

/** slice_list：切片列表。 */
export const sliceList = {
  name: 'slice_list',
  description: '列出项目切片（id/key/标题/类型/状态/owner/交接摘要）。可按 status 过滤。',
  parameters: params({ status: S('切片状态（可选）') }, []),
  actors: ['pm', 'task', 'qa'],
  execute: async function (args, _exec, actor, deps) {
    const slices = deps.store.listSlices(actor.db, { status: args.status || undefined }).map(minimalSlice)
    return { count: slices.length, slices: slices }
  },
}

export function createReadTools(_ctx, _deps) {
  return [projectStatus, projectBrief, projectRecall, docList, docGet, taskList, sliceList]
}
