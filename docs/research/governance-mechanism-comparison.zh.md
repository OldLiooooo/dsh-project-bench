# 两套「项目治理」的对比：lumio 仓库治理 vs 工作台插件机制

> 2026-11-12 · 只读核查（未改 lumio 与 workbench 任何代码）。事实底稿：
> [lumio-facts.md](governance-facts/lumio-facts.md)、[plugin-facts.md](governance-facts/plugin-facts.md)。
> 关联：[`docs/lumio-git-ci-postmortem.zh.md`](../lumio-git-ci-postmortem.zh.md)、[`docs/research/lumio-doc-system-audit.zh.md`](lumio-doc-system-audit.zh.md)、
> [施工图 §12.1/§12.2](../workbench-architecture-v1.zh.md)、[`docs/delivery.zh.md`](../delivery.zh.md)。

## 0. 一页结论

| 问题 | 结论 |
|---|---|
| 是不是同一件事？ | **不是同一层。** lumio 治理的是「交付」（代码进 main 需要过什么），插件治理的是「过程」（阶段/切片/决策/会话/交接怎么流转）。 |
| 相同的部分 | **意图几乎完全重合**：唯一权威、单一写入口、可追溯、状态机+门禁、证据优先、写作用域隔离、认领与并发、生成物与权威分离。 |
| 冲突的部分 | **权威位置冲突（双写）**、**写入口与绕过面冲突**、**状态词表/粒度冲突**、**门禁判据不同源**、**成本方向相反**、**可 review/可回滚 vs 不可 review**。 |
| 双写是哪的问题 | **两种双写**：跨系统（仓库↔DB，**项目现场问题**，缺迁移清扫）+ 插件内部（**机制问题**，缺唯一约束），见 §5。 |
| 插件能否保持单写 | **能**：应用层单写者已成立；文件级/DB 级独占**未成立**（2 连接可同写、0 触发器、任务会话有 bash+fs write）；「伪造一次合法写入」需靠「DB 移出工作区 + 证据进 git」兜底。见 §5.3。 |
| 工作区能否全由插件改 | **能，但要换思路**：不是「禁 agent 写」（两条路都不成立：run_code 裸 fs 可绕过工具层、沙箱无 deny-list），而是「把权威搬出工作区」（~/.dsh/storages/ 实测 agent 为 EPERM）+ 代码/测试保留 agent 直写并用 hash 事后机检。见 §6。 |
| 更应该采取哪种 | **分层双权威，不做二选一**：交付治理用 lumio（git 为权威），过程治理用插件（DB 为权威），但两者必须**用外键单向绑定 + 机器判据互认**，否则就是第二个影子权威。 |

**一句话判据**：某个状态的下一次读者是谁，权威就放在哪 —— 要被 git/CI/人 review 的（代码、契约、发布记录）放仓库文件；要被多个 agent 会话并发读写且需要 CAS/租约的（切片、任务、会话、阶段、待办决策）放 DB。

---

## 1. 两套机制各自是什么

### 1.1 lumio 仓库治理（文件 + git 为权威）

| 层 | 载体 | 证据 |
|---|---|---|
| 权威顺序 | 人类确认 > 已生效 DEC > AGENTS/工程规范 > 模块 README/合同/测试 > 代码现状 | `AGENTS.md:7-13` |
| 过程实体 | 工作项 49 + bootstrap 2、决策 39、证据 32、项目记忆 4（均为 markdown，人和 agent 都可直写；目录另有 README/索引） | `docs/work-items/`、`docs/decisions/`、`docs/evidence/`、`docs/memory/` |
| 硬约束工具 | coordinate（认领/编号/范围锁）、ai-finish（唯一交付入口）、checker、closeout、integrity、verify（4 档）、merge-pr | `tools/engineering/*.mjs`（3,440 行 + 2,594 行反例测试） |
| 闸门 | pre-commit → `gate.mjs --staged`；pre-push → `verify.mjs --tier=code`；远端 Gitee CI 只跑 gate 档 | `.githooks/pre-commit:9`、`.githooks/pre-push:25`、`.workflow/README.md:27-33` |
| 目录/清单不变量 | policy.json：108 目录、95 模块 README、35 必填文件、4 条 deferredChecks | `tools/engineering/policy.json` |
| 无服务端状态 | 认领表 `.tmp/coordination/claims.json`、收尾状态 `.tmp/ai-finish/<WI>/state.json`、远端 PR/check-run | coordinate.mjs、ai-finish.mjs |

### 1.2 工作台插件（`.project/project.db` 为权威）

| 层 | 载体 | 证据 |
|---|---|---|
| 权威 | 一个工作区一个 `project.db`（SQLite WAL），20 张表 | `workbench/host/schema.js:5-41` |
| 单写者 | 唯一 `ProjectDb` 实例；每次写 = 一个 `BEGIN IMMEDIATE` 事务 + 同事务 `appendEvent`（seq 无空洞） | `workbench/host/db.js:91-118` |
| 过程实体 | slices / tasks / sessions / documents+doc_versions / decisions / approvals / evidence / artifacts / leases / exports / imports | schema.js |
| 硬约束 | 文档版本只增、DOC_FROZEN、LEASE_HELD、同一（切片,角色）只能一个 active 任务会话、会话命名 角色-切片-动作、证据≥1 才能收工、不可逆决策 CONFIRM_REQUIRED(409) | `docs.js:150,162`、`leases.js:56-62,141-155`、`pm-tools.js:151-154`、`store.js:333-351`、`task-tools.js:214-237`、`project.js:210-237` |
| 人门禁 | 只有 `POST /project-workbench/api/decision` 能落定；agent 工具集里**没有** approve/resolve；批准 → 冻结+导出+阶段推进同一事务 | `http.js:341-354`、`project.js:96-141`、`pm-tools.js:219-253` |
| 上下文预算 | L0 400 / L1 300 / L2 900，硬上限 2000 tokens，超限降级 | `context.js:243-253`、`project-defaults.js:31` |
| 导出单向 | DB → `docs/*.md`（带 generated 头），只写不回读；索引器显式跳过 `docs` | `export.js:143-177,88-94`、`indexer.js:15-18` |
| 编排 | PM 用 `session_spawn_task` → `ctx.subagents.startActivation(agentPreset:'project-task')`；**不用**原生 Agent Teams 任务板 | `orchestration.js:240-322`、`docs/implementation/contracts-v1.zh.md:179` |

