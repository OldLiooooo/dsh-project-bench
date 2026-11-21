# ADR-0003：失败状态、租约栅栏、切片作用域、预算/错误/身份

> 状态：**已批准（v4 实现）** · 2026-11-20
> 影响面：`schema.js`(v4)、`store.js`、`leases.js`、`scope.js`(新)、`identity.js`(新)、
> `orchestration.js`、`http.js`、`tools/task-tools.js`、`tools/pm-tools.js`、`client.js`
> 关联：ADR-0001、ADR-0002

本文件把六个相关但独立的修正放在一起，因为它们共享同一批 schema 变更（v4）。

## 1. 失败状态（spawn / finish / 重启对账）

### 1.1 问题

| 缺口（设计逻辑 §7 已列） | 实测后果 |
|---|---|
| `sessions` 无 error 列，`SPAWN_FAILED` 只抛给调用方 | 会话停在 `failed`，但没人能回答「为什么」 |
| 派活失败不回滚 task | 任务挂在已失败的会话上（幽灵指派），面板显示「进行中」 |
| 失败路径零测试 | 所有 `startActivation` 替身永远成功 |
| 重启对账只写 `status='interrupted'` | 用户重开面板看到「中断」，但不知道是重启还是崩溃 |

### 1.2 决策

1. **失败是一个带原因的终态**：`sessions.failure_code / failure_detail / failure_at`。
   `endSession(status='failed'|'interrupted')` 必须给出（缺省码 `FAILED_UNSPECIFIED` / `INTERRUPTED`）。
2. **幂等结束会补齐原因，但不会洗掉原因**：旧代码路径只写 `status='failed'` 时，
   再次 `endSession` 会把缺失的 `failure_code` 补上（而不是直接 `return` 原样返回）。
3. **派活失败必须回滚任务**：`task.status → pending`、`assignee_session → NULL`，写一条 `task/status` 事件。
4. **重启对账要区分并计数**：`interrupted / leasesReleased / orphanLeases / phantomTasks / errors`，
   每条 interrupted 都带 `HOST_RESTART` + `dshSessionId` + `attempt`。
5. **`attempt` 序号**：同 (切片,角色) 的历史会话数 + 1，让「第几次尝试」可查询。
6. **DB 层兜底**：`guard_task_session_terminal` 阻止任务会话从终态复活
   （复活会让「租约已释放 + 又持租」与 attempt 账同时错位）。

## 2. 租约栅栏（fencing token）

### 2.1 问题

只比对「当前 holder 是谁」存在一个无法自证的窗口：

```text
A 持租 → A 卡住（进程挂起/GC/await）→ 租约过期 → B 抢占 → A 醒来继续写
```

在 A 的写路径里，「检查 holder」与「真正写」之间仍可能被抢占（TOCTOU）。

### 2.2 决策

`leases.epoch` 单调递增，每次 acquire 换发（续期沿用）；spawn 时把当次 epoch 写进
`sessions.context.fenceEpoch`；所有写路径（`doc_write` / `evidence_add` / `artifact_add` /
`doc_freeze` / `session_finish_task`）通过 `assertWriteScope` 比对令牌，不符即 `LEASE_FENCED`。

关键细节：

- **释放后重新获取也换新令牌**：否则「释放 → 重取」会复用旧 epoch，让已失效的写重新变合法。
  实现上把历史最大 epoch 记进 `project_meta['lease.epoch.<sliceId>']`。
- **DB 层兜底**：`guard_lease_epoch_monotonic` 禁止 epoch 回退。
- 拒绝的语义是「这次授权失效」，不是「这个会话被拉黑」：出示正确 epoch 即可继续写。

## 3. 切片作用域（真实 diff 校验）

### 3.1 问题

`session_finish_task` 只要求调用方传 `noOutOfScopeChanges=true`。**声明永远能写 true**，
所以「片外零改动」在 v1–v3 从未被真正检查过。

### 3.2 决策

引入 `host/scope.js`：采集**真实工作区 diff**（`git status --porcelain` + `git diff --numstat`），
按 `slice_scopes` 表归因成三类，并区分「能判定」与「不能判定」：

| 结论 | 含义 |
|---|---|
| `verifiable=true, ok=true` | 真的校验过且干净（唯一可用于门禁的结论） |
| `verifiable=false, ok=true` | 无 git 或未声明作用域 → **如实标注无法校验**，不伪造通过 |
| `ok=false` | 抓到可判定违规：`CROSS_SCOPE_CHANGES`（改了别人的已声明地盘）或 `OUT_OF_SCOPE_CHANGES` |

三条判定原则：

