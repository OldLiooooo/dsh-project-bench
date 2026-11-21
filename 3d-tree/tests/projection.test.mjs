// 3d-tree/tests/projection.test.mjs
// 运行：node 3d-tree/tests/projection.test.mjs
//
// 3D 数学错了页面会「看起来怪但还能动」，比直接报错更难发现，
// 所以透视/排序/命中/布局这几件事全部单测钉住。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cameraBasis,
  clampCamera,
  completionColor,
  createCamera,
  depthSort,
  layoutTree,
  pick,
  project,
  v3,
} from '../web/projection.js'

const VIEWPORT = { width: 800, height: 600 }

// ---------------------------------------------------------------------------
// 向量
// ---------------------------------------------------------------------------

test('v3 基本运算', () => {
  assert.deepEqual(v3.add([1, 2, 3], [4, 5, 6]), [5, 7, 9])
  assert.deepEqual(v3.sub([4, 5, 6], [1, 2, 3]), [3, 3, 3])
  assert.deepEqual(v3.scale([1, 2, 3], 2), [2, 4, 6])
  assert.equal(v3.dot([1, 0, 0], [0, 1, 0]), 0)
  assert.deepEqual(v3.cross([1, 0, 0], [0, 1, 0]), [0, 0, 1])
  assert.equal(v3.len([3, 4, 0]), 5)
  const n = v3.norm([3, 4, 0])
  assert.ok(Math.abs(v3.len(n) - 1) < 1e-9)
})

test('v3.norm 对零向量不产生 NaN', () => {
  const n = v3.norm([0, 0, 0])
  assert.ok(Number.isFinite(n[0]) && Number.isFinite(n[1]) && Number.isFinite(n[2]))
})

// ---------------------------------------------------------------------------
// 相机
// ---------------------------------------------------------------------------

test('clampCamera 限制俯仰与距离，防止翻面和穿模', () => {
  const c = clampCamera({ yaw: 0, pitch: 99, distance: 1000, fov: 55, target: [0, 0, 0] })
  assert.ok(c.pitch <= 1.45)
  assert.ok(c.distance <= 90)

  const d = clampCamera({ yaw: 0, pitch: -99, distance: 0, fov: 55, target: [0, 0, 0] })
  assert.ok(d.pitch >= -1.45)
  assert.ok(d.distance >= 4)
})

test('cameraBasis 返回正交归一基', () => {
  const cam = createCamera({ yaw: 0.7, pitch: 0.3, distance: 12 })
  const { forward, right, up } = cameraBasis(cam)
  assert.ok(Math.abs(v3.len(forward) - 1) < 1e-9)
  assert.ok(Math.abs(v3.len(right) - 1) < 1e-9)
  assert.ok(Math.abs(v3.len(up) - 1) < 1e-9)
  assert.ok(Math.abs(v3.dot(forward, right)) < 1e-9, 'forward ⊥ right')
  assert.ok(Math.abs(v3.dot(forward, up)) < 1e-9, 'forward ⊥ up')
  assert.ok(Math.abs(v3.dot(right, up)) < 1e-9, 'right ⊥ up')
})

test('相机在正上方时 basis 不退化', () => {
  // pitch 接近 ±90° 时 forward 与 worldUp 平行，right 会退化
  const cam = clampCamera({ yaw: 0, pitch: 1.5707, distance: 10, fov: 55, target: [0, 0, 0] })
  const { right } = cameraBasis(cam)
  assert.ok(Number.isFinite(right[0]) && Number.isFinite(right[1]) && Number.isFinite(right[2]))
  assert.ok(Math.abs(v3.len(right) - 1) < 1e-6)
})

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

test('原点附近的点投影到屏幕中心', () => {
  const cam = createCamera({ yaw: 0, pitch: 0, distance: 10 })
  const p = project([0, 0, 0], cam, VIEWPORT)
  assert.ok(p.visible)
  assert.ok(Math.abs(p.x - VIEWPORT.width / 2) < 1)
  assert.ok(Math.abs(p.y - VIEWPORT.height / 2) < 1)
})

test('相机背后的点标记为不可见', () => {
  const cam = createCamera({ yaw: 0, pitch: 0, distance: 10 })
  // 相机在 +Z 方向 10 处看向原点，所以 z=+20 的点在相机背后
  const p = project([0, 0, 20], cam, VIEWPORT)
  assert.equal(p.visible, false)
})

test('越近的物体投影越大（透视正确）', () => {
  const cam = createCamera({ yaw: 0, pitch: 0, distance: 10 })
  const near = project([1, 0, 0], cam, VIEWPORT)
  const far = project([1, 0, -5], cam, VIEWPORT)
  assert.ok(near.depth < far.depth)
  assert.ok(near.scale > far.scale)
})

test('X 轴上的点按预期落在中心右侧/左侧', () => {
  const cam = createCamera({ yaw: 0, pitch: 0, distance: 10 })
  const rightPoint = project([2, 0, 0], cam, VIEWPORT)
  const leftPoint = project([-2, 0, 0], cam, VIEWPORT)
  assert.ok(rightPoint.visible && leftPoint.visible)
  assert.ok(rightPoint.x > VIEWPORT.width / 2)
  assert.ok(leftPoint.x < VIEWPORT.width / 2)
})

