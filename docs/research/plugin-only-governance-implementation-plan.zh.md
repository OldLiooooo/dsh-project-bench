# 只通过插件治理 lumio：实施计划（已批准，执行中）

> **状态：已批准，执行中。** 2026-11-14 批准；**W1、W2 已完成**，W3–W5 待办。
> 前置事实：[插件约束实测](governance-facts/plugin-constraint-audit.zh.md)、[治理机制对比](governance-mechanism-comparison.zh.md)、
> [可行性方案](plugin-only-governance-feasibility.zh.md)。

## 0. 先纠正你问的两个问题

### Q1：本插件做了约束了吗？

**做了，但只在应用层；数据库层一条都没有。** 实测（两个方向各跑一遍）：

| 层 | 有没有约束 | 实测结果 |
|---|---|---|
| **数据库层**（schema） | **0 条** | `CREATE TRIGGER`=0、`CHECK(`=0；允许删事件、改写事件、插跳号、删 doc_versions、重复 artifact/evidence、任意 slice 状态 |
| **应用层**（store/docs/leases） | **6 条会真的拒绝** | `DOC_FROZEN` / `DUPLICATE_ACTIVE_SESSION` / 命名 `INVALID` / `LEASE_HELD` / 重复裁决 `INVALID` / 不可逆无 confirmed `INVALID` |
| **应用层缺口** | **3 处** | slice 状态任意字符串（无枚举）、artifact 同 path 可重复、evidence 同 uri 可重复 |

准确表述：**约束强度 = "参与者是否自愿走应用层"。** 任务会话带 `bash` + `fs write`，绕过可行，所以单写尚未成立。

### Q2：不用"最小 xxx"

收到。本计划全文不使用「最小」作方案命名；只在**有明确因果**（某条约束依赖某条语法的必然结果）或**研究/探索任务**时使用。

## 1. 目标与边界

### 1.1 目标

让 lumio 这个项目的治理**只通过工作台插件**完成，并且这个"只"是**可验证**的，不是约定。

### 1.2 明确不在范围

- 不重写 lumio 的 `tools/engineering/*`（继续用，作为被调用的规则库）。
- 不把 git/PR/check-run 搬进 DB（§6.1 已判定重造 CI）。
- 不改 lumio 仓库的既有提交历史。
- 不动 `workbench/client.js`（另有会话在改，2026-11-12 19:09 有未提交改动）。

## 2. 现状基线（可复核）

| 项 | 实测值 | 来源 |
|---|---|---|
| lumio 工作项 / 决策 / 证据 | 49 / 39 / 32 | `docs/work-items/WI-*.md` 等 |
| 工作项状态表述 | **42 种**不同中文 | `grep '^- 状态：' \| sort -u` |
| 模块 README 带「当前交接」 | **302 份** | `grep -rl '^## 当前交接'` |
| 插件阶段模板 | `S1..S7` 硬编码 | `project-defaults.js:6-12` |
| project.json 的 stageTemplate | **只写不读** | `registry.js:12` / `:54` |
| 纯 Node 可跑的 lumio 规则 | 5 个模块 | `checker`/`closeout`/`validate-spec`/`generate-spec-docs`/`audit-materialized` |
| 需 git 的规则 | 7 个模块 | `integrity`/`trunk-health`/`ai-finish`/`merge-pr`/`create-pr`/`check-runs`/`ci-rehearsal` |
| 当前红灯 | checker 5 条、closeout 1 条 | `DIR_UNREGISTERED` ×5、`MEMORY_BEHIND` |

## 3. 分五个工作包（每个都可独立验收、独立回滚）

### W1 数据库层补防线（不依赖任何外部系统）｜✅ 已完成 2026-11-14

**为什么**：Q1 的结论是"DB 一条都不拦"。这是所有其它工作的地基。

