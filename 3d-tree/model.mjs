// 3d-tree/model.mjs
//
// 只读投影层：把一个 .project/project.db 变成「3D 树 + 完成度」。
//
// 设计原则（为什么长这样）：
//   1. 纯函数，不碰 HTTP、不碰 DOM —— 完成度算法必须能单测，否则数字没人敢信。
//   2. 只用 node:sqlite 的 readOnly 连接，**一行都不写**。这是个旁路观察器，
//      不是第二个写入者；单写者不变量（架构 invariant 1）不受影响。
//   3. 完成度不是猜的：每个阶段的「应有产物」来自阶段模板的 deliverableTypes，
//      实际产物来自 documents 表（按 stage 归组），文档状态换算权重。缺什么一目了然。
//   4. 文件完成度 = 文档在 DB 里的状态权重 × 是否已导出到磁盘。后者用 exports 表
//      的路径再 stat 一次，得到「DB 说有，磁盘上也真有」。

import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  DECISION_RESOLVED_STATUS,
  DEFAULT_STAGE_TEMPLATE,
  DOC_STATE_WEIGHT,
  SLICE_EXCLUDED_STATUS,
  TASK_STATUS_WEIGHT,
} from './defaults.mjs'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function safeJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  if (typeof text !== 'string') return text
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function clamp01(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

/** 权重 -> 百分比整数。0.004 -> 0，0.996 -> 100。 */
export function pct(weight) {
  return Math.round(clamp01(weight) * 100)
}

/**
 * 阶段模板：优先 project.json 里的 stageTemplate，缺失/非法回退内置默认。
 * 与插件 host/project-defaults.js 的 resolveStageTemplate 同语义（宽松版）。
 */
export function normalizeStageTemplate(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return cloneTemplate(DEFAULT_STAGE_TEMPLATE)
  const out = []
  const seen = new Set()
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i]
    if (!item || typeof item !== 'object') continue
    const key = String(item.key || '').trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    const types = Array.isArray(item.deliverableTypes)
      ? item.deliverableTypes.map((x) => String(x).trim()).filter(Boolean)
      : []
    out.push({
      key,
      name: String(item.name || key).trim(),
      gate: item.gate ? String(item.gate).trim() : null,
      deliverableTypes: types,
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : i,
    })
  }
  if (out.length === 0) return cloneTemplate(DEFAULT_STAGE_TEMPLATE)
  return out.sort((a, b) => a.position - b.position)
}

function cloneTemplate(template) {
  return template.map((item, index) => ({
    key: item.key,
    name: item.name,
    gate: item.gate ?? null,
    deliverableTypes: [...item.deliverableTypes],
    position: index,
  }))
}

/** 与插件 export.js 的 documentFileName 同规则：logicalKey 的斜杠换成 '-'。 */
export function documentFileName(logicalKey, documentId) {
  const base = String(logicalKey || documentId).replace(/[\\/]+/g, '-')
  return base + '.md'
}

