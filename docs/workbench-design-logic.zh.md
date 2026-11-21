# DSH 项目工作台插件 · 设计逻辑

> 版本：v1.2（2026-11-20 修订） · 代码：`workbench/`
> **v1.1 变更**：全文区分「插件自身」与「插件产出」；新增 §0.1 术语表；修正 v1.0 中 3 处计数错误；新增 §9 歧义清单。
> **v1.2 变更（v4 实现）**：判据信任模型（§决策 2 重写）、事务与补偿（§决策 3 重写）、
> 失败状态 / 租约栅栏 / 切片作用域（§决策 6）、prompt 预算（§决策 7）、
> 错误详情与身份模型（§决策 5、§6.1）；§3.2 表数 20→24；§7 缺口表更新。
> 详细论证见 `docs/implementation/adr-0001..0003`。

---

## 0. 怎么读这份文档

### 0.1 两个必须分清的概念

本文全程使用这两个标记：

| 标记 | 含义 | 例子 |
|---|---|---|
| 🟦 **【插件】** | 插件**自身的代码/机制**，装了插件就有 | 27 个工具、24 张表（23 普通 + 1 FTS5 虚拟）、11 个触发器、11 个 UI 槽位 |
| 🟩 **【产出】** | 插件**在运行时生成的数据/文件**，属于你的项目 | `project.db` 里的切片/决策、`docs/product/prd-*.md`、`timeline.md` |

**一句话区分**：🟦 是「软件」，🟩 是「软件产生的资料」。
删掉插件，🟦 消失，🟩 留下（在 store 和 `docs/` 里）。

> 下文凡涉及具体对象，都会带这个标记。不带标记的是**通用概念**。

### 0.2 术语表（消除重载）

| 词 | 本文的准确含义 | 容易混淆成 |
|---|---|---|
| **门禁 gate** | 阶段推进前的**批准点**，形如 `G1` / `PRD-AUDIT` | ~~"gateway"（网关）~~ |
| **决策 decision** | `decisions` 表的一行；`kind='gate'` 时即门禁 | 泛指"任何决定" |
| **审批 approval** | `approvals` 表的一行，记录**人签字的对象与快照** | 与 decision 混为一谈 |
| **切片 slice** | 工作项或模块，是**写作用域的边界** | ~~"代码切片"~~ |
| **导出 export** | 把 DB 内容写到工作区 `docs/`（单向投影） | ES module 的 `export` 关键字 |
| **会话 session** | 一条 agent 会话记录（PM 或任务） | DSH 的底层会话对象 |
| **判据 checker** | 仓库自带的检查脚本，门禁时被调用 | 插件内置的规则 |
| **store** | 外部权威源目录 `$DSH_HOME/storages/...` | 泛指"存储" |

---

## 1. 要解决的问题

### 1.1 病根（背景，不是插件产物）

对一个真实仓库的复盘结论：

> 流程被实现成「一堆脚本 + 一堆文档 + 人肉约定」，而不是一个有唯一权威、能拒绝非法状态转移的状态机。

### 1.2 插件要提供三样东西

| 要什么 | 🟦【插件】如何实现 |
|---|---|
| 一个权威源 | SQLite 项目库，且 agent 物理碰不到 |
| 能拒绝的状态机 | 阶段机 + 门禁 + 租约 + 11 个 DB 触发器 |
| 判据来自机器 | 门禁前置机检，调用**仓库自己的**检查器 |

---

## 2. 核心设计决策

> 每个决策都标注：**为什么**（问题）→ **🟦【插件】怎么做**（机制）

### 决策 1：权威源放在 agent 写不到的地方

**为什么**：DSH 沙箱只有 allow-list，**没有 deny-list**。「工作区可写但 `.project` 不可写」表达不出来。

**🟦【插件】怎么做**：把权威源放到 `$DSH_HOME/storages/project-workbench/<workspaceKey>/`。

```
🟩【产出】位置分两处：

  外部 store（agent 沙箱 EPERM）          工作区（人可见、可进 git）
  └── <workspaceKey>/                    └── .project/
      ├── project.db      ← 权威           ├── exports/
      ├── project.json                     │   ├── docs/      ← 导出的 md
      ├── inbox/                           │   └── timeline.md
      └── packages/                        └── .gitignore
```

- 🟦 布局由 `registry.projectPaths()` 决定
- 🟩 权威数据 → store；导出投影 → 工作区
- `workspaceKey` = 工作区 realpath 的 sha256 前 16 位

