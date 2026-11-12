# Web UI 插件骨架（输入框装饰）

来源：DSH 官方 skill `cordis-plugin-development` 的 `templates/decoration`，补了中文 locale。

复制本目录为你的插件目录，然后改这几处：

1. `package.json` 的 `name`（本地开发用 `@local/xxx` + `"private": true`）。
2. **`client.js` 里 `__ModuleLoader__.load({ id: ... })` 的 id 必须等于包名。**
3. `cordis.patch.yml` 的 `id` 与 `name`。
4. `locale/en.json`、`locale/zh.json` 的标题/描述。
5. 图标换成你自己的（≤256 KiB，包内相对路径）。
6. 想放别的 slot 时，先用 `cordis_inspect_query` 查 `Slots.listSubTree` 和该 slot 的注册选项/props，不要凭猜测写 `name`。

安装：让 agent 用 `plugin_manager` → `install_bundle` 安装本目录绝对路径（会写 `desktop` profile，影响所有会话）。
装好后在页面里看到装饰；改代码后按环境需要刷新页面或重启 Desktop。

UI 规则（详细版见 `../../docs/dsh-plugin-guide.zh.md` 3.3 节）：

- 只用 slot 贡献 UI；不 iframe、不替换 app root、不往 `document.body` 追加节点。
- 主题只用 `--dsw-alias-*` token，不要写死颜色（插画除外）。
- 不 `require` 任何 `@deepseek-ai/dsh-client-*` 包；需要控件就照宿主样式自己写。
- 工厂无副作用；资源注册放在 `apply` 里并用 `ctx.effect` / `ctx.on` 返回清理。
