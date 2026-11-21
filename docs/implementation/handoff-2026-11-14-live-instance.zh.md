# 交接：真实 DSH 实例跑通（Round 2）

> 2026-11-14 第五批 · 目标 ①：**插件在真实环境跑通**。
> 前四批见 [M0 权威源外移](handoff-2026-11-14-m0-external-store.zh.md) 等。

---

## 1. 为什么要绕开 CLI

本机 `ops_bash` 全量 `EXECUTOR_UNAVAILABLE`（niubash 硬链接池），`child_process.spawn` 全量 `EPERM`。
`dev-instance.mjs` 走 `spawn(exe, ['--expose-internals', cli, '--profile', 'web', ...])` → **起不来**。
上一轮 52999 实例 `ECONNREFUSED` 就是这么来的。

**但 DSH 本身是可编程的**：`profile-boot` 的 `runProfile()` 能在当前进程内组装并启动一个真实 web profile。
这不是 mock：真服务、真路由、真鉴权、真插件加载。只是省掉了「另起一个 OS 进程」。

## 2. 踩通的四个技术障碍（每个都花了实打实的时间）

| # | 障碍 | 表现 | 解法 |
|---|---|---|---|
| 1 | 原生扩展解析失败 | `No usable native binding found for node-addon-require-builtin-win32-x64-msvc` | PTC 进程 `process.env` 是空的 → `TEMP` 未定义 → 原生缓存目录解析成 `undefined\temp\...`。补 `TEMP/TMP/LOCALAPPDATA/APPDATA/USERPROFILE/HOME` |
| 2 | 原生缓存不可写 | 缓存目录落在系统 temp | 显式 `NARB_NATIVE_CACHE_DIR` 指到工作区 |
| 3 | argv 重复注入 | `error: unknown option '--profile'` | `runProfile({ profile })` 已经指定 profile，`args` 只传 web 自己的旗标（`--no-open --port N`） |
| 4 | 插件没加载 | 工具 0 个、面板 API 404 | `runProfile` 首启会用内置 web 模板（只有 base + web-app）。必须先写 `profile/package.json` 的 `dsh.profile.bundles` + 软链 `node_modules/@local/dsh-project-workbench` |

## 3. 新增测试：`live-inprocess-instance.mjs`（**15/15**）

[workbench/tests/e2e/live-inprocess-instance.mjs](../workbench/tests/e2e/live-inprocess-instance.mjs)
日志：[.artifacts/live-inprocess-instance.log](../.artifacts/live-inprocess-instance.log)

```text
PASS ① 真实 web profile 在进程内启动  — 2070ms on :53120
PASS ②a 工作区已登记进 workspaceRegistry（HTTP 通道准入前提）
PASS ② 核心服务就位  — all present（webServer/connection/workspaceRegistry/tools/sessions/agents/subagents/systemPrompt/skills）
PASS ③ 插件工具注册进真实 tools 服务  — 25 个
PASS ④ 取得实例 launch token
PASS ⑤ token 换 cookie（303 + Set-Cookie）
PASS ⑥ 无 cookie 首页 → 401（鉴权真生效）
PASS ⑦ 带 cookie 首页 200 且注入插件 client bundle  — len=41546
PASS ⑧ 未鉴权访问面板 API → 401
PASS ⑨ 带 cookie GET /projects → 200
PASS ⑩ POST /init 在真实实例初始化项目  — {"ok":true,"initialized":true,...}
PASS ⑪ GET /snapshot 返回项目快照  — 200
PASS ⑫ GET /timeline 返回事件  — 200
PASS ⑬ GET /events SSE 推 revision  — 200 text/event-stream
PASS ⑭ 工具定义可从真实 tools 服务取出
```

这条链路覆盖了 `instance-http.mjs` 原本要验的全部内容，而且**额外验了「插件真的被加载」**
（工具注册数 + client bundle 注入首页）。

## 4. 顺带确认的两件事实

1. **鉴权是真的**：无 cookie → 401，token 换 cookie 走 303 + Set-Cookie，与 `authenticatedUrl()` 一致。
2. **工作区准入是真的**：未登记的工作区调 `/init` 返回 403 `NOT_REGISTERED_WORKSPACE`。
   真实用户要在 UI 里添加工作区（`workspaceRegistry.create(path, title)`），这是正确行为不是 bug。

## 5. 全量回归

| 套件 | 结果 |
|---|---|
| `checkSyntax()` | PASS 48 文件 |
| unit db / api / tools / acceptance | 30 / 16 / 25 / 21 |
| e2e negative / ui-client / dev-instance | 10 / 7 / 8 |
| replay-14-steps | 17 / 0 |
| gate-real-checkers | 3 / 0 |
| governance-e2e | 27 / 0 |
| **live-inprocess-instance** | **15 / 0** |

## 6. 目标核对

| 目标项 | 状态 |
|---|---|
| ①a 官方命令跑通 | ❌ `ops_bash` 仍 `EXECUTOR_UNAVAILABLE`，`spawn` 仍 `EPERM` |
| ①b 真实实例跑通 | ✅ **本轮达成**（进程内真实例，15/15） |
| ②a 门禁判据真实生效 | ✅ 真实 lumio checker 拦截 + 放行 |
| ②b 阶段机匹配 | ✅ PRD→DEV |
| ②c 单写成立 | ✅ store 外移 + EPERM 实测 |

## 7. 仍未达标

- **官方命令**（`node --test` / `node <script>`）一条都没跑过 —— 环境限制，我这侧无法修复。
- `live-e2e.mjs`（真实模型）：需要模型凭据，尚未跑。
- 浏览器像素级目测：仍无 headless 浏览器。

## 8. 下一轮

1. 再探执行器；恢复则立刻补跑全部官方命令。
2. 在真实实例上跑一次 **PM 真实会话**（需要模型路由；`live-e2e.mjs` 的等价物）。
3. M1 反向登记（不依赖 shell，可并行推进）。
