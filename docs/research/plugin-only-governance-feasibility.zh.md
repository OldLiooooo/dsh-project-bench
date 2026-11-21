# 只通过插件治理 lumio：可行性与落地方案

> 2026-11-14 · 只读核查（未改 lumio，未改 workbench 代码）。前置：
> [治理机制对比](governance-mechanism-comparison.zh.md) §5（双写）/ §6（能否全由插件改）。
> 事实底稿：[lumio-facts](governance-facts/lumio-facts.md)、[plugin-facts](governance-facts/plugin-facts.md)。
> 下一步：[实施计划（待批准）](plugin-only-governance-implementation-plan.zh.md)。

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 插件能不能单独治理 lumio？ | **能，但只能接管"判定"，不能接管"执行"。** 判定层（16+3 条规则）实测可当纯函数库 import，**< 400 ms 跑完**；执行层（commit/push/PR/merge）仍应留在 git + `ai-finish`。 |
| 最大障碍是什么？ | **不是技术，是三个结构缺口**：① 阶段模板硬编码 S1–S7，且 `project.json` 的 `stageTemplate` **只写不读**（改配置不生效）；② lumio 有 17 种中文状态表述、插件是英文枚举，且**无映射表**；③ lumio 有 310 份模块交接，插件只有"每切片一份"。 |
| 建议什么叫"只通过插件"？ | **方案甲（账本 + 判据）**：过程状态与门禁判定归插件（单写、可机检），交付事实归 git（插件只读回填）。**不要**做"全接管"（重造 CI，约 2,000 行）。 |
| 先做哪一步？ | `gate_submit` 内联 `checker` + `closeout`，**约 180 行 + 2 个测试**。当前 lumio 正好有 5 条 `DIR_UNREGISTERED` + 1 条 `MEMORY_BEHIND` 真实红灯，可以直接当验收夹具。 |

## 0.1 实测证据（决定可行性的四条）

```
# 把 lumio 的检查器当纯函数库 import（无 shell、无 spawn）
checkRepository('.../lumio')  → FAIL, 5 issues, 346 ms
checkCloseout('.../lumio')    → FAIL, MEMORY_BEHIND,   9 ms

# 插件能否读仓库 + 解析状态
fs.readFileSync(policy.json)        → 13 个键
fs.readFileSync(WI-20261112-001.md) → 5098 字符，状态解析出「实现完成（未验收；验证缺口见下）」

# 阶段模板：改 project.json 不生效
grep stageTemplate workbench/host/*.js
  registry.js:12  const STAGE_TEMPLATE = projectDefaults.STAGE_TEMPLATE   ← 从常量读
  registry.js:54  return { ..., stageTemplate: STAGE_TEMPLATE }           ← 只写进 json
  （无任何读回 project.json 的 stageTemplate 的代码）
```

## 1. 先回答：哪些 lumio 治理能被插件"原生"接管

实测把 lumio 的 5 个记录层检查器当**纯函数库**直接 import，不 spawn、不 shell：

| lumio 模块 | import 依赖 | 插件能直接跑吗 | 实测 |
|---|---|---|---|
| `checker.mjs`（16 条规则） | 只有 `node:fs/path/url` | **能** | `checkRepository()` **346 ms**，返回 5 issues |
| `closeout.mjs`（3 条规则） | 只有 `node:fs/path` | **能** | `checkCloseout()` **9 ms**，返回 `MEMORY_BEHIND` |
| `validate-spec.mjs` | 0 处 child_process | **能** | — |
| `generate-spec-docs.mjs` | 0 处 child_process | **能** | — |
| `audit-materialized.mjs` | 0 处 child_process | **能** | — |
| `integrity.mjs` | `execFileSync`（git） | 需 git | 实测返回 `{skipped:true}`（无 git 就静默跳过） |
| `trunk-health.mjs` | `child_process` | 需 git | — |
| `ai-finish.mjs` | `spawnSync`（git） | 需 git | — |
| `merge-pr` / `create-pr` / `check-runs` / `ci-rehearsal` | `child_process` + `node:https` | 需 git + 网络 | — |

