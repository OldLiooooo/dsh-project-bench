// 3d-tree/tests/model.test.mjs
// 运行：node --test 3d-tree/tests/
//
// 只测纯函数，不碰网络、不碰真项目库 —— 完成度算法是这套视图唯一的"判断"，
// 它错了后面所有颜色和百分比都是错的，所以边界要钉死。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildTree,
  collectFiles,
  diffDisk,
  documentExportRel,
  documentWeight,
  normalizeStageTemplate,
  pct,
  safeJson,
  sliceCompletion,
  stageCompletion,
  taskWeight,
} from '../model.mjs'
import { DEFAULT_STAGE_TEMPLATE, MIRROR_SOURCE } from '../defaults.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKBENCH_ROOT = resolve(HERE, '..', '..')

// ---------------------------------------------------------------------------
// 默认模板镜像一致性：3d-tree 复制了一份 STAGE_TEMPLATE，必须和插件源一致
// ---------------------------------------------------------------------------

test('阶段模板镜像与插件源逐字一致', () => {
  const source = join(WORKBENCH_ROOT, MIRROR_SOURCE)
  if (!existsSync(source)) {
    // 插件目录被移走时跳过，避免把这个独立工具绑死在工作区布局上。
    return
  }
  const text = readFileSync(source, 'utf8')
  for (const item of DEFAULT_STAGE_TEMPLATE) {
    assert.ok(text.includes("'" + item.key + "'"), '缺少阶段 ' + item.key)
    assert.ok(text.includes("'" + item.name + "'"), '缺少阶段名 ' + item.name)
    for (const type of item.deliverableTypes) {
      assert.ok(text.includes("'" + type + "'"), '缺少交付物类型 ' + type)
    }
  }
})

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

test('pct 四舍五入并夹在 0..100', () => {
  assert.equal(pct(0), 0)
  assert.equal(pct(1), 100)
  assert.equal(pct(0.004), 0)
  assert.equal(pct(0.996), 100)
  assert.equal(pct(0.5), 50)
  assert.equal(pct(-1), 0)
  assert.equal(pct(7), 100)
  assert.equal(pct(NaN), 0)
})

test('safeJson 对坏数据不抛异常', () => {
  assert.deepEqual(safeJson('{"a":1}', {}), { a: 1 })
  assert.deepEqual(safeJson('not json', { fallback: true }), { fallback: true })
  assert.deepEqual(safeJson(null, []), [])
  assert.deepEqual(safeJson('', { x: 1 }), { x: 1 })
})

test('normalizeStageTemplate 容错：空/非法回退默认，重复 key 去重', () => {
  assert.equal(normalizeStageTemplate(null).length, DEFAULT_STAGE_TEMPLATE.length)
  assert.equal(normalizeStageTemplate([]).length, DEFAULT_STAGE_TEMPLATE.length)
  assert.equal(normalizeStageTemplate('nope').length, DEFAULT_STAGE_TEMPLATE.length)

  const custom = normalizeStageTemplate([
    { key: 'A', name: '甲', deliverableTypes: ['prd'] },
    { key: 'A', name: '重复', deliverableTypes: [] },
    { key: 'B', name: '乙' },
  ])
  assert.equal(custom.length, 2)
  assert.equal(custom[0].key, 'A')
  assert.equal(custom[1].key, 'B')
  assert.deepEqual(custom[1].deliverableTypes, [])
})

// ---------------------------------------------------------------------------
// 文档权重：0 版本不能被算成完成
// ---------------------------------------------------------------------------

test('文档权重按状态分级，0 版本一律 0', () => {
  assert.equal(documentWeight({ status: 'frozen', current_version: 3 }), 1)
  assert.equal(documentWeight({ status: 'approved', current_version: 1 }), 1)
  assert.equal(documentWeight({ status: 'review', current_version: 1 }), 0.6)
  assert.equal(documentWeight({ status: 'draft', current_version: 1 }), 0.3)
  // 关键边界：状态写着 frozen 但没写过正文，是数据异常，不能算完成
  assert.equal(documentWeight({ status: 'frozen', current_version: 0 }), 0)
  assert.equal(documentWeight({ status: 'frozen' }), 0)
  assert.equal(documentWeight(null), 0)
})

