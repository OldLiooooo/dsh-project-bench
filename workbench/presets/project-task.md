# preset: project-task（项目任务会话）

**谁创建**：PM 调 `session_spawn_task({role, sliceKey, action, prompt, ...})` → Host 用
`ctx.subagents.startActivation({provider:'spawn', delivery:'parent', childId, label, prompt, parent, agentPreset:'project-task', ...})`
（**prompt / parent 是顶层字段**，不存在 request 包装层 —— 见 docs/implementation/contracts-v1.zh.md）
拉起；会话名 = 角色-切片-动作（如 产品-支付退款-PRD / 码农-支付退款-实现）。

**职责**：承接一个切片的一个角色任务：决定怎么做、按需拉子 agent、产出文档/证据/交接，收工向 PM 汇报。
不跨切片写、不直接向用户提问。

**工具面（preset 插件）**

| 插件 | 说明 |
|---|---|
| persona | 任务会话身份（只对 PM 负责、切片内写、收工交交接） |
| tool-bash / tool-pwsh | 按平台二选一（win32 用 pwsh） |
| tool-fs（read/write/edit=true, applyPatch=false） | 改代码/测试/脚本 |
| tool-fs-search / tool-jobs | 检索与后台任务 |
| skill-filesystem + tool-skill | 技能模板（实现/测试/交接等） |
| compaction group | 压缩 + 工具结果裁剪 |
| delegation group | tool-subagent-control + subagent（provider=spawn）；maxDepth 继承 Host 配置 2 |
| tool-todo / tool-web / present | 待办、检索、交付物 |

工作台项目工具可见：project_status/brief/recall、doc_list/doc_get、doc_write、doc_freeze、doc_export?（否，
导出只给 PM）、task_list/task_update、slice_list/slice_update（仅本切片）、evidence_add、artifact_add、
session_task_report、session_finish_task。**不可用**：session_spawn_task/send_task、decision_create、
gate_submit、export_project、import_inbox、project_init、slice_create、task_create。

**收工硬校验**（session_finish_task）：
1. `handoff` 正文非空（同时写 handoff 文档新版本）；
2. 证据 ≥1（evidenceIds 或本切片已记录证据）；
3. `noOutOfScopeChanges=true` 声明片外零改动（如有片外改动需先回 PM）；
4. 通过后：结束项目会话行（status=done/failed）、释放切片租约、通知 PM。
