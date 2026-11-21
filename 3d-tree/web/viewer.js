// 3d-tree/web/viewer.js
//
// three.js 主程序：渲染循环、Bloom 后处理、交互、HUD 联动。
//
// 视觉目标：深色底 + 发光节点 + 体积感光晕，重点让「主干/分支状态」一眼可读。
// 刻意不做：阶段节点、百分比文字贴在 3D 上（那些都进弹窗）。

import * as THREE from './vendor/three.module.min.js'
import { OrbitControls } from './vendor/OrbitControls.js'
import { EffectComposer } from './vendor/EffectComposer.js'
import { RenderPass } from './vendor/RenderPass.js'
import { UnrealBloomPass } from './vendor/UnrealBloomPass.js'
import { OutputPass } from './vendor/OutputPass.js'
import { buildScene, buildStarfield, computeLayout, PALETTE } from './scene.js'

export function createViewer(canvas, options = {}) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(PALETTE.bg)
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.021)

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 220)
  camera.position.set(9.5, 4.5, 12.5)

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace

  // ---- 灯光：一个冷色主光 + 一个暖色边缘光 + 环境光，制造立体感 ----
  const key = new THREE.DirectionalLight(0xbcd4ff, 1.5)
  key.position.set(6, 12, 8)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x4f7cff, 0.85)
  rim.position.set(-8, -3, -7)
  scene.add(rim)
  scene.add(new THREE.AmbientLight(0x2c3a52, 1.5))

  const stars = buildStarfield()
  scene.add(stars.points)

  // ---- 后处理：Bloom 是"酷炫"的主要来源 ----
  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.18)
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.07
  controls.rotateSpeed = 0.75
  controls.zoomSpeed = 0.85
  controls.minDistance = 3
  controls.maxDistance = 46
  controls.autoRotateSpeed = 0.55
  controls.target.set(0, 0, 0)

  let sceneData = null
  let layout = null
  let raf = 0
  let hovered = null
  let selected = null
  const listeners = { select: [], hover: [] }
  const clock = new THREE.Clock()
  let time = 0

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let pointerInside = false

  function emit(name, payload) {
    for (const fn of listeners[name]) fn(payload)
  }

  function setTree(tree) {
    if (sceneData) {
      scene.remove(sceneData.group)
      sceneData.dispose()
      sceneData = null
    }
    layout = computeLayout(tree, options.layout || {})
    sceneData = buildScene(THREE, layout, options)
    scene.add(sceneData.group)
    // 主干按项目状态染色
    applyTrunkStatus(tree.trunk?.status)
    frame()
    return layout
  }

  /** 主干颜色随项目状态变：阻塞红 / 待决策黄 / 完成绿 / 其它蓝。 */
  function applyTrunkStatus(status) {
    if (!sceneData) return
    const map = {
      blocked: PALETTE.trunkBad,
      attention: PALETTE.trunkWarn,
      done: PALETTE.trunkHealthy,
      active: 0x59b0ff,
    }
    const color = new THREE.Color(map[status] ?? PALETTE.trunkIdle)
    sceneData.group.traverse((obj) => {
      if (obj.userData?.nodeId?.startsWith('trunk:') && obj.material) {
        obj.material.color.copy(color)
        obj.material.emissive?.copy(color)
      }
    })
  }

  /** 相机对准整棵树：按主干高度和分支半径算合适的距离。 */
  function frame() {
    if (!layout || layout.nodes.length === 0) return
    let minY = Infinity, maxY = -Infinity, maxR = 1
    for (const n of layout.nodes) {
      minY = Math.min(minY, n.position[1])
      maxY = Math.max(maxY, n.position[1])
      maxR = Math.max(maxR, Math.hypot(n.position[0], n.position[2]))
    }
    const center = new THREE.Vector3(0, (minY + maxY) / 2, 0)
    controls.target.copy(center)
    const span = Math.max(maxY - minY, maxR * 2.2, 6)
    const dist = span * 1.25
    const dir = new THREE.Vector3(0.62, 0.28, 0.73).normalize()
    camera.position.copy(center).addScaledVector(dir, dist)
    controls.update()
  }

  function resize() {
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, rect.width)
    const h = Math.max(1, rect.height)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    composer.setSize(w, h)
    bloom.resolution.set(w, h)
  }

  // ---- 交互 ----

  function updatePointer(event) {
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    pointerInside = true
  }

  function pick() {
    if (!sceneData) return null
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObjects(sceneData.pickables, false)
    return hits.length > 0 ? hits[0].object.userData.node ?? null : null
  }

  function onMove(event) {
    updatePointer(event)
    const node = pick()
    if ((node?.id ?? null) !== (hovered?.id ?? null)) {
      hovered = node
      canvas.style.cursor = node ? 'pointer' : 'grab'
      emit('hover', node)
    }
  }

  function onLeave() {
    pointerInside = false
    if (hovered) {
      hovered = null
      emit('hover', null)
    }
  }

  let downAt = null
  function onDown(event) {
    downAt = { x: event.clientX, y: event.clientY }
  }
  function onUp(event) {
    if (!downAt) return
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
    downAt = null
    if (moved > 5) return
    updatePointer(event)
    const node = pick()
    selected = node
    emit('select', node)
  }

  // ---- 渲染循环 ----

  function animate() {
    raf = requestAnimationFrame(animate)
    const dt = clock.getDelta()
    time += dt
    controls.update()

    // 呼吸脉冲：让场景"活"起来，同时暗示状态是动态的
    if (sceneData) {
      const pulse = 1 + Math.sin(time * 1.6) * 0.06
      sceneData.group.traverse((obj) => {
        if (obj.userData?.nodeId?.startsWith('branch:') && obj.material?.emissiveIntensity !== undefined) {
          obj.material.emissiveIntensity = 1.25 * pulse
        }
      })
      if (sceneData.nodeIndex) {
        for (const [id, node] of sceneData.nodeIndex) {
          if (node.halo) {
            node.halo.scale.setScalar(node.size * 2.5 * (1 + Math.sin(time * 1.1 + id.length) * 0.09))
          }
        }
      }
      // 星场缓慢自转
      stars.points.rotation.y = time * 0.012
    }

    composer.render()
  }

  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  window.addEventListener('resize', resize)

  resize()
  animate()

  return {
    setTree,
    frame,
    resize,
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); return this },
    setAutoRotate(v) { controls.autoRotate = Boolean(v); return controls.autoRotate },
    getAutoRotate() { return controls.autoRotate },
    getLayout: () => layout,
    getScene: () => sceneData,
    getSelected: () => selected,
    clearSelection() { selected = null; emit('select', null) },
    /** 高亮某个分支及其文件（点击 HUD 列表时用）。 */
    focusBranch(branchId) {
      if (!sceneData) return null
      const node = sceneData.nodeIndex.get('branch:' + branchId)
      if (!node) return null
      selected = node
      emit('select', node)
      // 相机看向该分支
      const target = new THREE.Vector3(...node.position)
      controls.target.lerp(target, 0.85)
      return node
    },
    dispose() {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      window.removeEventListener('resize', resize)
      controls.dispose()
      stars.dispose()
      if (sceneData) sceneData.dispose()
      renderer.dispose()
      composer.dispose?.()
    },
  }
}

export { PALETTE }
