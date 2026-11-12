# 记忆机制初版归档（2026-11-11）

这里存放的是「软件项目工作台」记忆机制的第一版设计，**已从主提案中删除**，仅作为研究资料保留。

归档原因（用户结论）：

- 初版把工程记忆做成了「SQLite 账本 + 四层/七类记忆 + claim/verified + 注入预算 + 蒸馏协议 + 使用期六个时刻」，
  **过于复杂**，不适合真实使用。
- 方向（分片、分职责、分模块、记忆互不干扰）是对的，但执行方案把不同职责/不同 agent 的记忆混在一起，
  且依赖大量文档阅读，会稀释 agent 注意力。
- 下一轮调研方向：**分层 + 分片**（每片有明确 owner/读写者/可见性），参考：
  - Anthropic《The components of agent memory》（memory notes / dreaming / memory hierarchy / 单写者分片）
  - TencentCloud/TencentDB-Agent-Memory（四类记忆资产 + 分层 L0-L3 + ACL/Agent Loadout）
  - lumio 文档体系复盘（方向对、执行错：多 agent 各认一块、会话开得太随意、文档阅读稀释注意力）

文件说明：

| 文件 | 原位置 | 内容 |
|---|---|---|
| project-memory-design.zh.md | docs/ | 四层记忆 + SQLite schema + 评测 |
| memory-in-use-design.zh.md | docs/ | 使用期六个时刻 + DSH 运行时映射 |
| memory-in-use-gap-audit.zh.md | docs/research/ | 现有设计的使用期缺口审计（仍可参考） |
| memory-in-use-external-patterns.zh.md | docs/research/ | 外部产品记忆交互调研（仍可参考） |
| project-workbench-design.before-memory-removal.zh.md | docs/ | 删除记忆章节前的主提案快照 |

主提案（[docs/project-workbench-design.zh.md](../project-workbench-design.zh.md)）已删除 §12.4/§12.7；
新方案定稿前不再写入。
