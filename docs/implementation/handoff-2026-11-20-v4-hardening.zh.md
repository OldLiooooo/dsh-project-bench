# 交接：v4 治理加固（信任模型 / 事务补偿 / 失败状态 / 栅栏 / 作用域 / 预算·错误·身份）

> 2026-11-20 · 六个议题一次性落地。代码在 `workbench/`，设计论证在 `docs/implementation/adr-0001..0003`。

---

## 1. 六个议题与「怎么解的」

| 议题 | 结论 | 落点 |
|---|---|---|
| ① checker 信任模型 + 是否隔离 | **两级信任**：`worker`（默认，超时可 terminate）/ `in-process`；信任级别作为输出字段回传并存进审批快照 | ADR-0001、`host/checkers.js` |
| ② gate/approval/evidence/export 事务与补偿 | **四段式**：preflight(tx外) → commit(tx内,只写意图) → apply(tx外写盘) → settle(tx内结算)；`export_outbox` 对账 + 可重放 | ADR-0002、`host/project.js`、`host/export.js` |
| ③ spawn / finish / 重启对账失败状态 | 失败成为**带原因的终态**（`failure_code/detail/at`）；派活失败回滚任务；对账分四类计数 | ADR-0003 §1 |
| ④ 切片作用域对真实 diff | 采真实 `git status/diff`，归因 in/cross/out 三类；**能判定才判，不能判定如实标注** | ADR-0003 §3、`host/scope.js`(新) |
| ⑤ lease epoch / fencing token | `leases.epoch` 单调 + `sessions.context.fenceEpoch` + 写路径比对，`LEASE_FENCED` | ADR-0003 §2、`host/leases.js` |
| ⑥ prompt 预算 / HTTP 错误详情 / 多人身份 | 开场简报整体 2000 硬上限；错误带 `issues/details/hints`；身份三级来源 + `approval_signers` | ADR-0003 §4–6 |

---

## 2. 关键决策里最容易被做错的三处（都已修正）

### 2.1 `requireIsolation` 初版记成 `skipped` —— 语义反了
`skipped` 的意思是「没有判据」，会让门禁放行。配置写 `requireIsolation=true` 的人想要的恰恰相反。
已改成 `CHECKER_ISOLATION_REQUIRED` 失败关闭。

### 2.2 导出写在 `db.tx` 里 —— 事务边界的假象
`db.tx` 可重入，所以在 `applyGateApproval` 里调 `exportDocument` 会**在事务内写文件**。
文件系统不参与回滚 → 半批文件无人认领。已改成 `deferWrite` + 事务提交后 `flushPlannedExports`。

### 2.3 「片外零改动」不能拿「无法校验」当通过，但也不能当失败
非 git 工作区 + 未声明作用域时，判「通过」是撒谎，判「失败」会永久卡死所有非 git 项目。
已改成三档：`verifiable=true`（真校验过） / `verifiable=false`（如实标注 unresolved） / `ok=false`（抓到可判定违规）。

---

## 3. 怎么验证（可逐条复跑）

```bash
export DSH_HOME='<workspace>/.artifacts/dshhome-baseline'   # 单元测试必须指到工作区内，否则 EPERM（这本身反证单写成立）

node workbench/scripts/check-syntax.mjs                                  # 53 文件 / 0 语法 / 0 import
node --test --test-isolation=none workbench/tests/unit/                  # 99：98 pass / 0 fail / 1 skipped
node workbench/tests/e2e/negative.test.mjs                               # 10 / 0
node workbench/tests/e2e/ui-client.test.mjs                              # 7 / 0
node workbench/tests/e2e/dev-instance.test.mjs                           # 8 / 0
node workbench/tests/e2e/replay-14-steps.mjs --strict                    # 17 / 0
node workbench/tests/probes/gate-real-checkers.mjs                       # 3 / 0
node workbench/tests/probes/governance-e2e.mjs                           # 27 / 0（不要设 DSH_HOME，否则 ②c 单写探针会误报）
```

**跳过的那 1 例**：`作用域校验（真实 git diff）` —— 本会话沙箱 `spawn` 返回 `EPERM`（`git` 也起不来）。
等价的核心断言由不依赖 git 的「作用域归因」用例覆盖（三类归因 + 模式匹配边界）。
在有 git 的机器上这一例会真的跑 17 行 git 命令。

### 新增测试文件

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `unit/failure.test.mjs` | 16（15 pass / 1 skip） | spawn 失败回滚、租约冲突、栅栏（领域 + **工具路径**）、对账三类、判据 fail-closed、判据隔离、导出补偿、门禁导出失败、doc_export 失败、作用域三档 |
| `unit/contracts-v4.test.mjs` | 10 | 身份解析/落库/签名、HTTP 错误详情与错误码矩阵、鉴权失败关闭、prompt 预算、审批代次与状态机 |

---

## 4. 数据库变更（v3 → v4，幂等）

新增表 4 张：`export_outbox` `slice_scopes` `identities` `approval_signers`
新增列：`sessions.failure_code/failure_detail/failure_at/attempt`、`leases.epoch`、
`approvals.epoch/superseded_reason/superseded_by`、`exports.error/batch_id`、`slices.scope_declared`
新增触发器 4 个：`guard_lease_epoch_monotonic` `guard_task_session_terminal`
`guard_approval_epoch_monotonic` `guard_outbox_done_terminal`（共 11）

> **顺带修掉一个真 bug**：v1/v2 的 `GUARD_TRIGGERS` 只在 `current<2` 时建立，
> 所以 v3 库永远拿不到后加的触发器。已改为每次打开 `ensureGuards()` 幂等补齐。

---

## 5. 仍然存在的边界（不掩饰）

| 边界 | 说明 |
|---|---|
| worker **不是安全沙箱** | 与宿主同进程空间、同 fs 权限。恶意判据仍可读文件。进程级隔离在本运行时不可用（`spawn` EPERM），ADR-0001 已明写，不假装提供 |
| 身份能**追责**但不能**强制分离** | 无密码/RBAC；不阻止同人既提又批，只如实返回 `separation.separated` |
| 非 git 工作区无法校验作用域 | 只能 `verifiable=false` 如实标注（设计如此） |
| 46 个空 catch 仍在 | 多为「失败不影响主流程」的降级路径，审计噪音仍在 |
| 未做反向登记 / 交付链未接 | 与前几轮一致，未动 |
| `instance-http --strict` 与 `live-e2e` 未跑 | 需要真实 `dsh web` 实例 / 真实模型；本会话无法 `spawn` 起实例。上一轮（2026-11-19）10/0 与 4/0 的结论不受本次改动影响（HTTP 路由只增不改契约） |

---

## 6. 下一步建议（按价值排序）

1. **在真实实例上跑 `instance-http --strict`**：验证 `/exports/replay` 与 `/identities` 两个新路由，
   以及新增错误详情在真实 SSE/面板链路下的表现。
2. **给 `slice_scope` 补面板入口**：现在只有 PM 工具能声明作用域，面板看不到「哪些切片已声明」。
3. **把 `separation` 变成面板警告**：目前只是返回值字段，没有 UI 呈现。
4. **审计 46 个空 catch**：区分「有意的降级」与「吞掉真错误」，给后者加 warn + 事件。
5. **考虑 `spawn` 可用后的进程级隔离**：接口已留（`trust` 字段），换实现即可。