test('Y 轴向上：世界 +Y 在屏幕上更靠上（y 更小）', () => {
  const cam = createCamera({ yaw: 0, pitch: 0, distance: 10 })
  const up = project([0, 2, 0], cam, VIEWPORT)
  const down = project([0, -2, 0], cam, VIEWPORT)
  assert.ok(up.y < down.y, 'screen y 向下增长，所以更高的点 y 更小')
})

// ---------------------------------------------------------------------------
// 深度排序
// ---------------------------------------------------------------------------

test('depthSort 远的排在前面（画家算法）', () => {
  const cam = createCamera({ yaw: 0, pitch: 0, distance: 10 })
  const nodes = [
    { id: 'near', position: [0, 0, 5] },
    { id: 'far', position: [0, 0, -5] },
    { id: 'mid', position: [0, 0, 0] },
  ]
  const sorted = depthSort(nodes, cam)
  assert.deepEqual(sorted.map((n) => n.id), ['far', 'mid', 'near'])
})

test('depthSort 不修改入参', () => {
  const cam = createCamera({})
  const nodes = [{ id: 'a', position: [0, 0, 0] }, { id: 'b', position: [0, 0, -3] }]
  const copy = nodes.slice()
  depthSort(nodes, cam)
  assert.deepEqual(nodes, copy)
})

// ---------------------------------------------------------------------------
// 命中测试
// ---------------------------------------------------------------------------

test('pick 命中最近的可见点', () => {
  const points = [
    { node: 'a', visible: true, screen: { x: 100, y: 100 }, radius: 10 },
    { node: 'b', visible: true, screen: { x: 104, y: 100 }, radius: 10 },
    { node: 'c', visible: false, screen: { x: 100, y: 100 }, radius: 10 },
  ]
  const hit = pick(points, 103, 100, 12)
  assert.equal(hit, 'b', '应命中距离更近的 b')
})

test('pick 在空白处返回 null', () => {
  const points = [{ node: 'a', visible: true, screen: { x: 100, y: 100 }, radius: 5 }]
  assert.equal(pick(points, 400, 400, 10), null)
})

test('pick 不会命中不可见节点', () => {
  const points = [{ node: 'a', visible: false, screen: { x: 100, y: 100 }, radius: 20 }]
  assert.equal(pick(points, 100, 100, 30), null)
})

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

function sampleTree() {
  return {
    project: { name: 'P' },
    total: 40,
    stages: [
      { key: 'S1', name: '产品', status: 'done', completion: 100, slices: [] },
      {
        key: 'S2', name: 'UX', status: 'active', completion: 50,
        slices: [{
          id: 'slice-a', title: 'A', status: 'review', completion: 30,
          documents: [
            { id: 'doc-1', title: 'D1', status: 'frozen', weight: 100, fileState: 'present' },
            { id: 'doc-2', title: 'D2', status: 'draft', weight: 30, fileState: 'missing' },
          ],
        }],
      },
    ],
  }
}

test('layoutTree 产出 root + 每阶段 + 每切片 + 每文档', () => {
  const { nodes, edges } = layoutTree(sampleTree())
  const kinds = nodes.reduce((acc, n) => { acc[n.kind] = (acc[n.kind] || 0) + 1; return acc }, {})
  assert.equal(kinds.root, 1)
  assert.equal(kinds.stage, 2)
  assert.equal(kinds.slice, 1)
  assert.equal(kinds.document, 2)
  assert.ok(edges.length >= 4, '每个非根节点都应有一条边')
})

test('layoutTree 节点 id 唯一（选中/重绑依赖它）', () => {
  const { nodes } = layoutTree(sampleTree())
  const ids = nodes.map((n) => n.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('layoutTree 阶段沿 Y 轴分层，互不重叠', () => {
  const { nodes } = layoutTree(sampleTree())
  const stages = nodes.filter((n) => n.kind === 'stage')
  assert.notEqual(stages[0].position[1], stages[1].position[1])
})

test('layoutTree 切片挂在对应阶段的楼层上', () => {
  const { nodes } = layoutTree(sampleTree())
  const s2 = nodes.find((n) => n.id === 'stage:S2')
  const slice = nodes.find((n) => n.kind === 'slice')
  // 允许 ±0.3 的抖动，但不该跑到别的楼层
  assert.ok(Math.abs(slice.position[1] - s2.position[1]) < 1)
})

test('layoutTree 空树不抛异常', () => {
  const { nodes, edges } = layoutTree({ project: { name: '空' }, total: 0, stages: [] })
  assert.equal(nodes.length, 1)
  assert.equal(edges.length, 0)
})

test('layoutTree 处理 undefined stages', () => {
  const { nodes } = layoutTree({ project: { name: 'x' }, total: 0 })
  assert.equal(nodes.length, 1)
})

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

test('completionColor 0% 偏红、100% 偏绿', () => {
  const red = completionColor(0)
  const green = completionColor(100)
  const hueOf = (hsl) => Number(hsl.match(/hsl\((\d+)/)[1])
  assert.ok(hueOf(red) < 30, '0% 应是红色系')
  assert.ok(hueOf(green) > 110, '100% 应是绿色系')
})

test('completionColor 对越界值不产生 NaN', () => {
  for (const v of [-50, 0, 50, 100, 500, NaN]) {
    assert.ok(!completionColor(v).includes('NaN'), 'value=' + v)
  }
})
