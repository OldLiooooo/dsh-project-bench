// 3d-tree/web/scene.js
//
// 3D 场景构建：把 model 的树变成 three.js 的几何体。
//
// 语义（这决定了整个视图长什么样）：
//   主干 trunk  = 项目本身。它的颜色/脉冲代表项目整体状态。
//   分支 branch = 一个「切片」（工作项）。分支的粗细/发光代表该切片状态。
//   叶   leaf   = 磁盘上的**真实文件**。片的完成度最终体现为「文件在不在、什么状态」。
//   阶段 S01/S02 不做成节点 —— 它们的百分比只进弹窗。
//
// 为什么阶段不上树：用户要的是「一眼看主干和分支什么状态」。
// 七个阶段做成节点会把树撑成一条直线，主干语义被稀释。

import * as THREE from './vendor/three.module.min.js'

export const PALETTE = {
  bg: 0x05070d,
  fog: 0x05070d,
  trunkHealthy: 0x35e08d,
  trunkWarn: 0xe8b33c,
  trunkBad: 0xe8574d,
  trunkIdle: 0x3a4557,
  branchActive: 0x59b0ff,
  branchDone: 0x35e08d,
  branchBlocked: 0xe8574d,
  branchOpen: 0x6b7fa8,
  leafPresent: 0x7ee0c0,
  leafMissing: 0xe86b6b,
  leafDraft: 0xe8b33c,
}

/** 状态 -> 颜色。用词保守：只认库里真实出现的状态值。 */
export function colorForStatus(kind, status, fallback = 0x6b7fa8) {
  const s = String(status || '').toLowerCase()
  if (kind === 'branch') {
    if (['done', 'completed', 'complete'].includes(s)) return PALETTE.branchDone
    if (['blocked', 'failed'].includes(s)) return PALETTE.branchBlocked
    if (['in_progress', 'active', 'review', 'ongoing'].includes(s)) return PALETTE.branchActive
    if (['open', 'pending'].includes(s)) return PALETTE.branchOpen
    return fallback
  }
  if (kind === 'trunk') {
    if (['blocked', 'failed'].includes(s)) return PALETTE.trunkBad
    if (['attention', 'review'].includes(s)) return PALETTE.trunkWarn
    if (['done', 'completed'].includes(s)) return PALETTE.trunkHealthy
    return 0x59b0ff // 进行中：与分支的 active 同色系，但主干靠亮度区分
  }
  return fallback
}

/** 文件状态 -> 颜色 + 大小倍率。 */
export function leafStyle(file) {
  if (file.state === 'synced') return { color: PALETTE.leafPresent, scale: 1.0, glow: 0.9 }
  if (file.state === 'stale') return { color: PALETTE.leafMissing, scale: 0.72, glow: 0.55 }
  return { color: PALETTE.leafDraft, scale: 0.55, glow: 0.35 }
}

// ---------------------------------------------------------------------------
// 布局：主干竖直，分支从主干螺旋伸出，叶子挂在分支末端
// ---------------------------------------------------------------------------

/**
 * @param {object} tree buildTree 的输出（含 fileTree）
 * @param {object} options 间距参数
 * @returns {{nodes: Array, links: Array}}
 */
