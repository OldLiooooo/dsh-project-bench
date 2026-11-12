# 技能模板（workbench/skills）

这些 Markdown 是插件通过 `ctx.skills.register` 注册的运行时技能正文（模型按需加载，不占 2k 注入预算）。
host/skills.js 在插件加载时读取本目录并注册；技能名见各文件首行标题与 host/skills.js 的 SKILLS 表。

| 技能 | 名称 | 使用方 |
|---|---|---|
| 需求梳理 | requirement-grooming | PM / 产品 |
| PRD 写作 | prd-writing | 产品 |
| ADR/架构 | adr-writing | 架构 |
| 实现执行 | implementation-execution | 码农 |
| 测试验证 | testing-verification | 测试 |
| 交接写作 | handoff-writeup | 所有任务会话 |
| 决策卡 | decision-card | PM（配合 actionCards propose_action） |