---

## 2. 相同的部分（意图级重合，9 条）

| # | 治理意图 | lumio 的实现 | 插件的实现 |
|---|---|---|---|
| 1 | **唯一权威 + 单一写入口** | 唯一交付入口 `ai-finish --pr`；手工 commit/push 是「被承认的例外」，须登记 | 唯一可写 `ProjectDb`；全体写经存储层工具；agent 无 approve 工具 |
| 2 | **可追溯（谁/何时/为什么）** | WI+DEC+EV 文件 + git history + 提交 trailer | append-only `events`（seq 无空洞 + 时间线导出） |
| 3 | **状态机 + 门禁** | 工作项状态词表 + pre-commit/pre-push/CI/PR/人合并 | 7 阶段 7 门禁 + 决策卡 + 不可逆二次确认 |
| 4 | **证据优先，自述不算** | 「没有证据的已完成只能标记实现完成」；验收须可复现 | `session_finish_task` 硬要求证据≥1；`gate_submit` 要求 evidenceIds |
| 5 | **写作用域隔离** | `coordinate` 路径级 scope + `SCOPE_OUTSIDE`/`WORKTREE_NOT_ISOLATED` | 切片租约（`LEASE_HELD`）+ `noOutOfScopeChanges` 声明 |
| 6 | **认领/并发控制** | `claims.json` + 单一全局锁 + 重叠拒绝（`SCOPE_CONFLICT`） | `leases` 表 + TTL/抢占/续期 + 唯一索引（`DUPLICATE_ACTIVE_SESSION`） |
| 7 | **生成物 ≠ 权威** | 规格生成物 `--check`、仪表盘产物不入库、计数由 index.json 生成 | `docs/` 导出只写不读、`doc_sections`/`doc_fts` 派生可重建、`file_index` 只存 path+hash |
| 8 | **人只看驾驶舱/入口** | `docs/dashboard`、memory 单入口、AI 收尾入口唯一 | 面板（总览/树/文档/决策/时间线）+ 会话内徽章 |
| 9 | **流程成本意识** | 复盘已量化（治理提交占比、重复收尾、未验收积压） | 设计要求 `process_health` + 「流程健康」卡片（**未实现**） |

> 这 9 条说明：**两套机制在「要什么」上高度一致，分歧只在「放在哪、谁来判」**。

---

## 3. 冲突的部分（6 类，按严重度）

### C1 双权威（最硬冲突）：同一批实体写了两遍

- lumio 实测：DB 有 4 slices / 5 tasks / 3 decisions / 3 evidence / 45 events；仓库有 52 WI / 40 DEC / 34 EV。
- **同一件事两边各写一份**：DB `slice-7937fb41`（`baseline-reconcile`，status=review）↔ 仓库未提交的 `WI-20261112-001`；DB 的 3 条 evidence 逐字引用仓库命令输出；artifacts 指向仓库文件。
- **零绑定**：`links` 表 0 行、`content_hash` 全 NULL、全仓 grep `.project` 在 `tools/apps/backend/packages/infra` 下 0 命中 → 门禁对 DB 零感知，DB 对 git/CI/PR 零感知。
- 现成症状：插件把宿主门禁钉在红态 —— `checker` 恒报 5 条 `DIR_UNREGISTERED .project*`（实测 `FAIL: 663 files, 113 directories, 5 issues`），closeout 另报 `MEMORY_BEHIND`。而 DB 自己已经把这条冲突登记成一条 pending 决策（「.project 工作台存储的 policy 归属」）。

### C2 写入口与绕过面冲突：两边都把不变量押在「参与者自愿」上

| 不变量 | 声称 | 真实绕过面 |
|---|---|---|
| 插件：「只有 ProjectDb 能写」 | 单写者 | 任务会话 preset 带 `tool-bash`/`tool-pwsh` + `tool-fs` write/edit（`cordis.patch.yml:108-121`）→ 可直接 sqlite 改库；无触发器/CHECK |
| 插件：「片外零改动」 | 硬校验 | 只校验**自述** `noOutOfScopeChanges===true`（`task-tools.js:214-216`），不与工作区 diff 比对 |
| lumio：「唯一交付入口」 | `ai-finish --pr` | 手工 `git commit/push` + `--no-verify`（需登记、无检测）；直推 main（分支保护对管理员无效）；手工合并（无 `pre-merge-commit`） |
| lumio：「合并门禁」 | `merge-pr` 校验 check-run | **Windows 上 5 个 CLI 静默失效**（实测 `merge-pr/create-pr/check-runs --help` 均 exit 0 且零输出，因为用 `argv[1].endsWith('/x.mjs')` 判断入口）→ 合并门禁在 Windows 无法经 CLI 触发 |

