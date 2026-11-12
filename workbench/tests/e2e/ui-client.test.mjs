// T5 verify · Client UI 契约自测（不需要浏览器/React 运行时）。
// 通过 client.js 的 __ModuleLoader__ 注册与 factory 返回的 __pure/__dictionaries/__components 测试面，
// 验证：槽位注册、i18n 字典、纯数据变换、组件存在性。
// 运行：node --test workbench/tests/e2e/ui-client.test.mjs
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import * as H from './harness.mjs'

const isNodeTest = process.env.NODE_TEST_CONTEXT !== undefined

let loadSequence = 0

/** 加载 client.js 并调用 factory(require)，require 只提供最小 react 替身（纯函数/组件存在性不需要真 React）。 */
export async function loadClientBundle() {
  // ESM 模块缓存：同一进程内多次加载要带唯一 query，否则顶层 __ModuleLoader__.load 不会再执行。
  loadSequence += 1
  const captured = []
  const previousWindow = globalThis.window
  globalThis.window = {
    __ModuleLoader__: { load(spec) { captured.push(spec) } },
    addEventListener() {}, removeEventListener() {},
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    matchMedia() { return { matches: false, addEventListener() {} } },
  }
  try {
    await import(pathToFileURL(H.hostFile('client.js')).href + '?ui-check=' + String(loadSequence))
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  H.expect(captured.length === 1, 'client.js 应通过 __ModuleLoader__.load 注册一次，实际 ' + String(captured.length))
  const spec = captured[0]
  H.expectEqual(spec.id, '@local/dsh-project-workbench', '插件 id')
  const reactStub = {
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    Fragment: Symbol('Fragment'),
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {}, useLayoutEffect() {}, useMemo(fn) { return fn() }, useCallback(fn) { return fn },
    useRef(value) { return { current: value } }, useContext() { return {} },
  }
  // client.js 的 ensureStyle() 在 factory 内执行；Node 测试没有真实 DOM，移除 document 让它安全跳过样式注入。
  const previousDocument = globalThis.document
  try { delete globalThis.document } catch { /* 内建不可删 */ }
  let exportsObject
  try {
    exportsObject = spec.factory((name) => {
      if (name === 'react') return reactStub
      throw new Error('client.js 不应 require 其它模块: ' + name)
    })
  } finally {
    if (previousDocument !== undefined) globalThis.document = previousDocument
  }
  return { spec, exports: exportsObject, react: reactStub }
}

/** client 侧 fake ctx：记录 slot/locale 注册。 */
export function makeClientCtx() {
  const state = { slots: [], injected: [], locales: [], disposed: [], effects: [], layoutCalls: [], log: [] }
  const ctx = {
    state,
    slots: {
      inject(name, callback) { state.injected.push(name); return callback() },
      register(definition, component) { state.slots.push({ definition, component }); return () => {} },
    },
    locale: {
      register(namespace, dictionaries) { state.locales.push({ namespace, dictionaries }); return () => {} },
      bind(namespace) { return (key) => namespace + ':' + key },
    },
    layout: { selectPanel(...args) { state.layoutCalls.push(args) } },
    uiWorkspace: { openSession() {}, startSession: async () => ({ id: 'fake-session' }) },
    sessions: { list: () => [] },
    workspaces: { list: () => [] },
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined
      if (typeof dispose === 'function') state.effects.push(dispose)
      return dispose
    },
  }
  return ctx
}

