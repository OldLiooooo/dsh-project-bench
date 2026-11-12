# ADR / 架构文档（adr-writing）

用途：记录架构决策与设计契约，供实现/测试会话按契约执行。

## 结构
- 标题 / 状态（建议/已批准/已废弃）
- 背景与约束
- 决策（一句话结论 + 关键细节）
- 备选方案与取舍
- 后果（正面/负面/影响面：API、DB、兼容性、迁移）
- 验证方式（如何证明实现符合本决策）

## 工具
- `doc_write(mode=create, type=adr, logicalKey=adr/<切片key>, content)`；设计/规格用 type=design|spec。
- 一个决策一篇 ADR；跨切片契约可用 logicalKey 前缀区分。
- 不可逆取舍先 `decision_create`（PM）并等用户批准，再冻结。

## 纪律
- 不擅自改已批准架构；变更走新 ADR + 决策。
- 契约要可执行：字段/接口/错误码写具体，不写口号。
