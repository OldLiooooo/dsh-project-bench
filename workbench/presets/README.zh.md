# 项目 preset（workbench/presets）

三个 Agent preset 由 `../cordis.patch.yml` 以 `@deepseek-ai/dsh-agent-preset` 行插入：

| preset id | 名称 | 用途 |
|---|---|---|
| `project-office` | 项目办公室（PM） | 用户在客户端新建的唯一项目会话；编排入口 |
| `project-task` | 项目任务会话 | PM 通过 `session_spawn_task` 拉起；命名 角色-切片-动作 |
| `project-qa` | 项目验收会话 | PM 通过 `session_spawn_qa` 拉起；命名 验收-切片-动作（v5） |

设计要点：

1. **项目工具是全局注册 + when 过滤**：workbench 插件在顶层注册 project_* 工具，按 `exec.agent` 身份
   （项目 sessions 表 kind=pm/task/qa 且 active）过滤，所以单个 preset 不需要再挂工具包；
   非项目会话看不到任何项目工具。
2. **PM 不写文件/代码**：PM preset 只挂 tool-fs 的只读面（read，禁用 write/edit/applyPatch）与 fs-search；
   文档正文写入靠 project 工具（doc_write 只对任务会话开放），PM 只做切片/任务/决策/门禁/导出。
3. **PM 不拉子 agent**：PM 用工作台工具 `session_spawn_task`（带命名/切片/租约校验）拉起 project-task
   会话、用 `session_spawn_qa` 拉起 project-qa 会话；不挂原生 subagent 工具、不挂 native team 工具，
   避免绕过校验。
4. **任务会话是完整执行集**：fs 读写、bash/pwsh、jobs、skill、todo、web、present，
   并挂 delegation group（`subagent` 工具）——依赖 Host `subagent` 行 config `maxDepth: 2`
   （任务会话本身 depth=1，还能再拉一层子 agent）。
5. **任务会话没有 ask_user_question**：任务会话不直接问用户，问题通过 `session_task_report` 回 PM，
   由 PM 汇总成决策卡。

## project-qa：为什么必须是独立 preset（v5）

用 `project-task` 做验收时，「建造者不验收」只剩角色卡里一句话 —— 而提示词不算约束
（设计逻辑 §8 第 1 条）。验收会话的三条硬边界靠 **preset 静态工具面 + 工具 actors** 双重保证：

| 边界 | 怎么实现 |
|---|---|
| 不写文件 | preset 里 `tool-fs` 的 `write/edit/applyPatch` 全 false；并且工具层没有任何文件写工具 |
| 不占租约 | 会话 `kind='qa'`，不进 `kind='task'` 的租约路径；`evidence_add` 对它跳过 `assertWriteScope` |
| 只能记证据 + 签字 | 工具 actors 里只有 `evidence_add` 与 `slice_verify` 允许 `qa`；`doc_write` / `session_finish_task` 等对它是隐藏的 |

另外**故意不挂**：`delegation`（验收会话不该再拉子 agent）、`tool-web`（别把外部材料当证据）、
`tool-ask-user`（验收者不直接问用户）。

验收会话能看到 9 个工具：`project_status` `project_brief` `project_recall` `doc_list` `doc_get`
`task_list` `slice_list` `evidence_add` `slice_verify`。

## 命名与唯一性

- 任务会话：`角色-切片key-动作`（角色取自固定词表 产品/UX/架构/码农/测试/发布/复盘）
- 验收会话：`验收-切片key-动作`

两条唯一性约束都在 DB 层：同一（切片,角色）只能一个 active 任务会话；
同一（切片）只能一个 active 验收会话。

## 修改时注意

patch 覆盖行是**整体替换 config**，改一个键也要重述同层所有键。
