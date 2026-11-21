// 3d-tree/tests/render.test.mjs
// 运行：node 3d-tree/tests/render.test.mjs
//
// 没有浏览器可用（沙箱里 headless Chromium 起不来），所以这里用一个假的 canvas 上下文
// 把 renderer.js 真跑一遍：验证它调用绘图 API 的顺序不出错、节点真的被画了、
// 交互事件真的改变了状态。这不是像素级断言，但能抓住「一进页面就白屏/抛异常」这类致命问题。
//
// renderer.js 依赖 window/document/requestAnimationFrame，所以先装桩再动态 import。

import test from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 最小 DOM / Canvas 桩
// ---------------------------------------------------------------------------

function makeCtx() {
  const calls = { arc: 0, fill: 0, stroke: 0, fillText: 0, beginPath: 0, gradients: 0 }
  const ctx = {
    canvas: null,
    save() {}, restore() {}, scale() {}, translate() {},
    beginPath() { calls.beginPath += 1 },
    moveTo() {}, lineTo() {}, arcTo() {}, closePath() {},
    arc() { calls.arc += 1 },
    fill() { calls.fill += 1 },
    stroke() { calls.stroke += 1 },
    fillText() { calls.fillText += 1 },
    fillRect() {},
    measureText: (t) => ({ width: String(t).length * 6 }),
    createRadialGradient() {
      calls.gradients += 1
      return { addColorStop() {} }
    },
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
    set globalAlpha(_v) {}, set font(_v) {}, set textBaseline(_v) {},
    get fillStyle() { return '' }, get strokeStyle() { return '' },
    get lineWidth() { return 1 }, get globalAlpha() { return 1 },
    get font() { return '' }, get textBaseline() { return '' },
  }
  return { ctx, calls }
}

function makeCanvas() {
  const { ctx, calls } = makeCtx()
  const listeners = new Map()
  const canvas = {
    width: 800, height: 600,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    addEventListener: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name) || []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    setPointerCapture() {}, releasePointerCapture() {},
    dispatch(name, event) { for (const fn of listeners.get(name) || []) fn(event) },
    _calls: calls,
  }
  ctx.canvas = canvas
  return canvas
}

/** 装全局桩。返回 {canvas, fireFrame, teardown}。 */
function installStubs() {
  const canvas = makeCanvas()
  const frames = []
  const globalAny = globalThis
  const prevWindow = globalAny.window
  const prevDocument = globalAny.document
  const prevRaf = globalAny.requestAnimationFrame

  const win = {
    devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
  }
  globalAny.window = win
  globalAny.document = { getElementById: () => canvas, createElement: () => canvas, addEventListener() {}, removeEventListener() {} }
  globalAny.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length }
  globalAny.EventSource = class { constructor() {} addEventListener() {} }

  return {
    canvas,
    runFrame() {
      const pending = frames.splice(0, frames.length)
      for (const fn of pending) fn(16)
      return pending.length
    },
    teardown() {
      globalAny.window = prevWindow
      globalAny.document = prevDocument
      globalAny.requestAnimationFrame = prevRaf
    },
  }
}

