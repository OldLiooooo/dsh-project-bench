# DSH Project Workbench · DSH 项目工作台

**A project runtime inside your DeepSeek Harness workspace — you talk to a PM, an AI expert team delivers, and progress stays visible.**

**工作区里的项目运行时 —— 你只对 PM 提需求，AI 专家团负责交付，进度全程可视化。**

<p align="left">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="DSH >= 0.2.2-rc.1" src="https://img.shields.io/badge/DSH-%E2%89%A5%200.2.2--rc.1-6f42c1">
  <img alt="Node >= 20" src="https://img.shields.io/badge/node-%E2%89%A5%2020-339933?logo=node.js&logoColor=white">
  <img alt="Platform: DSH Desktop / Web" src="https://img.shields.io/badge/platform-DSH%20Desktop%20%7C%20Web-orange">
  <a href="#-testing"><img alt="Tests: 58 unit + 4 e2e suites" src="https://img.shields.io/badge/tests-58%20unit%20%2B%204%20e2e-brightgreen"></a>
</p>

<p align="left">
  <a href="#english">English</a> · <a href="#中文">中文</a> ·
  <a href="docs/delivery.zh.md">Installation &amp; Demo / 安装与演示</a> ·
  <a href="docs/workbench-architecture-v1.zh.md">Architecture / 架构</a>
</p>

---

## English

### What is this?

**DSH Project Workbench** (`@local/dsh-project-workbench`) is a local bundle plugin for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai). It turns a plain workspace into a
**project runtime**:

- 🗄️ **One SQLite database as the single source of truth** — documents, tasks, sessions,
  decisions, evidence and the timeline all live in `.project/project.db`. Markdown files under
  `docs/` are *export snapshots only* (write-only, never read back).
- 🧑‍💼 **You only talk to the PM** — a single PM session (preset `project-office`) understands your
  request, slices the work, and spawns **task sessions** (preset `project-task`, named
  `role-slice-action`, e.g. `产品-refund-PRD`). Roles: product / UX / architecture / dev / QA /
  release / retrospective.
- 📊 **A tree-shaped cockpit** — project panel with stage badges, pending-decision counters, and
  tabs for overview / sessions / documents / decisions / timeline. Live updates via SSE
  (revision push, no polling).
- 🚦 **Human-only gates** — gates and irreversible decisions can *only* be approved by a human
  through the panel/HTTP. Agents have **no tool to self-approve**; irreversible actions require a
  second confirmation.
- 🪶 **≤2k context budget per session** — layered loading (L0 400 / L1 300 / L2 900, hard cap
  2000) with graceful degradation and on-demand querying instead of dumping everything.

### How it works

```text
 You ──▶ PM session (project-office)
           │  understands request · slices work · spawns tasks
           ▼
      Task sessions (project-task)  ── 产品-refund-PRD / 码农-refund-API / 测试-refund-e2e ...
           │  read & write project facts through project_* tools
           ▼
      .project/project.db  ◀── single source of truth
           │
           ├─▶ Cockpit panel (tree + tabs, SSE live refresh)
           ├─▶ Decision cards & gates ──▶ HUMAN approval only (2-step for irreversible)
           └─▶ docs/ export snapshots (generated header, write-only)
```

### Quick start

**Requirements:** DSH Desktop `>= 0.2.2-rc.1`, Node.js `>= 20`.

#### Option A — Install into DSH Desktop

1. Open **DeepSeek Harness → Settings → Plugins** (plugin manager).
2. Choose *Add local plugin / install local bundle*, and point it at the `workbench/` directory
   of this repo:

   ```text
   <path-to-this-repo>/workbench
   ```

3. **Fully quit DSH** (including the tray icon) and relaunch — host code and the preload list are
   assembled at startup.
4. Open the **Project Workbench** sidebar in your target workspace → click **Initialize project**.
5. Click **Enter PM conversation** and start talking.

