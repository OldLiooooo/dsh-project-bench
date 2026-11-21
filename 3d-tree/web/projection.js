// 3d-tree/web/projection.js
//
// 纯数学：3D 点 -> 屏幕点。没有 DOM、没有 canvas，能在 node 里单测。
// 为什么自己写而不是上 three.js：插件 client 是首屏预载的 CJS bundle，
// 拖一个 WebGL 库进去会拖慢启动（见 docs/workbench-ui-architecture-v1.zh.md §6）。
// 这个视图只需要「点、线、球」，正交/透视投影 + 深度排序一共不到 100 行，
// 换成零依赖是明确更优的选择。

/** 3D 向量工具。 */
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
}

/**
 * 相机：绕原点球面分布。
 * yaw 绕 Y 轴、pitch 俯仰、distance 距离，全部是用户拖拽/滚轮控制的量。
 */
export function createCamera({ yaw = 0.6, pitch = 0.42, distance = 15, fov = 55 } = {}) {
  return { yaw, pitch, distance, fov, target: [0, 0, 0] }
}

export function clampCamera(cam) {
  const pitch = Math.max(-1.45, Math.min(1.45, cam.pitch))
  const distance = Math.max(4, Math.min(90, cam.distance))
  return { ...cam, pitch, distance }
}

/**
 * 世界 -> 视图坐标。返回相机基向量，供投影与排序用。
 * 约定：Y 轴向上（阶段沿 Y 排布像一层层楼），X/Z 是水平面。
 */
export function cameraBasis(cam) {
  const { yaw, pitch } = cam
  const dir = [
    Math.cos(pitch) * Math.sin(yaw),
    Math.sin(pitch),
    Math.cos(pitch) * Math.cos(yaw),
  ]
  const eye = v3.add(cam.target, v3.scale(v3.norm(dir), cam.distance))
  const forward = v3.norm(v3.sub(cam.target, eye))
  const worldUp = [0, 1, 0]
  let right = v3.cross(forward, worldUp)
  if (v3.len(right) < 1e-6) right = [1, 0, 0]
  right = v3.norm(right)
  const up = v3.norm(v3.cross(right, forward))
  return { eye, forward, right, up }
}

/**
 * 透视投影。返回 {x, y, depth, scale, visible}。
 * depth > 0 表示在相机前方；visible=false 的点不要画。
 */
export function project(point, cam, viewport) {
  const { eye, forward, right, up } = cameraBasis(cam)
  const rel = v3.sub(point, eye)
  const depth = v3.dot(rel, forward)
  if (depth <= 0.15) return { x: 0, y: 0, depth, scale: 0, visible: false }
  const focal = (viewport.height / 2) / Math.tan((cam.fov * Math.PI) / 360)
  const sx = v3.dot(rel, right)
  const sy = v3.dot(rel, up)
  return {
    x: viewport.width / 2 + (sx / depth) * focal,
    y: viewport.height / 2 - (sy / depth) * focal,
    depth,
    scale: focal / depth,
    visible: true,
  }
}

/**
 * 球体排序用的「画家算法」键：深度越大越先画。
 * 3D 场景里球面互相遮挡，按深度倒序画即可，不需要真的 zbuffer。
 */
export function depthSort(nodes, cam) {
  const { eye, forward } = cameraBasis(cam)
  return nodes
    .map((node) => ({ node, depth: v3.dot(v3.sub(node.position, eye), forward) }))
    .sort((a, b) => b.depth - a.depth)
    .map((item) => item.node)
}

/** 屏幕空间命中测试：找最近的、在半径内的节点。 */
export function pick(points, x, y, radius = 14) {
  let best = null
  for (const item of points) {
    if (!item.visible) continue
    const d = Math.hypot(item.screen.x - x, item.screen.y - y)
    const hitRadius = Math.max(radius, item.radius || 0)
    if (d <= hitRadius && (best === null || d < best.distance)) best = { node: item.node, distance: d }
  }
  return best ? best.node : null
}

