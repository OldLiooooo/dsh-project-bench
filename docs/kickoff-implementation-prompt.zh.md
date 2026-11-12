# 启动提示词：实现 DSH 软件项目工作台插件

> 用法：在本工作区（C:/Users/oldap/Documents/dsh-porject-bench）新开一个 DSH 会话，把下面「提示词正文」整段粘贴进去。
> 该会话是 Lead（PM）会话，允许并鼓励拉起 teammate / subagent 协同实现。
> 本文是提示词的存档；以 chat 里粘贴的版本为准（内容相同）。

---

## 提示词正文（复制以下全部）

你是 DSH「软件项目工作台」插件的实现负责人（Lead）。工作区：C:/Users/oldap/Documents/dsh-porject-bench。

目标：按既有目标架构**一次性实现完整插件**。不分期、不做 MVP、不做最小原型、不重新设计架构。用户就是产品负责人：用户只提需求，你和你的团队交付。

### 第一步：通读文档（必须，按顺序）

1. docs/workbench-architecture-v1.zh.md —— 目标架构 v1（目录、概念/数据模型、业务预演、数据流不变量、DSH 映射、验收清单）。这是施工图。
2. docs/workbench-ui-architecture-v1.zh.md —— UI 架构 v1（工作区→项目→PM、树状驾驶舱、2D+CSS3D、槽位映射）。注意：Team 只读视图**暂缓实现**，设计保留。
3. docs/research/poc-platform-capabilities.zh.md —— 已实测平台能力（node:sqlite、插件安装、client bundle、任务会话调 Codex、自定义路由鉴权坑）。
4. docs/project-workbench-design.zh.md —— 背景提案（阶段/门禁/专家团/驾驶舱）；其中记忆机制旧章已删，不要按旧章实现。
5. 需要时：docs/research/dsh-runtime-memory-facts.zh.md（DSH 注入/压缩/工具边界）、docs/research/dsh-ui-extension-audit.zh.md（UI 能力审计）、docs/dsh-plugin-guide.zh.md（插件规则/发布）。
6. 可参考 PoC：poc/host-probe（node:sqlite + webServer 路由）、poc/ui-probe（main + sidebar 注册）。

### 已定架构（摘要，防止误解）

- 插件 = 工作区里的「项目」运行时，不是 CLI、不是外部 memory 服务。所有操作走插件工具 + 驾驶舱。
- 用户只和 PM 会话沟通；PM 会话是 project-office preset（Lead）。PM 拉起任务会话（teammate），任务会话可按需拉子 agent；子 agent 只向任务会话交结果，不写项目记忆。
- 任务会话命名：角色-切片-动作（产品-支付PRD / 码农-会话保持实现 / 测试-支付回归），角色词表：产品/UX/架构/码农/测试/发布/复盘。同一（切片, 角色）同时只有一个 active 会话。
- 数据：SQLite（node:sqlite，WAL）为唯一事实源：项目/阶段/切片/任务/会话/文档（版本）/决策/证据/事件时间线/租约/导出记录。
- 文档直接存 DB（doc_versions.content），**不做文件↔DB 双写、不做同步**；检索按章节片段（doc_sections 派生，可重建）。交付文档只在门禁/发布时导出到 docs/（只写不回读）。
- 代码/测试/脚本仍是工作区文件；DB 只记路径+hash+事件。
- 上下文：每会话注入 ≤2k tokens（L0 全局卡 400 / L1 角色卡 300 / L2 当前切片 900 / 余量 400）；每步只刷 L0 变化部分；按需查询 ≤500/次。DSH 用 systemPrompt.section/context 注入。
- 门禁/决策：人批准；不可逆动作必须人确认；actionCards 仅运行版可用，实现前核对。
- 外部模型：GPT/Claude 走 DSH provider 会话；真实 Codex 走原生 subagent_codex（一次性、无追问、只回最终答案）；Claude Code/ACP 同理；不做外部工作包双向同步（仅兜底导入）。
- 工作区目录：.project/（project.db、project.json、exports/、inbox/、packages/）；docs/ 为导出交付物；.project 下 DB 不入 git，project.json + docs 入 git。
- Team 只读视图：**本次不实现**（用户 2026-11-11 决定暂缓）。项目面板里可先展示会话列表/状态/产物链接；原生会话可兜底打开；不要为只读去改宿主。

### 实现范围（一次性，全部）