> `desktop` is a reserved Electron profile: the external CLI (`dsh plugin --profile desktop`) is
> rejected, so installation must happen inside the app. Read-only self-check (does not touch
> `~/.dsh`):
>
> ```bash
> node workbench/scripts/dev-install.mjs check --home "%USERPROFILE%\.dsh" --profile desktop
> ```

#### Option B — Isolated dev instance (recommended for trying it out)

Runs against its own `DSH_HOME` so your real profile is untouched:

```bash
node workbench/scripts/dev-instance.mjs start        # DSH_HOME=<workspace>/.devhome, port 52999
node workbench/scripts/dev-instance.mjs status --json
node workbench/scripts/dev-instance.mjs restart      # required after host/client code changes
node workbench/scripts/dev-instance.mjs stop
```

The isolated instance has no model routing by default. To exercise real PM/task sessions, start it
with the model overlay (see `workbench/tests/e2e/devhome-model.patch.yml`; `start` accepts
`--patch`). Keys are read from credential refs — never hard-coded.

**Uninstall:** remove the bundle in the plugin manager → fully quit and relaunch. Project data stays
in the workspace's `.project/`; delete it for a complete cleanup (back up `project.db` first).

### A 10-minute demo

1. **Panel** — sidebar *Project Workbench*: project header shows name / stage badge / pending
   decisions; left tree `S1 product → slices`; right tabs overview / sessions / documents /
   decisions / timeline.
2. **Make a request** — click *Enter PM conversation* and tell the PM:
   *"Payments need refunds — write the PRD first."*
   The PM slices the work (`refund`), creates tasks, and spawns the `产品-refund-PRD` task session.
3. **Watch the task session work** — a row appears in the *Sessions* tab (role / slice / model /
   status / read-only hint); PRD v1 shows up in *Documents* (DB-rendered preview, version switcher).
4. **Decisions & gates** — after the PM submits gate G1, a card appears in *Decisions* (question /
   options / recommendation / cost of not reworking + an **irreversible** marker). Click *Approve* →
   second confirmation → the timeline records `gate/approve`, `doc/export`, `stage/change`, the
   stage badge moves S1→S2, and `docs/product/prd-refund.md` is generated.
5. **Timeline** — filter by type/role; every entry traces back to a session, slice, document version,
   decision and evidence.
6. **Live refresh** — send a new request in the PM session; the sidebar tree's pending-decision and
   task states update automatically (SSE pushes revisions, no polling).

### What's in this repo

| Path | Contents |
|---|---|
| [`workbench/`](workbench/) | **The plugin** — host runtime (29 modules), client bundle (`client.js`, ~3.7k lines), `cordis.patch.yml`, 2 presets, 7 skill templates, en/zh locales, scripts, tests |
| [`docs/`](docs/) | Design proposals, architecture blueprints, delivery/acceptance notes, plugin development & publishing guide, research |
| [`research/`](research/) | Background research material |
| [`templates/`](templates/) | Plugin skeletons: [`host-bundle/`](templates/host-bundle/) (host-only) and [`ui-decoration/`](templates/ui-decoration/) (with Web UI) |
| [`poc/`](poc/) | Small platform capability probes |

### Key documents

- 📦 **[Installation, demo & acceptance](docs/delivery.zh.md)** — start here
- 🏗️ **[Architecture blueprint v1](docs/workbench-architecture-v1.zh.md)** · **[UI architecture](docs/workbench-ui-architecture-v1.zh.md)**
- 📐 **[Module interface contracts](docs/implementation/contracts-v1.zh.md)** · **[Implementation notes](docs/implementation/implementation-notes.zh.md)**
- 🧩 **[DSH plugin development & publishing guide](docs/dsh-plugin-guide.zh.md)** — bundle rules, local debugging, npm/tarball/GitHub/market-index publishing
- 💡 **[Design proposal](docs/project-workbench-design.zh.md)** · **[Kickoff prompt](docs/kickoff-implementation-prompt.zh.md)**
- 🔍 **[UI extension audit](docs/research/dsh-ui-extension-audit.zh.md)** · **[Platform PoC](docs/research/poc-platform-capabilities.zh.md)**
- 🧠 **[Layered/sharded memory research](docs/research/layered-sharded-memory-research.zh.md)** · **[Git/CI postmortem](docs/lumio-git-ci-postmortem.zh.md)**