export function computeLayout(tree, options = {}) {
  const trunkHeight = Number(options.trunkHeight ?? 9)
  const branchSpread = Number(options.branchSpread ?? 4.2)
  const leafSpread = Number(options.leafSpread ?? 1.15)
  const branches = tree.branches || []
  const nodes = []
  const links = []

  // 主干：一串节点，从上到下流动，代表时间/进度
  const SEGMENTS = 26
  for (let i = 0; i <= SEGMENTS; i += 1) {
    const t = i / SEGMENTS
    nodes.push({
      id: 'trunk:' + i,
      kind: 'trunk',
      position: [0, trunkHeight / 2 - t * trunkHeight, 0],
      size: 0.16 + Math.sin(t * Math.PI) * 0.05,
      t,
    })
    if (i > 0) {
      const prev = nodes[nodes.length - 2]
      const cur = nodes[nodes.length - 1]
      links.push({ from: prev.id, to: cur.id, kind: 'trunk', width: 0.075 })
    }
  }

  // 分支：按数量均匀绕 Y 轴分布，并沿主干高度错开，形成螺旋
  const n = Math.max(1, branches.length)
  branches.forEach((branch, bi) => {
    const angle = (bi / n) * Math.PI * 2 - Math.PI / 2
    // 高度沿主干均匀铺开，但要留出上下边距
    const hT = n === 1 ? 0.5 : (bi + 0.5) / n
    const y = trunkHeight / 2 - hT * trunkHeight
    const radius = branchSpread * (0.8 + ((bi * 37) % 11) / 22) // 伪随机，但对同一输入稳定
    const tip = [Math.cos(angle) * radius, y + 0.35, Math.sin(angle) * radius]
    const root = [0, y, 0]

    const branchColor = colorForStatus('branch', branch.status)

    nodes.push({
      id: 'branch:' + branch.id,
      kind: 'branch',
      branchId: branch.id,
      label: branch.title,
      status: branch.status,
      position: tip,
      size: 0.34 + (branch.fileCount ? Math.min(0.22, Math.log2(branch.fileCount + 1) * 0.07) : 0),
      color: branchColor,
      data: branch,
    })
    links.push({ from: 'root', to: 'branch:' + branch.id, kind: 'branch', width: 0.035, color: branchColor, via: root })

    // 叶子：每条分支末端发散的细枝，每根挂一个文件
    const files = branch.files || []
    const fn = files.length
    files.forEach((file, fi) => {
      // 末端再分叉：让文件点形成一簇小星团
      const localAngle = fn === 1 ? angle : angle - 0.9 + (fi / Math.max(1, fn - 1)) * 1.8
      const localRadius = leafSpread * (1 + ((fi * 13) % 7) / 14)
      const pos = [
        tip[0] + Math.cos(localAngle) * localRadius,
        tip[1] + (fi % 2 === 0 ? 0.26 : -0.2) + ((fi * 7) % 5) * 0.05,
        tip[2] + Math.sin(localAngle) * localRadius,
      ]
      const style = leafStyle(file)
      nodes.push({
        id: 'file:' + file.id,
        kind: 'file',
        branchId: branch.id,
        label: file.title,
        file,
        position: pos,
        size: 0.075 * style.scale + 0.045,
        color: style.color,
        glow: style.glow,
      })
      links.push({
        from: 'branch:' + branch.id,
        to: 'file:' + file.id,
        kind: 'leaf',
        width: 0.012,
        color: style.color,
      })
    })

    // 分支自身的「文件数」用小卫星表示（有多少文件还没落地时依然有视觉密度）
    if (fn === 0) {
      // 没有文件的切片：末端画一个空心环，表示"这里还没有产物"
      nodes.push({
        id: 'empty:' + branch.id,
        kind: 'empty',
        branchId: branch.id,
        position: [tip[0] * 1.16, tip[1], tip[2] * 1.16],
        size: 0.13,
        color: PALETTE.leafMissing,
      })
      links.push({ from: 'branch:' + branch.id, to: 'empty:' + branch.id, kind: 'leaf', width: 0.01, color: PALETTE.leafMissing })
    }
  })

  return { nodes, links }
}

// ---------------------------------------------------------------------------
// 场景构建
// ---------------------------------------------------------------------------

/**
 * 把布局变成 three.js 对象。
 * 返回 {group, pickables, dispose} —— pickables 是射线拾取用的原始数据。
 */