**三模式**：`home`（默认，单写成立）/ `local`（兼容，**单写不成立**）/ 绝对路径。

**实测**：会话沙箱写 `~/.dsh/storages/` → `EPERM`。

---

### 决策 2：判据必须来自机器

**为什么**：只靠「人点了批准」，和原来的「人肉约定」没有本质区别。

**🟦【插件】怎么做**：`gate_submit` 调用**仓库自带**的检查器（不是插件内置规则）。

```
<你的仓库>/tools/engineering/checker.mjs   → checkRepository(root)
<你的仓库>/tools/engineering/closeout.mjs  → checkCloseout(root)
```

> ⚠️ 这两个文件**不属于插件**。它们是**你仓库里的**判据，插件只负责调用。
> 仓库没有这两个文件 → 插件跳过机检并**如实标注**，不假装通过。

**判据的信任模型（v1.2 新增，必须先答）**：判据是**仓库自己的代码**，与宿主同进程、同权限。
所以先回答「跑它时把它当成什么」：

| 级别 | 执行方式 | 解决 | 不解决 |
|---|---|---|---|
| `in-process` | 直接 `import()` 到 Host | —（仅兼容） | 卡死、污染、读宿主状态 |
| `worker`（**默认**） | `worker_threads` + 超时 `terminate` + 纯 JSON 回传 | 卡死、跑飞、模块污染 | **恶意判据偷数据**（同进程空间） |

> 进程级隔离（`child_process` + `--permission`）在本运行时**不可用**：实测 `spawn` 一律 `EPERM`。
> 因此插件不假装提供这一层，而是把「隔离到了哪一级」作为输出字段如实回传
> （`machineCheck.trust`，并存进审批快照 `checkTrust`）。

**fail-closed（含隔离）**：

| 情况 | 行为 |
|---|---|
| 判据返回 `ok:false` | **拒绝** `GATE_PRECHECK_FAILED`，带 issues 原文 |
| 判据**抛异常** | **也拒绝** `CHECKER_ERROR`（跑不通 ≠ 通过） |
| 判据**超时** | **强制 terminate** 后拒绝 `CHECKER_ERROR`（写明超时毫秒） |
| worker 崩溃 / 无导出函数 | 拒绝 `CHECKER_ERROR` |
| 没有判据文件 | 放行，但 `machineCheck.skipped=true` 明确标注 |
| 配置 `in-process` 且 `requireIsolation=true` | **拒绝** `CHECKER_ISOLATION_REQUIRED`（不是 skipped） |

详见 [ADR-0001](implementation/adr-0001-checker-trust-model.zh.md)。

---

### 决策 3：门禁是「双点」的

**为什么**：提交时绿 ≠ 批准时绿。中间仓库可能变了。

**🟦【插件】时序**：

```
PM gate_submit
  ├─ ① 阶段守卫 validateGateTarget
  ├─ ② 文档快照 → approvals.snapshot_json（docId@version@hash）
  ├─ ③ 机检 → FAIL 抛错（不留 pending）；PASS 存 evidence
  └─ ④ 建 pending approval + 决策卡（🟩 落到 decisions/approvals 表）
       ↓ 人点批准（面板 / POST /decision）
  ├─ ⑤ 复跑判据 preflightGateApproval（**事务外**）
  │     不通过 / 与提交时不一致 → STALE_PRECHECK
  ├─ ⑥ 文档守卫：版本/hash 变了 → STALE_APPROVAL
  ├─ ⑦ 阶段推进 advanceStage（必须恰一个 active）
  └─ ⑧ 🟩 冻结 + 导出 docs/ + approvals 行 + gate/approve 事件 + 唤醒 PM
```

**为什么复跑在事务外**：`db.tx` 是同步的，判据是 async。`await` 进同步事务会撕裂事务边界。

**v1.2：四段式事务与补偿**（详见 [ADR-0002](implementation/adr-0002-transaction-compensation.zh.md)）

v1.1 把「决策落定 / 冻结 / 导出文件 / 阶段推进」全塞进一个 `db.tx`。但**文件系统不参与 SQLite 事务**，
于是有两条无法重试修复的失败形态：导出中途失败会回滚 DB 却留下半批文件；导出成功而事务失败会留下
没人认领的文件。v4 改成：