### C3 状态词表与粒度不兼容

- 仓库：工作项状态是**中文自由文本**（`实现完成（未验收）`、`已完成（实现完成，非验收）`…），全仓无代码校验状态转移顺序；状态机 `待认领→已认领→实施中→待验证→已完成` 只写在 `docs/engineering/multi-agent-collaboration.md:15`。
- 插件：英文枚举（slice: open/review；task: pending/blocked；document: draft/review/approved/frozen）+ 7 阶段 G1–G7。
- 粒度差一个数量级（4 切片 vs 52 工作项）；插件阶段模板（S1 产品 → S7 复盘）与仓库生命周期（PRD-W → DEV-W → FILE-W → CODE-W）**没有映射表**。
- 后果：任何「同步」都要先造一张词表映射，而这张表没人维护 → 必然漂移（正是 lumio `COUNT_STALE` 的翻版）。

### C4 门禁判据不同源（同名不同义）

- lumio 的「验收」= checker/closeout/integrity + verify 档位 + check-run + 人合并，**有机器判据**。
- 插件的「门禁批准」= 人点按钮 + 冻结文档 + 推进阶段；除 `NO_EVIDENCE` 外**没有任何机器判据**，证据本身可以是 agent 自述文本。
- 于是同一个词在两处含义不同：插件 `gate/approve` 只证明「人点了批准」，**不证明代码可运行**。而 §12.2 第 6 条要求的「收尾对账门」在插件中完全未实现（十条硬规则实测**完全实现 0 条**）。

### C5 成本方向相反（lumio 复盘的核心教训正在插件上重演）

| 量 | lumio | 插件 |
|---|---|---|
| 治理/工具 vs 被治理对象 | 文档 34,904 行 vs 业务代码 4,081 行（8.5:1）；工具 3,440 + 测试 2,594 | host 6,304 + client 3,755 = 10,059 行代码，另加测试 4,476 + 设计文档 5,469；而它当前实际托管的 lumio 业务代码是 4,081 行 |
| 提交/新增行占比 | docs 触及 92/111（82.9%）、业务代码四根仅 8 个（7.2%）；新增行 docs 82.9% | —— |
| 设计承诺 vs 落地 | —— | §12.2 十条硬规则：**完全实现 0 条**；§12.1 阶段写路径策略 **0 行代码**；`expectedRevision` CAS **0 命中** |

lumio 复盘的 R5 是「事故 → 加工具/加决策 → 工具成为最大变更源」。插件目前是**文档先行、约束后置**：设计里写着"状态机"，代码里只有存储层与 4 处写作用域校验。这不是冲突，但**会把冲突放大**：机制越描述得完备，越容易被当成"已经有了"。

### C6 可 review / 可回滚 vs 不可 review

- lumio：权威在 git → 可 diff、可 review、可回滚、可跨机（代价：多 checkout 冲突需要人工协调）。
- 插件：权威在 `project.db`，**不入 git**（`registry.js:61-76` 生成 `.project/.gitignore`）；实测 `git ls-files .project` = 0，连 `project.json` 都没跟踪（与自己注释矛盾）。
- 后果：DB 中的阶段推进、决策落定、门禁批准**不可 review、不可回滚、不可跨机**；只能靠 `exports/` 快照重建人读视图，而 `exports` 表当前 0 行。

---

## 4. 对「项目治理」更应该采取哪种

### 4.1 结论：分层双权威，不做二选一

| 治理层 | 权威放哪 | 采用哪套 | 理由 |
|---|---|---|---|
| **交付治理**（代码、契约、发布、合并） | 仓库文件 + git | **lumio 那套**（唯一入口 + 钩子 + verify 档位 + check-run + 人批准） | 交付物本体就是文件；git 天然提供 diff/回滚/review/跨机；DB 无法承担 merge 语义 |
| **过程治理**（阶段、切片、任务、会话、交接、待办决策） | `.project/project.db` | **插件那套**（单写者 + 事件时间线 + 租约 + 人门禁） | 这些状态要被多个 agent 会话高频并发读写、需要 CAS/租约/TTL，且**不需要**进 git |

### 4.2 但插件那套必须先补 5 个前提，否则它只是第二个影子权威

1. **外键单向绑定，禁止双写正文**：DB 只存 `external_ref`（WI/DEC/EV 编号）+ `content_hash`，正文只在仓库；仓库只认编号存在性，不读 DB。当前是两边各存一份正文（C1 的直接成因）。
2. **门禁由机器判据驱动，人只做批准**：`gate_submit` 前必须跑 `verify.mjs --json` + `gate.mjs --closeout`，把**原文输出**存为 evidence（`result_summary` 已有字段），人看到的是退出码而不是叙述。这与 C4 相反，也是唯一能挡住「假绿」的做法。
3. **DB 必须可重建、可审计**：导出快照（timeline + 决策/切片投影）进 git；DB 丢失能从快照 + 仓库重建。没有这一条，「不可 review」就是硬伤。
4. **收紧绕过面**：`.project/**` 在 preset 层禁止任务会话写（工具 guard 或 fs 限制）；`git` 写只经交付入口。否则 C2 会让「单写者」名存实亡。
5. **治理预算上限**：新增一个治理机制必须替换/删除一个旧机制（lumio `DEC-20261109-001` 的单一入口教训）。度量项直接复用 lumio 已跑通的口径：治理提交占比 >30% 告警、未验收积压 >5 告警。

### 4.3 当前 lumio 现场的落地顺序（可立即执行）