| 动作 | 具体 | 验收 | 状态 |
|---|---|---|---|
| 1.1 加 append-only 触发器 | events 禁 UPDATE/DELETE；seq 必须 = MAX(seq)+1 | 直连 DB 删/改/跳号 → `EVENT_IMMUTABLE`/`SEQ_NOT_CONTIGUOUS` | ✅ |
| 1.2 加 doc_versions 保护 | 禁 DELETE；禁改 content/content_hash（`frozen` 仍可改） | 直连删版本/改正文 → `DOCVERSION_IMMUTABLE` | ✅ |
| 1.3 加唯一约束 | artifacts `(project_id,kind,path)`、evidence `(project_id,kind,uri) WHERE uri IS NOT NULL` | 重复登记 → `DUPLICATE_ARTIFACT`/`DUPLICATE_EVIDENCE`（应用层）+ UNIQUE（DB 层兜底） | ✅ |
| 1.4 状态枚举 | `STATUS_ENUMS`（7 实体）+ `auditStatuses()` 审计函数 | 越界状态可被检出，不抛错 | ✅ |
| 1.5 migration | `SCHEMA_VERSION` 1→2，去重与加约束同事务，幂等 | 旧库自动升级、二次迁移无副作用 | ✅ |

**实测结果**（`.artifacts/w1-proof.mjs`，临时库）：

```
=== 绕过应用层直连 DB（8 项反证）===
BLOCKED  删 events 行                  [EVENT_IMMUTABLE]
BLOCKED  改 events payload             [EVENT_IMMUTABLE]
BLOCKED  插跳号 event                  [SEQ_NOT_CONTIGUOUS]
BLOCKED  删 doc_versions               [DOCVERSION_IMMUTABLE]
BLOCKED  改 doc_versions 正文          [DOCVERSION_IMMUTABLE]
BLOCKED  重复 artifact                 [UNIQUE constraint failed]
BLOCKED  重复 evidence                 [UNIQUE constraint failed]
BLOCKED  已批准 decision 改回 pending  [DECISION_TERMINAL]

=== 合法写必须仍然通过（4 项）===
ALLOWED  正常追加 event / 冻结版本 / 新路径 artifact / pending 正常落定
```

**真实库迁移预演**（`.artifacts/w1-migrate-realdb.mjs`，lumio DB 的副本）：

```
迁移前: evidence=3, artifacts=6, 重复 evidence=1 组(2 行), version=1
迁移后: evidence=2, artifacts=6, 重复 evidence=0,   version=2, 耗时 27ms
       触发器=7, 唯一索引=4, 事件数 47 不变, doc_versions 3 不变
二次迁移: 幂等（触发器仍 7、版本行仍 2）
```

**不做**：不给 decisions 加"pending→approved 只能一次"的触发器——实测能挡住"已批准改回 pending"，但挡不住"伪造首次批准"，做了会给人虚假安全感。

**回归**：67 项单测/验收（db 23 / tools 11 / api 16 / acceptance 17）+ replay 17/17 + negative 10/10 全绿。
**改动**：`workbench/host/schema.js` +122、`workbench/host/store.js` +15、`workbench/tests/unit/db.test.mjs` +140。

### W2 阶段模板改为可配置（解 lumio 生命周期对不上的问题）｜✅ 已完成 2026-11-14

**为什么**：不改这个，插件按 S1→S2 推进，而 lumio 在 DEV-W1，门禁会推错阶段。原实现里 `project.json.stageTemplate` **只写不读**——改配置对已初始化项目完全无效。

| 动作 | 具体 | 验收 | 状态 |
|---|---|---|---|
| 2.1 读回 | `registry.js` 每次 open/ensure 都从 `project.json.stageTemplate` 解析生效模板 | 改配置后 `stages` 表跟着变 | ✅ |
| 2.2 校验 | `normalizeStageTemplate()`：非空、key/name 非空、key 与 gate 各自唯一、长度上限 | 重复 key/gate → `POLICY_INVALID` | ✅ |
| 2.3 不破坏存量 | 只**补建缺失 key**，绝不删除或改名已有阶段行；`planStageRemap()` 只出计划 | 已有 `S1..S7` 的项目换模板后旧 key 仍在、active 阶段不变 | ✅ |
| 2.4 lumio 模板 | 内置 `LUMIO_STAGE_TEMPLATE`：`PRD/DEV/FILE/CODE` + 对应门禁 | 模板能通过自身校验 | ✅ |