```text
① preflight (tx 外, 只读)  判据复跑 → 阶段守卫 → 快照校验 → 审批仍有效
② commit    (tx 内, 原子)  决策落定 → 冻结 → 阶段推进 → approvals(epoch) → 导出【意图】→ gate/approve
③ apply     (tx 外)        按 export_outbox 逐条写文件（原子 rename），逐条回填
④ settle    (tx 内)        导出结果回写审批 payload；有失败写 gate/export_failed
```

- `export_outbox` = DB（应该有什么）与文件系统（实际有什么）之间的**对账表**。
- 失败自动重放一次；仍失败留 `failed`，可随时 `POST /exports/replay`（面板「重新生成导出」）补偿。
- **绝不因导出失败回滚阶段推进**：阶段是人签的不可逆事实，文件是可再生的派生物。
- 重提交时旧 pending 审批标 `superseded`（保留行）；`approvals.epoch` 单调，批准签的是「某一代快照」。

---

### 决策 4：阶段机可配置，但换模板不破坏历史

**为什么**：内置 S1..S7 与许多真实项目的生命周期对不上。

**🟦【插件】怎么做**：
- 模板来源：`project.json.stageTemplate`（🟩 在 store 里）
- 换模板是**显式写路径** `applyStageRemap(ref, template, { confirmed })`，未确认抛 `CONFIRM_REQUIRED`
- 旧阶段 `status='retired'`，**行与历史事件都保留，不 DELETE**

**为什么不删**：`events` 是 append-only，历史 `stage/change` 事件指向旧 key。删行 = 审计断链。

**🟦 配套**：`listStages()` 默认只返回**活阶段机**（`status != 'retired'`）。

> 这条不是设计出来的，是演练跑出来的——retire 后 `advanceStage` 选到了已退役的 S1。

---

### 决策 5：人批准是唯一出口

**🟦【插件】三道闸**：

1. **工具层**：PM 只有 `decision_create`，**没有** `decision_resolve`
2. **实现层**：唯一落定入口 `resolveDecisionAction`，只被 HTTP 路由和 actionCard 调用
3. **不可逆**：`irreversible: true` 必须 `confirmed === true`，否则 409

**v1.2：人身份从字符串提升为可追溯主体**（详见 [ADR-0003 §6](implementation/adr-0003-failure-fencing-scope.zh.md)）

`decidedBy` 默认 `'user'` 的问题：共享实例上 A 与 B 的批准长得一模一样，
「人批准」实际退化成「请求通过了宿主 cookie 围栏」。v4 的三级来源：

| 来源 | 何时成立 | 可信度 |
|---|---|---|
| `host` | 宿主 `connection.identity(req)` 明确给出 subject | 高 |
| `declared` | 面板 `actingAs` / 请求头 / 旧接口 `decidedBy`（≠'user'） | 中（可伪造） |
| `local` | 兜底；以及旧默认值 `'user'` | 低 |

- `identities`（按 project+subject 唯一）+ `approval_signers`（每次审批的签名主体与来源）。
- 来源只允许**升级**（local→declared→host），不允许降级——历史记录不能被改写成更弱的声明。
- 审批返回 `separation.separated`：**如实报告**提交人与批准人是否同一人。

**仍然没有**：密码、RBAC、「谁能批哪类门禁」。单机单用户成立；共享实例下**能追责**，但**不能强制分离**。
不阻止同人既提又批，是因为假装阻止只会造出「换个名字就绕过」的安全感。

---

### 决策 6：租约约束写作用域 + 栅栏令牌 + 真实 diff 校验

**为什么**：同一切片同时应只有一个任务会话在写。

**🟦【插件】**：`leases` 表 + `assertWriteScope`。

调用点：`doc_write`、`evidence_add`、`artifact_add`、`doc_freeze`、**`session_finish_task`**。

**v1.2：栅栏令牌（fencing token）**——只比「当前 holder 是谁」有一个无法自证的窗口：

```text
A 持租 → A 卡住 → 租约过期 → B 抢占 → A 醒来继续写
```

「检查 holder」与「真正写」之间仍可能被抢占（TOCTOU）。v4 给 `leases.epoch` 单调递增，
spawn 时把当次 epoch 写进 `sessions.context.fenceEpoch`，写路径比对令牌，不符即 `LEASE_FENCED`。

- **释放后重取也换新令牌**（历史最大值存 `project_meta`），否则失效的写会重新变合法。
- DB 层兜底：`guard_lease_epoch_monotonic` 禁止 epoch 回退。
- 拒绝的语义是「这次授权失效」，不是「这个会话被拉黑」：出示正确 epoch 即可继续写。

