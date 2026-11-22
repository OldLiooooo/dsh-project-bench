# BACKLOG：从「流程执行器」到「合格的 PM」

> 来源：[交付审计 2026-11-21](delivery-audit-2026-11-21.zh.md)。
> **2026-11-21 第二轮：B1–B7 已全部落地（schema v5）**，本文件改为记录「已完成」与「仍待办」。

---

## 已完成（v5，2026-11-21 第二轮）

| # | 能力 | 落点 | 证据 |
|---|---|---|---|
| B1 | **Verified Done 进入数据模型** | `schema.js` v5：`slices` 加 verified 状态 + `verified_by/verified_at/verified_session`；`store.verifySlice`；`slice_verify` 工具 | `tools.test` 5 例 |
| B2 | **独立验收会话 project-qa** | 第三个 preset + `kind='qa'` + `session_spawn_qa` + 工具 actors 收紧 | 工具面 9 个；不占租约 |
| B3 | **deliverableTypes 真读** | `project-defaults.checkDeliverableType` + `doc_write` 拦截（`STAGE_DELIVERABLE_NOT_ALLOWED`） | `tools.test` 3 例 |
| B4 | **决策超时** | `decision_create` 加 `deadline`/`defaultOption`（v5 列 `default_option`） | `tools.test` |
| B5 | **`evidence.verified_by` 真实写入** | `verifySlice` 回填该切片证据的验收人与时间 | `tools.test` |
| B6 | **周期（period）** | `period_roll` 写 meta + `period/roll` 事件；概览 period 跟随 | `tools.test` |
| B7 | **维护债（部分）** | `links` 表有了第一个真实写入点（验收依据的证据连边）；新增 `scripts/check-doc-counts.mjs`（8 条规范句对照实测） | 脚本 exit=0 |

### B1 的关键设计取舍（不是「加个状态」那么轻）

`done` ≠ `verified`：
- `done` = 交付方自认完成（自述）
- `verified` = 独立验收通过（有签名、可追溯）

**不自动把存量 done 升级成 verified** —— 那等于伪造验收记录，而 events 是 append-only、事后无法纠正。
所以迁移只加列，不改数据；老项目会显示「done 未验收」，这是**如实反映历史**，不是迁移失败。

三道闸缺一条 verified 就只是改名：
1. 唯一写入路径 `store.verifySlice`（`updateSliceStatus` 收 verified 直接拒）；
2. 建造者不验收（按该切片**最近一次实现会话**比对，不按角色词）；
3. DB 触发器兜底（`guard_verified_requires_signer` + `guard_verified_slice_terminal`）。

---

## 仍待办

### MVP 清单收口（2026-11-22）

设计 §10.1 的 MVP 清单最后三项已补齐：

| 项 | 落点 |
|---|---|
| ⑤ 周报可贴 GitHub Issue | `weekly_report` 工具 + `host/report.js`（确定性渲染，走 outbox） |
| 看板视图 | 面板第 2 个 tab，7 列（**done 与 verified 分列**） |
| 9 个 SOP 技能 | 新增 `testing-acceptance`（验收会话）与 `cycle-retrospective`（周期复盘） |

### 仍有明确设计缺口（MVP 之后）

| # | 缺口 | 说明 | 建议 |
|---|---|---|---|
| N1 | **风险 / 问题 / 假设三本账** | 设计 §6.4 四本账只落了决策；风险 Top-N、问题日志、假设日志都没有表。§6.3 的升级阈值（阻塞 >24h、决策等待 >48h）也就无从计算 | schema v6：`risks` `issues` `assumptions` 三表 + PM 工具；优先级中（影响「风险 Top-3 是什么」的答案） |
| N2 | **周期熔断（circuit breaker）** | `period_roll` 是显式推进，没有「周期到期」判定：到期未完成不会强制停，也不会进 parking lot | 设计 §5.4 的 appetite 语义需要先拍板（见下） |
| N3 | **路线图 / 燃起图 / 指标页** | 设计 §7.2 七视图落到 6 tab（含看板）+ 进度卡；燃起图与指标页仍未做 | 先做燃起图（verified 累计 vs 范围），成本最低、信息量最大 |
| N4 | **交付链（commit/push/PR）** | 设计 §10.2 Phase 3；现在仍由任务会话自己做 | 低优先级，但要接就得接成证据自动采集 |
| N5 | **反向登记** | 已有仓库的历史条目还在文档里，没进 DB | 中 |
| N6 | **周报进 docs/ 的版本链** | 现在周报写 `.project/exports/weekly.md`（派生视图，可重复生成）。要不要同时生成一篇 `docs/reports/weekly-*.md` 进版本链，取决于「周报要不要留历史」 | 需拍板 |

### 仍然只是「如实标注」的边界（不是缺陷）

| 边界 | 为什么 |
|---|---|
| 判据隔离不是安全边界 | 同进程空间、`spawn` EPERM，ADR-0001 已明写 |
| 多人身份不能强制分离 | 能追责、不能阻止同人既提又批；无 RBAC |
| 非 git 工作区无法校验作用域 | `verifiable=false` 如实标注 |
| 验收会话工具面靠 actors 白名单 | 若新增工具忘了收紧，qa 可能拿到不该有的工具；没有自动断言 |

### 需要拍板的问题（这些不定，N1–N3 无法开工）

1. **`done` 与 `verified` 的关系**（已按「并存」实现）——要不要在 UI 上把 `done` 直接显示成「未验收」？
   现在的做法是进度卡单列「已交付未验收 N 项」。
2. **周期长度与推进者**：两周？谁推进——人点、PM 自己、还是到期提醒？
3. **风险账本的粒度**：只要 Top-N 摘要（够回答三问），还是要完整登记册（概率×影响×缓解×复查日）？
4. **deliverableTypes 要不要更严**：现在只拦 doc_write 新建；要不要也拦 `artifact_add`（比如 S1 阶段不许登记 `src/**` 产物）？

---

## 优先级建议（下一轮）

```
N3 燃起图     ← 进度已有分母，这是最划算的一步（成本低、直接回答「到哪了」）
N1 三本账     ← 回答「风险 Top-3」的前提
N2 周期熔断   ← 等周期语义拍板
N4/N5         ← 交付链与反向登记，最后
```