**实现说明（三个新函数，都在 `project-defaults.js`）**：

| 函数 | 职责 | 特征 |
|---|---|---|
| `normalizeStageTemplate(input)` | 校验 + 规范化 | 纯函数、无 IO，返回 `{ok, template}` 或 `{ok:false, code, message}` |
| `resolveStageTemplate(projectJson)` | 从 json 取模板，缺失/非法回退默认 | **非法原因带出去**（`error.code`），不静默吞掉 |
| `planStageRemap(rows, template)` | 对比现状与目标，只出计划 | 报告 `added/removed/renamed/regated` + `activeStageSurvives` |

**registry 新增两个公开方法**：`activeStageTemplate(reference)`（读生效模板）、`stageRemapPlan(reference, targetTemplate)`（只读评估）。后者对非法模板抛 `POLICY_INVALID`，不返回半成品。

**实测：为什么必须由人确认 remap**（`workbench/tests/probes/w2-stage-remap.mjs`，lumio 库副本）：

```
当前阶段（lumio 项目）: S1 产品(active) / S2 UX / ... / S7 复盘
换成 LUMIO_STAGE_TEMPLATE 的影响:
  新增: PRD, DEV, FILE, CODE
  移除: S1..S7
  当前阶段: S1 | 换成新模板后是否还存在: false
  需要人确认: true
⚠ 当前 active 阶段在新模板里不存在 —— 直接换会让项目"没有当前阶段"。
```

这就是 D2 选 A 的实证：自动 remap 会让项目静默失去当前阶段。

**测试**：新增 6 个（模板校验/resolve/真生效/不破坏存量/remap 计划/lumio 模板合法）。
**回归**：100 项全绿（db 29 / tools 11 / api 16 / acceptance 17 / replay 17 / negative 10）。
**改动**：`workbench/host/project-defaults.js` +124、`workbench/host/registry.js` +29、`workbench/tests/unit/db.test.mjs` +141、新增探针 1 个。

**遗留（W3 才解）**：现在只是"模板可配"，lumio 项目**还没有真的换模板**——因为换模板必须先建映射（W3）并让人确认 `stageRemapPlan` 的结果。

### W3 状态词表映射（解 42 种中文表述）

| 动作 | 具体 | 验收 |
|---|---|---|
| 3.1 映射表入 policy | 42 种 → 6 个标准态（`proposed/ready/in_progress/in_review/verified/done`），存 `project.json.legacyStatusMap` | 未映射的表述 → 明确报错，不静默归类 |
| 3.2 反向登记工具 | 读 WI 文件 → 解析「状态：」→ 按映射表建 slice/task，**只存 external_ref + hash，不复制正文** | 49 个 WI 全部登记成功，`links` 非空 |
| 3.3 幂等 | 重复跑不产生重复行（靠 external_ref 唯一） | 跑两次行数不变 |

### W4 门禁接入机检（让"人批准"前面先有机器判定）

**为什么**：现在 `gate_submit` 只查"证据≥1"，证据可以是 agent 自述。

| 动作 | 具体 | 验收 |
|---|---|---|
| 4.1 `host/checkers.js` | 从 `<root>/tools/engineering/` 动态 import，跑 A 类 5 个模块 | 单测：伪造目录 → 报 NOT_AVAILABLE，不崩 |
| 4.2 `gate_submit` 前置 | 任一 FAIL → 抛 `GATE_PRECHECK_FAILED` + issues 原文 | 用当前 lumio 实跑，必须因 5 条 `DIR_UNREGISTERED` 失败 |
| 4.3 存证 | 通过则把 5 份原文写 evidence（`command` + `result_summary` + `content_hash`） | 面板能看到原文，不只是摘要 |
| 4.4 旁路记录 | 人若坚持在红灯下批准，必须填 `override_reason`，落一条 decision | 无 reason → 409 |