export async function makeSuite() {
  const cases = []
  const add = (name, fn) => cases.push({ name, fn })

  add('client: factory 注册 id/inject，4 个槽位注册到位', async () => {
    const { exports } = await loadClientBundle()
    H.expect(Array.isArray(exports.inject), 'factory 应返回 inject 数组')
    for (const service of ['slots', 'locale', 'layout', 'uiWorkspace', 'sessions', 'workspaces']) {
      H.expect(exports.inject.includes(service), 'inject 缺 ' + service)
    }
    H.expectEqual(typeof exports.apply, 'function', 'factory 应返回 apply')
    const ctx = makeClientCtx()
    exports.apply(ctx)
    const bySlot = new Map(ctx.state.slots.map((item) => [item.definition.name, item.definition]))
    H.expectEqual(bySlot.size, 4, '应注册 4 个槽位，实际 ' + String(bySlot.size))
    const main = bySlot.get('main')
    H.expectEqual(main.key, 'project-workbench', 'main key 应为 project-workbench')
    H.expectEqual(bySlot.get('sidebar.panellist').id, 'project-workbench', 'sidebar.panellist id 应为 project-workbench')
    H.expectEqual(bySlot.get('conversation.session.header.utilities').id, 'wb-pm-badge', 'PM 页头徽章 id')
    H.expectEqual(bySlot.get('conversation.composer.dock').id, 'wb-pm-summary', 'PM composer 状态条 id')
    for (const item of ctx.state.slots) H.expectEqual(typeof item.component, 'function', '槽位组件应为函数: ' + item.definition.name)
    // i18n：zh/en 字典同 key 集合，绑定命名空间 workbench
    H.expectEqual(ctx.state.locales.length, 1, '应注册 1 个 locale 字典')
    H.expectEqual(ctx.state.locales[0].namespace, 'workbench', 'locale 命名空间')
    const { zh, en } = ctx.state.locales[0].dictionaries
    H.expect(zh && en, '应同时提供 zh/en 字典')
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    H.expectEqual(JSON.stringify(zhKeys), JSON.stringify(enKeys), 'zh/en 字典 key 应一致')
    H.expect(zhKeys.length >= 40, '字典 key 数量应足够（>=40），实际 ' + String(zhKeys.length))
    for (const key of zhKeys) {
      H.expect(typeof zh[key] === 'string' && zh[key].length > 0, 'zh[' + key + '] 应为非空字符串')
      H.expect(typeof en[key] === 'string' && en[key].length > 0, 'en[' + key + '] 应为非空字符串')
    }
  })

  add('client: __pure 纯变换齐全且 parseDocContent/formatTime 基本行为正确', async () => {
    const { exports } = await loadClientBundle()
    const pure = exports.__pure
    H.expect(pure && typeof pure === 'object', '应暴露 __pure 测试面')
    const names = Object.keys(pure)
    H.expect(names.length >= 30, '__pure 变换数量应 >=30，实际 ' + String(names.length))
    for (const name of names) H.expectEqual(typeof pure[name], 'function', '__pure.' + name + ' 应为函数')
    // markdown → blocks（只渲染结构，不碰 DOM）
    const blocks = pure.parseDocContent('# 标题\n- 列表项\n\n正文段落')
    H.expect(Array.isArray(blocks) && blocks.length >= 2, 'parseDocContent 应返回块数组')
    const types = blocks.map((block) => block && block.type)
    H.expect(types.some((type) => /^h[1-6]$/.test(String(type))), '应解析标题块: ' + types.join(','))
    H.expect(types.includes('li'), '应解析列表块: ' + types.join(','))
    H.expect(types.includes('p'), '应解析段落块: ' + types.join(','))
    // 时间/状态标签：i18n 用占位 t（返回 key），断言返回非空字符串
    const fakeT = (key) => String(key)
    const time = pure.formatTime(new Date().toISOString(), 'zh')
    H.expect(typeof time === 'string' && time.length > 0, 'formatTime 应返回非空字符串')
    for (const status of ['active', 'pending', 'done', 'blocked']) {
      const label = pure.statusLabel(status, fakeT)
      H.expect(typeof label === 'string' && label.length > 0, 'statusLabel(' + status + ') 非空')
      H.expect(typeof pure.toneOfStatus(status) === 'string', 'toneOfStatus(' + status + ') 应返回字符串')
    }
    // 错误归一化
    const info = pure.errorInfo({ code: 'X', message: 'boom' })
    H.expect(info && typeof info === 'object', 'errorInfo 应返回对象')
    const text = pure.errorText({ code: 'X', message: 'boom' }, fakeT)
    H.expect(typeof text === 'string' && text.length > 0, 'errorText 应返回非空文本')
    H.expect(typeof pure.truncate('abcdefghij', 4) === 'string', 'truncate 应返回字符串')
  })

  add('client: __components 四个组件存在，字典 key 覆盖面板/决策/时间线', async () => {
    const { exports } = await loadClientBundle()
    const components = exports.__components
    for (const name of ['WorkbenchPanel', 'PMSessionBadge', 'PMComposerSummary', 'WorkbenchIcon']) {
      H.expectEqual(typeof components[name], 'function', '组件存在: ' + name)
    }
    const { zh } = exports.__dictionaries
    const text = Object.values(zh).join('\n')
    for (const keyword of ['项目', '决策', '时间线', '初始化', '阶段']) {
      H.expect(text.includes(keyword), '中文字典应覆盖关键词: ' + keyword)
    }
  })

  return cases
}

if (isNodeTest) {
  const cases = await makeSuite()
  for (const item of cases) test(item.name, item.fn)
} else if (H.isMain(import.meta.url)) {
  const cases = await makeSuite()
  const summary = await H.runCases('ui-client.test', cases)
  H.cleanupTracked()
  process.exitCode = H.summaryExitCode(summary)
}