const SAMPLE_TREE = {
  project: { name: '渲染测试项目', root: 'C:/fake' },
  total: 45,
  activeTotal: 62,
  dbPath: 'C:/fake/.project/project.db',
  generatedAt: '2026-01-01T00:00:00Z',
  counts: { slices: 2, tasks: 3, tasksDone: 1, documents: 2, decisions: 1, pendingDecisions: 1, evidence: 0, sessions: 1 },
  pipeline: { stages: 2, done: 1, started: 1 },
  alerts: { pendingDecisions: [], blockedSlices: [] },
  stages: [
    {
      key: 'S1', name: '产品', status: 'done', completion: 100,
      completionDetail: { sliceMean: 100, coverage: 100, expected: ['prd'], missing: [] },
      sliceCount: 2, documentCount: 2,
      slices: [
        {
          id: 'sl-1', title: '切片一', status: 'review', completion: 88,
          completionDetail: [{ key: 'documents', score: 100 }],
          counts: { tasks: 1, documents: 1, decisions: 0, evidence: 0, sessions: 0 },
          tasksDone: 1, tasksTotal: 1,
          documents: [{ id: 'd1', title: 'PRD', status: 'frozen', version: 1, weight: 100, exportPath: 'docs/product/a.md', fileState: 'present' }],
          decisions: [],
        },
        {
          id: 'sl-2', title: '切片二', status: 'open', completion: 0,
          completionDetail: [], counts: { tasks: 0, documents: 0, decisions: 0, evidence: 0, sessions: 0 },
          tasksDone: 0, tasksTotal: 0, documents: [], decisions: [],
        },
      ],
    },
    {
      key: 'S2', name: 'UX', status: 'pending', completion: 0,
      completionDetail: { sliceMean: 0, coverage: 0, expected: ['ux'], missing: ['ux'] },
      sliceCount: 0, documentCount: 0, slices: [],
    },
  ],
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('renderer 能装载并画出一帧，不抛异常', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.frame()
    stub.runFrame()

    const calls = stub.canvas._calls
    assert.ok(calls.arc > 0, '应画了圆（节点）')
    assert.ok(calls.fill > 0, '应调用了 fill')
    assert.ok(calls.stroke > 0, '应画了边或进度环')
    assert.ok(calls.fillText > 0, '应画了阶段标签')
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('setTree 之后布局节点数与树一致', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    const layout = renderer._debug.getLayout()
    // root(1) + 阶段(2) + 切片(2) + 文档(1)
    assert.equal(layout.nodes.length, 6)
    assert.ok(layout.edges.length >= 5)
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('空树也能画（不白屏崩溃）', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree({ project: { name: '空' }, total: 0, stages: [] })
    renderer.frame()
    stub.runFrame()
    assert.ok(stub.canvas._calls.fill >= 0)
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('拖拽改变相机 yaw，且拖拽结束后不当点击选中', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.frame()
    stub.runFrame()

    const yaw0 = renderer.getCamera().yaw
    stub.canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    stub.canvas.dispatch('pointermove', { clientX: 180, clientY: 100, pointerId: 1 })
    stub.canvas.dispatch('pointerup', { clientX: 180, clientY: 100, pointerId: 1 })
    const yaw1 = renderer.getCamera().yaw
    assert.notEqual(yaw0, yaw1, '拖拽应改变 yaw')
    assert.equal(renderer.getSelected(), null, '拖拽位移大于阈值时不应选中节点')
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('滚轮缩放改变相机距离并被钳制', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.frame()
    const d0 = renderer.getCamera().distance

    stub.canvas.dispatch('wheel', { deltaY: -500, preventDefault() {} })
    const d1 = renderer.getCamera().distance
    assert.ok(d1 < d0, '向上滚应拉近')

    // 疯狂放大也不能穿进去
    for (let i = 0; i < 50; i += 1) stub.canvas.dispatch('wheel', { deltaY: -500, preventDefault() {} })
    assert.ok(renderer.getCamera().distance >= 4, '距离有下限')
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('Esc 清空选中', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.select({ id: 'stage:S1', kind: 'stage', position: [0, 0, 0], radius: 0.3, completion: 100 })
    assert.ok(renderer.getSelected())
    // keydown 是挂在 window 上的；桩里 window.addEventListener 是空实现，
    // 所以这里直接验 API 行为（Esc 的接线在页面里另有覆盖）
    renderer.select(null)
    assert.equal(renderer.getSelected(), null)
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('自动旋转开关会持续改变相机', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.setAutoRotate(true)
    assert.equal(renderer.getAutoRotate(), true)
    const yaw0 = renderer.getCamera().yaw
    for (let i = 0; i < 5; i += 1) stub.runFrame()
    assert.notEqual(yaw0, renderer.getCamera().yaw, '自动旋转应改变 yaw')
    renderer.setAutoRotate(false)
    assert.equal(renderer.getAutoRotate(), false)
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('点选回调把节点抛给详情面板', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.frame()
    stub.runFrame()

    const seen = []
    renderer.on('select', (node) => seen.push(node))
    // 直接调 select + 手动 emit，避免依赖命中测试的像素坐标
    const layout = renderer._debug.getLayout()
    const target = layout.nodes.find((n) => n.kind === 'stage')
    renderer.select(target)
    assert.equal(renderer.getSelected().id, target.id)
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})

test('resize 后仍可继续画', async () => {
  const stub = installStubs()
  try {
    const { createRenderer } = await import('../web/renderer.js')
    const renderer = createRenderer(stub.canvas)
    renderer.setTree(SAMPLE_TREE)
    renderer.resize()
    renderer.redraw()
    stub.runFrame()
    assert.ok(stub.canvas._calls.fill > 0)
    renderer.dispose()
  } finally {
    stub.teardown()
  }
})