### W5 权属搬迁与收尾（解双权威与红灯）

| 动作 | 具体 | 验收 |
|---|---|---|
| 5.1 `.project/` 移出工作区 | 改 `registry.js:128-141` 路径 → `~/.dsh/storages/project-workbench/<workspaceId>/`；headless 保留回退 | agent 写 `.project` → EPERM（实测该路径本就 EPERM） |
| 5.2 迁移脚本 | 旧 `.project/` → 新位置，校验 hash | 迁移后 `project_status` 一致 |
| 5.3 lumio policy 登记 | `.project` 进 `ignoredDirectories`（若 5.1 未上线则保留在工作区，此步暂缓） | checker 5 条 `DIR_UNREGISTERED` 清零 |
| 5.4 `MEMORY_BEHIND` 解耦 | `docs/memory/project-context.md` 的当前交接改由插件导出生成，不再手写 | closeout 转绿 |

**5.1 与 5.3 的因果关系必须保持**：先搬走（agent 碰不到），再登记忽略（checker 不红）。顺序颠倒会得到一个"被忽略但仍可被篡改"的位置。

## 4. 执行顺序与依赖

```
W1（DB 防线）──┬─→ W4（门禁机检）──→ W5.3/W5.4（消红）
               │
W2（阶段可配）─┴─→ W3（状态映射）──→ W5.1/W5.2（搬迁）
```

- **W1 必须最先**：其它包都建立在"DB 真的会拒绝"之上。
- **W2/W3 可并行**：都只动 DB 与 project.json，不碰门禁。
- **W4 依赖 W1**：否则门禁虽然绿了，DB 仍可被直改。
- **W5 最后**：搬迁会改变路径，前面的验收用例要跟着改；放最后只改一次。

## 5. 每个工作包的验收方式（都可复现）

| 包 | 验收命令 / 断言 |
|---|---|
| W1 | `node .artifacts/verify-constraints.cjs` 的 9 项全部从「允许」翻成「拒绝」，除 3 项明确豁免 |
| W2 | 改 `project.json.stageTemplate` → 重启 → `SELECT * FROM stages` 一致；重复 key → 报错 |
| W3 | 42 种状态逐条断言映射结果；未映射表述必报错；跑两次行数不变 |
| W4 | 当前 lumio 实跑必须因 5 条 `DIR_UNREGISTERED` 失败；造一个断链 fixture 也必须失败 |
| W5 | `echo x > ~/.dsh/storages/...` 从 agent 侧必须 EPERM；`git status` 中 `.project` 消失 |

## 6. 需要你先拍板的三件事

### D1：DB 防线做到哪一层？

| 选项 | 内容 | 代价 |
|---|---|---|
| **A**（推荐） | W1 全做（触发器 + 唯一约束 + 枚举） | ~90 行 DDL + 1 个 migration |
| B | 只做唯一约束，不做触发器 | 少一半，但 append-only 仍是口头承诺 |
| C | 都不做，先上 W2/W3 | 快，但"单写"继续名存实亡 |

### D2：阶段模板改动如何处理已有项目？

| 选项 | 内容 | 代价 |
|---|---|---|
| **A**（推荐） | 读回 project.json；已有项目不动，提供显式 `stage_remap` | 旧项目需要一次手工确认 |
| B | 读回并自动按新模板重建阶段 | 会静默改变已有项目的阶段语义——不可逆 |
| C | 不改，只把 lumio 的阶段塞进 S1..S7 的 name | 语义错位，门禁判据对不上 |

### D3：`.project/` 搬到哪？

| 选项 | 内容 | 代价 |
|---|---|---|
| **A**（推荐） | `~/.dsh/storages/project-workbench/<workspaceId>/` | 改路径 + 迁移脚本；headless 需回退 |
| B | 留在工作区，只加 guard | 实测 guard 被 `run_code` 裸 fs 绕过，等于没加 |
| C | 留在工作区，靠"约定不改" | 回到当前状态：checker 恒红 + 可被直改 |