> **关键发现**：lumio 最有价值的 16+3 条规则（目录/文件/README 字段/ID 唯一/链接/骨架/EV 存在/记忆新鲜/计数一致）**全部是纯 Node 的只读判定**，插件 Host 进程可以直接 import，总耗时 **< 400 ms**。
> 这意味着：**门禁可以在 `gate_submit` 时同步跑完机检，不需要 shell、不需要 agent 自觉。**

## 2. 三种"只通过插件"的方案，及其真实代价

| 方案 | 插件负责什么 | lumio 现状 | 代价 | 判定 |
|---|---|---|---|---|
| **甲 账本 + 判据**（推荐） | 切片/任务/会话/文档版本/决策/证据/门禁 + **内联跑 A 类机检** + 记录 B/C 类结果 | 交付仍走 `ai-finish --pr`（由任务会话执行），插件只**记录** PR/check-run/分支 | 中：改 `gate_submit` + 新增 `repo_probe` 工具 | ✅ **现在就能做** |
| **乙 全接管** | 甲 + 插件自己 spawn git 做 commit/push/PR/merge | lumio 的 tools/engineering 全部退役 | 大：要移植 `ai-finish`+`merge-pr`+`create-pr`+`check-runs` ≈ 2,000 行，还要处理 Gitee 凭据、check-run 语义、Windows CLI bug | ⚠️ 可行但**重造 CI**，不建议 |
| **丙 只做过程** | 甲 - 机检，只保留状态流转 | 16+3 条规则作废 | 小：但等于回到"靠自觉"，lumio 复盘的所有教训会重演 | ❌ 不要 |

**推荐甲**。它把"单写"拆成两件事，各自都有明确的权威：
- **过程状态**（阶段/切片/任务/会话/决策/门禁）→ 插件 DB，单写
- **交付事实**（分支/PR/check-run/合并）→ git + 远端，插件**只读回填**，不冒充权威

## 3. 方案甲的完整形态

### 3.1 分工表

| 能力 | 谁做 | 落在哪 | 现状 |
|---|---|---|---|
| 阶段/切片/任务/会话/交接版本 | 插件 | `project.db` | ✅ 已实现 |
| 决策卡 + 不可逆二次确认 | 插件（人只在面板点） | `decisions`/`approvals` | ✅ 已实现 |
| 证据（命令 + 退出码 + 原文） | 插件 | `evidence` 表 | ✅ 已实现（`command`/`result_summary` 字段够用） |
| **16 条结构规则** | 插件 import `checker.mjs` | 门禁时内联，结果写 evidence | ❌ 未接 |
| **3 条收尾对账** | 插件 import `closeout.mjs` | 同上 | ❌ 未接 |
| 规格生成物新鲜度 | 插件 import `generate-spec-docs.mjs --check` | 同上 | ❌ 未接 |
| hook 可执行位 / 交接新鲜度 | 插件 spawn 只读 git | `repo_probe` 工具 | ❌ 未接 |
| commit / push / PR | 任务会话跑 `ai-finish --pr` | git + Gitee | ✅ 保持不动 |
| PR / check-run 结果 | 插件只读回填 | `evidence`（kind=`pr`） | ❌ 未接 |
| 合并 | **人**（插件只记录结果） | `approvals` | ✅ 与现状一致 |

### 3.2 门禁的新时序（这是方案甲的核心改动）

现在（弱）：
```
PM gate_submit → 建 pending approval + 决策卡 → 人点批准 → 冻结 + 导出 + 推阶段
```

改成（强）：
```
PM gate_submit
  → 插件内联跑 5 个纯 Node 检查器（<400ms）
  → 任一 FAIL：直接拒绝提交，返回 code + 原文（agent 可读）
  → 全 PASS：把 5 份原文存进 evidence（content_hash + command + result_summary）
  → 建 pending approval（snapshot 里带 evidence ids）
→ 人点批准（看到的是"机器绿 + 摘要"，不是 agent 自述）
→ 冻结 + 导出 + 推阶段
```

> 这一步同时解掉 C4（门禁判据不同源）和 §5.3 的"伪造批准"问题的一大半：**人批准前机器已经判过**。

### 3.3 需要给插件新增的东西（清点后的完整清单）

