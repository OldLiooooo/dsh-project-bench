// 3d-tree/tests/scene.test.mjs
// 运行：node 3d-tree/tests/scene.test.mjs
//
// 新的 3D 布局是纯函数（computeLayout），可以先不碰 WebGL 就验证：
//   主干竖直、分支绕主干分布、叶子挂在分支上、颜色跟状态走。
// 这是「一眼看出主干/分支状态」的数学保证 —— 布局错了，视觉语义就错了。

import test from 'node:test'
import assert from 'node:assert/strict'

import { PALETTE, colorForStatus, computeLayout, leafStyle } from '../web/scene.js'

function sampleTree() {
  return {
    trunk: { title: 'P', status: 'attention', completion: 42, branchCount: 3, fileCount: 5 },
    branches: [
      {
        id: 'b1', title: '分支一', status: 'in_progress', completion: 50,
        fileCount: 2, tasksDone: 1, tasksTotal: 2, pendingDecisions: 0,
        files: [
          { id: 'f1', title: 'a.md', type: 'prd', status: 'frozen', version: 1, state: 'synced', exportPath: 'docs/product/a.md' },
          { id: 'f2', title: 'b.md', type: 'prd', status: 'draft', version: 1, state: 'stale', exportPath: 'docs/product/b.md' },
        ],
      },
      {
        id: 'b2', title: '分支二', status: 'done', completion: 100,
        fileCount: 1, tasksDone: 1, tasksTotal: 1, pendingDecisions: 0,
        files: [{ id: 'f3', title: 'c.md', type: 'spec', status: 'frozen', version: 2, state: 'synced', exportPath: 'docs/spec/c.md' }],
      },
      {
        id: 'b3', title: '空分支', status: 'open', completion: 0,
        fileCount: 0, tasksDone: 0, tasksTotal: 1, pendingDecisions: 0,
        files: [],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// 布局语义
// ---------------------------------------------------------------------------

test('主干是竖直的一列，X/Z 恒为 0', () => {
  const { nodes } = computeLayout(sampleTree())
  const trunk = nodes.filter((n) => n.kind === 'trunk')
  assert.ok(trunk.length > 5, '主干应由多段组成')
  for (const n of trunk) {
    assert.equal(n.position[0], 0)
    assert.equal(n.position[2], 0)
  }
  // 高度必须单调下降（从顶到底）
  for (let i = 1; i < trunk.length; i += 1) {
    assert.ok(trunk[i].position[1] < trunk[i - 1].position[1], '主干应自上而下排列')
  }
})

test('每条分支都离主干有距离（不会被主干盖住）', () => {
  const { nodes } = computeLayout(sampleTree())
  for (const b of nodes.filter((n) => n.kind === 'branch')) {
    const r = Math.hypot(b.position[0], b.position[2])
    assert.ok(r > 1.5, '分支半径应明显大于 0，实际 ' + r.toFixed(2))
  }
})

test('分支绕主干分布，角度互不重合', () => {
  const { nodes } = computeLayout(sampleTree())
  const branches = nodes.filter((n) => n.kind === 'branch')
  const angles = branches.map((b) => Math.atan2(b.position[2], b.position[0]))
  for (let i = 0; i < angles.length; i += 1) {
    for (let j = i + 1; j < angles.length; j += 1) {
      const diff = Math.abs(angles[i] - angles[j])
      const norm = Math.min(diff, Math.PI * 2 - diff)
      assert.ok(norm > 0.3, '两条分支角度太近会重叠：' + norm.toFixed(2))
    }
  }
})

test('叶子是文件，且每个文件一个叶节点', () => {
  const tree = sampleTree()
  const { nodes } = computeLayout(tree)
  const leaves = nodes.filter((n) => n.kind === 'file')
  const expected = tree.branches.reduce((acc, b) => acc + b.files.length, 0)
  assert.equal(leaves.length, expected)
  // 叶节点必须带文件名
  for (const leaf of leaves) {
    assert.ok(leaf.label && leaf.label.length > 0, '叶节点要有文件名')
    assert.ok(leaf.file, '叶节点要带原始 file 数据')
  }
})

test('叶子挂在它所属分支附近，不飞到别处', () => {
  const { nodes } = computeLayout(sampleTree())
  const branches = nodes.filter((n) => n.kind === 'branch')
  for (const leaf of nodes.filter((n) => n.kind === 'file')) {
    const parent = branches.find((b) => b.branchId === leaf.branchId)
    assert.ok(parent, '叶子必须有父分支')
    const d = Math.hypot(
      leaf.position[0] - parent.position[0],
      leaf.position[1] - parent.position[1],
      leaf.position[2] - parent.position[2],
    )
    assert.ok(d < 3.2, '叶子离父分支太远：' + d.toFixed(2))
  }
})

test('没有文件的分支会得到一个「空」标记节点', () => {
  const { nodes } = computeLayout(sampleTree())
  const empties = nodes.filter((n) => n.kind === 'empty')
  assert.equal(empties.length, 1, '只有 b3 没文件')
  assert.equal(empties[0].branchId, 'b3')
})

test('连线覆盖主干链、分支、叶', () => {
  const { nodes, links } = computeLayout(sampleTree())
  const kinds = new Set(links.map((l) => l.kind))
  assert.ok(kinds.has('trunk'), '应有主干连线')
  assert.ok(kinds.has('branch'), '应有分支连线')
  assert.ok(kinds.has('leaf'), '应有叶子连线')
  // 每条 link 的端点必须在 nodes 里（或 root）
  const ids = new Set(nodes.map((n) => n.id))
  for (const l of links) {
    assert.ok(ids.has(l.from) || l.from === 'root', 'link.from 悬空: ' + l.from)
    assert.ok(ids.has(l.to) || l.to === 'root', 'link.to 悬空: ' + l.to)
  }
})

test('节点 id 唯一（拾取与高亮依赖它）', () => {
  const { nodes } = computeLayout(sampleTree())
  const ids = nodes.map((n) => n.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('空项目只出主干，不抛异常', () => {
  const { nodes, links } = computeLayout({ trunk: { status: 'active' }, branches: [] })
  assert.ok(nodes.filter((n) => n.kind === 'trunk').length > 5)
  assert.equal(nodes.filter((n) => n.kind === 'branch').length, 0)
  assert.equal(links.filter((l) => l.kind === 'branch').length, 0)
})

test('branches 缺失也不炸', () => {
  const { nodes } = computeLayout({ trunk: {} })
  assert.ok(nodes.length > 0)
})

test('同一条分支的文件高度错开（不叠成一点）', () => {
  const tree = {
    trunk: { status: 'active' },
    branches: [{
      id: 'bx', title: 'x', status: 'open', completion: 0, fileCount: 3,
      files: [
        { id: 'x1', title: '1.md', state: 'synced', type: 'prd', exportPath: 'docs/a/1.md' },
        { id: 'x2', title: '2.md', state: 'synced', type: 'prd', exportPath: 'docs/a/2.md' },
        { id: 'x3', title: '3.md', state: 'synced', type: 'prd', exportPath: 'docs/a/3.md' },
      ],
    }],
  }
  const { nodes } = computeLayout(tree)
  const leaves = nodes.filter((n) => n.kind === 'file')
  const ys = leaves.map((l) => l.position[1].toFixed(3))
  assert.equal(new Set(ys).size > 1, true, '文件的 Y 不该完全相同')
})

// ---------------------------------------------------------------------------
// 颜色语义
// ---------------------------------------------------------------------------

test('分支颜色按状态区分：完成绿 / 进行中蓝 / 阻塞红', () => {
  assert.equal(colorForStatus('branch', 'done'), PALETTE.branchDone)
  assert.equal(colorForStatus('branch', 'in_progress'), PALETTE.branchActive)
  assert.equal(colorForStatus('branch', 'blocked'), PALETTE.branchBlocked)
  assert.equal(colorForStatus('branch', 'review'), PALETTE.branchActive)
})

test('主干颜色按项目状态：阻塞红 / 待决策黄 / 完成绿', () => {
  assert.equal(colorForStatus('trunk', 'blocked'), PALETTE.trunkBad)
  assert.equal(colorForStatus('trunk', 'attention'), PALETTE.trunkWarn)
  assert.equal(colorForStatus('trunk', 'done'), PALETTE.trunkHealthy)
})

test('未知状态给兜底色而不是 undefined', () => {
  const c = colorForStatus('branch', 'weird-status')
  assert.equal(typeof c, 'number')
  assert.ok(Number.isFinite(c))
})

test('文件三态各有颜色与大小：已落地 > 未导出 > 无正文', () => {
  const synced = leafStyle({ state: 'synced' })
  const stale = leafStyle({ state: 'stale' })
  const empty = leafStyle({ state: 'empty' })
  assert.equal(synced.color, PALETTE.leafPresent)
  assert.equal(stale.color, PALETTE.leafMissing)
  assert.ok(synced.scale > stale.scale, '已落地的点应更大')
  assert.ok(stale.scale > empty.scale, '未导出的应大于无正文的')
  assert.ok(synced.glow > empty.glow)
})
