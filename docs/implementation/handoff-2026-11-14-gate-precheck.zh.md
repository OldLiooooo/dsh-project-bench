# 交接：门禁判据接入 + P1 阻断项修复

> 日期：2026-11-14 · 目标：**B + A**（先修门禁状态机缺陷，再把判据接进门禁）
> 前置：[坑位预演](plugin-project-pitfalls-dryrun.zh.md) · [业务逻辑审查](implementation/business-logic-review.zh.md) · [只通过插件治理·实施计划](research/plugin-only-governance-implementation-plan.zh.md)

---

## 1. 做了什么（两批，都是加法）

### 批次 A：P1 阻断项修复（4 条真实缺陷）

| # | 缺陷 | 修复位置 | 语义变化 |
|---|---|---|---|
| A1 | 门禁可提交给**未来阶段**（S1 active 时批准 S4 → 两个 active） | [project.js](../workbench/host/project.js) `validateGateTarget` + [pm-tools.js](../workbench/host/tools/pm-tools.js) | 提交与批准两端都校验：阶段存在 / gate 匹配 / 恰一个 active；非法→ `GATE_STAGE_INVALID` |
| A2 | 批准时按 stage 现场重查文档，**提交的 docIds 被忽略**（提交 A 却冻结 B） | `applyGateApproval` 改读 `approvals.snapshot_json` | 只冻结**提交时那一组**；未提交的同阶段文档不再被连带冻结 |
| A3 | 审批**不绑定版本**（提交 v1 后追加 v2，原审批冻结 v2） | `validateSubmittedDocuments` | 快照钉 `docId@version@hash`；内容变动 → `STALE_APPROVAL`，必须重新提交 |
| A4 | 收工**不校验租约**、返回值**硬编码 `review`** | [task-tools.js](../workbench/host/tools/task-tools.js) | 写库前 `assertWriteScope`（被接管 → `LEASE_HELD`）；返回值取自更新后的实际记录（failed → blocked） |

设计取舍（重要）：
- **零阶段行的项目保持宽松**（`stages.length === 0` 时不做阶段推演），否则旧库/headless profile 会被误伤。有阶段机时严格。
- API 层不强制新字段（向后兼容）；强制点放在工具层（agent 走的那一层）。

### 批次 B：判据接进门禁（M2 最小切片）

新增 [checkers.js](../workbench/host/checkers.js)（约 150 行），`gate_submit` 在建决策**之前**跑机检：

```text
PM gate_submit
  → 阶段守卫（A1）→ 文档快照（A2/A3）
  → runProjectCheckers(root)         // <root>/tools/engineering/checker.mjs + closeout.mjs
      ├─ FAIL      → 抛 GATE_PRECHECK_FAILED（带 issues 原文），不留 pending/决策卡
      ├─ PASS      → addEvidence(kind:'check')，进审批快照 checks[]
      └─ 无判据文件 → skipped=true，如实标注「本次只有人工判据」
  → 建 pending approval + gate 决策卡 → 等人批准
```

**fail-closed 三态**（这是这套机制的价值所在）：
- 判据说不过 → 拒绝
- 判据跑不起来 → 也拒绝（`CHECKER_ERROR`）——「跑不通」不等于「通过」
- 完全没有判据 → 放行但**明确标注跳过**，不假装通过

判据来源不绑定仓库：默认 `tools/engineering/*.mjs`，可在 `project.json.checkers` 覆盖。

---

## 2. 怎么验证的（全部可复跑）

### 2.1 验证路径说明（先说清楚）

本会话 `ops_bash` 与 `child_process.spawn` **全量被拒**（`EXECUTOR_UNAVAILABLE`：niubash 硬链接池耗尽；`spawn EPERM`）。
因此**官方命令一条都没跑**，全部改为 **in-process 等价验证**（PTC `run_code` 直接 import 测试模块）：

- 测试跑批器：`.artifacts/wb-verify.mjs`（`makeSuite()` 型走 `runCases`，`node:test` 型捕获 reporter 输出计数）
- 语法门禁：直接调 `check-syntax.mjs` 的 `checkSyntax()`（它自带 `isMain` 守卫，import 无副作用）

**这是本次的证据强度上限，请据此打折看待**：HTTP/SSE 走的是真实 `node:http` 路由服务器（等价），
但「真实实例 + 真实模型」这两层本轮**没有跑**。