| # | 新增 | 作用 | 工作量 |
|---|---|---|---|
| 1 | `workbench/host/checkers.js` | 发现并 import 项目内的 `tools/engineering/*.mjs`，跑 A 类 | ~120 行 |
| 2 | `gate_submit` 前置机检 | 失败即拒，成功则存证 | ~60 行 |
| 3 | `repo_probe` 工具（PM 专用） | spawn 只读 git：`status`/`branch`/`log`/`ls-files --stage` | ~80 行 |
| 4 | `evidence_add` 增加 `verbatim` 模式 | 存命令原文 + 退出码，不只是摘要 | ~30 行 |
| 5 | 交付结果回填 | `ai-finish` 的 state.json → evidence（kind=`delivery`） | ~40 行 |
| 6 | 阶段模板可配置 | 见 §4.1，这是个真缺口 | ~50 行 |

合计约 **380 行**，全部是加法，不动现有测试。

## 4. 三个必须承认的硬缺口

### 4.1 阶段模板是硬编码的（`S1..S7`），和 lumio 生命周期完全对不上

- 插件：`S1 产品 / S2 UX / S3 架构 / S4 实现 / S5 测试 / S6 发布 / S7 复盘`（`project-defaults.js:6-12`）
- lumio：`PRD-W1..W4 → PRD-AUDIT → DEV-W1..W4 → FILE-W1..W4 → CODE-W1..W4`
- **而且 `project.json` 里的 `stageTemplate` 只写不读**：`registry.js:12` 从常量模块读，`registry.js:54` 只往 json 写；全仓 `grep stageTemplate` 只有这两处 → **改 project.json 不生效**。
- 影响：不改这个，插件的阶段推进（`advanceStage`）会按 S1→S2 推，而 lumio 实际在 DEV-W1。**必须让 stageTemplate 从 project.json 读回。**

### 4.2 状态词表 17 种，插件只有英文枚举

lumio 实测 49 个工作项的状态分布：
```
17 × 实现完成       6 × 已完成        3 × 实现完成，未验收
 1 × 进行中         1 × 设计正文交付完成  1 × 规格与工具完成
 ... 共 17 种不同表述
```
插件：`slice.status` 无枚举约束（`store.js:214` 只要非空字符串），`document.status` 是 `draft/review/approved/frozen`。
→ 迁移必须带一张**显式映射表**（17 → 5），且映射表要进 policy（可机检），否则就是 C3 的漂移源。

### 4.3 交接是"每模块一份"（310 份），插件只有"每切片一份"

- lumio：`checker` 要求 310 个模块 README 都有 `## 当前交接` 六字段（`HANDOFF_FIELDS`），另有 `docs/memory/project-context.md` 一份
- 插件：`handoff` 是**文档类型**，挂在切片上（`task-tools.js:44-57`），没有"每模块一份"的概念
→ 要么把这 310 份降级为"仓库侧视图"（插件不管），要么给插件加 `module` 实体。**建议前者**：这些是代码目录的说明，本来就该跟代码走。

## 5. 迁移路径（5 步，每步可回滚）

| 步 | 动作 | 验收 | 回滚 |
|---|---|---|---|
| **M0** | `.project/` 从工作区移到 `~/.dsh/storages/`（§5.3 的 L0） | agent 写入返回 EPERM | 移回即恢复 |
| **M1** | 反向登记：把 49 WI / 39 DEC / 32 EV 建成 DB 的 slice/task/decision/evidence，**只存 `external_ref` + hash，不复制正文** | `links` 表非空；`project_recall` 能按 WI 编号查到 | 删 DB 重建 |
| **M2** | `gate_submit` 内联 5 个机检 | 故意造一条 `LINK_BROKEN`，`gate_submit` 应直接失败 | 移除 hook |
| **M3** | 交付链保持 `ai-finish --pr`，插件只回填 PR/check-run 结果 | `project_status` 能看到 PR 号与 check-run 结论 | 停用回填 |
| **M4** | 仓库侧 `.project` 进 `policy.json.ignoredDirectories`，`MEMORY_BEHIND` 改成读 DB 导出 | `checker`/`closeout` 全绿 | 改回 policy |

