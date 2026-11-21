# ADR-0001：判据信任模型与隔离执行

> 状态：**已批准（v4 实现）** · 2026-11-20
> 影响面：`workbench/host/checkers.js`、`pm-tools.js`(gate_submit)、`project.js`(preflight)、`contracts-v4.test.mjs`
> 关联：`docs/workbench-design-logic.zh.md` 决策 2；`docs/research/governance-facts/plugin-constraint-audit.zh.md`

## 1. 背景与约束

门禁的机器判据来自**仓库自己的代码**（`tools/engineering/checker.mjs` 等）。它和被测代码同源，
运行在插件 Host 进程里，与插件共享 `process.env`、文件句柄、模块图与网络能力。因此必须先回答一个
被 v1 跳过的问题：

> 跑这段判据时，把它当成什么？

v1 的隐含答案是「完全可信」——直接 `await import()`，没有超时，没有隔离。后果有三条实测事实：

| 事实 | 后果 |
|---|---|
| 判据里 `while(true){}` 会卡死 Host 事件循环 | 整个面板/SSE/所有会话一起失去响应（`Promise.race` 打断不了同步循环） |
| 判据抛错时只有 `String(error)` 进 issues | 失败原因不可比对、不可重放 |
| 判据能读 `process.env` 与其它工作区路径 | 「判据通过」可能依赖与仓库无关的宿主状态 |

同时有一条**物理约束**必须先摆出来（这是本决策的边界，不是取舍）：

- 实测本环境（PTC / DSH 沙箱）中 `child_process.spawn` 一律 `EPERM`（`spawnSync`/`execFile`/`spawn` 全部失败）。
- 因此**进程级隔离**（`child_process` + `--permission` + 只读挂载）在本运行时里拿不到。
  退而求其次：`worker_threads` 可用，且能可靠 `terminate()`。

## 2. 决策

采用**两级信任模型 + 失败关闭**，并把「信任级别」变成可查询的输出字段（而不是文档里的一句话）：

| 级别 | 名称 | 执行方式 | 能解决 | 不能解决 |
|---|---|---|---|---|
| T0 | `in-process` | 直接 `await import()` 到 Host | 无（仅向后兼容） | 卡死、污染、读宿主 |
| T1 | `worker`（**默认**） | `worker_threads` + 超时 `terminate` + 纯 JSON 回传 | 卡死、跑飞、模块污染、结果不可序列化 | **恶意判据偷数据**（同进程空间，同 fs 权限） |

配置入口（`project.json`）：

```json
{
  "checkers": [
    { "name": "repository", "module": "tools/engineering/checker.mjs",
      "export": "checkRepository", "kind": "async",
      "trust": "worker", "timeoutMs": 20000 }
  ],
  "checkerPolicy": { "defaultTrust": "worker", "requireIsolation": false }
}
```

判定规则（fail-closed，与 v1 的语义一致并收紧）：

| 情况 | 行为 |
|---|---|
| 判据 `ok:false` | 拒绝 `GATE_PRECHECK_FAILED`，带 issues 原文 |
| 判据抛错 | 拒绝，`CHECKER_ERROR` |
| 判据超时 | **强制 terminate** 后拒绝，`CHECKER_ERROR`（消息里写明超时毫秒） |
| worker 崩溃/提前退出 | 拒绝，`CHECKER_ERROR` |
| 模块无导出函数 | 拒绝，`CHECKER_ERROR` |
| 判据文件不存在 | 跳过并标注 `module-missing`（没有判据的项目不该被卡住） |
| 配置 `in-process` 但 `requireIsolation=true` | **拒绝**，`CHECKER_ISOLATION_REQUIRED`（不是 skipped） |

> 最后一条是这次修正的重点：初版把它记成 `skipped`，而 `skipped` 的语义是「没有判据」，
> 会让门禁在没有机器判定的情况下放行 —— 恰好抵消了配置项想达到的目的。

## 3. 备选方案与取舍

| 方案 | 取舍 | 结论 |
|---|---|---|
| A. 全部 `in-process`（v1 现状） | 零改动，但卡死/污染无解 | 否 |
| B. `worker_threads`（**采用**） | 能解决卡死与污染；不是安全边界 | **是** |
| C. `child_process` + `--permission` | 真隔离，但本运行时 `spawn` EPERM | 否（**不可用**，不是不想做） |
| D. 只跑白名单哈希的判据 | 能挡改动，但每次改判据都要重新登记 | 否（挡住正常迭代） |
| E. 不做机检，只靠人 | 回到「人肉约定」病根 | 否 |

## 4. 后果

### 正面
- 判据死循环不再拖死 Host：实测 300ms 超时在 311ms 内返回并标记 error。
- 门禁的「机器判定」有了可审计的信任标签：`gate_submit` 返回 `machineCheck.trust`，
  审批快照 `snapshot_json.checkTrust` 保存当时的级别，`summarizeCheckRun` 输出里带 `信任：worker`。
- 判据结果只回传纯 JSON（深度/长度有上限），宿主不会因判据返回循环引用而崩。

### 负面 / 已知边界
- **worker 不是安全沙箱**：恶意判据仍可读同进程的文件、发网络请求。
  文档与返回的 `trust.note` 都明写这一点，不制造虚假安全感。
- worker 冷启动开销（每次判据约 30–80ms）。门禁是低频操作，可接受。
- 判据若依赖模块级单例状态（缓存），worker 每次都是新实例 —— 这是**期望行为**（可重复），
  但会暴露原本靠缓存掩盖的慢查询。
- 同步判据在 worker 里仍要 `await fn()` 之外的路径（`kind:'sync'` 时直接调用），
  不支持返回 Promise 的 sync 判据（配置写错会在超时处暴露）。

## 5. 验证方式

| 断言 | 位置 |
|---|---|
| 死循环被超时终止，且耗时 < 5s | `unit/failure.test.mjs`「判据失败关闭」 |
| 抛错 / 无导出 / 崩溃都算失败 | 同上 |
| worker 与 in-process 的 trust 被如实标注 | `unit/failure.test.mjs`「判据隔离」 |
| `requireIsolation` 时 in-process 判据失败关闭 | 同上 |
| 真实仓库红/绿双向 + 判据故障 fail-closed | `probes/gate-real-checkers.mjs`（3/0） |
| 门禁被真实红灯拒绝、留不下 pending | `probes/governance-e2e.mjs` ⑪⑫⑬ |

复现：`node workbench/tests/probes/gate-real-checkers.mjs`（需要真实仓库 `tools/engineering/`）。