**v1.2：切片作用域对真实 diff 校验**——「片外零改动」原来只是一句自述（`noOutOfScopeChanges=true`
永远能写 true）。v4 引入 `host/scope.js`：采集真实 `git status/diff`，按 `slice_scopes` 归因，

| 结论 | 含义 |
|---|---|
| `verifiable=true, ok=true` | 真的校验过且干净（唯一可用于门禁的结论） |
| `verifiable=false, ok=true` | 无 git 或未声明作用域 → **如实标注无法校验**，不伪造通过 |
| `ok=false` | `CROSS_SCOPE_CHANGES`（改了别人的已声明地盘）或 `OUT_OF_SCOPE_CHANGES` |

> `crossScope` 在任何策略下都拒绝：那不是「本切片没声明清楚」，而是侵犯了别人**已声明**的范围。
> 配套工具 `slice_scope`（list/declare/clear）——没有声明入口，可判定性永远不成立。

---

### 决策 7：每会话 ≤2k 上下文

**🟦【插件】** 三层装载：

| 层 | 预算 | 内容 | 时机 |
|---|---|---|---|
| L0 | ≤400 | 项目/阶段/角色/待决策数 | **每步** |
| L1 | ≤300 | 角色卡 | 首步、切切片 |
| L2 | ≤900 | 切片简报 | 首步、切切片 |

**合计 1600**，**硬上限 2000**。中间 400 的差值是「工具结果可以用」的空间，**不是第四层**。

超限先裁 L2 再裁 L1，注入降级提示，并写 🟩 `context/downgrade` 事件。

**v1.2：预算覆盖整段开场提示，而不只是 L0/L1/L2**。
v1.1 里 `buildTaskAssignment` 把「PM 交代」与「验收」**无上限**拼在 L1/L2 之后，
PM 写一段长 brief 就能让开场注入远超 2000（实测修复前 2020 > 2000）。

v4 的做法：组装后**量真实占用**，按超出量依次回收
① PM 交代（PM 可再发消息补）→ ② 验收（硬信息，最后才动）→ ③ 整体硬截断（兜底）。
返回值带 `used / hardLimit / truncated{brief,acceptance} / degraded`，可被测试与 PM 核对。

---

### 决策 8：UI 只加不减

**为什么**：DSH 的 single 槽被官方占用，影子覆盖会**静默杀掉官方能力**。

**🟦【插件】** 只在官方 **list 槽**追加，不设 priority。**11 个落点**：

```
sidebar.panellist                        面板入口图标
sidebar.panellist.actions                「更多」菜单一行
conversation.session.header.utilities    PM 页头徽章
conversation.composer.dock               输入框摘要条
sidebar.session.row.leading              角色首字徽章
sidebar.session.row.trailing             切片标记
sidebar.session.row.hover                项目/阶段/待决策
sidebar.workspaces.session.row.action    定位按钮
sidebar.workspaces.session.menu.item     右键菜单（3 项）
sidebar.footer.action                    底部状态条
main                                     项目面板页面
```

**🟦 数据只走已有通道**：`hub.publish` 里用纯函数派生，席位只读，**不 fetch、不轮询**。

---

## 3. 领域模型

> §3 全部是 🟦【插件】的结构定义。🟩【产出】是这些结构里的**行**。

### 3.1 实体关系

```
Project
└── Stage (阶段机，可 retire)
    └── Slice (切片 = 写作用域边界)
        ├── Task
        ├── Session (PM / 任务)
        ├── Document → DocVersion
        ├── Decision → Approval
        ├── Evidence
        └── Artifact
Event (append-only, seq 连续)
Lease (切片维度写锁)
```

### 3.2 表（v4：**共 24 个**：23 个普通表 + 1 个虚拟表）

| 表 | 类型 | 作用 |
|---|---|---|
| `projects` `stages` `slices` `tasks` `sessions` | 普通 | 项目骨架 |
| `documents` `doc_versions` `doc_sections` | 普通 | 文档与版本链 |
| **`doc_fts`** | **虚拟（FTS5）** | 全文检索，trigram 分词 |
| `decisions` `approvals` | 普通 | 决策与人签字 |
| `evidence` `artifacts` `links` | 普通 | 证据/产物/引用 |
| `events` | 普通 | 时间线，`UNIQUE(project_id, seq)` |
| `leases` | 普通 | 写锁 |
| `exports` `imports` | 普通 | 导出/导入记录 |
| `project_meta` `schema_migrations` | 普通 | 元数据 |
| **`export_outbox`** | 普通（v4） | 导出意图与对账（DB ↔ 文件系统的补偿表） |
| **`slice_scopes`** | 普通（v4） | 切片写作用域的路径模式 |
| **`identities`** | 普通（v4） | 人主体（host / declared / local） |
| **`approval_signers`** | 普通（v4） | 每次审批签名的结构化身份 |