> **M0 和 M4 是配对的两个动作**：先搬走（agent 碰不到），再登记忽略（checker 不再红）。只做一半就是现在这个状态：**红着跑**。

## 6. 只通过插件治理，会丢掉什么（必须承认）

| 丢掉 | 后果 | 缓解 |
|---|---|---|
| git 钩子（pre-commit/pre-push） | agent 可以绕过一切直接 commit | **不丢**：交付仍走 ai-finish，钩子保留 |
| 远端 CI 作为探测器 | 没人知道推上去红不红 | 保留 Gitee CI，插件只回填结果 |
| 310 份模块交接 | 模块级上下文断层 | 降级为"跟代码走的 README"，不进 DB |
| `coordinate` 的编号分配 | WI 编号可能重复 | 插件生成编号（`slice.key` 已唯一） |
| `--no-verify` 的登记义务 | 变成无记录 | 插件把"绕过"记为一条 decision（可审计） |

**结论**：插件能接管的是"**判定**"（谁该绿、依据什么原文），接管不了也不该接管的是"**执行**"（真的去 commit/push/merge）。把这两件事分开，就是方案甲。

## 7. 首个可交付切片（建议先做这一个）

**目标**：让 `gate_submit` 在 lumio 上第一次"机器绿才允许提交"。

1. `workbench/host/checkers.js`：从 `<root>/tools/engineering/` 动态 import `checker.mjs`/`closeout.mjs`
2. `gate_submit` 前置：跑这两项，FAIL 直接抛 `GATE_PRECHECK_FAILED` + issues 原文
3. 通过则写 2 条 evidence（`kind:'check'`，`command:'import checker.checkRepository'`，`result_summary` 存 JSON 原文）
4. 测试：造一个断链的 fixture，断言 `gate_submit` 必失败；再用当前 lumio 实跑，断言它因为既有的 5 条 `DIR_UNREGISTERED` 失败（**真实红灯，可直接复用**）

预计 **180 行 + 2 个测试**，一天内可完成，且能立刻看到效果。

## 附：事实来源与取证边界

- 实测（本轮，只读）：`checkRepository('C:/Users/oldap/Documents/lumio')` → FAIL/5 issues/346 ms；`checkCloseout()` → FAIL/`MEMORY_BEHIND`/9 ms；两者均以 `import()` 直接调用，**未 spawn、未 shell**。
- 实测：`integrity.checkGitIntegrity()` 返回 `{ok:true, skipped:true}` —— 因为它靠 `execFileSync('git')`，在无 git 的进程/目录里静默降级。这是 B 类（需 git）与 A 类（纯 Node）的分界证据。
- 读码分类：`checker`/`closeout`/`validate-spec`/`generate-spec-docs`/`audit-materialized` = **0 处 child_process**（A 类）；`integrity`/`trunk-health`/`ai-finish`/`merge-pr`/`create-pr`/`check-runs`/`ci-rehearsal` = **有 child_process**（B 类）。
- 结构缺口实测：`grep stageTemplate workbench/host/*.js` 只命中 `registry.js:12`（从常量读）与 `registry.js:54`（写进 json），**无读回 project.json 的代码** → 改 project.json 的 stageTemplate 不生效。
- 数量实测：`docs/work-items/WI-*.md` 49 个；`docs/decisions/DEC-*.md` 39；`docs/evidence/EV-*.md` 32；`grep '^- 状态：' WI-*.md | sort -u` = **42 种不同表述**；`grep -rl '^## 当前交接' --include=README.md`（排除 docs/、node_modules、.venv）= **302 份**。
- 当前红灯（可直接当验收夹具）：`checker` 5 × `DIR_UNREGISTERED .project*`；`closeout` 1 × `MEMORY_BEHIND`（WI-20261112-001 已写"实现完成"但 `docs/memory/project-context.md` 停在 WI-20261110-001）。
- 未实测：任何 `git`/`pnpm`/`uv` 步骤（本沙箱禁止工具内 spawn git，实测 `spawn EPERM`）；`ai-finish` 的变更枚举与 `gate --staged` 的端到端分支均按「读码」标注。