## 7. 我打算怎么验证"真的只通过插件"

四条反证，缺一不可：

1. **反证 1**：从任务会话发一条 `sqlite3 UPDATE` 到 DB → 必须失败（W1 触发器）。
2. **反证 2**：从任务会话 `fs.writeFileSync` 到 `.project/` → 必须 EPERM（W5 搬迁）。
3. **反证 3**：在 checker 红灯下 `gate_submit` → 必须失败并返回 issues 原文（W4）。
4. **反证 4**：手改 `docs/` 导出文件 → 下次导出的 hash 与 `exports` 表不一致，被 `import_inbox` 拒绝（W4 存证）。

## 8. 工作量与风险

| 包 | 估时 | 主要风险 |
|---|---|---|
| W1 | 1 天 | migration 写错会锁死旧库 → 先备份 + 幂等 + 可在副本上跑 |
| W2 | 0.5 天 | 自动重映射会静默改语义 → 只提供显式命令 |
| W3 | 1 天 | 42 种表述映射靠人判断，必有一两处争议 → 未映射即报错 |
| W4 | 1 天 | 动态 import 用户路径的代码 → 只 import 已知 5 个文件名，不扫目录 |
| W5 | 1 天 | 路径变更影响所有验收用例 → 放最后，一次性改 |

**总计约 4.5 天**，可按包分批交付，每包自带验收。

## 9. 执行记录

### 2026-11-14 · W1 完成

做了什么：给 schema 加 v2 防线（7 个触发器 + 2 个唯一索引 + 状态枚举审计），并在 `store` 层把唯一冲突翻译成可读错误码。迁移把"去重"与"加约束"放在同一事务里，先降噪再加约束，因此存量库（lumio 实测有 1 组重复 evidence）能直接升级。

怎么验证：8 项"绕过应用层直连 DB"的反证全部被拒、4 项合法写全部放行；真实库副本迁移 27ms 完成、事件与版本数不变；全套 94 项测试（67 单测/验收 + 17 replay + 10 negative）全绿。

遗留：W1 只解决"绕过应用层直连数据库"。**没有**解决：
- 任务会话能 `fs.write` 整个 `.project/` 目录（W5 的搬迁）；
- 门禁仍只看"证据≥1"（W4 的机检）；
- ~~阶段模板仍硬编码~~ → 已由 W2 解决。

### 2026-11-14 · W2 完成（D2 按选项 A 执行）

做了什么：把阶段模板从"模块常量"改成"从 `project.json` 读回"。新增 `normalizeStageTemplate` / `resolveStageTemplate` / `planStageRemap` 三个纯函数，registry 暴露 `activeStageTemplate` 与 `stageRemapPlan`。**存量项目不被自动改写**：只补缺失阶段，绝不删/改名/改门禁。

怎么验证：6 个新测试覆盖"改配置真生效""非法回退并带原因""存量不破坏""remap 只出计划"。用 lumio 库副本实跑 `w2-stage-remap.mjs`，得到关键结论：直接把 S1..S7 换成 `PRD/DEV/FILE/CODE` 会让 **active 阶段的 S1 消失**（`activeStageSurvives: false`）——这正是 D2 选 A（不自动改）的实证依据。

遗留：
- 模板能配了，但 lumio 项目**还没换**——换之前必须先有 W3 的状态映射，并让人确认 remap 计划；
- `project.json` 里非法模板目前只回退 + 能被 API 读到，**还没有在 UI 上告警**。

### 下一步：W3（状态词表映射）

原因：W2 让阶段可配，但阶段里要挂的状态仍是 42 种中文自由文本。W3 是"把 lumio 的真实数据搬进来"的最后一块前置，也是 W5 收尾对账的前提。

W3 的关键取舍：42 → 6 的映射表必须**显式且可机检**，遇到未映射表述要报错而不是猜。

