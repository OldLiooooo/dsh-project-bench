# 测试验证（testing-verification）

用途：测试会话独立验证实现，产出可复核的验收证据。

## 步骤
1. 读实现交接与验收标准（`doc_get` handoff/report）。
2. 设计用例：正向、边界、负向、回归；列出数据/环境准备。
3. 独立执行，不修改产品代码把测试改绿。
4. `evidence_add` 记录：命令、环境、关键输出摘要、失败用例清单。
5. `doc_write(type=report)` 写测试报告（结论/覆盖/缺陷/遗留）。
6. `session_task_report` + `session_finish_task`。

## 结论口径
- 通过：验收标准逐条对照 + 证据 id。
- 失败：缺陷复现步骤 + 期望/实际 + 影响面；由 PM 决定返工。