> ⚠️ v1.0 文档写「19 张表」是**错的**；v1.1 修正为 20。v4 新增 4 张表后为 **24 条 CREATE**，
> 其中 `doc_fts` 是 `CREATE VIRTUAL TABLE`（FTS5），容易被漏数。

### 3.3 触发器（v4：11 个，DB 级）

| 触发器 | 保证 | 版本 |
|---|---|---|
| `guard_events_no_update` | 事件不可改 | v2 |
| `guard_events_no_delete` | 事件不可删 | v2 |
| `guard_events_seq_contiguous` | seq 必须连续 | v2 |
| `guard_doc_versions_no_delete` | 版本不可删 | v2 |
| `guard_doc_versions_body_immutable` | 已写版本正文不可改 | v2 |
| `guard_decisions_terminal` | 已落定决策不可回改 | v2 |
| `guard_approvals_terminal` | 已通过审批不可改判 | v2 |
| `guard_lease_epoch_monotonic` | 栅栏令牌只能增（回退会让失效的写重新合法） | v4 |
| `guard_task_session_terminal` | 任务会话终态不可复活（复活会让租约与 attempt 账错位） | v4 |
| `guard_approval_epoch_monotonic` | 审批代次只能增（批准必须签「某一代快照」） | v4 |
| `guard_outbox_done_terminal` | 已完成的导出意图不可回退成 pending（否则补偿无限重放） | v4 |

> v1.1 之前这些触发器只在 `current<2` 时建立，v3 库永远拿不到后加的触发器。
> v4 改为每次打开都 `ensureGuards()` 幂等补齐（全部 `IF NOT EXISTS`，无副作用）。

### 3.4 角色与技能

**7 个任务角色**（🟦 `roles.js`）：产品 / UX / 架构 / 码农 / 测试 / 发布 / 复盘
每个角色一张卡：`title / stage / reads / writes / start / finish / guardrails`，作为 L1 注入。

**7 个技能模板**（🟦 `workbench/skills/*.md`）：
`requirement-grooming` `prd-writing` `adr-writing` `implementation-execution` `testing-verification` `handoff-writeup` `decision-card`

> 技能是**按需加载**的完整指令，**不占** 2k 预算。模型通过 `skill` 工具加载。

### 3.5 事件（v4：31 种 kind）

```
project/init
stage/change  stage/template
slice/create  slice/status
task/create   task/status
session/create  session/end
doc/create  doc/version  doc/freeze  doc/export
decision/create  decision/resolve
gate/submit  gate/approve  gate/reject
evidence/add  artifact/add
lease/acquire  lease/release
export/snapshot  import/inbox  index/backfill
context/downgrade
slice/scope  approval/supersede  gate/export_failed  export/replay
```

> v4 新增 4 种：切片作用域声明（`slice/scope`）、旧审批作废（`approval/supersede`）、
> 门禁导出失败（`gate/export_failed`）、导出补偿（`export/replay`）。

### 3.6 状态枚举

```
slices     open / in_progress / review / blocked / done / archived / cut
tasks      pending / in_progress / review / blocked / done / failed
decisions  pending / approved / rejected / superseded / hang
approvals  pending / approved / rejected
documents  draft / review / approved / frozen
sessions   active / done / failed / interrupted / ended
stages     pending / active / done / retired
```

---

## 4. 运行时分层

```
🟦 对话层
   用户 ⇄ PM 会话（preset: project-office）
          任务会话（preset: project-task，命名 角色-切片-动作）

🟦 能力层：27 个工具
   PM 独有 12 │ 双端共享 11 │ 任务独有 4
   → PM 可见 23，任务可见 15，普通会话/子 agent 可见 0

🟦 领域层
   store / docs / leases / export / import
   project（门禁状态机）/ orchestration（派活）

🟦 存储层
   ProjectDb（单实例）→ 24 表（23 普通 + 1 FTS5 虚拟）+ 11 触发器
   BEGIN IMMEDIATE 串行化；event 与数据同事务

🟦 通道层
   HTTP 12 路由（8 GET + 4 POST；先 requestRejection；v4 增 /identities 与 /exports/replay）
   SSE /events 推 revision
   UI 11 槽位（只读派生）
```

