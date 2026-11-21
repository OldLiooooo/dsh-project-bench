# BACKLOG：从「流程执行器」到「合格的 PM」

> 来源：[交付审计 2026-11-21](delivery-audit-2026-11-21.zh.md)。
> 每条都是**独立可开工的切片**，不是「顺手改一下」—— 因为它们要么改 schema，要么改门禁主路径，
> 按本插件自己的原则（设计逻辑 §8）必须走 ADR + 门禁 + 独立验收，不能塞进收尾提交。

排序：先按「阻塞 PM 的定义性能力」，再按成本。

---

## B1 · Verified Done 进入数据模型（**最高价值**）

**为什么**：设计 §6.2 定「唯一进度口径 = 已验证完成」，但 `slices` 的状态枚举是
`open/in_progress/review/blocked/done/archived/cut` —— **没有 `verified`**。
没有这个状态，进度、验证吞吐、一次验收通过率、返工率全都算不出来（没有分母）。
这是「PM 能不能回答进度」的根。

**改动面**
- `schema.js` → v5：`STATUS_ENUMS.slices` 加 `verified`；`slices` 加 `verified_by / verified_at / verified_session`；
  迁移需处理存量 `done` 行（语义映射：`done` → 保持 `done`，只有新流程产 `verified`）
- 新工具 `slice_verify`（与 `slice_update` 分开：**写状态**和**验证**是两种权限）
- 约束：验证者 ≠ 该切片最近一次实现会话（用 `sessions.kind='task'` + `slice_id` 比对），否则拒
  `SELF_VERIFICATION_DENIED`
- 事件：`slice/verify`；`probes/w1-guards` 补一条反证（verified 不可回退到 in_progress）

**验收标准**
1. 未验证的切片不能被门禁计入「已完成」；
2. 实现者调 `slice_verify` 被拒，且拒绝理由可读；
3. 迁移后存量 `done` 行不丢、可查询；
4. 新增 ≥6 例测试（含 2 条负向）。

**需要拍板**：`done` 与 `verified` 的关系——`done` = 交付方自认完成，`verified` = 独立验收通过？
还是把 `done` 直接改名？改名会破坏已有 `events` 的 payload（append-only，不能改历史）。

---

## B2 · `project-qa` preset：让「建造者不验收」从文案变成机制（**高价值 / 低成本**）

**为什么**：设计 §10.5 问题 4 早就拍板「MVP 用独立 QA 会话」，但 `workbench/presets/` 只有
`project-office` 与 `project-task`。现在测试角色和实现角色是同一个 preset，独立性只靠角色卡里的
「独立验证，不改产品代码把测试改绿」这句提示词 —— 而提示词不算约束（设计逻辑 §8 第 1 条）。

**改动面**
- `cordis.patch.yml` 加第 3 个 preset `project-qa`：只读 fs（`write:false`）+ 允许跑测试命令 + 无 `ask_user_question`
- `orchestration.js` 的 `PROJECT_PRESETS` 加 `project-qa`；`session-hooks.js` 同步
- `pm-tools.js`：`session_spawn_task` 在 `role='测试'` 时默认用 `project-qa`
- tools 可见性：QA 会话应只有读工具 + `evidence_add` + `slice_verify`（B1）

**验收标准**
1. 拉起 QA 会话后，它**调不动** `doc_write` / 文件写工具（工具层拒绝，不是隐藏）；
2. 不影响现有 PM/任务会话的工具可见性（PM 23 / 任务 15 断言不变）；
3. `e2e/replay-14-steps` 第 11–12 步改用 QA preset 后仍 17/0。

---

## B3 · 阶段写路径硬控制（**设计缺口最大的一项**）

**为什么**：设计 §12.1 写了 8 阶段 + 6 门禁 + **每阶段写路径硬控制**（S1 禁写 `src/**`），
并给了四层拦截方案。代码里 **0 实现**。而这恰恰是 lumio 事故的原始病因
（`docs/lumio-git-ci-postmortem.zh.md`：设计阶段就产出了 `src/` 的提交）。

**改动面（建议只做「最小可用版」，不做四层）**
- `project.json.stagePolicy`：`{ allowedPaths, forbiddenPaths }`（已有 `deliverableTypes` 可作为第三种约束）
- 工具层拦截：`doc_write` 校验 type 是否属于当前阶段 `deliverableTypes`；
  `session_finish_task` 的 `scope.js` 归因里加「阶段外改动」一类 → `STAGE_VIOLATION`