/** 与插件 export.js 的 exportSubdir 同规则（exportMap 缺省时按 type 落子目录）。 */
export function exportSubdir(type, exportMap) {
  const map = exportMap && typeof exportMap === 'object' ? exportMap : {}
  const mapped = Object.prototype.hasOwnProperty.call(map, type) ? map[type] : undefined
  const raw = mapped === undefined || mapped === null ? type : mapped
  let cleaned = String(raw).replace(/\\/g, '/').replace(/^\.\//, '')
  cleaned = cleaned.replace(/^docs\//, '')
  const segments = cleaned.split('/').filter((part) => part.length > 0)
  return segments.length > 0 ? segments.join('/') : 'misc'
}

/** docs/ 下的相对路径；越界返回 null。 */
export function documentExportRel(type, logicalKey, documentId, exportMap) {
  const subdir = exportSubdir(type, exportMap)
  const fileName = documentFileName(logicalKey, documentId)
  const docsRoot = resolve('docs')
  const abs = resolve(docsRoot, subdir, fileName)
  const rel = relative(docsRoot, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null
  return subdir + '/' + fileName
}

// ---------------------------------------------------------------------------
// 读库（全部只读）
// ---------------------------------------------------------------------------

function all(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}

function one(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params)
  } catch {
    return undefined
  }
}

/** 读一个项目库的全部原始行。缺表不报错（老库/半迁移库照样能看树）。 */
export function readProjectRows(db) {
  const project = one(db, 'SELECT * FROM projects LIMIT 1') || {}
  return {
    project,
    stages: all(db, 'SELECT * FROM stages ORDER BY position ASC'),
    slices: all(db, 'SELECT * FROM slices ORDER BY created_at ASC, key ASC'),
    tasks: all(db, 'SELECT * FROM tasks'),
    sessions: all(db, 'SELECT * FROM sessions'),
    documents: all(db, 'SELECT * FROM documents'),
    decisions: all(db, 'SELECT * FROM decisions'),
    evidence: all(db, 'SELECT * FROM evidence'),
    approvals: all(db, 'SELECT * FROM approvals'),
    exports: all(db, 'SELECT * FROM exports ORDER BY exported_at DESC'),
    events: all(db, 'SELECT * FROM events ORDER BY seq DESC LIMIT 200'),
  }
}

// ---------------------------------------------------------------------------
// 完成度
// ---------------------------------------------------------------------------

/**
 * 文档完成度权重。
 * 冻结/批准=1，评审=0.6，草稿=0.3；但**没写过正文的文档**（current_version=0）
 * 无论状态都只给 0 —— 一个 0 版本的 'frozen' 文档是数据异常，不该被算成完成。
 */
export function documentWeight(doc) {
  if (!doc) return 0
  const version = Number(doc.current_version || 0)
  if (version <= 0) return 0
  const base = DOC_STATE_WEIGHT[doc.status]
  return base === undefined ? 0.3 : base
}

export function taskWeight(task) {
  if (!task) return 0
  const base = TASK_STATUS_WEIGHT[task.status]
  return base === undefined ? 0 : base
}

/**
 * 一个切片的完成度。
 * 三个来源，按「有没有」动态加权，避免空项目永远 0% 或永远 100%：
 *   文档（权重 5）> 任务（权重 4）> 子对象齐全度（权重 1，只作少量补充）。
 * 分母只算"存在的东西"，所以没有任务的切片不会因为没任务而被判 0。
 */
export function sliceCompletion(input) {
  const docs = input.documents || []
  const tasks = input.tasks || []
  const parts = []
  let docScore = 0
  if (docs.length > 0) {
    const sum = docs.reduce((acc, doc) => acc + documentWeight(doc), 0)
    docScore = sum / docs.length
    parts.push({ key: 'documents', weight: 5, score: docScore })
  }
  let taskScore = 0
  if (tasks.length > 0) {
    taskScore = tasks.reduce((acc, task) => acc + taskWeight(task), 0) / tasks.length
    parts.push({ key: 'tasks', weight: 4, score: taskScore })
  }
  const decisions = input.decisions || []
  let decisionScore = null
  if (decisions.length > 0) {
    const resolved = decisions.filter((d) => DECISION_RESOLVED_STATUS.has(d.status)).length
    decisionScore = resolved / decisions.length
    parts.push({ key: 'decisions', weight: 2, score: decisionScore })
  }
  if (parts.length === 0) return { score: 0, parts: [], empty: true }
  const totalWeight = parts.reduce((acc, part) => acc + part.weight, 0)
  const score = parts.reduce((acc, part) => acc + part.score * part.weight, 0) / totalWeight
  return { score: clamp01(score), parts, empty: false }
}

/**
 * 阶段完成度 = 该阶段切片的完成度均值 × 0.7 + 该阶段应有产物的覆盖率 × 0.3。
 * 第二个分量就是"缺哪个交付物"的机器表示：模板说 S3 要有 adr/design/spec，
 * 库里一个都没有，则覆盖率 0。
 */
export function stageCompletion(input) {
  const slices = input.slices || []
  const documents = input.documents || []
  const deliverableTypes = input.deliverableTypes || []
  const sliceScores = slices.map((slice) => sliceCompletion({
    documents: documents.filter((d) => d.slice_id === slice.id),
    tasks: (input.tasks || []).filter((t) => t.slice_id === slice.id),
    decisions: (input.decisions || []).filter((d) => d.slice_id === slice.id),
  }))
  const sliceMean = sliceScores.length > 0
    ? sliceScores.reduce((acc, item) => acc + item.score, 0) / sliceScores.length
    : 0
  const present = new Set(documents.filter((d) => Number(d.current_version || 0) > 0).map((d) => d.type))
  const covered = deliverableTypes.filter((type) => present.has(type))
  const coverage = deliverableTypes.length > 0 ? covered.length / deliverableTypes.length : (slices.length > 0 ? 1 : 0)
  const hasSlices = slices.length > 0
  const score = hasSlices
    ? sliceMean * 0.7 + coverage * 0.3
    : coverage * 0.4
  return {
    score: clamp01(score),
    sliceMean,
    coverage,
    expected: [...deliverableTypes],
    missing: deliverableTypes.filter((type) => !present.has(type)),
    sliceCount: slices.length,
    empty: slices.length === 0 && deliverableTypes.length === 0,
  }
}

// ---------------------------------------------------------------------------
// 文件落地检查（DB 说导出过 -> 磁盘上真的在不在）
// ---------------------------------------------------------------------------

export function fileStateOf(absPath) {
  if (!absPath) return 'missing'
  try {
    return existsSync(absPath) ? 'present' : 'missing'
  } catch {
    return 'missing'
  }
}

/**
 * 统一的「这个路径在不在」判断入口。
 * 传了 injected 就用注入的实现（测试/预扫描结果），否则才碰真磁盘。
 * 所有调用点都必须走这里 —— 否则注入的假文件系统会被绕过，
 * 导致同一份快照里 slice.documents.fileState 和 tree.files.onDisk 互相矛盾。
 */
export function resolveFileState(absPath, injected) {
  if (!absPath) return 'missing'
  if (typeof injected === 'function') return injected(absPath)
  return fileStateOf(absPath)
}

// ---------------------------------------------------------------------------
// 主投影
// ---------------------------------------------------------------------------

/**
 * 把 readProjectRows 的原始行投影成面板要的树。
 * @returns {{project, template, total, stages, files, generatedAt}}
 */
export function buildTree(rows, options = {}) {
  const root = options.root || rows.project?.root || '.'
  const projectJson = options.projectJson || safeJson(rows.project?.config_json, {}) || {}
  const template = normalizeStageTemplate(options.stageTemplate || projectJson.stageTemplate)
  const exportMap = projectJson.exportMap || {}
  const docsRootAbs = resolve(root, 'docs')

  const docRows = rows.documents || []
  const taskRows = rows.tasks || []
  const decisionRows = rows.decisions || []
  const evidenceRows = rows.evidence || []
  const sessionRows = rows.sessions || []
  const existingFiles = options.existingFiles

  // 切片 -> 阶段：与插件 snapshot.js 的 sliceStageKey 同语义（最近文档 stage 优先）。
  const stageKeys = new Set(template.map((item) => item.key))
  const stageOfSlice = new Map()
  for (const slice of rows.slices || []) {
    const docs = docRows
      .filter((d) => d.slice_id === slice.id && d.stage)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    const dec = decisionRows
      .filter((d) => d.slice_id === slice.id && d.stage)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    let key = docs[0]?.stage || dec[0]?.stage || null
    if (!key || !stageKeys.has(key)) key = template[0]?.key ?? null
    stageOfSlice.set(slice.id, key)
  }

  const stages = template.map((item) => {
    const stageRow = (rows.stages || []).find((s) => s.key === item.key)
    const slices = (rows.slices || []).filter((slice) => stageOfSlice.get(slice.id) === item.key)
    const stageDocs = docRows.filter((d) => d.stage === item.key)
    const completion = stageCompletion({
      slices,
      documents: docRows,
      tasks: taskRows,
      decisions: decisionRows,
      deliverableTypes: item.deliverableTypes,
    })
    const slicedNodes = slices.map((slice) => {
      const sliceDocs = docRows.filter((d) => d.slice_id === slice.id)
      const sliceTasks = taskRows.filter((t) => t.slice_id === slice.id)
      const sliceDecisions = decisionRows.filter((d) => d.slice_id === slice.id)
      const comp = sliceCompletion({ documents: sliceDocs, tasks: sliceTasks, decisions: sliceDecisions })
      return {
        id: slice.id,
        key: slice.key,
        title: slice.title,
        status: slice.status,
        type: slice.type,
        ownerRole: slice.owner_role ?? null,
        completion: pct(comp.score),
        completionDetail: comp.parts.map((p) => ({ key: p.key, score: pct(p.score) })),
        counts: {
          tasks: sliceTasks.length,
          documents: sliceDocs.length,
          decisions: sliceDecisions.length,
          evidence: evidenceRows.filter((e) => e.slice_id === slice.id).length,
          sessions: sessionRows.filter((s) => s.slice_id === slice.id).length,
        },
        tasksDone: sliceTasks.filter((t) => t.status === 'done').length,
        tasksTotal: sliceTasks.length,
        documents: sliceDocs.map((doc) => {
          const rel = documentExportRel(doc.type, doc.logical_key, doc.id, exportMap)
          const abs = rel ? join(docsRootAbs, rel) : null
          return {
            id: doc.id,
            type: doc.type,
            title: doc.title,
            status: doc.status,
            version: Number(doc.current_version || 0),
            weight: pct(documentWeight(doc)),
            exportPath: rel ? 'docs/' + rel : null,
            fileState: resolveFileState(abs, existingFiles),
          }
        }),
        decisions: sliceDecisions.map((d) => ({
          id: d.id,
          title: d.title,
          status: d.status,
          irreversible: Number(d.irreversible || 0) === 1,
          gate: d.gate ?? null,
        })),
        excluded: SLICE_EXCLUDED_STATUS.has(slice.status),
      }
    })

    return {
      key: item.key,
      name: item.name,
      gate: item.gate,
      status: stageRow?.status || 'pending',
      position: item.position,
      completion: pct(completion.score),
      completionDetail: {
        sliceMean: pct(completion.sliceMean),
        coverage: pct(completion.coverage),
        expected: completion.expected,
        missing: completion.missing,
      },
      sliceCount: slices.length,
      documentCount: stageDocs.length,
      slices: slicedNodes,
    }
  })

  // 未挂到任何已知阶段的切片（模板被改小/切片 stage 异常）。
  const orphanSlices = (rows.slices || []).filter((slice) => !stages.some((s) => s.slices.some((x) => x.id === slice.id)))

  // 两个口径，都返回，因为它们的含义真的不同：
  //   total       = 所有模板阶段的均值 —— 「整条流水线走完多少」，空阶段也算 0（不粉饰）。
  //   activeTotal = 只算有切片的阶段的均值 —— 「已开工的部分做到哪」，
  //                 用来回答「我动手的活儿还剩多少」，不被后面没开工的阶段稀释。
  const pipelineStages = stages.filter((s) => s.completionDetail.expected.length > 0)
  const totalScore = pipelineStages.length > 0
    ? pipelineStages.reduce((acc, s) => acc + s.completion / 100, 0) / pipelineStages.length
    : 0
  const activeStages = stages.filter((s) => s.sliceCount > 0)
  const activeScore = activeStages.length > 0
    ? activeStages.reduce((acc, s) => acc + s.completion / 100, 0) / activeStages.length
    : 0
  const doneStages = stages.filter((s) => s.status === 'done').length

  const pendingDecisions = decisionRows.filter((d) => d.status === 'pending')
  const blockedSlices = (rows.slices || []).filter((s) => s.status === 'blocked')

  // -------------------------------------------------------------------------
  // 3D 视图的数据形状：主干 = 项目，分支 = 切片，叶 = 文件
  //
  // 阶段（S01..）刻意**不进** branches —— 它们只在弹窗里作为百分比出现。
  // 这样 3D 上的密度直接对应"有多少条正在干的分支、每条挂了几个文件"，
  // 而不是被七个阶段节点稀释成一条直线。
  // -------------------------------------------------------------------------
  const branches = []
  for (const stage of stages) {
    for (const slice of stage.slices) {
      const files = slice.documents.map((doc) => ({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        status: doc.status,
        version: doc.version,
        // 3D 里叶子的三种态：已落地 / 库里有但磁盘没有 / 库里没正文
        state: doc.weight === 0 ? 'empty' : doc.fileState === 'present' ? 'synced' : 'stale',
        exportPath: doc.exportPath,
        weight: doc.weight,
        stageKey: stage.key,
        stageName: stage.name,
      }))
      branches.push({
        id: slice.id,
        title: slice.title,
        key: slice.key,
        status: slice.status,
        completion: slice.completion,
        stageKey: stage.key,
        stageName: stage.name,
        ownerRole: slice.ownerRole,
        fileCount: files.length,
        files,
        tasksDone: slice.tasksDone,
        tasksTotal: slice.tasksTotal,
        decisions: slice.decisions.length,
        pendingDecisions: slice.decisions.filter((d) => d.status === 'pending').length,
      })
    }
  }
  // -------------------------------------------------------------------------
  // 磁盘上「未被库纳管」的文件也要进树，否则视图会严重失真。
  //
  // 真实项目（lumio）库里只登记了 2 个文档，docs/ 里却有 271 个 md。
  // 只画 DB 文档 = 树上只有 2 个叶子，而项目明明有 271 个文件 —— 那是在撒谎。
  // 做法：按 docs/ 顶层子目录合成"未纳管"分支，标题里写明，不冒充成工作项。
  // -------------------------------------------------------------------------
  const diskFiles = options.diskFiles instanceof Map ? options.diskFiles : null
  if (diskFiles) {
    const tracked = new Set()
    for (const branch of branches) {
      for (const file of branch.files) if (file.exportPath) tracked.add(file.exportPath)
    }
    const byDir = new Map()
    for (const [relPath, bytes] of diskFiles) {
      if (tracked.has(relPath)) continue
      const parts = relPath.split('/')
      const dir = parts.length > 2 ? parts[1] : '(根目录)'
      if (!byDir.has(dir)) byDir.set(dir, [])
      byDir.get(dir).push({ relPath, bytes })
    }
    for (const [dir, list] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
      branches.push({
        id: 'disk:' + dir,
        title: dir + ' · 未纳管 ' + list.length,
        key: 'disk/' + dir,
        status: 'untracked',       // 刻意不是 open/done 之一：它没有工作项语义
        completion: 100,           // 文件确实存在 -> 对"文件是否落地"而言它是完成的
        stageKey: null,
        stageName: null,
        ownerRole: null,
        fileCount: list.length,
        untracked: true,
        tasksDone: 0,
        tasksTotal: 0,
        decisions: 0,
        pendingDecisions: 0,
        files: list.map((item) => ({
          id: 'diskfile:' + item.relPath,
          title: item.relPath.split('/').pop(),
          type: 'disk',
          status: 'untracked',
          version: null,
          state: 'synced',         // 磁盘上真的有
          exportPath: item.relPath,
          weight: 100,
          bytes: item.bytes,
          stageKey: null,
          stageName: null,
          untracked: true,
        })),
      })
    }
  }

  // 没有任何切片时，退化成"一个空分支都没有"的树；3D 会只显示主干 + 空枝提示。
  const statusOfProject = blockedSlices.length > 0
    ? 'blocked'
    : pendingDecisions.length > 0
      ? 'attention'
      : totalScore >= 1
        ? 'done'
        : 'active'

  return {
    branches,
    trunk: {
      title: rows.project?.name || '(未命名项目)',
      // 主干状态：阻塞 > 待决策 > 完成 > 进行中
      status: statusOfProject,
      completion: pct(totalScore),
      activeCompletion: pct(activeScore),
      branchCount: branches.length,
      fileCount: branches.reduce((acc, b) => acc + b.fileCount, 0),
      missingFiles: branches.reduce((acc, b) => acc + b.files.filter((f) => f.state === 'stale').length, 0),
      pendingDecisions: pendingDecisions.length,
      blockedSlices: blockedSlices.length,
    },
    project: {
      id: rows.project?.id || null,
      name: rows.project?.name || '(未命名项目)',
      root,
      stage: stages.find((s) => s.status === 'active')?.key || null,
    },
    total: pct(totalScore),
    activeTotal: pct(activeScore),
    pipeline: {
      stages: stages.length,
      done: doneStages,
      started: activeStages.length,
    },
    stages,
    orphanSlices: orphanSlices.map((slice) => ({
      id: slice.id, key: slice.key, title: slice.title, status: slice.status,
    })),
    counts: {
      stages: stages.length,
      slices: (rows.slices || []).length,
      tasks: taskRows.length,
      tasksDone: taskRows.filter((t) => t.status === 'done').length,
      documents: docRows.length,
      decisions: decisionRows.length,
      pendingDecisions: pendingDecisions.length,
      evidence: evidenceRows.length,
      sessions: sessionRows.length,
    },
    alerts: {
      pendingDecisions: pendingDecisions.map((d) => ({ id: d.id, title: d.title, irreversible: Number(d.irreversible || 0) === 1 })),
      blockedSlices: blockedSlices.map((s) => ({ id: s.id, title: s.title })),
    },
    files: collectFiles(docRows, exportMap, docsRootAbs, options),
    generatedAt: options.generatedAt || new Date().toISOString(),
  }
}

/** 文件视图：每个文档一条，含 DB 状态与磁盘状态两列。 */
export function collectFiles(docRows, exportMap, docsRootAbs, options = {}) {
  const existing = options.existingFiles // 可注入：测试时不碰真磁盘
  return docRows.map((doc) => {
    const rel = documentExportRel(doc.type, doc.logical_key, doc.id, exportMap)
    const abs = rel ? join(docsRootAbs, rel) : null
    const onDisk = resolveFileState(abs, existing)
    return {
      id: doc.id,
      type: doc.type,
      title: doc.title,
      logicalKey: doc.logical_key,
      status: doc.status,
      version: Number(doc.current_version || 0),
      stage: doc.stage ?? null,
      sliceId: doc.slice_id ?? null,
      weight: pct(documentWeight(doc)),
      exportPath: rel ? 'docs/' + rel : null,
      onDisk,
      // 三态：synced（DB 与磁盘都齐）/ stale（磁盘没有）/ empty（DB 里没正文）
      state: Number(doc.current_version || 0) <= 0 ? 'empty' : onDisk === 'present' ? 'synced' : 'stale',
    }
  })
}

// ---------------------------------------------------------------------------
// 磁盘侧（独立于 DB 的补充信息：哪些 docs 文件是孤儿、哪些缺失）
// ---------------------------------------------------------------------------

/**
 * 对比 DB 期望与磁盘现状。
 *
 * 为什么把「磁盘上没有的」分成 untracked 而不是 orphan：
 * 真实项目（如 lumio）的 docs/ 里绝大多数 md 是**项目自己手写的文档**，
 * 不是工作台导出的。把它们叫「孤儿」等于说项目文档是垃圾，语义是错的。
 * 这里诚实地分三类：
 *   synced    DB 有、磁盘也有 —— 数据库与文件系统一致
 *   missing   DB 有、磁盘没有 —— 导出没落地（这才是真问题）
 *   untracked 磁盘有、DB 没有 —— 项目自有文档，DB 未纳管
 * 第三类的量本身就是有价值的信号：DB 对 file 的覆盖率有多低。
 *
 * @param {{files: Array}} tree buildTree 的结果
 * @param {Map<string, number>} diskFiles relPath(相对 root) -> bytes
 */
export function diffDisk(tree, diskFiles) {
  const expected = new Map()
  for (const file of tree.files || []) {
    if (file.exportPath) expected.set(file.exportPath, file)
  }
  const synced = []
  const missing = []
  for (const [relPath, file] of expected) {
    if (diskFiles.has(relPath)) synced.push({ relPath, title: file.title, bytes: diskFiles.get(relPath) })
    else missing.push({ relPath, title: file.title, status: file.status })
  }
  const untracked = []
  const byDir = new Map()
  for (const [relPath, bytes] of diskFiles) {
    if (expected.has(relPath)) continue
    untracked.push({ relPath, bytes })
    const top = relPath.split('/')[1] || '(root)'
    byDir.set(top, (byDir.get(top) || 0) + 1)
  }
  const totalFiles = diskFiles.size
  return {
    present: synced,   // 兼容旧字段名
    synced,
    missing,
    untracked,
    expected: expected.size,
    onDisk: totalFiles,
    // DB 对磁盘文件的纳管率：expected 里有几个是真的落地的 / 磁盘总数
    coverage: totalFiles > 0 ? Math.round((synced.length / totalFiles) * 100) : 0,
    byDir: [...byDir.entries()]
      .map(([dir, count]) => ({ dir, count }))
      .sort((a, b) => b.count - a.count),
  }
}

export function nowIso() {
  return new Date().toISOString()
}