test('任务权重', () => {
  assert.equal(taskWeight({ status: 'done' }), 1)
  assert.equal(taskWeight({ status: 'review' }), 0.7)
  assert.equal(taskWeight({ status: 'in_progress' }), 0.4)
  assert.equal(taskWeight({ status: 'pending' }), 0)
  assert.equal(taskWeight({ status: 'blocked' }), 0)
  assert.equal(taskWeight({}), 0)
})

// ---------------------------------------------------------------------------
// 切片完成度
// ---------------------------------------------------------------------------

test('切片完成度：空切片是 0 且标记 empty', () => {
  const result = sliceCompletion({ documents: [], tasks: [], decisions: [] })
  assert.equal(result.score, 0)
  assert.equal(result.empty, true)
})

test('切片完成度：只有文档时不被"没有任务"拖累', () => {
  const result = sliceCompletion({
    documents: [{ status: 'frozen', current_version: 2 }],
    tasks: [],
    decisions: [],
  })
  assert.equal(result.score, 1)
  assert.equal(result.parts.length, 1)
  assert.equal(result.parts[0].key, 'documents')
})

test('切片完成度：文档和任务各 100% 时总分 100', () => {
  const result = sliceCompletion({
    documents: [{ status: 'frozen', current_version: 1 }],
    tasks: [{ status: 'done' }],
    decisions: [],
  })
  assert.equal(pct(result.score), 100)
})

test('切片完成度：文档权重高于任务', () => {
  // 文档全完成、任务全没做 -> 5/(5+4) = 0.5556
  const result = sliceCompletion({
    documents: [{ status: 'frozen', current_version: 1 }],
    tasks: [{ status: 'pending' }],
    decisions: [],
  })
  assert.equal(pct(result.score), 56)
})

test('切片完成度：决策未决会拉低分数', () => {
  const withPending = sliceCompletion({
    documents: [{ status: 'frozen', current_version: 1 }],
    tasks: [],
    decisions: [{ status: 'pending' }],
  })
  const withResolved = sliceCompletion({
    documents: [{ status: 'frozen', current_version: 1 }],
    tasks: [],
    decisions: [{ status: 'approved' }],
  })
  assert.ok(withPending.score < withResolved.score)
  assert.equal(withResolved.score, 1)
})

test('切片完成度：多个文档取平均', () => {
  const result = sliceCompletion({
    documents: [
      { status: 'frozen', current_version: 1 },   // 1
      { status: 'draft', current_version: 1 },    // 0.3
    ],
    tasks: [],
    decisions: [],
  })
  assert.equal(pct(result.score), 65)
})

// ---------------------------------------------------------------------------
// 阶段完成度
// ---------------------------------------------------------------------------

test('阶段完成度：交付物缺口体现在 coverage 上', () => {
  const result = stageCompletion({
    slices: [{ id: 's1' }],
    documents: [{ slice_id: 's1', type: 'adr', status: 'frozen', current_version: 1, stage: 'S3' }],
    tasks: [],
    decisions: [],
    deliverableTypes: ['adr', 'design', 'spec'],
  })
  assert.equal(result.expected.length, 3)
  assert.deepEqual(result.missing.sort(), ['design', 'spec'])
  assert.equal(pct(result.coverage), 33)
})

test('阶段完成度：0 版本文档不算覆盖', () => {
  const result = stageCompletion({
    slices: [],
    documents: [{ type: 'prd', status: 'frozen', current_version: 0 }],
    tasks: [],
    decisions: [],
    deliverableTypes: ['prd'],
  })
  assert.deepEqual(result.missing, ['prd'])
  assert.equal(result.coverage, 0)
})

test('阶段完成度：没切片的空阶段是 0，不是 100', () => {
  const result = stageCompletion({
    slices: [], documents: [], tasks: [], decisions: [],
    deliverableTypes: ['prd'],
  })
  assert.equal(pct(result.score), 0)
  assert.equal(result.sliceCount, 0)
})

// ---------------------------------------------------------------------------
// 导出路径推导（必须与插件 export.js 同规则）
// ---------------------------------------------------------------------------

test('导出路径按 exportMap 推导，斜杠换成短横线', () => {
  assert.equal(
    documentExportRel('handoff', 'handoff/refund', 'doc-1', { handoff: 'docs/handoffs' }),
    'handoffs/handoff-refund.md',
  )
  assert.equal(
    documentExportRel('prd', 'prd/refund', 'doc-2', { prd: 'docs/product' }),
    'product/prd-refund.md',
  )
})

