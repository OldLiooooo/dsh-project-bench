// 浏览器端模块：通过 __ModuleLoader__ 注册惰性工厂。
// 工厂 id 必须等于 package.json 的包名，React 从浏览器模块表 require，无需自带 React。
// 工厂函数保持无副作用；注册的资源和清理都放在 apply 里。
window.__ModuleLoader__.load({
  id: '@local/my-decoration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    function Decoration() {
      return h('svg', {
        viewBox: '0 0 64 64',
        width: 48,
        height: 48,
        'aria-hidden': true,
        style: { display: 'block', pointerEvents: 'none' },
      }, h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
    }

    return {
      // 先用 cordis_inspect_query 的 Slots.listSubTree 选一个已有空间的 slot，
      // 再按该 slot 的注册选项和 props 调整下面注册。
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'my-decoration',
          order: 5,
        }, Decoration));
      },
    };
  },
});
