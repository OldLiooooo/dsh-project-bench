# 平台能力 PoC 报告（SQLite / 插件 / Web UI / Codex）

> 2026-11-11 · 实测，不是设计提案。
> 目的：在一次性实现前，验证目标架构依赖的平台能力与风险（用户要求「去试试」）。
> 环境：DSH Desktop 运行版 0.2.2-rc.1；checkout 0.2.1-rc.2 作对照；Windows。

---

## 0. 结论表

| # | 能力 | 结果 | 证据 |
|---|---|---|---|
| 1 | Host 插件内使用 SQLite（node:sqlite） | ✅ 通过 | 独立 Web 实例加载 PoC Host 插件，建库/WAL/FTS5 trigram/读写全部成功，SQLite 3.53.4 |
| 2 | 插件以本地路径安装进 profile | ✅ 通过 | dsh plugin --profile web add <本地 bundle> 成功（pnpm link），bundle 出现在 profile bundles |
| 3 | 独立 Web 实例启动 + 鉴权 | ✅ 通过 | dsh web --no-open --port 51999 启动；/?token= 返回 303 + Set-Cookie，带 cookie 200 |
| 4 | Client 插件 bundle 被 Web 应用加载 | ✅ 已确认（服务端） | 页面预加载列表包含 @local/poc-ui-probe/client.js；bundle 由 profile 提供 |
| 5 | 主面板/侧栏真实渲染 | ⚠️ 未目测 | 本机无 Playwright/puppeteer/jsdom；Edge 无头被沙箱拒绝（crashpad/mojo 访问被拒） |
| 6 | 自定义 Web 数据路由（ctx.webServer.register） | ✅ 通过，但发现安全问题 | GET /poc/probe 返回 DB 数据；**不带 cookie 也返回 200**——自定义路由必须自行做鉴权 |
| 7 | 任务会话（teammate）调用 Codex 子智能体 | ✅ 通过 | teammate 调 subagent_codex，Codex 返回「任务会话可用。」并回传 |
| 8 | DSH「内置浏览器」 | ⚠️ 存在但未启用 | packages/browser-use 提供浏览器提供方框架 + 实验性 Playwright MCP / Chrome DevTools MCP / Stagehand；当前 profile 未挂载，无浏览器工具可用 |

---

## 1. 怎么测的（可复现）

### 1.1 独立 PoC 实例

```text
DSH_HOME=<workspace>/.dsh-poc
dsh --profile web --patch poc/dev-overlay.yml --no-open --port 51999
```

- PoC Host 插件：poc/host-probe/index.js（dev overlay 以绝对路径挂载）。
- PoC Client 插件：poc/ui-probe/（package.json 声明 dsh.client + bundle，本地路径安装进 profile）。
- 产物：.poc/host-probe.json、.poc/probe.db、.poc/page.html（页面 HTML）。

### 1.2 Host 插件里的 SQLite

插件 apply() 内直接：

```js
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(join(root, '.poc/probe.db'))
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE ...; CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='trigram');")
```

结果：SQLite 3.53.4；插入/查询成功；trigram FTS 命中 1；插件卸载/重启后数据保留。**结论：目标架构的 DB 层可以用 node:sqlite 在 Host 插件内直接实现，不需要外部数据库。**

### 1.3 自定义 Web 路由

```js
export const inject = ['webServer']
ctx.effect(() => ctx.webServer.register({
  kind: 'exact', path: '/poc/probe',
  handler: async (_req, res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(...)) },
}))
```

带 cookie 请求返回 DB 行；**不带 cookie 也返回 200**（因为 PoC handler 没做请求拒绝检查）。正式实现必须用 ctx.connection 的 requestRejection（参考 host/open-in-app）或在 Host 内部只暴露给已鉴权的 Remote/projection，不能裸挂自定义路由。

### 1.4 Client 插件

- package.json 声明 dsh.manifestVersion / dsh.bundle.patch / dsh.client（platform web, immediately）。
- client.js 用 window.__ModuleLoader__.load 注册 main + sidebar.panellist。
- 安装后重启 PoC Web 实例，页面 HTML 的 script preload 列表出现 @local/poc-ui-probe/client.js，证明 Client bundle 已被组合进页面。
- 未能截图/看 DOM：本机没有 headless 浏览器依赖；Edge 无头在 workspace 沙箱里因 crashpad/mojo「拒绝访问」失败（不是页面问题）。

### 1.5 Codex 子智能体

- 由现有 teammate（任务会话）调用 subagent_codex；调用返回 activation id；完成后运行时通知携带最终答复：「任务会话可用。」
- 限定：一次性、不能追问、只回最终答案（与 README 一致）；结果能回传。

---

## 2. 风险与待补

| 风险/缺口 | 状态 | 下一步 |
|---|---|---|
| Client 面板真实渲染未目测 | 未验证 | 用户浏览器打开 PoC URL 目测；或启用 DSH browser-use 提供方后用浏览器工具验证 |
| 自定义 Web 路由绕过鉴权 | 已发现 | 正式实现一律用 requestRejection 或只走 Remote/projection；安全负向测试 |
| 0.2.2 运行版与 0.2.1 源码差异 | 部分验证 | 客户端 slot 细节以运行版为准；实现前用 dsh web PoC 再核对 |
| DSH「内置浏览器」 | 未启用 | 如需自动验证，启用 experimental browser provider（Playwright MCP / Chrome DevTools MCP / Stagehand） |
| PoC 实例 | 临时 | 端口 51999 / .dsh-poc / .poc 仅用于验证，验证完可删 |

---

## 3. 直接结论

1. **SQLite 没问题**：Host 插件内 node:sqlite 可直接用，DB 层无需外部服务。
2. **插件链路没问题**：本地 bundle 安装、Host 插件加载、Web 实例启动、Client bundle 组合进页面，全部走通。
3. **Codex 没问题**：任务会话能发起 subagent_codex 并拿到最终答案。
4. **UI 渲染差最后一眼**：不是能力问题，是本机沙箱里跑不了无头浏览器；用户打开临时 PoC 实例即可目测（面板 + 侧栏入口）。
5. **安全注意**：自定义 webServer 路由默认不鉴权，正式实现必须补。
