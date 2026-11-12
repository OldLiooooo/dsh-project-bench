# dsh-porject-bench

DSH 工作台插件的开发工作区。**插件已实现完毕**：[workbench/](workbench/)（`@local/dsh-project-workbench`，
本地 bundle）。安装/演示/验收对照见 **[docs/delivery.zh.md](docs/delivery.zh.md)**，
验证结果与偏差见 **[docs/implementation/implementation-notes.zh.md](docs/implementation/implementation-notes.zh.md)**，
模块接口契约见 [docs/implementation/contracts-v1.zh.md](docs/implementation/contracts-v1.zh.md)。

实现规模：Host 运行时 31 个模块 + Client 单 bundle（3.7k 行）+ 2 个 preset + 7 个技能模板；
测试 57 个单测 + 4 套 e2e（14 步回放 17/17、负向 10/10、UI 契约 3/3、实例脚本 7/7）、
真实实例 HTTP/SSE 10/10、真实模型端到端 4/4，全部官方命令实跑通过。

以下为设计与研究资料（保持原样，作为施工图与背景）：

1. **插件开发与发布**（Dsh 基础规则）：[docs/dsh-plugin-guide.zh.md](docs/dsh-plugin-guide.zh.md)
   —— 插件/bundle 规则、本地调试、npm/tarball/GitHub/市场索引发布、常见坑。
2. **软件项目工作台插件设计**：[docs/project-workbench-design.zh.md](docs/project-workbench-design.zh.md)
   —— 面向「真人只提需求、AI 专家团交付、进度可视化」的设计提案（专家团、流程门禁、进度把控、驾驶舱、
   数据模型、DSH 实现映射、模型评测台账；含流程裁剪、Git/CI 硬规则）。
   **目标架构施工图**：[docs/workbench-architecture-v1.zh.md](docs/workbench-architecture-v1.zh.md)
   **UI 架构**：[docs/workbench-ui-architecture-v1.zh.md](docs/workbench-ui-architecture-v1.zh.md)
   —— 工作区→项目→PM（唯一对话）、team 只读、树状驾驶舱（2D+CSS3D；WebGL 需 PoC）；DSH 槽位映射与验收。
   能力审计：[docs/research/dsh-ui-extension-audit.zh.md](docs/research/dsh-ui-extension-audit.zh.md)。
   实现启动提示词：[docs/kickoff-implementation-prompt.zh.md](docs/kickoff-implementation-prompt.zh.md)。
   平台 PoC：[docs/research/poc-platform-capabilities.zh.md](docs/research/poc-platform-capabilities.zh.md)
   —— SQLite 在插件内可用、本地插件安装/Web 实例/Client bundle 已通、任务会话可调 Codex；UI 渲染待目测。
   Codex/GPT 接入已确认全部收敛 DSH 内：GPT 走 provider（grsai），真实 Codex 走原生 subagent_codex（已实测可用）。
   —— 用户只对 PM、PM 拉任务会话/子 agent；DB 为项目唯一事实源（文档不拆文件、不做同步）；文件只有代码/导出/外部工作包；
   含工作区目录、数据模型、14 步业务预演、数据流不变量、驾驶舱视图、DSH 映射与一次性实现验收清单。
   **v0.6 起主提案删除初版记忆机制章节**，记忆方案按研究结论重构。
3. **lumio Git/CI 治理复盘（新结论）**：[docs/lumio-git-ci-postmortem.zh.md](docs/lumio-git-ci-postmortem.zh.md)
   —— 只看第三代 `lumio`：111 commits 数据、事故链、5 层根因、新结论（Git/CI 必须是状态机）+ 10 条硬规则。
4. **记忆机制调研：分层分片（研究结论）**：[docs/research/layered-sharded-memory-research.zh.md](docs/research/layered-sharded-memory-research.zh.md)
   —— 方向从「一个大而全的工程记忆」改为**分层、分片、分职责**：片 = 可写对象（工作项/模块/角色），
   一片一 owner，agent 只装载自己的片，顶层 ≤2 页，其余按需查；会话绑定工作项，收工校验片外零改动。
   支撑材料：[lumio 文档体系复盘](docs/research/lumio-doc-system-audit.zh.md)、
   [Anthropic 机制解析](docs/research/anthropic-agent-memory-components.zh.md)、
   [TencentDB Agent Memory 调研](docs/research/tencentdb-agent-memory.zh.md)、
   [DSH 运行时事实](docs/research/dsh-runtime-memory-facts.zh.md)。
   数据库方案与基准：[DB 型记忆方案草案](docs/research/db-backed-memory-scheme.zh.md)、
   [agent 原生 DB 工具调研](docs/research/agent-native-db-tools.zh.md)、
   [SQLite vs Markdown 基准](docs/research/sqlite-vs-markdown-benchmark.zh.md)。
   初版记忆方案（SQLite 账本 + 四层/七类 + 注入协议 + 使用期六个时刻）已归档：
   [docs/archive/memory-design-v1/](docs/archive/memory-design-v1/)（仅作研究资料，不再作为提案）。

骨架模板：

- 纯 Host 插件：[templates/host-bundle/](templates/host-bundle/)
- 带 Web UI 的插件：[templates/ui-decoration/](templates/ui-decoration/)

开发路径（简版）：复制骨架 → 改包名 / patch 行 id / locale / 图标 → 装进 DSH 看效果 → 按指南发布。