1. **能判定才判，不能判定就标注** —— 非 git 项目不能被永久卡死，但也不能假装通过。
2. **`crossScope` 在任何策略下都拒绝** —— 那不是「本切片范围没声明清楚」，而是侵犯了别人**已声明**的范围。
3. **错误排序按「先补什么」**：证据校验（1 条命令可补）排在作用域校验（要回滚/改范围）之前。

配套：新增 PM 工具 `slice_scope`（list/declare/clear）。没有声明入口，整套校验就永远
停在 `verifiable=false` —— 可判定的前提是有人能声明边界。

## 4. 统一 prompt 预算

**问题**：只有 `compileContext` 受预算约束；`buildTaskAssignment` 把角色卡与 L2 之外的
PM 交代与验收**无上限**拼进去。PM 写一段长 brief 就能让开场注入突破 2000 token。
（实测修复前 2020 > 2000：骨架估算漏掉一个 `## 本任务` 标题就溢出。）

**决策**：整段开场提示统一受 `hardLimit`（2000）。组装后**量真实占用**，按超出量依次回收：
① PM 交代（PM 可再发消息补）→ ② 验收（硬信息，最后才动）→ ③ 整体硬截断（兜底）。
返回 `used / hardLimit / truncated{brief,acceptance} / degraded`，可被测试与 PM 核对。

## 5. HTTP 错误详情

**问题**：错误响应只有 `{code, message}`。门禁失败看不到 issues 原文、租约冲突看不到持有者、
栅栏失效看不到 epoch 差、作用域越界看不到文件清单。面板只能显示一句看不懂的话。

**决策**：统一补三块 + 限体积：

- `error.issues[]`（≤40 条，只保留 code/path/message/check）
- `error.details`（白名单字段：holder/epoch/presented/gate/stage/batchId/attempt/failureCode…；>6000 字符则截断并标注）
- `error.hints[]`（机器可读的下一步：`resubmit_gate` / `review_diff` / `release_and_respawn` / `replay_exports` …）

客户端 `errorInfo` 相应扩展（issues/hints/details），`errorText` 把第一条建议拼进文案，
`errorDetailLines` 供展开显示。

## 6. 多人身份模型

**问题**：`decidedBy` 默认字符串 `'user'`。共享实例上 A 与 B 的批准长得一模一样，
「人批准」实际退化成「请求通过了宿主 cookie 围栏」，而 cookie 是浏览器共享的。

**决策**（刻意简单，避免假装有大权限系统）：

| 来源 | 何时成立 | 可信度 |
|---|---|---|
| `host` | 宿主 `connection.identity(req)` 明确给出 subject | 高 |
| `declared` | 面板显式 `actingAs` / 请求头 / 旧接口 `decidedBy`（≠'user'） | 中（可伪造） |
| `local` | 兜底；以及旧默认值 `'user'` | 低 |

- `identities` 表按 (project, subject) 唯一；来源只允许**升级**（local → declared → host），不允许降级，
  避免历史记录被改写成更弱的声明。
- `approval_signers` 记录每次审批签名的结构化身份（approvals.approved_by 仍存 subject 字符串，向后兼容）。
- **明确不做**：密码、RBAC、「谁能批哪类门禁」；**也不阻止**同一 subject 既提交又批准，
  只如实报告 `separation.separated`。假装阻止会造出「换个名字就绕过」的安全感。

## 7. 验证方式

| 断言 | 位置 |
|---|---|
| spawn 失败：会话带失败码/详情/时间、租约释放、任务回滚 | `unit/failure.test.mjs` |
| 租约冲突：不留 active 会话、失败原因 `LEASE_ACQUIRE_FAILED` | 同上 |
| 抢占后旧会话写被拒 `LEASE_FENCED`（含错误里的 epoch/presented） | 同上 |
| 释放后重取不复用旧 epoch | 同上 |
| 对账：中断记 `HOST_RESTART`、孤儿租约清、幽灵任务回滚、live 会话不动 | 同上 |
| 作用域：无法校验如实标注；归因三类分开；跨域拒绝 | 同上 |
| 开场简报 ≤ 2000 token 且标注裁剪 | `unit/contracts-v4.test.mjs` |
| 身份解析优先级与来源标注；来源只升级不降级 | 同上 |
| 错误码稳定（404/405/413/400/401） | 同上 |
| 审批 epoch 单调、会话终态不可复活、租约 epoch 不可回退 | 同上 |
| v3 → v4 迁移补列补表补触发器，且幂等 | `unit/db.test.mjs`「v4 迁移」 |
| 14 步业务回放、门禁真实判据、治理全链路 | `e2e/replay-14-steps`(17/0)、`probes/gate-real-checkers`(3/0)、`probes/governance-e2e`(27/0) |
