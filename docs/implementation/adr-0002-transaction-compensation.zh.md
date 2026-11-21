# ADR-0002：gate / approval / evidence / export 的统一事务与补偿模型

> 状态：**已批准（v4 实现）** · 2026-11-20
> 影响面：`host/project.js`、`host/export.js`、`host/tools/pm-tools.js`、`host/schema.js`(export_outbox)
> 关联：ADR-0001；`docs/workbench-design-logic.zh.md` 决策 3

## 1. 背景：一个事务里塞了两种介质

批准一个门禁要做五件事，它们的可事务性完全不同：

| 步骤 | 介质 | 能否进 SQLite 事务 |
|---|---|---|
| A. 决策落定 + approvals 行 + 事件 | DB | 能 |
| B. 冻结文档（`doc_versions.frozen`） | DB | 能 |
| C. 导出文件到 `docs/` | **文件系统** | **不能** |
| D. 阶段推进 | DB | 能 |
| E. 判据复跑（async IO） | 外部进程/worker | **不能**（tx 是同步的） |

v1 把 A/B/C/D 全塞进一个 `db.tx`。这产生两个都无法重试修复的失败形态：

1. **C 中途失败 → 事务回滚，但磁盘上已经写了一部分文件。** 重试无法判断上一轮写过哪几篇。
2. **C 成功但 A/B/D 提交失败 → 文件已落盘，DB 里没有 `exports` 行。** 人可以看见文件，
   但系统认为没导过；下次导出会覆盖，历史不可追溯。

## 2. 决策

**意图先行（intent-first）+ 事务外落盘 + 可补偿**：

```text
① preflight   (tx 外, 只读)   判据复跑 → 阶段守卫 → 文档快照校验 → 审批仍有效校验
                              ↓ 任一不过：整体拒绝，未写任何状态，重试安全
② commit      (tx 内, 原子)   决策落定 → 冻结 → 阶段推进 → approvals(含 epoch)
                              → 导出「意图」写 export_outbox → gate/approve 事件
                              ↓ 提交成功 = 人签的字已生效（不可逆）
③ apply       (tx 外)         按 outbox 逐条写文件（原子 rename），逐条回填 status/hash
④ settle      (tx 内)         导出结果回写审批 payload；有失败则写 gate/export_failed 事件
```

补偿规则：

- `export_outbox` 每行 = 「应该有一个文件在 path，内容 hash 应为 desired_hash」。
  这是 DB 与文件系统之间的**对账表**。
- 失败立刻自动重放一次（瞬时 IO 失败占多数）；仍失败就留在 `failed` 等人工补偿。
- `POST /exports/replay`（面板按钮：重新生成导出）按 batch 重放，内容从 DB 重新渲染
  （确定性 → 同 hash），幂等。
- **绝不因为导出失败而回滚阶段推进**：阶段推进是不可逆的人签名，文件是可再生的派生物。
  为派生物回滚签名，等于把不可逆改成可逆，比留个洞更糟。

## 3. 同一决策还统一了三处审批语义

| 问题 | v1 | v4 |
|---|---|---|
| 重提交后的旧 pending 行 | 留在表里，永远批不掉 | 标 `superseded` + 原因 + `superseded_by`，保留历史 |
| 批准「哪一份提交」 | 按 `ORDER BY rowid DESC` 猜 | `approvals.epoch` 单调；preflight 之后再复核一次「仍是最新 pending」 |
| 谁签的字 | 字符串 `'user'` | `approval_signers`（subject/identity/source/时间）+ 报告 submitter 与 approver 是否同一人 |

## 4. 备选方案与取舍

| 方案 | 取舍 | 结论 |
|---|---|---|
| A. 保持单事务（v1） | 简单，但半写入无法修复 | 否 |
| B. 先写文件后写 DB | 文件成功 DB 失败时留下孤儿文件 | 否 |
| C. 意图 + outbox + 补偿（**采用**） | 多一张表、多两步 | **是** |
| D. 用临时目录整体 rename | 只能覆盖「全量快照」；单篇导出仍无法原子 | 部分采用（快照已先清空再写） |
| E. 导出失败就回滚阶段 | 语义错误（把不可逆变成可逆） | 否 |

## 5. 后果

### 正面
- 「批准成功但导出失败」是一个**可收敛的中间态**：有 outbox 行、有事件、有面板按钮。
- 导出失败不再被当成成功：`exports.status` 为 `failed` 且带 `error`。
- 崩溃恢复可对账：任何时候都能回答「这个批次还差几个文件」。

### 负面
- 多一次表写入与一次额外事件（失败时）。
- 阶段推进与文件落地之间存在一个短暂的不一致窗口（毫秒级）。
  **这是有意的**：把窗口变成「可查询 + 可补偿」比试图消除它更可靠。
- 全量快照仍先 `rmSync` 再写（无法原子），但每个文件的意图照常落 outbox，部分失败仍可补偿。

## 6. 验证方式

| 断言 | 位置 |
|---|---|
| 导出失败 → outbox 留 failed 行 + exports 标 failed + 意图不回滚 | `unit/failure.test.mjs`「导出失败可补偿」 |
| 修复环境后 replay 收敛到 `complete=true` | 同上 |
| 导出失败时阶段仍然推进、事件齐全、签名被记录 | `unit/failure.test.mjs`「门禁批准：导出失败不回滚阶段推进」 |
| 批准后冻结/导出/推进/approvals + 唤醒 PM | `unit/api.test.mjs`、`e2e/negative.test.mjs` |
| 旧审批被 superseded、epoch 单调 | `unit/contracts-v4.test.mjs`「审批代次」 |
