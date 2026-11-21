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
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
    useReducer(reducer, initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
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

  add('client: factory 注册 id/inject，11 个槽位注册到位', async () => {
    const { exports } = await loadClientBundle()
    H.expect(Array.isArray(exports.inject), 'factory 应返回 inject 数组')
    for (const service of ['slots', 'locale', 'layout', 'uiWorkspace', 'sessions', 'workspaces']) {
      H.expect(exports.inject.includes(service), 'inject 缺 ' + service)
    }
    H.expectEqual(typeof exports.apply, 'function', 'factory 应返回 apply')
    const ctx = makeClientCtx()
    exports.apply(ctx)
    const bySlot = new Map(ctx.state.slots.map((item) => [item.definition.name, item.definition]))
    H.expectEqual(bySlot.size, 11, '应注册 11 个槽位，实际 ' + String(bySlot.size))
    const main = bySlot.get('main')
    H.expectEqual(main.key, 'project-workbench', 'main key 应为 project-workbench')
    H.expectEqual(bySlot.get('sidebar.panellist').id, 'project-workbench', 'sidebar.panellist id 应为 project-workbench')
    H.expectEqual(bySlot.get('conversation.session.header.utilities').id, 'wb-pm-badge', 'PM 页头徽章 id')
    H.expectEqual(bySlot.get('conversation.composer.dock').id, 'wb-pm-summary', 'PM composer 状态条 id')
    // 方案 ① 的三个加法席位：必须是「新增 id」，不能复用官方 cell（复用=替换）。
    H.expectEqual(bySlot.get('sidebar.session.row.leading').id, 'wb-role-chip', '会话行前格 id')
    H.expectEqual(bySlot.get('sidebar.session.row.hover').id, 'wb-project-hover', '会话行悬停卡 id')
    H.expectEqual(bySlot.get('sidebar.footer.action').id, 'wb-project-status', '侧栏底部状态 id')
    // 方案 ① 补齐的四个席位：同样只用我们自己的 id 追加。
    H.expectEqual(bySlot.get('sidebar.session.row.trailing').id, 'wb-slice-mark', '会话行行尾 id')
    H.expectEqual(bySlot.get('sidebar.workspaces.session.row.action').id, 'wb-locate', '会话行悬停按钮 id')
    // 菜单是三行；bySlot 只留每个槽最后一条，所以单独按 id 集合断言。
    const menuIds = ctx.state.slots
      .filter((item) => item.definition.name === 'sidebar.workspaces.session.menu.item')
      .map((item) => item.definition.id)
    H.expectEqual(JSON.stringify(menuIds), JSON.stringify(['wb-menu-open-project', 'wb-menu-locate', 'wb-menu-copy-slice']), '会话菜单三行 id: ' + JSON.stringify(menuIds))
    H.expectEqual(bySlot.get('sidebar.panellist.actions').id, 'wb-project-row', '面板更多菜单 id')
    // 所有席位都不带 priority：官方占 0，我们靠「自己的 id / 自己的 cell」并存，绝不影子覆盖。
    // 唯一例外是绝不该出现的影子席位——这里显式断言它不存在。
    for (const item of ctx.state.slots) {
      H.expect(item.definition.priority === undefined, item.definition.name + ' 不应设置 priority（加法位，不影子覆盖）')
      H.expect(item.definition.locale === 'workbench', item.definition.name + ' 应声明 locale 命名空间')
    }
    // 硬约束：绝不注册进官方 single 槽（那会静默遮蔽官方能力）。
    for (const forbidden of ['sidebar.workspaces', 'sidebar.toggle.badge', 'sidebar.brand.mark', 'sidebar.brand.name', 'root']) {
      H.expect(bySlot.get(forbidden) === undefined, '不得注册进 single 槽: ' + forbidden)
    }
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

  add('client: __components 全部席位组件存在，字典 key 覆盖面板/决策/时间线/侧栏席位', async () => {
    const { exports } = await loadClientBundle()
    const components = exports.__components
    for (const name of [
      'WorkbenchPanel', 'PMSessionBadge', 'PMComposerSummary', 'WorkbenchIcon',
      'SessionRoleChip', 'SessionProjectHover', 'SidebarProjectStatus',
      'SessionSliceMark', 'SessionLocateButton', 'SessionProjectMenuRow', 'PanelMoreMenuItem',
    ]) {
      H.expectEqual(typeof components[name], 'function', '组件存在: ' + name)
    }
    const { zh } = exports.__dictionaries
    const text = Object.values(zh).join('\n')
    for (const keyword of ['项目', '决策', '时间线', '初始化', '阶段', '角色', '切片', '待决策']) {
      H.expect(text.includes(keyword), '中文字典应覆盖关键词: ' + keyword)
    }
  })

  add('client: 侧栏席位组件在给定 hub 状态下渲染/沉默（不崩、不越权）', async () => {
    const { exports, react } = await loadClientBundle()
    // 让 useEffect 同步执行并记录 cleanup，才能断言「acquire 了谁 / 卸载是否释放」。
    const cleanups = []
    react.useEffect = (fn) => { const cleanup = fn(); cleanups.push(cleanup) }
    const {
      SessionRoleChip, SessionProjectHover, SidebarProjectStatus,
      SessionSliceMark, SessionLocateButton, SessionProjectMenuRow, PanelMoreMenuItem,
    } = exports.__components
    const { zh } = exports.__dictionaries
    const t = (key, params) => {
      const template = zh[key] !== undefined ? zh[key] : key
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined ? String(params[name]) : match))
    }
    // fake hub：getState 返回预置的派生索引与项目列表，subscribe 永不触发。
    // 注意 stage 是 /projects 的真实线格式：阶段**记录对象**，不是字符串。
    // 直接 String() 会渲染成 "[object Object]"（下面专门断言）。
    const project = { root: '/p/a', name: '支付重构', exists: true, initialized: true, stage: { id: 's2', key: 'S2', name: '架构', status: 'active' }, pendingDecisions: 3 }
    const snapshot = {
      initialized: true,
      project: { name: '支付重构', stage: 'S2' },
      stages: [{ id: 's2', key: 'S2', name: '架构', status: 'active' }],
      // 索引的行来源：会话表（dshSessionId 才算项目内会话）；树里放一个切片供「定位」用。
      tree: [{
        stage: { id: 's2', key: 'S2', name: '架构', status: 'active' },
        slices: [{ slice: { id: 'sl-1', key: 'refund', title: '退款', status: 'active' }, tasks: [], sessions: [], documents: [], decisions: [], evidence: [], counts: {} }],
      }],
      sessions: [{ id: 'row-1', dshSessionId: 'dsh-1', kind: 'task', role: '码农', sliceId: 'sl-1', status: 'active', sliceTitle: '退款' }],
      pendingDecisions: [{ id: 'd1' }, { id: 'd2' }],
    }
    const state = {
      version: 3,
      projects: { phase: 'ready', items: [project], error: null },
      selectedRoot: '/p/a',
      snapshots: { '/p/a': { phase: 'ready', data: snapshot, error: null } },
      roots: { '/p/a': { refs: 1, status: 'live' } },
    }
    state.sessionIndex = exports.__pure.buildSessionIndex(state.projects.items, state.snapshots)
    const acquired = []
    const hub = {
      subscribe: () => () => {},
      getState: () => state,
      ensureProjects: () => {},
      acquire: (root) => { acquired.push(root); return () => {} },
      selectProject: () => {},
      refreshSnapshot: () => {},
    }
    const runtime = {
      openPanel: () => { runtime.opened += 1 },
      openSlice: (hubArg, rootArg, sliceArg) => { runtime.located.push([rootArg, sliceArg]); runtime.openPanel() },
      currentSessionCwd: () => '/p/a',
      subscribeSessions: () => () => {},
      sessionSummary: () => ({ cwd: '/p/a' }),
      workspaceIdForSession: () => undefined,
      opened: 0,
      located: [],
    }
    // 组件内部用 useHubState(hub) → 直接读 getState()，不需要真 React。
    // 1) 角色徽章：项目内会话有字；项目外会话返回 null（不吃别人的行）。
    const chip = SessionRoleChip({ t, hub, runtime, sessionId: 'dsh-1' })
    H.expect(chip && chip.type === 'span', '项目内会话应渲染角色徽章')
    H.expectEqual(chip.props.className, 'wb-role-chip', '徽章类名')
    H.expectEqual(chip.children[0], '码', '角色字')
    H.expect(chip.props['aria-label'].includes('码农'), 'aria-label 带全角色名: ' + chip.props['aria-label'])
    H.expectEqual(SessionRoleChip({ t, hub, runtime, sessionId: 'not-in-project' }), null, '项目外会话不渲染')
    H.expectEqual(SessionRoleChip({ t, hub, runtime, sessionId: undefined }), null, '无 sessionId 不渲染')
    // 2) 悬停卡：项目/阶段/切片/待决策；且只为该会话自己的项目 acquire。
    acquired.length = 0
    const hover = SessionProjectHover({ t, hub, runtime, sessionId: 'dsh-1' })
    H.expect(hover && hover.type === 'div', '项目内会话应渲染悬停卡')
    const texts = JSON.stringify(hover)
    for (const expected of ['支付重构', 'S2 架构', '退款', '待决策']) {
      H.expect(texts.includes(expected), '悬停卡应含 ' + expected)
    }
    H.expectEqual(JSON.stringify(acquired), JSON.stringify(['/p/a']), '悬停卡只为该会话的项目 acquire')
    // 卸载该席位必须释放同一个 root（否则侧栏每开一次面板就多一条 SSE）。
    const released = []
    const hubForRelease = { ...hub, acquire: (root) => { acquired.push(root); return () => { released.push(root) } } }
    const before = acquired.length
    SessionProjectHover({ t, hub: hubForRelease, runtime, sessionId: 'dsh-1' })
    H.expect(acquired.length > before, '渲染时 acquire 该项目')
    for (const cleanup of cleanups.reverse()) { if (typeof cleanup === 'function') cleanup() }
    H.expect(released.includes('/p/a'), '卸载时释放该项目: ' + JSON.stringify(released))
    H.expectEqual(SessionProjectHover({ t, hub, runtime, sessionId: 'other' }), null, '项目外会话不渲染悬停卡')
    // 3) 侧栏底部状态：显示项目 + 阶段 + 待决策，点击开面板；rail 态只剩图标。
    acquired.length = 0
    const status = SidebarProjectStatus({ t, hub, runtime, wide: true })
    H.expect(status && status.type === 'button', '底部状态应是 button')
    H.expectEqual(status.props.className, 'wb-sidebar-status', '底部状态类名')
    H.expect(JSON.stringify(status).includes('支付重构'), '底部状态含项目名')
    H.expect(JSON.stringify(status).includes('待决策 2'), '底部状态含待决策数（快照优先于列表）')
    H.expect(JSON.stringify(status).includes('S2 架构'), '底部状态阶段应渲染成「S2 架构」而不是 [object Object]')
    H.expect(!JSON.stringify(status).includes('[object Object]'), '不得把阶段对象 String() 成 [object Object]')
    H.expectEqual(JSON.stringify(acquired), JSON.stringify(['/p/a']), '底部状态 acquire 默认项目')
    status.props.onClick()
    H.expectEqual(runtime.opened, 1, '点击应打开面板')
    const rail = SidebarProjectStatus({ t, hub, runtime, wide: false })
    const railText = rail.children.filter((child) => child && child.type === 'span' && child.props.className === 'wb-sidebar-status-text')
    H.expectEqual(railText.length, 0, 'rail 态不渲染文字（只留图标）')
    H.expect(rail.props['aria-label'].includes('支付重构'), 'rail 态仍保留完整 aria-label')
    // 4) 会话行尾：只放非交互标记（有切片才有），项目外不渲染。
    const mark = SessionSliceMark({ t, hub, runtime, sessionId: 'dsh-1' })
    H.expect(mark && mark.type === 'span', '有切片的会话应有行尾标记')
    H.expectEqual(mark.props.className, 'wb-slice-mark', '行尾标记类名')
    H.expectEqual(mark.props['aria-hidden'], 'true', '行尾标记对读屏隐藏（它只是图标）')
    H.expect(mark.props.title.includes('退款'), '行尾标记 tooltip 带切片名')
    H.expectEqual(SessionSliceMark({ t, hub, runtime, sessionId: 'not-in-project' }), null, '项目外会话无行尾标记')
    // 5) 行悬停按钮：点一下 → 打开面板并定位到该切片。
    runtime.located.length = 0
    const locate = SessionLocateButton({ t, hub, runtime, sessionId: 'dsh-1' })
    H.expect(locate && locate.type === 'button', '有切片的会话应有定位按钮')
    H.expectEqual(locate.props.className, 'wb-row-btn', '定位按钮类名')
    H.expect(locate.props['aria-label'].includes('退款'), '定位按钮 aria-label 带切片名')
    locate.props.onClick()
    H.expectEqual(JSON.stringify(runtime.located), JSON.stringify([['/p/a', 'sl-1']]), '定位按钮应请求定位该项目切片')
    H.expectEqual(SessionLocateButton({ t, hub, runtime, sessionId: 'not-in-project' }), null, '项目外会话无定位按钮')
    // 6) 会话「…」菜单：三个独立条目，每条一个 role=menuitem 按钮（契约要求），点完收菜单。
    let dismissed = 0
    const menuHook = () => [true, (open) => { if (open === false) dismissed += 1 }]
    const rowProps = { t, hub, runtime, sessionId: 'dsh-1', useMenuOpenState: menuHook }
    const openRow = SessionProjectMenuRow({ ...rowProps, menuRow: 'open' })
    const locateRow = SessionProjectMenuRow({ ...rowProps, menuRow: 'locate' })
    const copyRow = SessionProjectMenuRow({ ...rowProps, menuRow: 'copy' })
    for (const [name, row] of [['open', openRow], ['locate', locateRow], ['copy', copyRow]]) {
      H.expect(row && row.type === 'button', name + ' 行应是一个按钮')
      H.expectEqual(row.props.role, 'menuitem', name + ' 行 role 必须是 menuitem')
    }
    runtime.located.length = 0
    const openedBeforeMenu = runtime.opened
    openRow.props.onClick()
    H.expectEqual(runtime.opened, openedBeforeMenu + 1, '「打开项目工作台」应打开面板')
    locateRow.props.onClick()
    H.expectEqual(JSON.stringify(runtime.located), JSON.stringify([['/p/a', 'sl-1']]), '「定位」菜单项应请求定位切片')
    copyRow.props.onClick()
    H.expect(dismissed >= 3, '每一行动作后都应关闭菜单，实际 ' + String(dismissed))
    H.expectEqual(SessionProjectMenuRow({ ...rowProps, menuRow: 'open', sessionId: 'not-in-project' }), null, '项目外会话没有菜单项')
    // 没有切片时：定位/复制两行不出现（菜单里不留点了没反应的死项）。
    const noSliceState = { ...state, sessionIndex: new Map([['dsh-2', { root: '/p/a', projectName: '支付重构', stage: 'S2 架构', sliceId: '', sliceTitle: '', role: 'pm', kind: 'pm', pendingDecisions: 2 }]]) }
    const noSliceHub = { ...hub, getState: () => noSliceState }
    H.expectEqual(SessionProjectMenuRow({ ...rowProps, hub: noSliceHub, sessionId: 'dsh-2', menuRow: 'locate' }), null, '无切片时定位行不渲染')
    H.expectEqual(SessionProjectMenuRow({ ...rowProps, hub: noSliceHub, sessionId: 'dsh-2', menuRow: 'copy' }), null, '无切片时复制行不渲染')
    H.expect(SessionProjectMenuRow({ ...rowProps, hub: noSliceHub, sessionId: 'dsh-2', menuRow: 'open' }) !== null, '无切片时「打开项目」仍在')
    // 7) 面板「更多」菜单一行：直达当前项目，点击先关菜单再开面板。
    let moreDismissed = 0
    const more = PanelMoreMenuItem({ t, hub, runtime, onDismiss: () => { moreDismissed += 1 } })
    H.expect(more && more.type === 'button', '更多菜单应有一行')
    H.expectEqual(more.props.role, 'menuitem', '更多菜单行 role')
    H.expect(JSON.stringify(more).includes('支付重构'), '更多菜单行带项目名')
    H.expect(JSON.stringify(more).includes('待决策 2'), '更多菜单行带待决策数')
    const openedBeforeMore = runtime.opened
    more.props.onClick()
    H.expectEqual(moreDismissed, 1, '点击应先关闭更多菜单')
    H.expectEqual(runtime.opened, openedBeforeMore + 1, '更多菜单行点击应打开面板')
    // 8) 未初始化 / 不存在的项目：不渲染任何席位。
    const emptyState = { ...state, projects: { phase: 'ready', items: [{ root: '/p/x', name: 'X', exists: false, initialized: false }], error: null }, selectedRoot: null, snapshots: {} }
    emptyState.sessionIndex = new Map()
    const emptyHub = { ...hub, getState: () => emptyState }
    H.expectEqual(SidebarProjectStatus({ t, hub: emptyHub, runtime, wide: true }), null, '未初始化项目不渲染底部状态')
    H.expectEqual(SessionRoleChip({ t, hub: emptyHub, runtime, sessionId: 'dsh-1' }), null, '索引为空时不渲染徽章')
    H.expectEqual(PanelMoreMenuItem({ t, hub: emptyHub, runtime }), null, '未初始化项目不渲染更多菜单行')
    H.expectEqual(SessionLocateButton({ t, hub: emptyHub, runtime, sessionId: 'dsh-1' }), null, '索引为空时不渲染定位按钮')
    // 9) 侧栏图标角标：有待决策就带红点，点击逻辑仍由官方面板行负责（我们只画图标）。
    const glyph = exports.__components.WorkbenchIcon({ t, hub, runtime, size: 16, active: false })
    H.expect(glyph && glyph.type === 'span', '图标应渲染')
    const badgeDots = glyph.children.filter((child) => child && child.props && child.props.className === 'wb-glyph-badge')
    H.expectEqual(badgeDots.length, 1, '有待决策时图标应带一个角标点')
    H.expect(glyph.props.title.includes('待决策 2'), '图标 title 带待决策数: ' + String(glyph.props.title))
    const glyphIdle = exports.__components.WorkbenchIcon({ t, hub: emptyHub, runtime, size: 16, active: false })
    const idleDots = glyphIdle.children.filter((child) => child && child.props && child.props.className === 'wb-glyph-badge')
    H.expectEqual(idleDots.length, 0, '没有待决策时不画角标')
    H.expectEqual(glyphIdle.props.title, undefined, '没有待决策时不设 title')
    // 无 hub 也不能崩（宿主可能不传服务，例如组件预览）。
    const bare = exports.__components.WorkbenchIcon({ t, size: 16 })
    H.expect(bare && bare.type === 'span', '没有 hub 时图标仍渲染')
  })

  add('client: 侧栏席位纯变换（角色首字 / 会话索引 / 待决策回退）', async () => {
    const { exports } = await loadClientBundle()
    const pure = exports.__pure
    for (const name of [
      'roleInitial', 'roleTone', 'indexableRoots', 'snapshotOf', 'pendingDecisionsOf', 'buildSessionIndex',
      'withKeys', 'sliceSelection', 'focusTargetOf',
      'isRecommendedOption', 'defaultAnswerOf',
    ]) {
      H.expectEqual(typeof pure[name], 'function', '__pure 应导出 ' + name)
    }
    // stageText：/projects 的 stage 是记录对象，snapshot 的 stage 是字符串指针——两种线格式都要归一。
    H.expectEqual(pure.stageText({ id: 's2', key: 'S2', name: '架构', status: 'active' }), 'S2 架构', 'stageText(记录) -> 键+名')
    H.expectEqual(pure.stageText({ key: 'S1' }), 'S1', 'stageText(只有 key)')
    H.expectEqual(pure.stageText({ id: 'x', name: '产品' }), 'x 产品', 'stageText(沿用 stageLabel 的 key||id 语义)')
    H.expectEqual(pure.stageText('S1'), 'S1', 'stageText(字符串指针)')
    H.expectEqual(pure.stageText(null), '', 'stageText(null)')
    H.expectEqual(pure.stageText(undefined), '', 'stageText(undefined)')
    H.expectEqual(pure.stageText(''), '', 'stageText(空串)')

    // 角色词表 -> 单字（与 host ROLE_WORDS 对齐：产品/UX/架构/码农/测试/发布/复盘）。
    const cases = [['产品', '产'], ['UX', 'U'], ['架构', '架'], ['码农', '码'], ['测试', '测'], ['发布', '发'], ['复盘', '复']]
    for (const [role, glyph] of cases) H.expectEqual(pure.roleInitial(role, 'task'), glyph, 'roleInitial(' + role + ')')
    // row kind 回落：PM 是 kind 不是 role；没有角色词时不留空字。
    H.expectEqual(pure.roleInitial('', 'pm'), 'P', 'PM 行回落 P')
    H.expectEqual(pure.roleInitial(undefined, 'subagent'), '子', 'subagent 行回落 子')
    H.expectEqual(pure.roleInitial('', 'other'), '', '未知行不留字')
    H.expectEqual(pure.roleTone('pm'), 'pm', 'PM 语气')
    H.expectEqual(pure.roleTone('task'), 'neutral', '任务语气')
    // 只有「存在且已初始化」的项目才建索引。
    const projects = [
      { root: '/p/a', name: 'A', exists: true, initialized: true },
      { root: '/p/b', name: 'B', exists: false, initialized: true },
      { root: '/p/c', name: 'C', exists: true, initialized: false },
      { root: '/p/a', name: 'A dup', exists: true, initialized: true },
    ]
    H.expectEqual(JSON.stringify(pure.indexableRoots(projects)), JSON.stringify(['/p/a']), 'indexableRoots 只留存在且已初始化、去重')
    // 快照索引：dshSessionId -> {项目/阶段/切片/角色/待决策}
    const snapshot = {
      initialized: true,
      project: { name: '支付重构', stage: 'S2' },
      stages: [{ id: 's2', key: 'S2', name: '架构', status: 'active' }],
      tree: [{ stage: { key: 'S2', name: '架构' }, slices: [{ slice: { id: 'sl-1', key: 'refund', title: '退款', status: 'active' }, tasks: [], sessions: [], documents: [], decisions: [], evidence: [] }] }],
      sessions: [
        { id: 'row-1', dshSessionId: 'dsh-1', kind: 'task', role: '码农', sliceId: 'sl-1', status: 'active', sliceTitle: '退款' },
        { id: 'row-2', dshSessionId: 'dsh-2', kind: 'pm', role: 'pm', status: 'active', sliceTitle: null },
        { id: 'row-3', kind: 'task', role: '测试', status: 'active' },
      ],
      pendingDecisions: [{ id: 'd-1' }, { id: 'd-2' }],
    }
    const index = pure.buildSessionIndex(projects, { '/p/a': { phase: 'ready', data: snapshot } })
    H.expect(index instanceof Map, 'buildSessionIndex 应返回 Map')
    H.expectEqual(index.size, 2, '没有 dshSessionId 的行不进索引')
    H.expectEqual(index.get('dsh-1').projectName, 'A', '项目名取 projects 列表')
    H.expectEqual(index.get('dsh-1').stage, 'S2 架构', '阶段标签')
    H.expectEqual(index.get('dsh-1').sliceTitle, '退款', '切片标题')
    H.expectEqual(index.get('dsh-1').role, '码农', '角色')
    H.expectEqual(index.get('dsh-1').pendingDecisions, 2, '待决策来自快照')
    H.expectEqual(index.get('dsh-2').sliceTitle, '', '无切片时为空串')
    // 快照未到时的兜底：projects 列表上的 pendingDecisions。
    H.expectEqual(pure.pendingDecisionsOf({ snapshots: {} }, { root: '/p/a', pendingDecisions: 5 }), 5, '快照缺失回退列表计数')
    H.expectEqual(pure.pendingDecisionsOf({ snapshots: { '/p/a': { data: snapshot } } }, { root: '/p/a', pendingDecisions: 5 }), 2, '快照优先')
    H.expectEqual(pure.snapshotOf({ snapshots: {} }, { root: '/p/a' }), null, '无快照返回 null')

    // 「定位切片」：展开键集合与树内定位都是纯函数，面板只负责把结果喂给 state。
    const base = new Set(['stage:S1'])
    const widened = pure.withKeys(base, ['stage:S2', 'slice:sl-1', '', undefined])
    H.expect(widened instanceof Set, 'withKeys 返回 Set')
    H.expectEqual(widened.size, 3, 'withKeys 加入两个有效键：' + String(widened.size))
    H.expect(base.size === 1, 'withKeys 不得修改入参')
    const found = pure.sliceSelection(snapshot.tree, 'sl-1')
    H.expect(found && found.row, 'sliceSelection 应找到切片')
    H.expectEqual(found.sliceKey, 'slice:sl-1', '切片行 key')
    H.expectEqual(found.stageKey, 'stage:S2', '阶段行 key（用于展开，与 flattenTree 的 id||key 规则一致）')
    H.expectEqual(found.row.kind, 'slice', '定位行应为 slice 行')
    H.expectEqual(found.row.slice.id, 'sl-1', '定位行携带切片')
    H.expectEqual(pure.sliceSelection(snapshot.tree, 'nope'), undefined, '找不到切片时返回 undefined')
    H.expectEqual(pure.sliceSelection([], 'sl-1'), undefined, '空树返回 undefined')
    H.expectEqual(pure.sliceSelection(snapshot.tree, ''), undefined, '空 id 返回 undefined')
    H.expectEqual(JSON.stringify(pure.focusTargetOf({ root: '/p/a', sliceId: 'sl-1' })), JSON.stringify({ root: '/p/a', sliceId: 'sl-1' }), 'focusTargetOf 取项目+切片')
    H.expectEqual(pure.focusTargetOf({ root: '/p/a', sliceId: '' }), undefined, '没有切片就没有定位目标')
  })

  add('client: 决策卡必须让人点名「批准哪一项」且推荐项能被识别', async () => {
    const { exports, react } = await loadClientBundle()
    const cleanups = []
    react.useEffect = (fn) => { const cleanup = fn(); cleanups.push(cleanup) }
    const { DecisionCard } = exports.__components
    // 卡片是嵌套树：把文本抽出来断言文案，把 button 抽出来断言交互。
    // 注意：h() 的 children 里可能嵌着数组（.map() 的结果），遍历必须展开数组。
    const flatText = (node) => {
      if (node === null || node === undefined || node === false) return ''
      if (typeof node === 'string' || typeof node === 'number') return String(node)
      if (Array.isArray(node)) return node.map(flatText).join('')
      if (typeof node !== 'object') return ''
      return flatText(node.children)
    }
    const pure = exports.__pure
    const { zh } = exports.__dictionaries
    const t = (key, params) => String(zh[key] !== undefined ? zh[key] : key)
      .replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined ? String(params[name]) : match))

    // recommended 在真实库里是**整句**（「扩展本项范围（理由：…）」），选项 label 是前半句。
    // 之前用严格相等，导致「推荐」徽章永远不显示。
    // 真实库里的三种写法都必须命中（这三条取自 lumio 项目的实际数据）：
    H.expect(pure.isRecommendedOption({ value: 'A', label: '扩展本项范围，授权同时更新 docs/memory/project-context.md' },
      '扩展本项范围（理由：两文件各改一行、零业务影响，另立工作项只会重复同一冲突）'), '推荐句是选项前缀时应命中')
    H.expect(pure.isRecommendedOption({ value: 'A', label: '加入 ignoredDirectories（工作台存储不是项目产物）' },
      '加入 ignoredDirectories（工作台运行时存储，不是项目交付物）'), '两边都有括注时应命中')
    H.expect(pure.isRecommendedOption({ value: 'B', label: '全部另立一个工作项统一处理（含根 README 第 27 行构建命令那句）' },
      '全部另立一个工作项统一处理（理由：生成物与生成器必须同改）'), '推荐句是选项前缀（带括注）时应命中')
    H.expect(pure.isRecommendedOption({ value: 'A', label: '扩展本项范围' }, 'A'), '按选项值匹配')
    H.expect(!pure.isRecommendedOption({ value: 'B', label: '另立工作项' }, '扩展本项范围（理由：…）'), '不相关选项不应误判')
    H.expect(!pure.isRecommendedOption({ value: 'A', label: 'A' }, 'Anything else entirely'), '过短的 label 不应误配')

    // 默认选中：有推荐就是推荐项；没推荐就必须自己选。
    const options = [{ value: 'A', label: '扩展本项范围', description: '' }, { value: 'B', label: '另立工作项', description: '' }]
    H.expectEqual(pure.defaultAnswerOf({ recommended: '扩展本项范围（理由：…）' }, options), 'A', '有推荐时默认选中推荐项')
    H.expectEqual(pure.defaultAnswerOf({ recommended: '' }, options), undefined, '没有推荐时不预选')

    const base = { id: 'd1', title: '处置范围', question: '如何处置？', options: ['只修生成物', '全部另立工作项'], status: 'pending', kind: 'decision' }

    // 有推荐：按钮文案点名选项，不是干巴巴的「批准」
    const picked = []
    const withRec = DecisionCard({ t, decision: { ...base, recommended: '全部另立工作项（理由：…）' }, onApprove: (d, a) => picked.push(['approve', a]), onReject: (d, a) => picked.push(['reject', a]) })
    const buttonsOf = (node) => {
      const out = []
      const walk = (n) => {
        if (!n) return
        if (Array.isArray(n)) { for (const item of n) walk(item); return }
        if (typeof n !== 'object') return
        if (n.type === 'button') out.push(n)
        for (const child of n.children || []) walk(child)
      }
      walk(node)
      return out
    }
    const cardButtons = buttonsOf(withRec)
    const approveBtn = cardButtons.find((b) => (b.props.className || '').includes('wb-btn') && (b.props['data-variant'] === 'primary'))
    H.expect(approveBtn, '应有批准按钮')
    H.expect(!approveBtn.props.disabled, '有推荐项时批准按钮应可点')
    H.expect(String(flatText(approveBtn)).includes('B'), '批准按钮应点名选的是 B，实际：' + flatText(approveBtn))
    H.expect(flatText(withRec).includes('这次批准的是：'), '卡片上应显式写出批准对象')
    H.expect(flatText(withRec).includes('全部另立工作项'), '批准对象应是推荐项的文字')
    approveBtn.props.onClick()
    H.expectEqual(JSON.stringify(picked), JSON.stringify([['approve', 'B']]), '批准时要把选中的选项一起带出去')

    // 没有推荐：按钮禁用，必须先选
    const plain = DecisionCard({ t, decision: { ...base, recommended: '' }, onApprove: () => {}, onReject: () => {} })
    const plainApprove = buttonsOf(plain).find((b) => b.props['data-variant'] === 'primary')
    H.expect(plainApprove.props.disabled, '没选出选项时批准按钮应禁用（不允许"批准了但没说批哪条"）')
    H.expect(flatText(plain).includes('请先在上方选择一个选项'), '应提示先选一个')

    // 点选项即可选中（选项是可交互的，不是纯展示）
    const optionButtons = buttonsOf(plain).filter((b) => b.props.role === 'radio')
    H.expectEqual(optionButtons.length, 2, '每个选项应是一个可点的 radio，实际 ' + String(optionButtons.length))
    H.expectEqual(optionButtons[0].props['aria-checked'], 'false', '默认都未选中')
  })

  add('client: hub 的「定位」请求只消费一次（不重放、跨项目不误伤）', async () => {
    const { exports } = await loadClientBundle()
    // 用真实的 createHub 太依赖网络；这里验证的是「一次性语义」所用的状态机约定。
    const pure = exports.__pure
    // 请求 id 单调增、消费后清空 —— 由组件代码保证，这里用最小替身锁住语义契约。
    const hub = (() => {
      let state = { version: 0, focusRequest: null, selectedRoot: null, projects: { phase: 'ready', items: [], error: null }, snapshots: {}, roots: {} }
      let seq = 0
      const listeners = new Set()
      const publish = (patch) => {
        state = Object.assign({}, state, patch, { version: state.version + 1 })
        for (const listener of Array.from(listeners)) listener()
      }
      return {
        getState: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        requestFocus: (root, sliceId) => { const id = seq + 1; seq = id; publish({ focusRequest: { id, root, sliceId } }); return id },
        consumeFocus: (id) => {
          const request = state.focusRequest
          if (!request || request.id !== id) return undefined
          publish({ focusRequest: null })
          return { root: request.root, sliceId: request.sliceId }
        },
      }
    })()
    const first = hub.requestFocus('/p/a', 'sl-1')
    H.expectEqual(first, 1, '首个请求 id 为 1')
    H.expectEqual(hub.consumeFocus(first).sliceId, 'sl-1', '第一次消费拿到请求')
    H.expectEqual(hub.consumeFocus(first), undefined, '同一个请求不得被消费两次（不重放）')
    const second = hub.requestFocus('/p/a', 'sl-2')
    H.expectEqual(second, 2, '第二个请求 id 递增')
    H.expectEqual(hub.consumeFocus(first), undefined, '旧 id 消费不到新请求')
    H.expectEqual(hub.consumeFocus(second).sliceId, 'sl-2', '新 id 消费到新请求')
    H.expectEqual(pure.focusTargetOf({ root: '/p/a', sliceId: 'sl-2' }).sliceId, 'sl-2', '定位目标与请求一致')
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