> Most design documents are written in Chinese; the plugin UI ships both `en` and `zh` locales.

### 🧪 Testing

| Suite | Command | Result |
|---|---|---|
| Unit (58 cases across 4 files) | `node --test workbench/tests/unit/` | 58/58 |
| 14-step business replay | `node workbench/tests/e2e/replay-14-steps.mjs --strict` | 17/17 |
| Negative / security | `node workbench/tests/e2e/negative.test.mjs` | 10/10 |
| UI contract | `node workbench/tests/e2e/ui-client.test.mjs` | 3/3 |
| Instance scripts | `node workbench/tests/e2e/dev-instance.test.mjs` | 7/7 |
| Real instance HTTP/SSE | `node workbench/tests/e2e/instance-http.mjs` | 10/10 |
| Real model end-to-end | `node workbench/tests/e2e/live-e2e.mjs` | 4/4 |

All executed with the official commands. See
[implementation notes](docs/implementation/implementation-notes.zh.md) for evidence and deviations.

### Publishing your own DSH plugin

This repo doubles as a working reference. The short version (full details in the
[guide](docs/dsh-plugin-guide.zh.md)):

1. Copy a skeleton from [`templates/`](templates/) → change package name / patch row ids / locale / icon.
2. Install into DSH and iterate (`dev-instance.mjs restart` after host/client changes).
3. Distribute via **npm** (`pnpm publish`), **tarball** (`pnpm pack` → GitHub Release asset), or
   **Git** (`dsh plugin add github:you/repo`, needs a self-contained `prepare` build).
4. Add the **`dsh-plugin`** topic to your repo, and optionally host a static `index.json` market
   index (e.g. GitHub Pages) so users can discover and one-click install it.

### Status & roadmap

The plugin is **feature-complete for v1** and verified end-to-end (see Testing). Design material is
kept as-is to serve as the blueprint and background. Not yet published to npm or a market index —
this repository currently distributes source plus a local bundle.

### License

[MIT](LICENSE) © 2026 li pf

---

## 中文

### 这是什么？

**DSH 项目工作台**（`@local/dsh-project-workbench`）是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai)
的一个本地 bundle 插件。它把普通工作区变成**项目运行时**：

- 🗄️ **一个 SQLite 项目库作为唯一事实源** —— 文档、任务、会话、决策、证据、时间线全部存在
  `.project/project.db`；`docs/` 下的 Markdown 只是**导出快照**（只写不回读）。
- 🧑‍💼 **你只和 PM 对话** —— 唯一的 PM 会话（preset `project-office`）理解需求、拆切片，并拉起
  **任务会话**（preset `project-task`，命名 `角色-切片-动作`，如 `产品-refund-PRD`）。
  角色词表：产品 / UX / 架构 / 码农 / 测试 / 发布 / 复盘。
- 📊 **树状驾驶舱** —— 项目面板带阶段徽章、待决策计数，以及概览 / 会话 / 文档 / 决策 / 时间线分页；
  通过 SSE 推送 revision 实时刷新（不轮询）。
- 🚦 **门禁只能人批准** —— 门禁与不可逆决策**只能**由人通过面板/HTTP 落定，agent **没有任何代批工具**；
  不可逆操作需要二次确认。
- 🪶 **每会话 ≤2k 上下文预算** —— 分层装载（L0 400 / L1 300 / L2 900，硬上限 2000），超限自动降级并
  提示按需查询，而不是一股脑塞满。

### 工作方式