1. Host 插件（项目运行时，单写者）：SQLite schema 与迁移；文档版本与章节派生；任务/切片/会话/决策/证据/事件；2k 上下文编译；导出/导入；lease/写作用域；门禁与对账；工具（project_status/brief/recall/doc_*/task_*/decision_*/evidence_*/session_*/export/import）；系统提示注入（section/context）；文件回填索引。
2. Client 插件：项目面板（main）、侧栏「项目」入口、树状驾驶舱（2D；CSS3D 可选，WebGL 不做）、PM 会话页头徽章/输入框状态条、决策卡/开工卡/收工回执、文档预览、时间线；Team 列表（只读视图暂缓，先做列表/状态，不做转录只读）。
3. PM/任务会话编排：project-office preset、角色卡、技能模板（需求/PRD/ADR/实现/测试/交接）、spawn/命名/收工校验规则；任务会话拉子 agent（需确认 Host maxDepth≥2）。
4. 安装与调试：插件以本地 bundle 安装；用隔离 DSH_HOME 的独立 web 实例验证（dsh --profile web --patch ... --no-open --port <port>），不要先动用户的 Desktop profile；验证通过后给用户安装/重启说明。
5. 文档：实现过程中更新 docs/（实现笔记、偏差记录），不重写架构。

### 团队协同（允许并鼓励）

- 你是 Lead，可以 spawn_teammate；按模块拆分并行：DB/领域模型、Host 工具与服务、Client 项目面板/树、会话编排/preset/技能、验证与测试。每个 teammate 明确写作用域，禁止重叠；你负责集成与最终验收。
- DSH 限制：spawn_teammate 只有 Lead 能调；任务会话拉子 agent 需要 Host maxDepth≥2（先确认，不可则 PM 直接拉子 agent，架构不变）；teammate 上限注意（本机 8）。
- 并行写代码时用 worktree 或明确文件所有权；集成前你亲自 review diff 并跑验收。
- 不要用「最小原型」交差；每个模块直接做到目标态，缺平台能力就记录偏差并停下来问用户，不擅自改架构。

### 平台事实与坑（已实测）

- node:sqlite 在 Host 插件内可用（SQLite 3.53.4，WAL，FTS5 trigram）；DB 文件放 .project/；不要依赖外部数据库。
- 本地 bundle 可直接 dsh plugin --profile web add <路径>；Client bundle 会出现在页面 preload；独立 web 实例可用工作区 DSH_HOME 启动，token/cookie 鉴权。
- 自定义 webServer 路由默认不鉴权（PoC 发现）：正式实现必须用 ctx.connection.requestRejection 或只走 Remote/projection，禁止裸路由。
- 本机沙箱里跑不了 headless Edge/Playwright：UI 渲染验证靠用户浏览器打开 PoC 实例；或启用 DSH browser-use 实验提供方。
- DSH 原生没有会话级只读；Team 只读视图暂缓。
- 0.2.1 源码 vs 0.2.2 运行版有差异：actionCards 等以运行版为准；实现前用运行中实例核对 slot/API。

### 验收（按 architecture §11 清单）

- 14 步业务预演可完整回放：用户需求→PM→任务会话→子 agent→文档/证据→决策→门禁→导出→时间线。
- 树状驾驶舱能回答：在做什么/依据什么/下一步；时间线可追溯到会话、切片、文档版本、决策、证据。
- 文档版本/冻结/导出/导入闭环；旧版本可查不可改。
- 2k 装载预算、按需查询、降级；单写者/租约/写作用域负向测试。
- PM 拉任务会话、任务会话拉子 agent、命名/角色/切片/模型可查；用户不直接进子会话对话（产品约定）。
- 决策/门禁人批准；不可逆二次确认。
- 恢复：DB 备份/重建、导出可重生成；重启后会话可恢复。

### 禁止

- 不写 CLI、不做外部 memory 服务、不做文件↔DB 双向同步。
- 不让 agent 直接写 DB 或绕过项目运行时；不让记忆机制重新膨胀成上一版的大而全。
- 不重设计架构、不分期、不交最小原型；不替用户做不可逆决策。
- 不先改用户 Desktop profile；先隔离实例验证。

### 起步动作

1. 读完 §第一步的文档，向用户回一份「实现计划 + 模块/teammate 拆分 + 风险」≤30 行；
2. 建 Host 插件骨架 + DB schema + 2k 装载最小闭环；
3. 建 Client 项目面板骨架 + PM 会话入口；
4. 按模块拉起 teammate 并行实现，你集成并逐项跑 §验收；
5. 全部通过后给用户安装说明与演示。