test('导出路径缺 exportMap 时退回 type 子目录', () => {
  assert.equal(documentExportRel('retro', 'retro/x', 'doc-3', {}), 'retro/retro-x.md')
})

test('导出路径拒绝穿越', () => {
  // 恶意 exportMap 不能逃出 docs/
  const rel = documentExportRel('prd', 'x', 'doc-4', { prd: '../../etc' })
  assert.equal(rel, null)
})

// ---------------------------------------------------------------------------
// diffDisk：三类语义不能混
// ---------------------------------------------------------------------------

test('diffDisk 区分 synced / missing / untracked', () => {
  const tree = {
    files: [
      { title: 'A', status: 'frozen', exportPath: 'docs/product/a.md' },
      { title: 'B', status: 'draft', exportPath: 'docs/product/b.md' },
    ],
  }
  const disk = new Map([
    ['docs/product/a.md', 100],
    ['docs/notes/hand-written.md', 200],
    ['docs/product/another.md', 300],
  ])
  const result = diffDisk(tree, disk)
  assert.equal(result.synced.length, 1)
  assert.equal(result.synced[0].relPath, 'docs/product/a.md')
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0].relPath, 'docs/product/b.md')
  assert.equal(result.untracked.length, 2)
  assert.equal(result.expected, 2)
  assert.equal(result.onDisk, 3)
  // 1 个同步 / 3 个磁盘文件
  assert.equal(result.coverage, 33)
})

test('diffDisk 统计未纳管文件按目录分组', () => {
  const result = diffDisk({ files: [] }, new Map([
    ['docs/product/a.md', 1],
    ['docs/product/b.md', 1],
    ['docs/specs/c.md', 1],
  ]))
  assert.equal(result.byDir[0].dir, 'product')
  assert.equal(result.byDir[0].count, 2)
})

test('diffDisk 全空不炸', () => {
  const result = diffDisk({ files: [] }, new Map())
  assert.equal(result.coverage, 0)
  assert.equal(result.expected, 0)
})

// ---------------------------------------------------------------------------
// buildTree 端到端（喂假行，不碰真库）
// ---------------------------------------------------------------------------

function makeRows(overrides = {}) {
  return {
    project: { id: 'p1', name: '测试项目', root: '/fake', created_at: '2026-01-01T00:00:00Z' },
    stages: [
      { key: 'S1', name: '产品', status: 'active', gate: 'G1', position: 0 },
      { key: 'S2', name: 'UX', status: 'pending', gate: 'G2', position: 1 },
    ],
    slices: [
      { id: 'slice-1', key: 'k1', title: '切片一', status: 'in_progress', type: 'workitem', created_at: '2026-01-01', updated_at: '2026-01-02' },
    ],
    tasks: [{ id: 't1', slice_id: 'slice-1', title: '任务一', status: 'done' }],
    sessions: [],
    documents: [{
      id: 'd1', slice_id: 'slice-1', type: 'prd', logical_key: 'prd/a',
      title: 'PRD', status: 'frozen', current_version: 1, stage: 'S1',
      created_at: '2026-01-01', updated_at: '2026-01-02',
    }],
    decisions: [],
    evidence: [],
    approvals: [],
    exports: [],
    events: [],
    ...overrides,
  }
}

const templateOverride = [
  { key: 'S1', name: '产品', gate: 'G1', deliverableTypes: ['prd'] },
  { key: 'S2', name: 'UX', gate: 'G2', deliverableTypes: ['ux'] },
]

