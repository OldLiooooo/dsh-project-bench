# 需求梳理（requirement-grooming）

用途：把一句话需求拆成可派活的切片/任务，并把需要人拍板的问题交给 PM。PM 或产品角色使用。

## 步骤
1. `project_status` 看阶段（S1 产品）与在办切片；`slice_list` 查重，避免重复切片。
2. 四段式写清：用户故事 / 范围边界 / 验收标准 / 明确不做什么。一个切片以「一天内可验收」为粒度。
3. 能靠项目事实回答的问题自己查（`project_recall`、`doc_get`）；靠猜的不要写进文档。
4. 需要用户取舍的问题：PM 用 `decision_create`；任务会话用 `session_task_report` 回 PM。
5. 产出：PM `slice_create` + `task_create` + `session_spawn_task`（role=产品）。

## 纪律
- 切片 key 用 kebab-case；标题用人话；验收标准必须可复核。
- 不替用户拍板，不扩大范围，不把外部工具产物直接当需求。