### 4.1 工具分配（v1.0 写的「22 + 15 = 37」是误导）

**v4 总数 27**（v1.1 为 26，新增 `slice_scope`），因为 11 个工具两端共享：

| 类别 | 数量 | 举例 |
|---|---|---|
| PM 独有 | 12 | `gate_submit` `session_spawn_task` `slice_create` `decision_create` `project_init` `slice_scope`(v4) |
| 双端共享 | 11 | `project_status` `doc_get` `slice_update` `artifact_add` `doc_freeze` |
| 任务独有 | 4 | `doc_write` `evidence_add` `session_finish_task` `session_task_report` |

> **PM 可见 23，任务可见 15**。v1.0 的「22 + 15 = 37 ≠ 26」是因为共享的 11 个被算了两遍。
> `slice_scope` 的存在理由：没有声明入口，「片外零改动」的校验永远只能 `verifiable=false`。

### 4.2 模块依赖（实际 import）

```
registry      → db, util, project-defaults, snapshot
db            → schema, util
store/docs/leases → db, util
project       → store, docs, export, registry, checkers, snapshot
orchestration → db, util, context, roles
context       → util, project-defaults, roles
prompts       → store, orchestration, context
session-hooks → store, leases, project, orchestration, context
snapshot      → store, docs
http          → registry, project, snapshot
tools/*       → store, docs, leases, export, import, project, checkers, indexer
```

**依赖单向，无环**：`db.js` 不依赖任何领域模块。

---

## 5. 关键流程

### 5.1 用户提需求 → PM 拆活 → 任务执行

```
1. 用户对 PM 说「支付要能退款」
2. PM: project_status → slice_list（查重）
3. PM: slice_create / task_create            → 🟩 落 slices/tasks 表
4. PM: session_spawn_task
       ├ 校验角色词表 + 同切片同角色无 active
       ├ 🟩 写 sessions 行 + lease + task→in_progress
       ├ 🟦 组装开场简报（角色卡 + L2 + 验收 + 纪律）
       └ 🟦 ctx.subagents.startActivation({ agentPreset: 'project-task' })
5. 任务会话: doc_write / evidence_add        → 🟩 落 documents/doc_versions/evidence
6. 任务收工: session_finish_task
       ├ assertWriteScope（租约）
       ├ 校验证据 ≥1
       ├ 🟩 写交接文档 + 更新 task/slice
       └ 🟩 endSession + releaseLease + notifyPm
```

### 5.2 导出（单向，🟩 产出）

```
export_document(db, { docId, version, root, exportMap })
  → 路径由 exportMap[type] 决定（prd → docs/product/）
  → 写 generated 头（projectId / docId / version / hash / 时间）
  → 🟩 写 exports 行 + doc/export 事件
```

**只写不回读**：🟦 indexer 显式跳过 `docs/`。导入只能走 `inbox/`，且有 realpath 包含检查。

---

## 6. 安全与约束

### 6.1 拒绝码（**v4：35 个，按实际抛出位置分层**）

v1.0 只写了 18 个且未分层；v1.1 首稿写 30 个也不准，v1.1 定稿 32 个。
v4 新增 3 个（`LEASE_FENCED` `OUT_OF_SCOPE_CHANGES` `CHECKER_ISOLATION_REQUIRED`），
用 `grep fail\('CODE'` 实测得 **35 个**，其中 3 个跨层。

**仅领域层（7）** — 只在 `store/docs/leases/export/import/db` 抛出：

```
DOC_FROZEN            LEASE_HELD
DUPLICATE_ARTIFACT    DUPLICATE_DOCUMENT
DUPLICATE_DSH_SESSION DUPLICATE_EVIDENCE
DUPLICATE_SLICE
```

**仅基础设施层（22）** — 只在 `registry/http/project/orchestration/tools/*` 抛出：

```
门禁    GATE_PRECHECK_FAILED  GATE_STAGE_INVALID
        STALE_PRECHECK       STALE_APPROVAL
        STALE_GATE_STAGE     CONFIRM_REQUIRED  CONFLICT
编排    SPAWN_FAILED         DELIVERY_FAILED
接入    NOT_PROJECT_SESSION  PERMISSION_DENIED  NO_EVIDENCE
        NOT_REGISTERED_WORKSPACE  MISSING_WORKSPACE  INVALID_ROOT
        NOT_INITIALIZED      PROJECT_DB_ERROR
        PAYLOAD_TOO_LARGE    UNAVAILABLE  DATA_LAYER_UNAVAILABLE
存储    STORE_ALREADY_EXISTS STORE_LOCAL_MODE
```

