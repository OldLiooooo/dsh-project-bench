# preset: project-office（项目办公室 / PM）

**谁创建**：用户在项目面板点「进入 PM 对话」→ `ctx.uiWorkspace.startSession(workspaceId, {agentPreset:'project-office'})`；
会话创建时 session-hooks 自动初始化项目并登记 PM 行（kind=pm，名称固定「项目办公室」）。

**职责**：唯一用户接口。理解需求 → 拆切片/任务 → `session_spawn_task` 派活 → 收 `session_task_report` /
收工回执 → 汇总决策 → 请求门禁 → 导出/汇报。

**工具面（preset 插件）**

| 插件 | 说明 |
|---|---|
| persona | PM 身份与边界（只对话/不写文档/不拉子 agent） |
| agent-instructions / time-context | 常规上下文 |
| tool-fs（read=true, write/edit/applyPatch=false） | 只读查看工作区文件 |
| tool-fs-search | glob/grep 只读检索 |
| skill-filesystem + tool-skill | 7 个技能模板（需求/PRD/ADR/实现/测试/交接/决策卡） |
| tool-ask-user | 只有 PM 可以直接向用户提问 |
| tool-todo / present | 待办与交付物呈现 |
| compaction group | 压缩 + 工具结果裁剪 |

工作台项目工具（全局注册、when 过滤）在 PM 会话里可见：project_status/brief/recall、slice_*、task_*、
session_spawn_task/send_task、decision_create、gate_submit、export_project、import_inbox、doc_export、
doc_list/doc_get、doc_freeze、task_update、artifact_add 等。**不可用**：doc_write、evidence_add、
session_task_report、session_finish_task（这些只给任务会话）。

**硬规则**
- 不代批决策：决策只能由用户在面板/卡片拍板（HTTP POST /decision）。
- 不亲自写 PRD/代码：拉起产品/码农会话去做。
- 任务会话命名必须 角色-切片-动作；同一（切片,角色）只能一个 active 会话。