| 步 | 动作 | 解决 |
|---|---|---|
| 1 | `.project` 进 `policy.json.ignoredDirectories`（DB 是运行时存储，不是交付物） | checker 5 条恒红（DB 里已有同名 pending 决策，推荐项一致） |
| 2 | DB 的 slice/task/evidence 增加 `external_ref`（WI/DEC/EV 编号）+ 回填现有 4/5/3 条；`links` 表启用 | C1 双权威 → 单向绑定 |
| 3 | `gate_submit` 增加「必须附 verify/closeout 的 `--json` 原文」硬校验 | C4 判据不同源 |
| 4 | 交付链保持 lumio 原样：`ai-finish --pr` 唯一入口；同时修 Windows 上 5 个 CLI 的入口判断（`path.resolve` 比较） | C2 绕过面（合并门禁在 Windows 全哑） |
| 5 | 文档类工作项的 `MEMORY_BEHIND` 冲突：改成「`docs/memory/project-context.md` 的当前交接由 DB 导出生成」，而不是让每个文档型 WI 都手改 project-context | 现存的 closeout 恒红（DB 里已登记为 pending 决策） |

### 4.4 明确不要做的

- **不要**把 git/PR/check-run 搬进 DB（重造 GitHub，成本无上限）。
- **不要**让 DB 成为"唯一权威"后再导出给人看：不可 review 的权威在出事故时无法复盘。
- **不要**给两边都写状态、靠"记得同步"维持一致 —— lumio 的 `COUNT_STALE`/`MEMORY_BEHIND`/`ID_DUPLICATE` 全部出自这个模式。
- **不要**在 §12.2 十条硬规则落地前继续扩写设计文档（C5：文档先行会把"设计过"误当"已实现"）。

---

## 5. 双写问题怎么解：先分清"两种双写"，再判断"插件能不能单写"

> 本节回答两个具体问题：**双写是项目现场的问题，还是插件机制本身不成立？** 以及 **插件到底能不能保持单写？**
> 结论先给：**两种都存在，但性质不同、解法不同**；插件**能**做到单写，但**当前实现只做到了"单实例"，没做到"单写者"**。

### 5.1 把"双写"拆成两个独立问题

| | A. 跨系统双写（仓库 ↔ DB） | B. 插件内部双写（DB 内部） |
|---|---|---|
| 是什么 | 同一个"工作项/决策/证据/交接"在仓库 markdown 与 `project.db` **各存一份正文**，无外键、无 hash 对账 | 同一件事在 DB 内部被两条路径写两次（不同 `kind` 的 artifact、重复 evidence 行、同切片两份 handoff） |
| 属于谁 | **项目现场问题**（把新机制叠加到既有项目上、没有做迁移清扫） | **插件机制问题**（schema 缺唯一约束、缺"一个事实一个权威行"的模型） |
| 是否致命 | 是：门禁看不见 DB、DB 看不见门禁，且已把宿主 checker 钉成红 | 中等：会漂移、会让"时间线"讲两个版本的故事，但不影响门禁 |
| 解法 | 单向绑定 + 迁移清扫（§5.4） | 唯一索引 + 禁止自动换 key（§5.3 末 / §5.4 第 3 步） |

> 一句话：**A 是"两套权威并存"，B 是"一套权威内部有冗余表示"。** 混为一谈会导致错误的结论——要么认为"插件不该存在"，要么认为"只要写个同步脚本就好了"。

### 5.2 实测：双写到底有多大（不是理论担忧）

跨系统（A）——实测自 lumio 当前现场：

| 证据 | 数字 / 事实 |
|---|---|
| DB 的 `slice-7937fb41`（`baseline-reconcile`）↔ 仓库 `WI-20261112-001` | 同一件事，两边各自完整 |
| DB `artifacts` 指向的仓库文件 | 6 条，其中 4 条是 `README.md`、`docs/README.md`、WI 文件、EV 文件；**`content_hash` 与 `bytes` 全为 NULL**（等于没有任何对账抓手） |
| DB `evidence` | 3 条，`result_summary` 逐字复制仓库命令输出；`content_hash` 全 NULL |
| DB 的 3 条 pending decision | 仓库 `docs/decisions/` 中**一条都没有**（`grep` 三个标题全部 0 命中）→ 真正的"只在一边存在"的孤儿决策 |
| DB `documents` 正文 | 3 个版本，共 8,244 字符；仓库里同一件事另有 5,098 字符的 WI 文件 → 两份不同结构、不同章节、无法逐字对上的叙述 |
| 绑定机制 | `links` 表 **0 行**；全仓 `grep '\.project'` 在 `tools/apps/backend/packages/infra` 下 **0 命中** |

插件内部（B）——实测自同一个 DB：

| 现象 | 实测 |
|---|---|
| 同一路径被登记为两种 kind | `docs/evidence/EV-20261112-001-*.md`、`docs/work-items/WI-20261112-001-*.md` 各被写成 `doc-export` + `code-file` 两条 artifact |
| 同一 EV 被两条 evidence 指向 | `evidence where uri=EV-...` → **2 行** |
| 同一（切片, handoff）两份正文 | `handoff/baseline-reconcile`（v1 249 字符 + v2 3,566 字符）与 `handoff/baseline-reconcile-readme-status-align`（v1 4,209 字符）——**后两份讲同一件事** |
| 为什么会这样 | 三个原因叠加：① `session_finish_task` 写 handoff 时若撞 `DOC_FROZEN` 会自动换 `logicalKey`（`task-tools.js:44-57`）；② `artifacts`/`evidence`/`documents` **三个表都没有唯一索引**（实测查询：唯一索引 = 无）；③ artifact 的 kind 是调用方自由填的字符串（`shared-tools.js:56`） |