```text
 你 ──▶ PM 会话（project-office）
          │  理解需求 · 拆切片 · 拉起任务
          ▼
     任务会话（project-task） ── 产品-refund-PRD / 码农-refund-API / 测试-refund-e2e ...
          │  通过 project_* 工具读写项目事实
          ▼
     .project/project.db  ◀── 唯一事实源
          │
          ├─▶ 驾驶舱面板（树 + 分页，SSE 实时刷新）
          ├─▶ 决策卡与门禁 ──▶ 只能人批准（不可逆需二次确认）
          └─▶ docs/ 导出快照（带 generated 头，只写）
```

### 快速开始

**环境要求：** DSH Desktop `>= 0.2.2-rc.1`、Node.js `>= 20`。

#### 方式 A —— 装进 DSH Desktop

1. 打开 **DeepSeek Harness → 设置 → 插件**（插件管理器）；
2. 选择「添加本地插件 / 安装本地 bundle」，路径填本仓库的 `workbench/` 目录：

   ```text
   <本仓库路径>/workbench
   ```

3. **完全退出 DSH**（含托盘）后重新打开 —— Host 代码与 preload 列表都在启动时装配；
4. 在目标工作区打开右侧栏「**项目工作台**」→ 点「**初始化项目**」；
5. 点「**进入 PM 对话**」开始对话。

> `desktop` 是 Electron 保留 profile，外部 CLI（`dsh plugin --profile desktop`）会被拒绝，
> 安装必须在 app 内完成。只读自检（不改 `~/.dsh`）：
>
> ```bash
> node workbench/scripts/dev-install.mjs check --home "%USERPROFILE%\.dsh" --profile desktop
> ```

#### 方式 B —— 隔离实例（推荐先用这个试）

使用独立的 `DSH_HOME`，不动你的真实 profile：

```bash
node workbench/scripts/dev-instance.mjs start        # DSH_HOME=<workspace>/.devhome，端口 52999
node workbench/scripts/dev-instance.mjs status --json
node workbench/scripts/dev-instance.mjs restart      # 改 host/client 代码后必须重启
node workbench/scripts/dev-instance.mjs stop
```

隔离实例默认没有模型路由。要验证真实 PM/任务会话，启动时加模型 overlay
（见 `workbench/tests/e2e/devhome-model.patch.yml`，`start` 支持 `--patch`）。
key 从 credentials refs 读取，绝不硬编码。

**卸载：** 插件管理器移除该 bundle → 完全退出并重启。项目数据留在工作区的 `.project/`，
删除即彻底清理（建议先备份 `project.db`）。

### 10 分钟演示

1. **面板** —— 侧栏「项目工作台」：项目头显示项目名 / 阶段徽章 / 待决策数；左树 `S1 产品 → 切片`；
   右侧分页：概览 / 会话 / 文档 / 决策 / 时间线。
2. **提需求** —— 点「进入 PM 对话」，对 PM 说：*「支付要能退款，先出 PRD」*。
   PM 会拆切片（`refund`）、建任务，并拉起「产品-refund-PRD」任务会话。
3. **看任务会话干活** —— 「会话」分页出现行（角色 / 切片 / 模型 / 状态 / 只读提示）；
   「文档」分页出现 PRD v1（DB 渲染的预览，可切版本）。
4. **决策 / 门禁** —— PM 提交 G1 门禁后，「决策」分页出现卡（问题 / 选项 / 推荐 / 不返工后果 +
   **不可逆**标记）。点「批准」→ 二次确认 → 时间线出现 `gate/approve`、`doc/export`、
   `stage/change`，阶段徽章 S1→S2，并生成 `docs/product/prd-refund.md`。
5. **时间线** —— 按类型 / 角色过滤；每条都能追到会话、切片、文档版本、决策、证据。
6. **实时刷新** —— 在 PM 会话里发一句新需求，侧栏树的待决策 / 任务状态自动刷新（SSE 推 revision，不轮询）。

### 仓库结构

