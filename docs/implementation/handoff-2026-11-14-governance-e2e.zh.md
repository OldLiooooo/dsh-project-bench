# 交接：治理闭环（阶段模板 + headless + 真实仓库演练）

> 2026-11-14 第三批 · 目标：让插件**能以插件身份治理一个真实仓库**。
> 前两批见 [handoff-2026-11-14-gate-precheck.zh.md](handoff-2026-11-14-gate-precheck.zh.md)。

---

## 1. 本批解决的三个「跑不通」

### A. headless 下根本初始化不了项目（死锁）

[registry.js](../workbench/host/registry.js) `rootForWorkspace` 在没有 `workspaceRegistry`（headless/CLI profile）时，只准入「**已经有** `.project` 运行时」的目录；而 `ensure()` 正是用来**创建**运行时的。→ 永远进不去。

修法：`ensure()` 走 `allowCreate` 路径（明确是初始化请求），`open()` 保持严格；`allowCreate` 仍要求目录真实存在，且**不**放宽到任意路径。

### B. 阶段模板只写不读 → 换不到 lumio 生命周期

lumio 的真实生命周期是 `PRD → DEV → FILE → CODE`（`PRD-AUDIT / DEV-GATE / FILE-GATE / CODE-GATE`），硬套 S1..S7 会让阶段推进落在错误语义上。

修法：

- `project.json.stageTemplate` 真正参与启动（`stageTemplateFor`）。
- 新增 **`applyStageRemap(reference, template, { confirmed })`**：换模板是显式写路径，未确认抛 `CONFIRM_REQUIRED`。
- **旧阶段 retire 而不是 DELETE**：`status='retired'`，行与历史事件都保留（W1 的教训：事件指向已删除主体 = 审计断链）。
- `stages` 状态枚举补 `retired`；写一条 `stage/template` 事件。

### C. retire 之后 active 阶段判定选错（真 bug，演练当场抓到）

`listStages(db)` 返回**全部**行，retired 的 S1 与新的 PRD/DEV position 重叠，`currentStage()` / `advanceStage()` 于是选到已退役的 S1 —— 实测「批准 PRD-AUDIT 后阶段推进到 **S1** 而不是 DEV」。

修法：`listStages` 默认只返回**活阶段机**（`status != 'retired'`），需要全量历史时显式 `listStages(db, { includeRetired: true })`。这条不是设计出来的，是演练跑出来的。

---

## 2. 端到端治理演练（本批的核心证据）

新增 [governance-e2e.mjs](../workbench/tests/probes/governance-e2e.mjs)：**用插件自己的工具治理一份真实的 lumio 仓库副本**。

- 真实：`registry → ProjectDb → store/docs/leases → 工具层 → gate_submit → 真实 checker.mjs/closeout.mjs → resolveDecisionAction`
- 唯一替身：`ctx.subagents`（拉起子会话）与 `ctx.agents`（唤醒 PM）——需要真实 DSH 运行时。但**断言替身收到了什么**（`agentPreset='project-task'`、开场简报 1159 字符），而不是假装成功。
- 沙箱：`<workspace>/.sandbox/governance-e2e/`，**不动你的真实 lumio**（本机真实仓库：[C:/Users/oldap/Documents/lumio](../../../../lumio)）。

### 24 条断言全过（`passed=24 failed=0`，日志：[governance-e2e.log](../.artifacts/governance-e2e.log)）

| # | 断言 | 结果 |
|---|---|---|
| ① | 复制真实 lumio 到沙箱（659 文件 / 6.7 MB，不动原仓库） | PASS |
| ② | headless 下能初始化项目（修复 A） | PASS |
| ③ | 换模板未确认 → `CONFIRM_REQUIRED` | PASS |
| ④-⑥ | 落地 PRD/DEV/FILE/CODE；旧 S1..S7 retire 不删；active 恰一个=PRD | PASS |
| ⑦-⑨ | PM 建切片/任务；拉起 `产品-delivery-lifecycle-PRD补齐`；activation 带 preset+简报 | PASS |
| ⑩ | 门禁缺证据 → `NO_EVIDENCE` | PASS |
| ⑪-⑬ | **真实判据红灯 → gate_submit 被拒**；带 `DIR_UNREGISTERED/MEMORY_BEHIND` 原文；不留 pending | PASS |
| ⑭a | `.project` 登记进仓库 policy.json（可审计的治理动作） | PASS |
| ⑭ | 补齐项目记忆后判据**真的**转绿（不是绕过） | PASS |
| ⑮-⑯ | 判据绿 → 提交成功；机检落 `check` 证据 | PASS |
| ⑰-⑱ | 不可逆门禁缺确认 → `CONFIRM_REQUIRED`；二次确认后批准，阶段 **PRD→DEV** | PASS |
| ⑲ | 批准时复跑判据（precheck 有记录） | PASS |
| ⑳-㉒ | 唤醒 PM 带新阶段；时间线含 `stage/template`/`gate/submit`/`gate/approve`/`stage/change`；active 恰一个=DEV | PASS |
| ㉓ | 导出快照成功（治理产物落盘） | PASS |

**这条链路的意义**：治理不再是「人点一下批准」。真实仓库的 16 条结构规则 + 3 条收尾对账**真的会拦下门禁**，而修好它们之后门禁**真的会放行**——两边都验过。

---

## 3. 验证结果

| 套件 | 结果 |
|---|---|
| `checkSyntax()` | **PASS** 47 文件 / 0 syntax / 0 import |
| unit db / api / tools / **acceptance** | 30 / 16 / 25 / **19**（+2 例：模板读回、remap+retire+过滤） |
| e2e negative / ui-client / dev-instance | 10 / 7 / 8 |
| replay-14-steps | 17 / 0 pending |
| gate-real-checkers 探针 | 3 / 0 |
| **governance-e2e 探针** | **24 / 0** |

---

## 4. 仍未达标的部分（诚实记档）

| 缺口 | 影响 | 下一步 |
|---|---|---|
| **官方命令仍未跑通** | bash 全程 `EXECUTOR_UNAVAILABLE`（niubash 硬链接池），`spawn` 全程 EPERM。所有证据来自 in-process | 执行器恢复后必须补跑，以它为准 |
| **未在真实 DSH 实例里跑过** | `instance-http.mjs` / `live-e2e.mjs` 需要真实例 + 真模型 + cookie | 同上 |
| **`.project` 仍在工作区内**（M0） | 判据再严，agent 仍可绕过应用层直连 DB —— **单写仍不成立** | 搬到 `~/.dsh/storages/` |
| **子会话仍是替身** | 真实 `ctx.subagents.startActivation` 行为未在真机验证 | 真实例 |
| **lumio 的 17 种状态词表未映射** | 反向登记（M1）没做：49 WI / 40 DEC 还没进 DB | M1 |

---

## 5. 一句话结论

**「插件能不能跑通」：能。** headless 初始化、阶段模板、门禁判据、人批准、导出，全链路在真实仓库副本上跑通了（24/24）。

**「能不能用它治理」：判据这一层成立了。** 真实 checker 拦得住、放得行、留得下证据。但「单写」这一层不成立——`.project` 还在工作区里，agent 可以绕过。**这一步不做，治理始终只是自觉。**