test('buildTree 把切片归到文档的 stage 下', () => {
  const tree = buildTree(makeRows(), { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  const s1 = tree.stages.find((s) => s.key === 'S1')
  const s2 = tree.stages.find((s) => s.key === 'S2')
  assert.equal(s1.slices.length, 1)
  assert.equal(s1.slices[0].title, '切片一')
  assert.equal(s2.slices.length, 0)
})

test('buildTree 切片完成度 = 文档与任务的加权', () => {
  const tree = buildTree(makeRows(), { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  const slice = tree.stages[0].slices[0]
  // 文档 1.0（权重5）+ 任务 1.0（权重4）-> 100
  assert.equal(slice.completion, 100)
  assert.equal(slice.tasksDone, 1)
  assert.equal(slice.tasksTotal, 1)
})

test('buildTree 记录文档在磁盘上的状态', () => {
  const present = buildTree(makeRows(), { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  assert.equal(present.stages[0].slices[0].documents[0].fileState, 'present')

  const missing = buildTree(makeRows(), { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'missing' })
  assert.equal(missing.stages[0].slices[0].documents[0].fileState, 'missing')
})

test('buildTree 阶段缺失交付物写进 completionDetail.missing', () => {
  const tree = buildTree(makeRows(), { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  const s2 = tree.stages.find((s) => s.key === 'S2')
  assert.deepEqual(s2.completionDetail.missing, ['ux'])
})

test('buildTree 同时给出流水线与已开工两个口径', () => {
  const tree = buildTree(makeRows(), { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  // S1 有切片有产物；S2 空 -> 流水线被 S2 拉低，已开工只看 S1
  assert.ok(tree.total < tree.activeTotal, '空阶段应拉低流水线口径')
  assert.equal(tree.pipeline.stages, 2)
  assert.equal(tree.pipeline.started, 1)
})

test('buildTree 归档切片被标记 excluded 但仍可见', () => {
  const rows = makeRows()
  rows.slices[0].status = 'archived'
  const tree = buildTree(rows, { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  assert.equal(tree.stages[0].slices[0].excluded, true)
  assert.equal(tree.counts.slices, 1)
})

test('buildTree 待决策与阻塞进 alerts', () => {
  const rows = makeRows()
  rows.decisions = [
    { id: 'dec1', slice_id: 'slice-1', title: '要不要做', status: 'pending', irreversible: 1 },
    { id: 'dec2', slice_id: 'slice-1', title: '已定', status: 'approved', irreversible: 0 },
  ]
  rows.slices[0].status = 'blocked'
  const tree = buildTree(rows, { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  assert.equal(tree.counts.pendingDecisions, 1)
  assert.equal(tree.alerts.pendingDecisions[0].irreversible, true)
  assert.equal(tree.alerts.blockedSlices.length, 1)
})

test('buildTree 对未知阶段的切片给出 orphan 而不是静默丢弃', () => {
  const rows = makeRows()
  rows.slices.push({
    id: 'slice-2', key: 'k2', title: '野切片', status: 'open', type: 'workitem',
    created_at: '2026-01-01', updated_at: '2026-01-01',
  })
  rows.documents.push({
    id: 'd2', slice_id: 'slice-2', type: 'prd', logical_key: 'prd/b',
    title: 'PRD2', status: 'draft', current_version: 1, stage: 'S9',
    created_at: '2026-01-01', updated_at: '2026-01-01',
  })
  const tree = buildTree(rows, { root: '/fake', stageTemplate: templateOverride, existingFiles: () => 'present' })
  // 切片会被兜底归到第一个阶段，不会丢
  const allSliceIds = tree.stages.flatMap((s) => s.slices.map((x) => x.id))
  assert.ok(allSliceIds.includes('slice-2'), '切片不能凭空消失')
})

test('buildTree 空项目不抛异常', () => {
  const tree = buildTree({
    project: {}, stages: [], slices: [], tasks: [], sessions: [],
    documents: [], decisions: [], evidence: [], approvals: [], exports: [], events: [],
  }, { root: '/fake', existingFiles: () => 'missing' })
  assert.equal(tree.total, 0)
  // 空库仍应铺出模板阶段（默认模板）
  assert.ok(tree.stages.length > 0)
})

test('collectFiles 三态：empty / stale / synced', () => {
  const docs = [
    { id: 'a', type: 'prd', logical_key: 'x', title: 'A', status: 'draft', current_version: 0 },
    { id: 'b', type: 'prd', logical_key: 'y', title: 'B', status: 'draft', current_version: 1 },
    { id: 'c', type: 'prd', logical_key: 'z', title: 'C', status: 'frozen', current_version: 1 },
  ]
  const files = collectFiles(docs, {}, '/fake/docs', {
    existingFiles: (abs) => (abs && abs.endsWith('z.md') ? 'present' : 'missing'),
  })
  assert.equal(files[0].state, 'empty')
  assert.equal(files[1].state, 'stale')
  assert.equal(files[2].state, 'synced')
})