### 5.3 插件能不能保持单写？——**能，但当前实现只是"单实例"**

这是本节的核心判断，分三类看。

#### (a) 已成立的：应用层单写者

- 只有一个 `ProjectDb` 实例（`registry.js:143-145` 的 `Map` 缓存），所有写都过 `store/docs/leases` 领域函数，每次写 = `BEGIN IMMEDIATE` + 同事务 `appendEvent`（`db.js:91-118`）。
- 这在**同进程、正常路径**下是成立的，且 seq 无空洞、事件与数据同事务，这块设计是对的。

#### (b) 不成立的：没有任何文件级/数据库级独占

实测（三个 PoC，均在 workspace 内的副本上跑，未动真实 DB）：

| PoC | 结果 | 含义 |
|---|---|---|
| 两个独立 `DatabaseSync` 连接同时打开同一 DB 并各写一行 | **都成功**（`from-plugin` + `from-agent` 两行都在） | "单写者"是**同进程内只有一个实例**，不是文件独占；任何第二个进程都能写 |
| 直接用 SQL 伪造"人已批准" | **成功**：`decisions.status='approved', decided_by='user'`、`approvals` 插一行、`stages` 把 S1/S2 同时置 active、插一条 `gate/approve` 事件（seq 连续，跳号检测也不会响） | **人门禁的"不可代批"只在工具层成立**，绕过工具层就没防线 |
| schema 里的防线 | `CREATE TRIGGER` = **0**、`CHECK(` = **0** | 数据库完全不做校验 |

而任务会话**确实拥有这些能力**：preset 里 `tool-bash`/`tool-pwsh` + `tool-fs` write/edit 全开（`cordis.patch.yml:108-121`）。

**但有一个重要的缓解事实（实测）**：DSH 的文件沙箱是**按会话工作区**围栏的——

| 写入目标 | 结果 |
|---|---|
| `<当前工作区>/.project/` | **允许**（agent 可写） |
| `C:/Users/oldap/Documents/lumio/.project/`（另一个工作区） | **拒绝** `Permission denied` |
| `~/.dsh/` | **拒绝** `Permission denied` |

所以：**agent 只能篡改"自己当前工作区"里的 DB**。这条约束把攻击面从"任意项目"缩到"自己所在项目"，但缩不到零——因为插件 DB 恰恰就在工作区里（`.project/project.db`）。

#### (c) 结论与三层修复（从便宜到贵，可叠加）

| 层 | 做法 | 成本 | 挡住什么 | 挡不住什么 |
|---|---|---|---|---|
| **L1 工具层**（现有 + 补漏） | 已有 `requireProjectActor`/`when` 过滤；补一条 `ctx.tools.guard()`：deny 任何 `write`/`edit`/`apply_patch` 目标落在 `.project/**`，deny `bash`/`pwsh` 命令里出现 `.project` 或 `project.db` | 十几行（`tools.guard` 已实测存在：`.runtime/dsh-tools/lib/index.js:649`，且 guard 在 PTC 子调用路径上也会跑） | 90% 的顺手改；模型可见拒绝理由 | 脚本里编码路径、从别的目录 cd 进去、base64、node -e 拼字符串 |
| **L2 数据库层** | 加 SQLite 触发器，把**单调不变量**钉在库里 | ~30 行 DDL，不改一行应用代码 | 见下方实测表 | 伪造一条本来就允许的"新增"行（如首次 approve） |
| **L3 存储位置** | DB 移出工作区（`ctx.storageDomain` 的后端文件在 `~/.dsh/storages/`，实测沙箱拒绝写） | 中：要改 registry 路径 + headless 兼容 | **整类** "agent 直接改库" | 沙箱被提权（`danger-full-access` 或用户批准升权） |

**L2 的实测效果**（PoC：装了 7 个触发器后重跑同样的攻击）：

```
攻击面：agent 直接改库
  ALLOWED  伪造 decision -> approved        ← 唯一挡不住的
  BLOCKED  把已批准 decision 改回 pending  [DECISION_TERMINAL]
  BLOCKED  删事件                          [EVENT_IMMUTABLE]
  BLOCKED  改事件 payload                  [EVENT_IMMUTABLE]
  BLOCKED  插跳号事件                      [SEQ_GAP]
  BLOCKED  删 doc_versions                 [DOCVERSION_IMMUTABLE]
  BLOCKED  改 doc_versions 正文            [DOCVERSION_IMMUTABLE]

合法写：必须仍然通过
  ALLOWED  冻结版本（UPDATE OF frozen，不在禁止列表）
  ALLOWED  正常追加事件（seq 连续）
  ALLOWED  pending decision 正常落定
```

> 「伪造 pending → approved」挡不住是**结构性的**：SQLite 触发器只认数据，不认"这次写入是谁发起的"；在同一个连接语义下，人点按钮和 agent 写 SQL 产生的行完全一样。
> 所以真正的防线只能是 **L3（文件不在可达路径内）+ 事后追责（把证据落到 git）**——这也正是 §4.2 第 3 条"DB 必须可重建、可审计"的原因。

**推荐组合**：L1 + L2 立刻做（当天可完成，纯加法、不破坏现有测试），L3 作为下一个迭代——因为它同时解决了 C6（不可 review）和这一条的最后 10%。

### 5.4 跨系统双写（A）怎么解：三选一 + 迁移清扫

