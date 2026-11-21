// 3d-tree/web/renderer.js
//
// Canvas 2D 上的软件 3D 渲染器。职责：把 layoutTree 的 {nodes, edges} 画出来，
// 处理鼠标拖拽/滚轮/点选。所有三维数学在 projection.js，这里只管画的顺序和样式。
//
// 为什么用 Canvas 2D 而不是 WebGL：目标机器（含远程桌面/虚拟机）不一定有可用 GPU，
// WebGL 上下文创建失败会让整个视图白屏；Canvas 2D 到处都能画，且几千个圆点完全够用。

import { clampCamera, completionColor, createCamera, depthSort, layoutTree, pick, project } from './projection.js'

const DEFAULT_THEME = {
  bg: '#0f1116',
  grid: 'rgba(255,255,255,0.045)',
  edge: 'rgba(150,168,200,0.30)',
  edgeDone: 'rgba(96,220,150,0.55)',
  text: 'rgba(232,238,250,0.94)',
  textDim: 'rgba(150,164,188,0.75)',
  label: 'rgba(255,255,255,0.92)',
  labelBg: 'rgba(12,15,22,0.72)',
  ring: 'rgba(255,255,255,0.16)',
  stageRing: 'rgba(120,160,255,0.22)',
}

export function createRenderer(canvas, options = {}) {
  const ctx = canvas.getContext('2d', { alpha: false })
  const theme = { ...DEFAULT_THEME, ...(options.theme || {}) }
  let camera = createCamera(options.camera || {})
  let tree = null
  let layout = { nodes: [], edges: [] }
  let hovered = null
  let selected = null
  let autoRotate = false
  let dpr = 1
  let viewport = { width: 1, height: 1 }
  let lastFrame = 0
  let dragging = null
  let dirty = true
  const listeners = { select: [], hover: [] }

  const cameraAnchor = options.cameraTarget || [0, 0, 0]

  function resize() {
    const rect = canvas.getBoundingClientRect()
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    viewport = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
    canvas.width = Math.round(viewport.width * dpr)
    canvas.height = Math.round(viewport.height * dpr)
    dirty = true
  }

  function setTree(nextTree) {
    tree = nextTree
    layout = layoutTree(tree, options.layout || {})
    // 布局变了，把选中/悬停按 id 重新绑到新对象上。
    if (selected) selected = layout.nodes.find((n) => n.id === selected.id) || null
    if (hovered) hovered = layout.nodes.find((n) => n.id === hovered.id) || null
    dirty = true
    return layout
  }

  /**
   * 相机对准当前树的几何中心：不同项目的阶段数/切片数差别很大，
   * 固定距离会导致有的项目占满屏、有的缩成一点。
   */
  function frame() {
    if (layout.nodes.length === 0) return
    let minY = Infinity
    let maxY = -Infinity
    let maxR = 1
    for (const node of layout.nodes) {
      minY = Math.min(minY, node.position[1])
      maxY = Math.max(maxY, node.position[1])
      maxR = Math.max(maxR, Math.hypot(node.position[0], node.position[2]))
    }
    const centerY = (minY + maxY) / 2
    camera.target = [0, centerY, 0]
    const span = Math.max(maxY - minY, maxR * 2, 3)
    camera.distance = span * 1.55
    camera = clampCamera(camera)
    dirty = true
  }

  function screenOf(node) {
    const p = project(node.position, camera, viewport)
    return {
      visible: p.visible,
      depth: p.depth,
      x: p.x,
      y: p.y,
      // 半径也跟随透视缩放，远处的球自然变小；钳一下防止退化。
      radius: Math.max(1.5, node.radius * p.scale),
    }
  }

  function drawBackground() {
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, viewport.width, viewport.height)

    // 地板网格：给一个深度参照，否则纯黑背景里 3D 看起来像 2D。
    const gridSize = 12
    const step = 1.6
    ctx.strokeStyle = theme.grid
    ctx.lineWidth = 1
    const yFloor = -Math.max(2, (layout.nodes.reduce((m, n) => Math.max(m, Math.abs(n.position[1])), 0)) + 1.4)
    ctx.beginPath()
    for (let i = -gridSize; i <= gridSize; i += 1) {
      const a = project([i * step, yFloor, -gridSize * step], camera, viewport)
      const b = project([i * step, yFloor, gridSize * step], camera, viewport)
      if (a.visible && b.visible) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y) }
      const c = project([-gridSize * step, yFloor, i * step], camera, viewport)
      const d = project([gridSize * step, yFloor, i * step], camera, viewport)
      if (c.visible && d.visible) { ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y) }
    }
    ctx.stroke()
  }

  function drawEdges(screenNodes) {
    for (const edge of layout.edges) {
      const a = project(edge.from, camera, viewport)
      const b = project(edge.to, camera, viewport)
      if (!a.visible || !b.visible) continue
      const done = edge.completion >= 100
      ctx.strokeStyle = done ? theme.edgeDone : theme.edge
      ctx.lineWidth = edge.kind === 'spine' ? 1.6 : edge.kind === 'branch' ? 1.1 : 0.8
      ctx.globalAlpha = edge.kind === 'leaf' ? 0.5 : 1
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    void screenNodes
  }

  function drawNode(node, screen) {
    const isSelected = selected && selected.id === node.id
    const isHovered = hovered && hovered.id === node.id
    const color = completionColor(node.completion)
    const r = screen.radius

    // 外发光：完成的节点更亮，一眼能扫出「哪些绿了」。
    if (node.kind !== 'document' || node.completion > 0) {
      const glow = ctx.createRadialGradient(screen.x, screen.y, r * 0.6, screen.x, screen.y, r * 3.2)
      glow.addColorStop(0, color.replace('hsl', 'hsla').replace(')', ' / 0.30)'))
      glow.addColorStop(1, color.replace('hsl', 'hsla').replace(')', ' / 0)'))
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, r * 3.2, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.beginPath()
    ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2)
    ctx.fillStyle = node.kind === 'document' && node.fileState === 'missing'
      ? 'rgba(120,130,150,0.55)'
      : color
    ctx.fill()

    // 完成度弧线：圆点外圈画一圈，像进度环。
    if (node.kind !== 'document' && node.completion > 0) {
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * node.completion) / 100)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.6
      ctx.globalAlpha = 0.85
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    if (node.kind === 'stage') {
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, r + 6, 0, Math.PI * 2)
      ctx.strokeStyle = node.status === 'active' ? 'rgba(120,170,255,0.75)' : theme.stageRing
      ctx.lineWidth = node.status === 'active' ? 1.8 : 1
      ctx.stroke()
    }

    if (isSelected || isHovered) {
      ctx.beginPath()
      ctx.arc(screen.x, screen.y, r + (isSelected ? 9 : 7), 0, Math.PI * 2)
      ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)'
      ctx.lineWidth = isSelected ? 2 : 1.2
      ctx.stroke()
    }
  }

  function drawLabels(points) {
    // 只给阶段和选中的节点画文字：全画会在密集时糊成一片。
    ctx.textBaseline = 'middle'
    for (const item of points) {
      const node = item.node
      const isStage = node.kind === 'stage'
      const isSelected = selected && selected.id === node.id
      const isHovered = hovered && hovered.id === node.id
      if (!isStage && !isSelected && !isHovered) continue
      if (!item.screen.visible) continue

      const label = isStage
        ? node.label + '  ' + node.completion + '%'
        : node.label
      const font = isStage ? '600 12px ui-sans-serif, system-ui, sans-serif' : '12px ui-sans-serif, system-ui, sans-serif'
      ctx.font = font
      const metrics = ctx.measureText(label)
      const padX = 6
      const padY = 3
      const boxW = metrics.width + padX * 2
      const boxH = 18
      const anchorX = item.screen.x + item.screen.radius + 10
      const anchorY = item.screen.y

      ctx.fillStyle = theme.labelBg
      roundRect(ctx, anchorX, anchorY - boxH / 2, boxW, boxH, 4)
      ctx.fill()

      ctx.fillStyle = isSelected ? theme.label : isStage ? theme.text : theme.textDim
      ctx.fillText(label, anchorX + padX, anchorY + 0.5)
    }
  }

  function roundRect(context, x, y, w, h, radius) {
    const r = Math.min(radius, h / 2, w / 2)
    context.beginPath()
    context.moveTo(x + r, y)
    context.arcTo(x + w, y, x + w, y + h, r)
    context.arcTo(x + w, y + h, x, y + h, r)
    context.arcTo(x, y + h, x, y, r)
    context.arcTo(x, y, x + w, y, r)
    context.closePath()
  }

  let cachedPoints = []

  function draw() {
    ctx.save()
    ctx.scale(dpr, dpr)
    drawBackground()

    // 画家算法：远的先画，近的后画，近的盖住远的。
    const sorted = depthSort(layout.nodes, camera)
    const points = sorted.map((node) => ({ node, screen: screenOf(node) }))
    cachedPoints = points

    drawEdges(points)
    for (const item of points) {
      if (!item.screen.visible) continue
      drawNode(item.node, item.screen)
    }
    drawLabels(points)
    ctx.restore()
  }

  function frameLoop(now) {
    if (autoRotate && !dragging) {
      camera.yaw += 0.0022
      dirty = true
    }
    if (dirty) {
      dirty = false
      draw()
    }
    lastFrame = now
    requestAnimationFrame(frameLoop)
  }

  // ---- 交互 ----

  function localPoint(event) {
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  function emit(name, payload) {
    for (const fn of listeners[name]) fn(payload)
  }

  function onPointerDown(event) {
    dragging = { x: event.clientX, y: event.clientY, moved: 0, yaw: camera.yaw, pitch: camera.pitch }
    canvas.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event) {
    if (dragging) {
      const dx = event.clientX - dragging.x
      const dy = event.clientY - dragging.y
      dragging.moved += Math.abs(dx) + Math.abs(dy)
      camera.yaw = dragging.yaw - dx * 0.006
      camera.pitch = dragging.pitch + dy * 0.005
      camera = clampCamera(camera)
      dirty = true
      return
    }
    const { x, y } = localPoint(event)
    const candidates = cachedPoints.map((item) => ({
      node: item.node,
      screen: item.screen,
      visible: item.screen.visible,
      radius: item.screen.radius + 6,
    }))
    const hit = pick(candidates, x, y, 10)
    if ((hit && hit.id) !== (hovered && hovered.id)) {
      hovered = hit
      canvas.style.cursor = hit ? 'pointer' : 'grab'
      dirty = true
      emit('hover', hit)
    }
  }

  function onPointerUp(event) {
    if (!dragging) return
    const moved = dragging.moved
    dragging = null
    canvas.releasePointerCapture?.(event.pointerId)
    if (moved > 6) return // 拖拽结束不当点击
    const { x, y } = localPoint(event)
    const candidates = cachedPoints.map((item) => ({
      node: item.node,
      screen: item.screen,
      visible: item.screen.visible,
      radius: item.screen.radius + 6,
    }))
    const hit = pick(candidates, x, y, 10)
    selected = hit
    dirty = true
    emit('select', hit)
  }

  function onWheel(event) {
    event.preventDefault()
    camera.distance *= Math.exp(event.deltaY * 0.0012)
    camera = clampCamera(camera)
    dirty = true
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      selected = null
      dirty = true
      emit('select', null)
    } else if (event.key === 'r' || event.key === 'R') {
      frame()
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', resize)

  resize()
  requestAnimationFrame(frameLoop)

  return {
    setTree,
    frame,
    resize,
    redraw: () => { dirty = true },
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); return this },
    select(node) { selected = node; dirty = true; return selected },
    getSelected: () => selected,
    setAutoRotate(value) { autoRotate = Boolean(value); return autoRotate },
    getAutoRotate: () => autoRotate,
    getCamera: () => ({ ...camera }),
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', resize)
    },
    _debug: { getLayout: () => layout, getCamera: () => camera, lastFrame }
  }
}
