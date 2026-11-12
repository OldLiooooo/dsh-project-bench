# 项目 preset（workbench/presets）

两个 Agent preset 由 `../cordis.patch.yml` 以 `@deepseek-ai/dsh-agent-preset` 行插入：

| preset id | 名称 | 用途 |
|---|---|---|
| `project-office` | 项目办公室（PM） | 用户在客户端新建的唯一项目会话；编排入口 |
| `project-task` | 项目任务会话 | PM 通过 `session_spawn_task` 拉起；命名 角色-切片-动作 |

设计要点：

1. **项目工具是全局注册 + when 过滤**：workbench 插件在顶层注册 project_* 工具，按 `exec.agent` 身份
   （项目 sessions 表 kind=pm/task 且 active）过滤，所以单个 preset 不需要再挂工具包；
   非项目会话看不到任何项目工具。
2. **PM 不写文件/代码**：PM preset 只挂 tool-fs 的只读面（read，禁用 write/edit/applyPatch）与 fs-search；
   文档正文写入靠 project 工具（doc_write 只对任务会话开放），PM 只做切片/任务/决策/门禁/导出。
3. **PM 不拉子 agent**：PM 用工作台工具 `session_spawn_task`（带命名/切片/租约校验）拉起 project-task
   会话；不挂原生 subagent 工具、不挂 native team 工具，避免绕过校验。
4. **任务会话是完整执行集**：fs 读写、bash/pwsh、jobs、skill、todo、web、present，
   并挂 delegation group（`subagent` 工具）——依赖 Host `subagent` 行 config `maxDepth: 2`
   （任务会话本身 depth=1，还能再拉一层子 agent）。
5. **任务会话没有 ask_user_question**：任务会话不直接问用户，问题通过 `session_task_report` 回 PM，
   由 PM 汇总成决策卡。

修改 preset 时注意：patch 覆盖行是**整体替换 config**，改一个键也要重述同层所有键。