### 2.2 结果

| 套件 | 结果 | 备注 |
|---|---|---|
| `checkSyntax()` | **PASS**，45 文件 / 38 parsed / 0 syntax / 0 import | 含新增 `host/checkers.js`、2 个 probe |
| `tests/unit/db.test.mjs` | 30 / 0 | |
| `tests/unit/api.test.mjs` | 16 / 0 | 门禁 seed 补了提交快照 |
| `tests/unit/tools.test.mjs` | **22 / 0** | 原 11 → 新增 11 例（6 例 P1 回归 + 4 例判据 + 1 例真实判据） |
| `tests/unit/acceptance.test.mjs` | 17 / 0 | |
| `tests/e2e/negative.test.mjs` | 10 / 0 | |
| `tests/e2e/ui-client.test.mjs` | 7 / 0 | |
| `tests/e2e/dev-instance.test.mjs` | 8 / 0 | |
| `tests/e2e/replay-14-steps.mjs` | **17 / 0 pending** | 6 个门禁全部改为携带提交文档快照 |

### 2.3 真实判据的证据（不是模拟）

```text
$ node workbench/tests/probes/gate-real-checkers.mjs
PASS  真实仓库跑真实判据（应红灯）  — 机检失败：repository=fail(5) / closeout=fail(1)，301ms
      issues=6 codes=DIR_UNREGISTERED,MEMORY_BEHIND
PASS  干净仓库跑真实判据（应绿灯）  — 机检通过：repository=pass / closeout=pass，1ms
PASS  判据故障 → fail-closed      — 机检失败：repository=ERROR(判据自身故障)
[gate-real-checkers] passed=3 failed=0
```

判据是 **lumio 仓库自己的** `tools/engineering/checker.mjs`（16 条结构规则，374ms）+ `closeout.mjs`（3 条收尾对账，9ms），
纯 Node 只读，插件 Host 进程直接 import，不 spawn、不 shell、不改被检查仓库。

`tests/unit/tools.test.mjs` 里那条例 **原样拷贝真实判据**再提交门禁，断言 `GATE_PRECHECK_FAILED` + 带 `DIR_UNREGISTERED` 原文 +
**不留 pending approval / 不留决策卡**。找不到 lumio 时自动 skip（他机不因此失败）。

---

## 3. 中途抓到并修掉的 2 个自身缺陷

1. **`checkers.js` 的 skipped/failed 混淆**：`executed` 只在成功返回时递增，导致「所有判据都报错」被标成
   `skipped=true`（= 未发现判据 = 放行）。探针第 ③ 项当场抓到。已改为「进调用即计数」，报错算跑过并失败。
   ——这就是 fail-closed 设计的意义：它把自身的 bug 也变成了红灯。
2. **probe 里的 `split('\n')` 被模板串吃掉转义**，导致整个文件语法错。已改为 `split(String.fromCharCode(10))`。

---

## 4. 偏离与遗留（如实记档）

| 项 | 状态 | 说明 |
|---|---|---|
| 官方命令（`node --test`、`node <script>`） | **未执行** | bash/spawn 全被拒；全部改用 in-process 等价验证。执行器恢复后应补跑一轮 |
| `instance-http.mjs` / `live-e2e.mjs` | **未跑** | 需要真实实例 + cookie + 真模型；本轮不具备条件 |
| 浏览器目测（面板/决策卡） | 未做 | 与本次改动无关（`host/` 层），但 UI 侧未回归 |
| `.project` 搬离工作区（实施计划 M0） | **未做** | Q3 拍的是「先不搬、只记档」；单写命门仍未解 —— agent 仍可直连 DB |
| 交付链（commit/push/PR 回填） | 未做 | 方案甲明确「交付事实归 git」，本轮不碰 |
| 判据在门禁**批准**时是否复跑 | 未做 | 当前只在提交时跑；提交到批准之间仓库可能变了。**建议下一轮补**（批准前复跑一次，变了就 `STALE_PRECHECK`） |
| 阶段模板硬编码 S1..S7 | 未改 | 实施计划 §4.1 的真缺口；`project.json.stageTemplate` 仍只写不读 |

---

## 5. 改动面