**跨层（3）** — 领域层与工具/接入层都会抛：

```
INVALID                    参数/状态不合法（最常用）
NOT_FOUND                  实体不存在
DUPLICATE_ACTIVE_SESSION   同切片同角色已有 active 会话
```

**v4 新增（3）**：

```
LEASE_FENCED               写作用域授权已换代（栅栏令牌失效）——出示正确 epoch 即可继续
OUT_OF_SCOPE_CHANGES       真实 diff 显示有片外/跨切片改动（收工被拒）
CHECKER_ISOLATION_REQUIRED 项目要求隔离执行，但判据配置为 in-process（失败关闭）
```

### 6.2 鉴权链

```
请求 → 🟦 requestRejection（宿主 cookie/origin）
     → 无 connection 服务 → fail-closed 401
     → 🟦 workspaceRegistry 准入（根必须已登记）
     → 🟦 领域校验
```

---

## 7. 已实现 vs 未实现

### ✅ 已实现（有测试）

| 能力 | 证据 |
|---|---|
| 权威源外移 + 旧库迁移 | `unit` 21 例 |
| 门禁双点机检 | `tools.test` 8 例 |
| 阶段守卫 + 提交快照绑定 | `tools.test` 4 例 |
| 租约 + 收工校验 | `tools.test` 2 例 |
| 触发器 7 个 | `db.test` 7 例 |
| 14 步业务回放 | 17 / 0 |
| 真实实例 HTTP/SSE | `instance-http` 10 / 0 |
| 真实模型会话 | `live-e2e` 4 / 0 |
| **失败路径 / 栅栏 / 作用域（v4）** | `unit/failure.test.mjs` 16 例 / 15 pass / 1 skip（跳过的是真实 git diff，本沙箱 spawn EPERM） |
| **身份 / 错误详情 / 预算 / 代次（v4）** | `unit/contracts-v4.test.mjs` 10 / 0 |
| **v3→v4 迁移** | `unit/db.test.mjs`（触发器 11 个 + 迁移幂等） |

### ✅ v1.2（v4）修掉的缺口

| 原缺口 | v4 做法 | 证据 |
|---|---|---|
| 会话失败不记录原因 | `sessions.failure_code/detail/at`；`endSession` 强制给码，幂等结束会补齐 | `unit/failure.test.mjs` |
| 派活失败不回滚 task | 失败时 `task→pending`、清 assignee、写 `task/status` 事件 | 同上 |
| 失败路径零测试 | 新增 `failure.test.mjs` 16 例 + `contracts-v4.test.mjs` 10 例 | 同上 |
| 人身份只是字符串 | `identities` + `approval_signers` + 来源分级（host/declared/local） | `contracts-v4.test.mjs` |
| 无重试熔断 | 失败带 `attempt` + `failureCode`；任务回滚，PM 重试不产生幽灵 | `failure.test.mjs` |
| 门禁判据无隔离 | `worker` 默认 + 超时 terminate + `requireIsolation` 失败关闭 | `failure.test.mjs`、ADR-0001 |
| 导出与 DB 事务不自洽 | outbox 意图先行 + 事务外落盘 + 补偿重放 | `failure.test.mjs`、ADR-0002 |
| 「片外零改动」只是自述 | 真实 git diff + 作用域声明 + 三档判定 | `failure.test.mjs` |
| 开场简报不受预算约束 | 整段统一 2000 硬上限 + 逐段回收 | `contracts-v4.test.mjs` |
| 错误响应没有细节 | `issues/details/hints` + 体积上限 + 客户端渲染 | `contracts-v4.test.mjs` |

### ❌ 仍然存在的缺口（不掩饰）