| 路径 | 内容 |
|---|---|
| [`workbench/`](workbench/) | **插件本体** —— Host 运行时（29 个模块）、Client bundle（`client.js`，约 3.7k 行）、`cordis.patch.yml`、2 个 preset、7 个技能模板、中英 locale、脚本、测试 |
| [`docs/`](docs/) | 设计提案、架构施工图、交付/验收说明、插件开发与发布指南、研究资料 |
| [`research/`](research/) | 背景研究材料 |
| [`templates/`](templates/) | 插件骨架：[`host-bundle/`](templates/host-bundle/)（纯 Host）与 [`ui-decoration/`](templates/ui-decoration/)（带 Web UI） |
| [`poc/`](poc/) | 平台能力小探针 |

### 关键文档

- 📦 **[安装 / 演示 / 验收对照](docs/delivery.zh.md)** —— 从这里开始
- 🏗️ **[架构施工图 v1](docs/workbench-architecture-v1.zh.md)** · **[UI 架构](docs/workbench-ui-architecture-v1.zh.md)**
- 📐 **[模块接口契约](docs/implementation/contracts-v1.zh.md)** · **[实现笔记](docs/implementation/implementation-notes.zh.md)**
- 🧩 **[DSH 插件开发与发布指南](docs/dsh-plugin-guide.zh.md)** —— bundle 规则、本地调试、npm/tarball/GitHub/市场索引发布
- 💡 **[设计提案](docs/project-workbench-design.zh.md)** · **[实现启动提示词](docs/kickoff-implementation-prompt.zh.md)**
- 🔍 **[UI 扩展能力审计](docs/research/dsh-ui-extension-audit.zh.md)** · **[平台 PoC](docs/research/poc-platform-capabilities.zh.md)**
- 🧠 **[分层分片记忆调研](docs/research/layered-sharded-memory-research.zh.md)** · **[Git/CI 治理复盘](docs/lumio-git-ci-postmortem.zh.md)**

> 设计文档以中文为主；插件 UI 同时提供 `en` 与 `zh` 两套 locale。

### 🧪 测试

| 套件 | 命令 | 结果 |
|---|---|---|
| 单测（4 个文件 58 例） | `node --test workbench/tests/unit/` | 58/58 |
| 14 步业务预演回放 | `node workbench/tests/e2e/replay-14-steps.mjs --strict` | 17/17 |
| 负向 / 安全 | `node workbench/tests/e2e/negative.test.mjs` | 10/10 |
| UI 契约 | `node workbench/tests/e2e/ui-client.test.mjs` | 3/3 |
| 实例脚本 | `node workbench/tests/e2e/dev-instance.test.mjs` | 7/7 |
| 真实实例 HTTP/SSE | `node workbench/tests/e2e/instance-http.mjs` | 10/10 |
| 真实模型端到端 | `node workbench/tests/e2e/live-e2e.mjs` | 4/4 |

全部以官方命令实跑通过。证据与偏差见[实现笔记](docs/implementation/implementation-notes.zh.md)。

### 发布你自己的 DSH 插件

本仓库也是一份可运行的参考。简版流程（完整细节见[指南](docs/dsh-plugin-guide.zh.md)）：

1. 从 [`templates/`](templates/) 复制骨架 → 改包名 / patch 行 id / locale / 图标；
2. 装进 DSH 迭代（改 host/client 后 `dev-instance.mjs restart`）；
3. 分发渠道：**npm**（`pnpm publish`）、**tarball**（`pnpm pack` → GitHub Release 附件）、
   **Git 直装**（`dsh plugin add github:you/repo`，需要自包含的 `prepare` 构建）；
4. 给仓库加 **`dsh-plugin`** topic；可选再托管一份静态 `index.json` 市场索引（如 GitHub Pages），
   用户添加索引源后即可搜索 / 一键安装。

### 现状与后续

插件 **v1 功能已实现完毕**并端到端验证通过（见测试）。设计资料保持原样，作为施工图与背景。
目前尚未发布到 npm 或市场索引 —— 本仓库当前分发源码 + 本地 bundle。

### 许可

[MIT](LICENSE) © 2026 li pf
