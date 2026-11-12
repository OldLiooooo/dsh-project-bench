# 交接写作（handoff-writeup）

用途：任务会话收工前的交接，让下一个会话零提问接手。

## 必写四段
1. 做了什么：切片/任务、改动文件、关键文档版本。
2. 怎么验证：命令 + 结果 + 证据 id。
3. 现状与风险：未完成项、已知缺陷、外部依赖、待拍板问题。
4. 下一步建议：谁接、先做什么。

## 工具
- `session_task_report(handoff=...)` 或 `doc_write(type=handoff, logicalKey=handoff/<切片key>)`。
- 收工：`session_finish_task(status=done, handoff=..., noOutOfScopeChanges=true)`。

## 纪律
- 交接是事实陈述：写可核对的内容，不写「应该没问题」。
- 有片外改动必须先在报告里说明，由 PM 调整切片/写决策。