| 缺口 | 后果 | 严重度 |
|---|---|---|
| 判据隔离不是安全边界 | 恶意判据仍可读宿主文件（同进程空间，`spawn` EPERM 使进程级隔离不可用） | 中（已在 ADR 明写） |
| 多人身份不能**强制**分离 | 能追责、不能阻止同人既提又批；无 RBAC | 中 |
| 58 个空 catch 仍在（共 168 个 catch，2026-11-21 复核） | 多数是「失败不影响主流程」的降级路径，但审计噪音仍在 | 中 |
| **`period` 元数据从未写入** | `snapshot.js:122` 读 `db.getMeta('period')`，但全仓库没有任何 `setMeta('period')` —— 周期永远是「当前月」。设计 §5.4 的两周周期**没有数据落点**，路线图/燃起图因此无分母 | 中 |
| **`deliverableTypes` 只写不读** | 内置 S1–S7 与 `LUMIO_STAGE_TEMPLATE` 都声明了每阶段可交付类型，但门禁与写路径从不读取（仅 `normalizeStageTemplate` 做过校验）。「S1 只能产 prd」目前只是文案 | 中 |
| 未做反向登记 | 已有仓库的历史条目还在文档里，没进 DB | 中 |
| 交付链未接 | commit/push/PR 仍由任务会话自己做 | 低 |
| 非 git 工作区无法校验作用域 | 只能 `verifiable=false` 如实标注（设计如此，不是缺陷） | 低 |

---

## 8. 设计原则

1. **约束要么在 DB，要么在领域函数；提示词里的话不算约束。**
2. **失败路径和成功路径同等重要**——要单独测「不该发生的时候会不会留烂摊子」。
3. **换位置，不改规则**：沙箱没有 deny-list，就把权威源搬出去。
4. **retire 不 delete**：历史事件指向的主体必须一直存在。
5. **判据失败要 fail-closed**：跑不通 ≠ 通过。
6. **UI 只加不减**：抢 single 槽 = 静默杀掉官方能力。
7. **文档必须标注「我没验什么」**——§7 就是为此存在。

---

## 9. 歧义清单（v1.1 修正记录）

这些是 v1.0 里容易误读的地方，逐条说明：

| # | 歧义点 | v1.0 的错误/模糊 | v1.1 澄清 |
|---|---|---|---|
| 1 | 插件 vs 产出 | 全文混在一起 | 全文加 🟦/🟩 标记 + §0.1 |
| 2 | **表数量** | 写「19 张表」 | v1.1 **实为 20**（`doc_fts` 是 VIRTUAL TABLE，被漏数）；v4 **实为 24**（见 §3.2） |
| 3 | **工具 22 + 15** | 看似 37 个工具 | v1.1 **实为 26**（11 个双端共享被算了两遍）；v4 **实为 27**（加 `slice_scope`） |
| 4 | **拒绝码数量** | v1.0 写 18；v1.1 首稿写 30 | v1.1 **实为 32**；v4 **实为 35**：仅领域 7 / 仅基础设施 22 / 跨层 3 / v4 新增 3（见 §6.1） |
| 5 | **「lumio」指哪个** | 文中泛指 | 测试用**副本**（`.sandbox/` 或 `.artifacts/`），**真实仓库未被测试写入** |
| 6 | **判据归属** | 易误以为插件内置规则 | 判据在**你的仓库** `tools/engineering/`，插件只调用 |
| 7 | **2k 预算 1600+400** | 像四层 | 三层 1600 + 硬上限 2000，差值给工具结果 |
| 8 | **「导出」双义** | 与 ES module `export` 混淆 | 本文「导出」= 业务概念（写 docs/） |
| 9 | **decision vs approval** | 常被混用 | decision 是议题，approval 是人签字的**对象+快照** |
| 10 | **「阶段门禁」vs「决策」** | 都叫 gate | `kind='gate'` 的 decision 才是门禁 |
| 11 | **测试替身 ≠ 真实** | 「全部测试通过」易误读 | 替身永远成功；真实行为见 §7 缺口 |

---

## 10. 附：🟩 产出物清单

装好插件、跑一个项目之后，你会在磁盘上看到：

**在 store（`$DSH_HOME/storages/project-workbench/<key>/`）**

| 文件 | 内容 |
|---|---|
| `project.db` | 24 张表的全部数据（切片/任务/会话/文档/决策/证据/事件） |
| `project.json` | 项目元信息 + 阶段模板 + checkers 配置 |
| `inbox/` | 待导入的外部文件 |
| `packages/` | 外部工作包 |

**在工作区（`<你的仓库>/`）**

| 路径 | 内容 |
|---|---|
| `.project/exports/docs/*.md` | 导出的文档，带 generated 头 |
| `.project/exports/timeline.md` | 时间线导出 |
| `.project/.gitignore` | 排除 exports/inbox/packages |
| `docs/` | 如果 exportMap 指向那里（默认 `docs/product` 等） |

**没有产物**：插件不改你的源码、不动 `package.json`、不写你的 `README`。