```text
workbench/host/project.js          +约 130 行（validateGateTarget / validateSubmittedDocuments / gateError / advanceStage 重写）
workbench/host/tools/pm-tools.js   +约 40 行（gate_submit 阶段守卫 + 文档快照 + 机检接线）
workbench/host/tools/task-tools.js +约 12 行（租约守卫 + 返回值取实际记录）
workbench/host/checkers.js         新增，约 150 行
workbench/tests/unit/tools.test.mjs          +11 例
workbench/tests/unit/api.test.mjs            seed 补提交快照
workbench/tests/e2e/negative.test.mjs        门禁用例补提交快照
workbench/tests/e2e/replay-14-steps.mjs      新增 submitGate，6 个门禁带文档快照
workbench/tests/probes/gate-real-checkers.mjs  新增（真实判据探针）
workbench/tests/probes/gate-green-fixture.mjs  新增（绿灯 fixture）
```

---

## 5.1 追加：批准时复跑判据（同日第二批）

补上了上一版留下的最后一环：**门禁提交时是绿的，不等于人点批准时还是绿的**。

### 做了什么

在 [project.js](../workbench/host/project.js) 新增 `preflightGateApproval`（async，**在 `db.tx` 之外**执行；
`db.tx` 是同步的，await 进去会撕裂事务边界）。`resolveDecisionAction` 因此变为 async，两个调用方一并 `await`：
[http.js](../workbench/host/http.js)（面板 POST /decision）与 [cards.js](../workbench/host/cards.js)（聊天卡片）。

```text
人点批准
  → preflightGateApproval（事务外）
      ├─ 提交快照无 checks（提交时就没判据） → 跳过，{skipped:true, reason:'no-checks-at-submit'}
      ├─ 复跑 FAIL                          → STALE_PRECHECK（带 issues 原文）
      ├─ 复跑 PASS 但与提交时不一致          → STALE_PRECHECK（带 drift 明细）
      └─ 复跑 PASS 且一致                    → 继续
  → db.tx：resolveDecision + 冻结 + 导出 + 推进阶段
  → 复跑摘要写进 approvals.snapshot_json 与 gate/approve 事件
```

**漂移判定**（`detectCheckDrift`）：按判据 name 对齐，比 `status` 与 `resultHash`；
新判据出现 / 旧判据消失 / 结果变化都算 drift。`resultHash` 覆盖 `ok + issues + counts`——
只对前两者做 hash 会漏掉「仓库规模变了但结论没变」这类漂移（这一条是写测试时才发现的）。

### 新增验证

`tools.test.mjs` 再加 3 例（11 → 22 → **25**）：

| 用例 | 锁住什么 |
|---|---|
| 提交后变红 → 批准被拒 | `STALE_PRECHECK`；决策仍 pending；**阶段不动**；**一篇都没冻** |
| 提交后规模变化（仍绿）→ 批准被拒 | 走 `result-changed` 分支，证明比的是 hash 不是 ok |
| 提交后一致 → 放行 | 复跑结果进 `actions.precheck` + `approvals.snapshot_json` + `gate/approve` 事件 |

### 复验（in-process，仍非官方命令）

    checkSyntax()                  PASS（47 文件 / 0 syntax / 0 import）
    unit db/api/tools/acceptance   30 / 16 / 25 / 17，全 0 fail
    e2e negative/ui-client/dev     10 / 7 / 8，全 0 fail
    replay-14-steps                17 / 0 pending
    gate-real-checkers 探针        3 / 0（真实仓库红灯 438ms、绿灯 fixture、判据故障 fail-closed）

### 仍未做

- **官方命令与真实实例/真实模型仍未跑**（bash + spawn 全程 EPERM），证据强度同上一条
- `.project` 仍在工作区内（M0 未做）→ 单写仍是自觉
- 阶段模板仍硬编码 S1..S7

---

## 6. 下一会话从哪里接

按性价比排序：

1. **补跑官方命令**（执行器恢复后）：`node --test workbench/tests/unit/`、`replay-14-steps.mjs --strict`、`instance-http.mjs --strict`。若结果与本文不符，以官方命令为准。
2. ~~批准时复跑判据~~ —— **本轮已完成**（见 §5.1）。
3. **阶段模板从 project.json 读回**（实施计划 §4.1），否则换到 lumio 生命周期会对不上。
4. **M0 搬 `.project`**：这一步没做，「单写」就始终只是自觉。