| 方案 | 做法 | 代价 | 适用 |
|---|---|---|---|
| **S1 单向绑定（推荐）** | DB 只存 `external_ref`（WI/DEC/EV 编号）+ `content_hash`；正文只在仓库；DB 的作用是"过程状态 + 索引"，不是"内容仓库" | 要改 `documents` 语义（现在存正文），加 `external_ref` 列与回填 | 现在是叠加式引入，仓库已有 49 WI / 39 DEC / 32 EV |
| S2 DB 权威 + 导出 | 正文进 DB，仓库只放导出快照 | git 失去 review/回滚语义（C6），且要把 52 个 WI 迁进 DB | 新项目从零开始，且团队接受"看板即权威" |
| S3 双向同步 | 两边都写，靠脚本对账 | lumio 的 `COUNT_STALE`/`MEMORY_BEHIND`/`ID_DUPLICATE` 全部出自这个模式；**明确不要做** | 无 |

**S1 的落地清单（按依赖顺序，每步都可独立验收）**：

1. `documents` 加 `external_ref TEXT`（`WI-YYYYMMDD-NNN` / `DEC-...` / `EV-...`）+ `content_hash` 回填真实值（现在全 NULL）。
2. `links` 表启用：`(slice, WI)`、`(evidence, EV)`、`(decision, DEC)` 三类关系先建。
3. `session_finish_task` 增加硬校验：`files[]` 里的每个路径必须**真实存在于工作区**且 hash 与登记一致（现在只做相对路径规范化，`spec-helpers.js:94-101`）；`noOutOfScopeChanges` 从"自述"改为"与 `file_index` 的 diff 比对"。
4. `gate_submit` 要求 `verify.mjs --json` + `gate.mjs --closeout` 的**原文**作为 evidence（把 C4 的"人点了批准"变成"机器判据 + 人批准"）。
5. 写完迁移脚本后**删除重复源**：DB 里已有的 3 条孤儿 decision 要么补进仓库 `docs/decisions/`，要么标 `superseded` 并写明"未入仓库，作废"。

> 第 5 步是 lumio 复盘 R2「交付链切换没有清扫」的直接教训：**新机制上线必须带清扫清单**，否则旧副本会一直漂。

### 5.5 两个问题的直接回答

**Q1：双写是项目的问题，还是插件的问题？**
两者都有，必须分开治：
- **跨系统双写是"项目现场问题"** —— 把新机制叠加到已有 111 提交、49 工作项的仓库上，却没做迁移与清扫（§5.2 A）。换成任何别的工具，只要"又存一份正文"，都会出同样的问题。
- **插件内部双写是"机制问题"** —— schema 缺唯一约束、"handoff 撞冻结就换 key"、"artifact kind 自由填"，这些是设计缺陷，跟项目无关（§5.2 B）。换到空项目上一样会发生。

**Q2：这个插件是不是就不能保持单写？**
**能，而且应该保持。** 但要区分三件事：
1. **应用层单写者**：已经成立（唯一 `ProjectDb` + 单事务 + 事件同写）。
2. **文件级/DB 级独占**：**当前不成立**（两个连接可同时写；0 触发器 0 CHECK；任务会话有 bash + fs write）。这是必须补的，不是"设计上做不到"——加 guard + 触发器是纯加法。
3. **"单写"挡不住"伪造一次合法写入"**：这是 DB 语义的边界，不是插件缺陷。所以最终防线必须落在 **L3（DB 不在工作区可达路径）+ 证据进 git**，而不是继续在 SQL 层加规则。

> 换句话说：**插件的方向是对的（单写者 + append-only + 人门禁），错在把"约束"写在了 prompt 和工具层，而没写在它唯一信任的那一层。** 补上 L1+L2 之后，它就是真正的单写者；补上 L3 之后，它才配当权威。

---

## 6. 「工作区全部由插件改，非插件不允许改」能不能做到

> 这是最彻底的单写方案：**工作区里所有文件变更都必须经过插件**，agent 不能自己写工作区。
> 结论：**能做，但不是靠"禁止 agent 写"做到的，而是靠"让 agent 写不到 + 给插件一条特权通道"**。
> 关键在于：DSH 的沙箱**没有 deny-list**，它只表达"能写哪里"，不能表达"工作区可写但某个子目录不可写"。

### 6.1 三条可能的实现路径，只有一条成立

| 路径 | 做法 | 判定 | 依据 |
|---|---|---|---|
| **P1 工具层黑名单** | 用 `ctx.tools.guard()` 拒绝写 `<workspace>/.project/**`，拒绝 bash 命令里出现 `.project` | **不成立** | ① `run_code` 里的裸 `node:fs` 完全绕过工具层（**实测**：本会话用 `fs.writeFileSync` 写 `<workspace>/.project/probe.txt` 成功，且不产生任何 `tool/call` 事件）；② bash 字符串匹配可被 `P=.pro''ject` 绕过（**实测** exit 0） |
| **P2 沙箱层排除** | 让会话 `workspace-write` 但把 `.project` 从可写集合里减掉 | **不成立** | DSH 沙箱是**纯 allow-list**：`writableRoots()` 只拼接工作区根 + 额外根 + `/tmp` + `os.tmpdir()`（`.runtime/dsh-sandbox/lib/index.js:239-246`），`denyRoots`/`excludedRoots`/`denyList`/`excludePaths` 全部 **0 命中** → 「工作区可写但子目录不可写」无法表达 |
| **P3 换位置 + 特权通道** | ① 把权威数据搬出工作区（`~/.dsh/storages/`）→ agent 物理上碰不到；② 工作区里只留**导出快照**；③ agent 要改工作区必须调插件工具，由插件代为落盘 | **成立** | ① `~/.dsh/storages/` 实测对 agent 是 `EPERM`；② 插件用**裸 `node:fs`**（`export.js:7`、`registry.js:4`）写在 Host 进程内，**不受会话沙箱约束** → 天然是"唯一写者"；③ 插件已有 `export_project`/`import_inbox` 的雏形 |

