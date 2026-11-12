# 实现执行（implementation-execution）

用途：码农会话按 ADR/规格改代码、跑测试、留证据、交交接。

## 开工
1. `project_brief` 读切片与验收；`doc_get` 读 ADR/规格。
2. 确认写作用域/租约：同切片同时只有一个任务写入会话；越界要回 PM。
3. `todo_write` 列步骤（实现 → 自测 → 证据 → 文档 → 收工）。

## 执行
- 只改本切片写作用域内的文件；小步改、小步验。
- 跑测试/构建：`evidence_add(kind=test|command, command, resultSummary)` 原样记命令与关键输出。
- 改动文件用 `artifact_add(kind=code-file, path)` 登记；或收工时用 `files` 传入。

## 收工
1. `doc_write` 写实现报告/交接（改了什么、怎么验证、遗留与风险）。
2. `session_task_report` 汇报给 PM。
3. `session_finish_task(status=done, handoff, noOutOfScopeChanges=true)`；若失败用 status=failed。

## 红线
- 冻结文档不回写；片外文件零改动；问题回 PM，不直接问用户。