export function buildScene(three, layout, options = {}) {
  const group = new THREE.Group()
  const pickables = []
  const disposables = []
  const nodeIndex = new Map()

  // ---- 连线 ----
  const linePositions = []
  const lineColors = []
  for (const link of layout.links) {
    const a = nodeIndex.get(link.from) || layout.nodes.find((n) => n.id === link.from)
    const b = nodeIndex.get(link.to) || layout.nodes.find((n) => n.id === link.to)
    if (!a || !b) continue
    let from = a.position
    let to = b.position
    // 分支要经过主干上的点（via），形成折线而不是直线斜拉
    if (link.via) {
      const color = new THREE.Color(link.color ?? 0x334155)
      linePositions.push(from[0], from[1], from[2], link.via[0], link.via[1], link.via[2])
      linePositions.push(link.via[0], link.via[1], link.via[2], to[0], to[1], to[2])
      for (let k = 0; k < 4; k += 1) lineColors.push(color.r, color.g, color.b)
    } else {
      const color = new THREE.Color(link.color ?? 0x334155)
      linePositions.push(from[0], from[1], from[2], to[0], to[1], to[2])
      lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    }
  }
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3))
  lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lineColors, 3))
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lines = new THREE.LineSegments(lineGeo, lineMat)
  group.add(lines)
  disposables.push(lineGeo, lineMat)

  // ---- 节点（球体）----
  const sphereGeo = new THREE.SphereGeometry(1, 20, 16)
  disposables.push(sphereGeo)

  for (const node of layout.nodes) {
    nodeIndex.set(node.id, node)

    // 主干：一串发光球组成的光柱
    if (node.kind === 'trunk') {
      const geo = new THREE.SphereGeometry(1, 12, 10)
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(PALETTE.trunkHealthy).lerp(new THREE.Color(PALETTE.branchOpen), 0.35),
        transparent: true,
        opacity: 0.35,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(...node.position)
      mesh.scale.setScalar(node.size * 0.9)
      mesh.userData = { nodeId: node.id, node }
      group.add(mesh)
      disposables.push(geo, mat)
      // 主干也要可点：点它 = 看阶段进度弹窗。之前漏了这行，主干点不动。
      pickables.push(mesh)
      continue
    }

    const color = new THREE.Color(node.color ?? 0x6b7fa8)
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: node.kind === 'file' ? 0.65 : 1.25,
      roughness: 0.35,
      metalness: 0.1,
    })
    const mesh = new THREE.Mesh(sphereGeo, mat)
    mesh.position.set(...node.position)
    mesh.scale.setScalar(node.size)
    mesh.userData = { nodeId: node.id, node }
    group.add(mesh)
    disposables.push(mat)

    if (node.kind === 'branch') {
      // 分支套一层半透明光晕球，制造体积感
      const haloGeo = new THREE.SphereGeometry(1, 16, 12)
      const haloMat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const halo = new THREE.Mesh(haloGeo, haloMat)
      halo.position.set(...node.position)
      halo.scale.setScalar(node.size * 2.5)
      group.add(halo)
      disposables.push(haloGeo, haloMat)
      nodeIndex.get(node.id).halo = halo
    }

    pickables.push(mesh)
  }

  return {
    group,
    pickables,
    nodeIndex,
    dispose() {
      for (const d of disposables) {
        if (d && typeof d.dispose === 'function') d.dispose()
      }
    },
  }
}

/** 背景星空：几百个远点，给 3D 一个尺度参照。 */
export function buildStarfield(count = 900, radius = 42) {
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    // 球壳均匀分布
    const u = Math.random()
    const v = Math.random()
    const theta = u * Math.PI * 2
    const phi = Math.acos(2 * v - 1)
    const r = radius * (0.65 + Math.random() * 0.35)
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.cos(phi) * 0.55
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.PointsMaterial({
    color: 0x6f8bb8,
    size: 0.09,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  })
  const points = new THREE.Points(geo, mat)
  return { points, dispose: () => { geo.dispose(); mat.dispose() } }
}