> 核心认知：**不要试图"削掉 agent 的写权限"，要"把权威搬到 agent 够不着的地方"。**
> 前者在 DSH 里无解（allow-list 沙箱 + 工具层可绕过），后者是现成的。

### 6.2 P3 的完整形态（四层，逐层可验收）

| 层 | 内容 | 现状 | 改造量 |
|---|---|---|---|
| **L0 权威外移** | `project.db`、`project.json` 从 `<workspace>/.project/` 移到 `~/.dsh/storages/project-workbench/<workspaceId>/` | 现在在工作区内（`registry.js:128-141` 的 `projectPaths`） | 改 1 处路径函数 + 迁移脚本；headless profile 需保留回退 |
| **L1 工作区只留导出物** | `docs/`、`timeline.md` 由插件导出，带 generated 头；agent 可写但写了会被覆盖（单向导出） | 已经是单向（`export.js:88-94`，`indexer.js:15-18` 跳过 docs） | 0 |
| **L2 变更走插件工具** | agent 要改代码/文档 → 调插件工具 → 插件校验写作用域/阶段策略 → 插件落盘并写事件 | **无**：现在 agent 直接用 `write`/`edit`/`bash` 改，插件只在收工时"听 agent 自述"（`task-tools.js:214-216`） | 大：要新增 `file_write`/`file_patch` 工具，并在 preset 里关掉 `tool-fs` 写与 `tool-bash` |
| **L3 收尾机检** | `session_finish_task` 用 `file_index` 的 hash 快照比对，而不是信 `noOutOfScopeChanges` | `file_index` 已存在（`indexer.js:73-119`），但没接进收工校验 | 中：接上即可 |

### 6.3 L2 是唯一的硬骨头，且有代价

要让"工作区全部由插件改"，必须**在 preset 里把 agent 的写能力关掉**：

```yaml
# project-task preset 需要修改的地方（workbench/cordis.patch.yml:108-121）
- id: tool-fs
  config: { read: true, write: false, edit: false, applyPatch: false }   # 现在 write/edit 都是 true
- id: tool-bash      # 直接 disabled: true —— 否则 bash 可以写任何东西
- id: tool-pwsh      # 同上（Windows）
- id: tool-jobs      # 后台任务会绕过
- id: tool-terminal  # 若有
```

**必须一起关掉下面这些，否则前功尽弃**（每一个都是"能写文件"的替代路径）：

| 工具 | 为什么必须关 | 证据 |
|---|---|---|
| `bash` / `pwsh` | `echo > file`、`sed -i`、`tee`、跑脚本……全部绕过 | 实测 `P=.pro''ject` 可绕过路径匹配 |
| `run_code`（PTC） | 裸 `node:fs` 完全绕过工具层 | **实测**写入成功且零 tool/call 事件 |
| `jobs` | 后台命令同样是 shell | `tool-jobs` 控制 bash/PTY 后台任务 |
| `terminal` | PTY 直写 | `dsh-tool-terminal` 存在 |
| `subagent` | 子 agent 可指定别的 preset（`agentPreset`/`allowedAgentPresets`，`.runtime/dsh-tool-subagent/lib/index.js:243-278`）→ 拉一个能写的子 agent | 必须在 tool-subagent 上锁白名单 |
| `workflow` | 扇出 subagent，同上 | 同上 |

**代价（必须承认）**：

1. **agent 失去"边改边跑测试"的能力**。改代码 → 想跑测试 → 没有 bash。只能让插件代跑；而插件执行命令时**不受沙箱约束**，等于把沙箱绕开，安全上要单独设计。
2. **体验显著变差**。现代 coding agent 的核心循环是「改-跑-看-再改」，关掉 bash 等于砍掉这个循环，与设计文档里"任务会话可拉子 agent、跑测试"直接冲突。
3. **PTC 只能整体禁**。`tools.restrict()` 明确拒绝点名 `run_code`（`.runtime/dsh-tools/lib/index.js:463`），要禁只能 guard 掉整个 `run_code`（guard 看 `exec.name`，可以做到），但那也砍掉 PTC 的并行能力。

### 6.4 结论：分场景，不要一刀切

| 场景 | 建议 | 理由 |
|---|---|---|
| **文档/决策/阶段/切片**（过程产物） | **完全走插件**：`doc_write`/`decision_create`/`gate_submit` 已是唯一入口 | 这些本来就不该让 agent 直接改文件，且已实现 |
| **代码/测试/脚本**（交付产物） | **不要收归插件**：让 agent 直接用 `write`/`edit`/`bash`，插件只做**事后机检**（L3） | 收归插件要砍掉整个「改-跑-看」循环，收益远小于代价；且 §4.1 已定"交付治理归 git" |
| **`.project/` 本身** | **必须搬走**（L0） | 这是真正的单写命门：搬走后 agent 物理上碰不到，插件天然唯一写者 |