- 门禁审计（最后防线）：`gate_submit` 前检查 `git status` 里有没有当前阶段禁写路径 → 有则拒
- 明确**不做**：`ctx.tools.pre-execute` / `guard`（源码核对过，fs 策略槽被官方占用，第三方不能可靠叠加）、
  bash 命令分类（只能启发式，会误伤；策略是「如实报告，不声称绝对不可能」）

**验收标准**
1. S1 阶段对 `src/**` 的改动 → 收工被拒，理由带路径与阶段；
2. 阶段推进后同一改动被放行；
3. 非 git 工作区 → `verifiable=false` 如实标注，不伪造通过；
4. `probes/governance-e2e` 加一条「S1 写 src 被拒」的断言。

**需要拍板**：`deliverableTypes` 要不要真的拦 document type？（会与现有 `tools.test` 里
「S1 阶段 `doc_write(type='prd')`」的写法一致，但要确认没有测试依赖「S1 也能写 report」）

---

## B4 · 决策卡 `deadline` + 超时策略（**低成本 / 补数据前提**）

**为什么**：`decisions.deadline` 列在 schema 里，`mapDecision` 也读它，但
`decision_create` **没有这个参数**、client **不展示**。设计 §6.3 的升级规则
（>48h 非不可逆用默认值继续、>24h 不可逆挂起并提醒）全靠它。

**改动面**
- `pm-tools.js` `decision_create` 加 `deadline`（ISO 时间）+ `defaultOption`（超时用哪个）
- client 决策卡显示「截止 X（还剩 Y）」+ 逾期标红；`locale/*.json` 加词条
- **不做**自动执行超时动作（需要调度器；先只做「显示 + 逾期可见」）

**验收标准**
1. 决策卡显示截止与剩余时间；
2. 逾期卡在概览里可被筛出；
3. 无 deadline 的老数据不报错。

---

## B5 · `evidence.verified_by` 真实写入（**低成本**）

**为什么**：列存在、`mapEvidence` 读它，但**没有任何写入点** —— 「谁验收的」不可追溯。
这是 Verified Done（B1）的配套：没有验收人，`verified` 状态只是换了个名字。

**改动面**：`store.addEvidence` 支持 `verifiedBy / verifiedAt`；`slice_verify`（B1）时回填该切片的证据；
READ 侧在 `doc_get` / 证据墙里显示。

**验收标准**：验收后证据行的 `verifiedBy` 有值且能追到身份（走 `identity.js` 的三级来源）。

---

## B6 · `period` 与周期语义（**需要产品决定**）

**为什么**：`snapshot.js:122` 读 `getMeta('period')`，全仓库**没有写入点** → 周期永远是当前月。
设计 §5.4 的两周周期 + cooldown、§6.2 的「每周期验证吞吐」都建在它上面。

**改动面**：`project_meta` 存 `period.current / period.startedAt / period.lengthDays`；
`project_init` 与一个 `period_roll` 工具负责推进；快照/指标读它。

**需要拍板（这是没做的原因）**
1. 周期长度默认多少？（设计建议 2 周 + 2–3 天 cooldown）
2. 谁推进周期——人点、PM 自己、还是日历到期自动？
3. 周期结束时未完成的工作项怎么处理——自动回 parking lot？需要人确认？

---

## B7 · 维护债（非功能，但会咬人）

| 项 | 说明 |
|---|---|
| 58 个空 catch | 区分「有意的降级」与「吞掉真错误」；后者加 warn + 事件（`context/downgrade` 已有先例） |
| `probes/seats-realdata.mjs` 取样假设过期 | 它假设 `snap.sessions[0]` 是 PM，但真实库里第一条是「架构」→ 恒 FAIL。改为按 `kind==='pm'` 取样 |
| `links` 表从来没人写 | 要么给它一个写入点（证据↔文档↔决策），要么删表（v5 迁移里一起做） |
| 46→58 这类计数漂移 | 建议把「文档里的计数」改成由脚本生成（`scripts/check-doc-counts.mjs`），否则还会漂 |

---

## 优先级建议

```
B1 (Verified)  →  B2 (QA preset)  →  B5 (verified_by)   ← 这三条一起做，才让「进度」有分母
B4 (deadline)  ← 低成本，独立
B3 (阶段写路径) ← 设计缺口最大，但改动面也最大，单独一轮
B6 (period)    ← 等产品决定
B7 (维护债)    ← 见缝插针
```
