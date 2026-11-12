window.__ModuleLoader__.load({
  id: '@local/poc-ui-probe',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function Panel() {
      return h('div', { style: { padding: 24, fontFamily: 'sans-serif' } },
        h('h1', { style: { fontSize: 20, margin: 0 } }, '项目面板 PoC'),
        h('p', null, '这是 PoC：验证插件主面板 + 侧栏入口 + 客户端 bundle 加载。'),
        h('p', null, '下一步验证：DB 数据通道 / PM 会话 / team 只读投影 / 树状驾驶舱。'))
    }
    function Icon({ size }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3, fill: '#247bbf' }))
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'poc-project-workbench',
          locale: undefined,
        }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'poc-project-workbench',
          order: 0,
          label: () => '项目 PoC',
        }, Icon))
      },
    }
  },
})