> **一句话**：能做到"工作区全部由插件改"的，是**过程产物**（已经做到了）和 **`.project` 元数据**（搬走即可）；
> **做不到也不该做**的，是**代码/测试**——那里应保留 agent 直接写，用事后 hash 校验（L3）兜底，而不是前置拦截。

### 6.5 改造清单（按性价比排序）

| 优先级 | 改动 | 效果 | 代价 |
|---|---|---|---|
| **P0** | `.project/` 搬到 `~/.dsh/storages/`（L0） | 单写命门解决：agent 物理碰不到 DB | 改 `registry.js` 路径 + 迁移脚本 + headless 回退 |
| **P0** | `session_finish_task` 接 `file_index` 做 hash 比对（L3） | `noOutOfScopeChanges` 从"自述"变"机检" | ~40 行 |
| **P1** | `gate_submit` 必附 `verify --json` + `closeout` 原文 | 门禁判据从"人点了批准"变"机器绿 + 人批准" | ~20 行 |
| **P2** | 加 `ctx.tools.guard()` 拒绝 `write`/`edit` 落在 `<workspace>/docs/**` | 防止手改导出快照造成"看起来是权威"的假象 | ~15 行 |
| **P3** | 关 `tool-fs` 写 + `bash`/`pwsh`/`jobs`/`terminal`，改走插件 `file_write` | 真正的"工作区全由插件改" | 大（见 §6.3），**不建议现在做** |

---

## 7. 需要你拍板的 5 件事（其余可自行执行）

1. **DB 与仓库的绑定方向**：接受「DB 只存 external_ref + hash、正文只在仓库」吗？（替代方案：DB 存正文、仓库只做导出 —— 会让 git 失去 review 语义，不建议）
2. **`.project` 的归属**：进 `ignoredDirectories`（推荐，DB 里已有同名决策的推荐项），还是登记为正式目录并写 README？
3. **文档类工作项的记忆冲突**：改成「项目记忆由 DB 导出生成」，还是继续要求人工同步（会让每个文档型 WI 都撞 `MEMORY_BEHIND`）？
4. **单写的纵深做到哪一层**（§5.3）：只做 L1 工具 guard（当天、挡 90%）、还是连 L2 触发器一起（+30 行 DDL，挡住除「伪造首次批准」外的全部）、还是连 L3 把 DB 移出工作区（同时解 C6，但要改 registry 与 headless 兼容）？
5. **「工作区全由插件改」做到哪一层**（§6.5）：只做 P0（搬走 .project + 收尾 hash 机检，改动小、收益确定）、还是做到 P2（连 docs/ 导出目录也 guard 起来）、还是 P3（关 bash/fs 写，全部走插件 file_write）？P3 会让 agent 失去「改-跑-看」循环，**不建议**，除非你能接受任务会话不能自己跑测试。

---

## 附：事实来源与取证边界

- 两套机制的事实清单（含 file:line）：[lumio-facts.md](governance-facts/lumio-facts.md)（95 行）、[plugin-facts.md](governance-facts/plugin-facts.md)（78 行）。原始取证目录 `.artifacts/governance-analysis/` 不入 git（.artifacts/ 已在 .gitignore）。
- 实测项：lumio `checker`（exit 1，`FAIL: 663 files, 113 directories, 5 issues`）、`gate --closeout`（exit 1，`MEMORY_BEHIND`）、`merge-pr`/`create-pr`/`check-runs`/`ci-rehearsal`/`trunk-health` 五个 CLI 带参数静默 exit 0 零输出、`.project` DB 各表行数、`git ls-files .project` 为空；插件侧 `grep` 反证（`expectedRevision`/`writeScope`/`stagePolicy`/`worktree`/`check-run` 全部 0 命中）。
- 未实测（沙箱禁止工具内起 git 子进程）：`ai-finish` 变更枚举、`gate --staged`、`verify --tier=code` 的端到端分支；这些按「读码」标注。
- §5.3 的 PoC 可复现（脚本在 `.artifacts/*.cjs`，全部在 workspace 内副本上跑，**未动 lumio 真实 DB**）：`poc-two-writers.cjs`（两个连接同写）、`poc-inside-workspace.cjs`（伪造"人已批准"+ 阶段推进 + gate/approve 事件）、`poc-triggers2.cjs`（7 个触发器后重跑同样攻击，仅"伪造首次批准"仍放行）。
- 沙箱围栏实测：写 `<当前工作区>/.project/` → **允许**；写 `C:/Users/oldap/Documents/lumio/.project/` → `Permission denied`；写 `~/.dsh/` → `Permission denied`。
- §6 的三条实测（决定「能不能只让插件改工作区」）：① run_code 内裸 node:fs 写 <workspace>/.project/probe.txt → **成功**，且不产生任何 tool/call 事件；② bash 用 P=.pro''ject 拼路径 → **exit 0**（字符串黑名单无效）；③ 写 ~/.dsh/storages/ 与 C:/.../lumio/.project/ → 均 **EPERM**（沙箱边界只认会话 cwd）。
- 平台结构事实（读码）：.runtime/dsh-sandbox/lib/index.js:239-246 的 writableRoots() 是纯 allow-list，denyRoots/excludedRoots/denyList/excludePaths 0 命中；.runtime/dsh-tools/lib/index.js:463 的 tools.restrict() 明确拒绝对 run_code 命名；.runtime/dsh-tools/lib/index.js:649 的 tools.guard() 是单调拒绝，PTC 子调用也过同一 prepare()（.runtime/dsh-tool-executor-ptc/lib/index.js:564）；插件自身用裸 node:fs（workbench/host/export.js:7、registry.js:4），不受会话沙箱约束。
