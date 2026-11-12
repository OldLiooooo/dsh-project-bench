# Host 插件骨架（纯 Node 侧）

复制本目录为你的插件目录，然后改这几处：

1. `package.json` 的 `name`（本地开发用 `@local/xxx` + `"private": true`；发布 npm 时改成你自己的公开包名并去掉 `private`）。
2. `cordis.patch.yml` 的 `id` 与 `name`（`name` 必须等于包名）。
3. `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description`。
4. `icon.svg` 换成你自己的图标（SVG/PNG/JPEG/WebP，≤256 KiB）。

安装到 DSH（二选一）：

- Desktop 会话内：让 agent 用 `plugin_manager` → `install_bundle`，target 传本目录的绝对路径。
- 命令行（先退出 Desktop）：`dsh plugin --profile desktop add <本目录绝对路径>`，重开 Desktop 生效。

不安装、用独立 Web 实例调试 Host 逻辑：

```sh
dsh web --patch C:\Users\oldap\Documents\dsh-porject-bench\templates\host-bundle\dev-overlay.yml
```

`dev-overlay.yml` 里插件行用的是 `index.js` 的绝对路径，所以不依赖包安装；改完重启该实例。

发布前检查清单见 `../../docs/dsh-plugin-guide.zh.md` 第五章。