/**
 * 布局：项目在原点，阶段沿 Y 轴向上排成一列环，
 * 切片绕各自阶段做圆周分布（同一阶段的切片在同一「楼层」）。
 * 纯函数：给定树和参数，返回 {nodes, edges}，d3/canvas 都吃这个。
 */
export function layoutTree(tree, options = {}) {
  const floorGap = Number(options.floorGap ?? 2.6)
  const sliceRadius = Number(options.sliceRadius ?? 3.1)
  const rootRadius = Number(options.rootRadius ?? 0.62)
  const nodes = []
  const edges = []
  const stages = tree.stages || []
  const mid = (stages.length - 1) / 2

  nodes.push({
    id: 'root',
    kind: 'root',
    label: tree.project?.name || 'project',
    position: [0, 0, 0],
    radius: rootRadius,
    completion: tree.total || 0,
    meta: tree,
  })

  stages.forEach((stage, index) => {
    const y = (index - mid) * floorGap
    const stagePos = [0, y, 0]
    nodes.push({
      id: 'stage:' + stage.key,
      kind: 'stage',
      label: stage.key + ' ' + stage.name,
      stageKey: stage.key,
      position: stagePos,
      radius: 0.34,
      completion: stage.completion,
      status: stage.status,
      meta: stage,
    })
    edges.push({ from: [0, 0, 0], to: stagePos, kind: 'spine', completion: stage.completion })

    const count = stage.slices.length
    stage.slices.forEach((slice, si) => {
      const angle = count === 1 ? 0 : (si / count) * Math.PI * 2
      // 每层转一点角度，避免上下层的切片在视觉上连成一条直线。
      const spin = index * 0.7
      const pos = [
        Math.cos(angle + spin) * sliceRadius,
        y + Math.sin(angle * 2 + spin) * 0.28,
        Math.sin(angle + spin) * sliceRadius,
      ]
      nodes.push({
        id: 'slice:' + slice.id,
        kind: 'slice',
        label: slice.title,
        stageKey: stage.key,
        position: pos,
        radius: 0.2 + (slice.completion / 100) * 0.1,
        completion: slice.completion,
        status: slice.status,
        meta: slice,
      })
      edges.push({ from: stagePos, to: pos, kind: 'branch', completion: slice.completion })

      // 文档作为更小的一层卫星：只画有正文的，空的用淡色，避免噪声。
      slice.documents.forEach((doc, di) => {
        const docCount = slice.documents.length
        const a = (di / Math.max(1, docCount)) * Math.PI * 2
        const docPos = [
          pos[0] + Math.cos(a) * 0.72,
          pos[1] + 0.16 + Math.sin(a) * 0.3,
          pos[2] + Math.sin(a) * 0.72,
        ]
        nodes.push({
          id: 'doc:' + doc.id,
          kind: 'document',
          label: doc.title,
          stageKey: stage.key,
          sliceId: slice.id,
          position: docPos,
          radius: 0.1,
          completion: doc.weight,
          status: doc.status,
          fileState: doc.fileState,
          meta: doc,
        })
        edges.push({ from: pos, to: docPos, kind: 'leaf', completion: doc.weight })
      })
    })
  })

  return { nodes, edges }
}

/** 完成度 -> 颜色（HSL，红->黄->绿）。饱和度压低一点，暗色主题下不刺眼。 */
export function completionColor(value, options = {}) {
  // Number(NaN) 会让 Math.min/max 一路带 NaN 出去，最后得到 hsl(NaN ...) ——
  // canvas 会静默丢弃这个 fillStyle，节点变成看不见的透明色。所以先归一再钳。
  const raw = Number(value)
  const t = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw / 100)) : 0
  const hue = 8 + t * 132 // 8(红) -> 140(绿)
  const sat = options.sat ?? 62
  const light = options.light ?? 52
  return 'hsl(' + hue.toFixed(0) + ' ' + sat + '% ' + light + '%)'
}
