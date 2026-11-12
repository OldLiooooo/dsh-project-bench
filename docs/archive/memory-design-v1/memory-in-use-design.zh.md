# DSH 项目工作台 · 使用时的记忆（运行层设计 v1）

> 2026-11-11 · 研究阶段提案。
> 本文只回答一个问题：**真实使用工作台时，记忆在什么时刻、由谁、以什么方式被读/写/展示/纠正。**
> 存储与算法不在这里重复：四层记忆、双时态、propose→commit、SQLite schema 见
> [项目记忆系统设计](project-memory-design.zh.md)；流程/阶段/门禁/专家团见
> [工作台设计提案](project-workbench-design.zh.md)。
>
> 研究材料：
> - 现有设计缺口审计：[research/memory-in-use-gap-audit.zh.md](research/memory-in-use-gap-audit.zh.md)
>   （47 条已定 / 24 条未定 / 18 条矛盾，全部带原文行号）
> - DSH 运行时事实（源码级）：[research/dsh-runtime-memory-facts.zh.md](research/dsh-runtime-memory-facts.zh.md)
> - 外部产品交互模式：[research/memory-in-use-external-patterns.zh.md](research/memory-in-use-external-patterns.zh.md)
>
> 一句话：**会话是缓存，项目是账本，人是裁判。记忆不靠 agent 自觉，靠一张「使用时刻表」+ 一个不被压缩的核心。**

---

## 0. 一页纸

### 0.1 问题：记忆失效都发生在边界

两份已有文档把记忆设计成「账本 + 协议 + 视图」，但没有设计成「一次会话生命周期内的行为」。真实使用中，事故几乎都发生在边界：

| 边界 | 典型失效 | 已有证据 |
|---|---|---|
| 会话开始 | 新会话不知道上次做到哪，人重复解释半小时 | lumio 手工交接链；WorkBuddy 记忆 scope 不一致导致注入命中率 27%（不过滤 88%） |
| 任务中途 | agent 记不住约束、写前不查历史、写完不复盘 | 无强制召回点、无写入触发点 |
| 上下文压缩 | 压缩后忘记已确认决策、违反约束、重复劳动 | lumio 长会话上下文漂移 |
| 会话结束 | 交接靠自觉；「格式通过 ≠ 内容属实」 | lumio 44 行交接 + 399 行人工文件索引 |
| 隔天回来 | 记忆在库里但没出现在眼前 | 无「上次停在这里」摘要 |
| 并行/团队 | 各记各的、纠正不传播、评审被污染 | 团队任务板是会话级；无记忆可见性矩阵 |
| 工具有但没人用 | 有 memory 工具，零写入 | WorkBuddy `memory_write` 2475 次调用、0 次入库 |

### 0.2 答案：六个时刻 + 两条贯穿线

| 时刻 | 目标（一句话） | 核心机制 | 验收 |
|---|---|---|---|
| **T1 进入** | 60 秒内知道「这是什么项目、上次到哪、我该干什么」 | 开工简报 Boot Brief（≤2k，确定性生成，指针优先） | 冷启动三问 |
| **T2 执行中** | 每一步都不违反约束，要细节能召回 | 不可压缩核心 NCC（≤400/步）+ 写前召回 + 按需 recall | 写前召回命中、无记忆不幻觉 |
| **T3 压缩前后** | 上下文被压缩，任务状态不丢 | 提前冻结检查点 + 压缩后恢复卡 + 核心放 system head 每步重注 | 压缩保真三问 |
| **T4 门禁/决策** | 人的拍板有依据，冲突不静默 | 门禁记忆快照 + 决策记忆 + 争议队列阻断 | 冲突注入测试、对账 |
| **T5 收工** | 会话可以死，项目能续 | 确定性交接 + 机械校验 + 收工回执 | 隔天恢复测试、交接负向 fixture |
| **T6 回来** | 隔天/换人/换机都能接上 | 「你不在时的变化」增量 + 导出包 + 冷项目降级 | 换人/换机演练 |
| **贯穿 A 纠错** | 人改一条，系统立刻按新的来 | 纠正 → supersede → 传播 → 回执 | 纠正传播测试 |
| **贯穿 B 并行** | 多个会话/专家看同一本账，不串味 | 单写者 + 租约 + 可见性矩阵 + 增量广播 | 并发写/越权测试 |

### 0.3 使用期铁律（十条）

1. **不靠自觉**：领域事件由服务自动写；agent 只能提交提案（claimed），验证与提交由服务/人完成。
2. **指针优先**：常驻内容只给「状态 + 指针 + 时间 + 可信度」，全文按需 recall；截断必须显式。
3. **核心不被压缩**：阶段、写策略、当前工作项、门禁、待决策数组成 NCC，每步重新注入（≤400 tokens），放 system head（`systemPrompt.section`）；简报走 context 通道但必须可重建——**注入即历史**，见 §4.1。
4. **写前必召回**：修改/合并/发布/改契约前，必须过「相关约束与教训」检查；未读则拒绝并提示先 recall。
5. **冲突显式化**：stale / disputed / superseded 不得静默注入；涉及门禁与不可逆动作时 fail-closed。
6. **收工必有回执**：没有通过校验的交接单，不允许把工作项标记完成、不允许进门禁。
7. **纠正立即传播**：改库 + 事件广播 + 下回合 revision 漂移提示 + 导出重算，四件事缺一不可。
8. **故障可见降级**：记忆不可用时不许静默以空记忆开工；降级必须有人看得见的提示与禁用范围。
9. **人的记忆工作量预算**：每周期最多 5 次记忆相关交互（看开工卡、收工回执、偶尔纠错），默认零维护。
10. **记忆质量用任务证明**：指标不是「存了多少」，是「冷启动能不能接上、压缩后跑没跑偏、纠正有没有生效」。

### 0.4 三个必须通过的验收（详见 §10）

- **冷启动**：全新会话 + 只有开工简报，回答「在做什么/上次结论/下一步」三问，准确率 ≥90%，不幻觉。
- **压缩保真**：任务中强制压缩一次，恢复后的下一步与未压缩基线一致率 ≥90%。
- **纠正生效**：人改一条记忆后，下一个回合所有相关 agent 都能感知并按新事实行动；旧值零次再注入。

---

## 1. 五个使用现场（问题是怎么发生的）

> 这些现场由已有设计与真实复盘推演而来；每个现场给出「要求编号」，后文按号设计。

### 现场 A：周一 9:05，隔了三天回到项目

人打开工作台，新建一个会话。PM 不知道上周已经确认了三个决策、不知道有两项工作项在等验收、不知道人上次把某个范围砍掉了。于是它重新读仓库、重新问范围，人花了 30 分钟重复解释。

**要求 R1**：任何新会话/新成员，在第一次行动前必须拿到「开工简报」，能在 60 秒内回答：这是什么项目、现在哪个阶段、上次到哪、什么不能违反、需要人决定什么。**要求 R1b**：简报必须说明「哪些记忆是陈旧的、哪些是未验证的」，不能让 agent 把旧事当现状。

### 现场 B：周三 15:40，重构做到一半，上下文压满

会话自动压缩。压缩后 agent 忘了 10 分钟前刚确认的约束「不改 public API」，开始改接口签名；又重做了一遍已经完成的迁移；把它自己 20 分钟前的猜测说成了「既定方案」。

**要求 R2**：压缩前必须把任务状态冻结成检查点；压缩后必须重注入恢复卡；**关键约束必须放在每步重注的不可压缩核心（NCC）里，而不是只存在对话历史里**。

### 现场 C：周五 18:00，收工 / 下周一换人接手

工作项写着「完成」，但没有证据；交接单是 agent 自己写的一段话；新人打开后发现「记忆里说已经验证，仓库里其实没有」。更糟的是：代码已经改了，记忆里的接口还停留在旧版本。

**要求 R3**：交班必须由确定性规则生成 + 机械校验（证据存在、工作项状态、未决争议、写租约归还、下一步可执行），不能只靠 agent 自述；**记忆要锚定代码/提交 hash，变了就标 stale 并生成重验任务**。

### 现场 D：周三全天，三个专家并行 + 人中途纠错

后端 lane 和前端 lane 各自记录了对接口的不同事实，两边都「verified」；人在聊天里说「不对，我们不用 GraphQL」，但这句话只留在会话里，另一个 lane 的 agent 不知道；验收会话能看到实现者的全部自述记忆，独立性被污染；某个 teammate 重启后完全不记得任务约束。

**要求 R4**：单写者 + 租约 + 工作项级写作用域；**记忆可见性矩阵**（谁能读/写哪一层、QA 看到什么）；纠正必须传播到所有活跃会话；teammate 开局必须收到任务级简报，且不能把自述当事实。

### 现场 E：某天升级到一半 / 数据库被锁 / 检索索引损坏

工作台静默地以「空记忆」开工，agent 自信地跑偏；或者整个项目停摆，人不知道为什么。也可能检索坏了，但开工简报还在，系统却告诉 agent「没有相关记忆」。

**要求 R5**：记忆服务故障必须分级降级（只读 / 无检索 / 只读简报 / 拒绝新任务），并对人和 agent 都显式可见；写事件不能丢（本地 outbox 可重放）；恢复后自动对账。

---

## 2. 要求 → 机制 → 验收（总表）

| # | 要求 | 机制 | 时刻 | 验收用例 |
|---|---|---|---|---|
| R1 | 开工 60 秒接上 | 开工简报（角色化模板）+ 注入快照 revision | T1/T6 | U01 冷启动三问 |
| R1b | 简报不撒谎 | 状态/时间/陈旧/未验证标注 + 禁止注入 superseded | T1/T2 | U02 stale 注入测试 |
| R2 | 压缩不失忆 | NCC 每步重注 + checkpoint + 恢复卡 | T3 | U03 压缩保真 |
| R3 | 交接可验证 | 确定性交接单 + 校验器 + 锚定 hash + 收尾对账门 | T5 | U04 交接负向 fixture、U05 代码漂移 |
| R4 | 并行不串味 | 单写者 + claims + 可见性矩阵 + 纠正广播 | T2/T4 | U06 并发写、U07 越权、U08 纠正传播 |
| R4b | 团队开局有记忆 | 任务级简报由 PM 生成并写入 spawn prompt；项目 skill 要求首步 brief | T1 | U09 teammate 开局 |
| R5 | 故障不静默 | 分级降级 + 横幅 + outbox + 恢复对账 | 全局 | U10 降级演练 |
| R6 | 人不用维护记忆 | 自动捕获 + 默认值 + 每周最多 3 分钟 review | T5/T6 | U11 人因测试 |
| R7 | 成本可控 | 四级注入预算 + token 会计 + 超限降级指针 | T1/T2 | U12 预算压测 |

---

## 3. 记忆平面：缓存、过程、账本、画像

使用期的一切问题，先要回答「这条记忆在哪个平面、谁说了算」。

| 平面 | 载体 | 生命周期 | 权威？ | 谁写 | 谁读 | 丢了会怎样 |
|---|---|---|---|---|---|---|
| **P0 上下文** | 模型 context window | 秒~分钟 | 否 | 宿主/插件注入 | 模型 | 正常现象；靠 T2/T3 重新获得 |
| **P1 会话日志** | DSH session JSONL + 派生检索 | 会话级 | **否**（过程记录） | DSH | 人、审计、检索 | 可丢；不能用来重建项目事实 |
| **P2 项目账本** | `.dsh/memory/project.sqlite`（权威）+ 检索库（派生） | 项目全周期 | **是** | 项目服务单写者 | agent 工具、驾驶舱、导出 | 灾难；靠备份/导出恢复 |
| **P3 人的画像** | profile 级偏好/决策风格 | 跨项目长期 | 仅偏好，非事实 | 人显式确认 | 会话按需注入 | 影响体验，不影响正确性 |
| **P4 共享视图** | 开工简报/NCC/增量 delta | 派生、每步重建 | 否 | 项目服务派生 | 所有会话 | 可重建 |

**四条平面规则**：

1. **会话永远不能直写 P2**：agent 只调 `project_remember` 提交提案；写工具、bash 都无法绕过项目服务。
2. **P1 不能回灌 P2 当事实**：会话日志只能作为证据线索（「当时说过这句话」），不能升级为项目事实。
3. **P4 只由 P2 派生**：简报里不出现库里查不到的内容；派生失败要显式报错，不许「大概记得」。
4. **P3 必须显式同意**：偏好记忆默认关闭跨项目；项目内偏好放项目账本，不放 profile。

> 裁决：现有文档中 `audit_log` 与 `memory_events` 双源（缺口 C04）统一为 **`memory_events` 是唯一事实源**；
> `audit_log` 降级为安全审计投影（可重建）。`storageDomain` 仅存插件设置与 UI 缓存（缺口 C01）。

---

## 4. 六个时刻（核心设计）

> 每个时刻必须回答六件事：**触发 / 执行者 / 读什么 / 写什么 / 预算频率 / 失败降级**。未定义项一律按 fail-visible 处理。

### 4.1 T1 进入：开工简报（Boot Brief）

**触发**：新会话首个用户回合；进程重启后恢复会话；隔天/隔周重新打开项目；换人接手（QA/新 PM）；teammate 开局；新工作项被分派。
**执行者**：插件 Host 服务确定性生成；会话侧有两条**已确认可用**的注入通道（源码结论见 §12）：

- **载体 A（首选）**：插件注册 `systemPrompt.section` / `systemPrompt.context`。前者在每步 assemble 时求值、不进 durable 历史（压缩删不掉）；后者变化时才追加为 user 消息，自带去重与冷恢复。DSH 0.2.1-rc.2 已确认可用，且 preset 没有独立的 promptContext 字段，所以注入要走"插件 + agent 作用域"这条正路。
- **载体 B（保底）**：项目 skill 规定首步必须调用 `project_brief`；teammate 由 PM 调
  `project_brief(role=teammate, task=<id>)` 生成任务文本放入 spawn prompt，或由插件在 `agent/created` 后 `child.inject`。

> **关键约束「注入即历史」（源码 + 本机实测）**：`systemPrompt.context` 追加的是 durable `user/message`，
> 会和用户消息一样被压缩、检索、冷恢复——它不是旁路注解。因此：简报必须带 source/版本/digest、可从项目账本重建；
> **不可压缩的关键约束放 `systemPrompt.section`（system head，永不压缩）**；自定义注入被压缩 shadow 后，
> 插件要自己从 surface 重建（参考 runtime-context / agent-instructions 的自愈实现）。

**简报内容（角色化，≤2k tokens，所有条目带 id/时间/状态）**：

```text
# 开工简报 · <项目> · <阶段> · <角色> · <生成时间>
## 1 项目名片 (≤150 tokens)
- 项目 ID/类型/仓库/主分支/入口；阶段 Sx / 周期 Cy / process_profile vN（冻结日期）
- 冻结基线：PRD vX(hash) · ADR vY(hash) · 契约 vZ(hash) · 当前门禁
## 2 当前焦点 (≤300)
- 进行中工作项：id | 状态 | owner | 下一步（≤5 条）
- 本周期目标 / 剩余 appetite / WIP 与验证队列
## 3 上次停在这里 (≤400)
- 上次会话 <id> <时间> <结束方式：收工/崩溃/切换>
- 做到哪 / 已决定什么 / 卡在哪 / 下一步 / 未完成提案与未归还租约
## 4 不可忘约束 (≤300)
- 阶段写策略（允许/禁止写什么）；钉住约束与约定（标 verified/claimed）
- 最近 5 条决策：日期 + 一句话 + 引用 id
## 5 待你决定 (≤100)
- 待决策 N 条 / 最紧急 2 条 / 超时默认值
## 6 记忆健康 (≤100)
- stale N / 未验证 M / 争议 K / 上次蒸馏 / 降级状态
## 7 召回指针 (<100)
- 相关文档 id、`project_recall` 用法、本角色可见范围
```

**规则**：

- 只给状态、指针、时间，不给全文；
- 每条带统一引用格式 `[M-0042|verified|2026-11-03|ADR-0003]`；
- 陈旧标 `stale(since 2026-11-01)`，争议标 `disputed` 并一句话列出双方；
- `superseded/rejected` 一律不出现；
- 新项目输出「裁剪 5 问」引导，不输出空白记忆。

**写**：只写 `brief_issued` 事件（session_id、brief_hash、快照 revision、角色、token 数）。
**预算/频率**：每次进入一次；≤2k tokens；p95 < 500ms。超时（>2s）降级为极简版（名片 + 焦点 + 待决策）。
**失败降级**：账本不可用 → 最近导出简报 + 红条「记忆只读，最后同步 <时间>」；未初始化 → 引导立项；简报生成失败 → **禁止开工**（不许空记忆开工）。
**验收**：U01 冷启动三问；U02 stale/争议标注。

### 4.2 T2 执行中：核心常驻 + 写前召回 + 按需召回

执行中分三层，从「必须有」到「按需」：

| 层 | 内容 | 触发 | 预算 | 载体 |
|---|---|---|---|---|
| **NCC 不可压缩核心** | 项目/阶段/写策略、当前工作项、门禁、待决策数、最近项目 delta | 每步/每工具批次 | ≤400 tokens/步 | 动态 prompt context（首选）或 skill+核心工具（保底） |
| **写前召回** | 与目标路径/实体相关的已验证约束、教训、最近决策 | 写/改/合并/发布/改契约前 | ≤300 tokens/次 | 工具 guard 拦截 + 返回摘要 |
| **按需召回** | 需求卡、ADR、契约、历史工作项、教训、证据 | 5 类触发（见下） | ≤4k/次 | `project_recall` |

**NCC 每步重注**的目的：**让压缩无法删掉关键约束**。实现上走 §12 的 `systemPrompt.section`（每步 assemble、不进 durable 历史，compaction 不会把它压掉）；保底方案是项目 skill 在「计划开始 / 每批工具调用前 / 收到压缩提示后」强制调用 `project_brief(mode=core)`，并用工具 guard 兜底。

**写前召回的 5 类触发**：

1. 触碰实体：需求/工作项/模块/文件/接口（按实体与路径召回）；
2. 准备决策或改变已批准的东西；
3. 失败重试（先召回类似教训）；
4. 人要追溯「为什么」（给引用链，不许编）；
5. 观察到与记忆冲突的事实（测试/代码与记忆不一致 → 触发冲突流程）。

**写前召回的闸门语义**（关键设计）：

- guard 发现目标路径/实体存在「本会话未读的已验证约束或最近决策」→ **拒绝**并返回：
  「该路径关联 2 条约束（M-0042/M-0051）与 1 条最近决策；先调用 `project_recall(scope=path:src/auth/**)` 再重试」；
- 会话内已确认阅读（或明确声明「不适用」）→ 记 `constraint_ack` 事件，本次会话免打扰；
- 门禁阶段或不可逆动作 → 不允许声明「不适用」，必须人确认；
- guard 不可用/超时 → 放行但写 `guard_degraded` 事件，收工回执标注（绝不能因记忆故障卡死所有写操作）。

**预算/频率**：NCC 每步；写前召回每次写操作（最多每批一次）；按需召回由 agent/人发起；每会话记忆注入总量 ≤ 上下文预算 15%（可配），超限只给指针并标 `truncated`。
**失败**：召回为空 → 明确「未找到相关记忆」+ 建议（查代码 / 问人 / 新建），禁止用「我记得」补空；账本慢 → 用缓存简报 + `memory_slow` 事件。
**验收**：U13 写前召回命中；U14 无记忆不幻觉；U12 注入预算压测。

### 4.3 T3 压缩前后：检查点 + 恢复卡

**现实约束（0.2.1-rc.2 源码确认）**：DSH **没有「压缩前」钩子**，`compaction/start` 是压缩已开始后的会话事件，插件只能在之后看到。可用的观测点：`session/event` 中的 `compaction/start|summary|end|prune`、摘要事件，以及 `tokenMeter` 水位。因此本设计把「压缩前 flush」改写为「**提前冻结**」：在水位 ≥70%、每 N 步、大动作后、进程退出前写 checkpoint；压缩事件只用于记录、恢复与对账。

**触发**：水位 ≥70%（每步用 tokenMeter 评估）；每 N 步（默认 20）；每个大动作（合并/门禁/发布）之后；进程退出前；收到 `compaction/start` 时补最后一次冻结（事后但仍可补）。

**提前冻结 Flush（写）**：系统与会话协作生成 `session_checkpoint`：

- 当前工作项/阶段/目标/剩余计划；
- 本会话的决策与假设（含未提交提案）；
- 已触碰文件 + hash、未归还租约；
- 未决问题、下一步动作；
- 当前注入快照 revision。

**压缩后 Restore（读）**：监听 `compaction/summary` 事件（摘要事件本身就是恢复信号），把恢复卡通过 `systemPrompt.context` 注入下一回合（≤1k）；原文被折叠的节点仍在 session JSONL 里，可检索但不重灌。源码细节：0.8 × 窗口压力触发、保留约 16% 近端原文、system head 永不压缩；摘要同时以 `compaction/summary` 事件与 `compact-checkpoint` surface user 消息双写，冷恢复由 foldSurface 重建。**自研注入必须自己实现「被 shadow 后重注」**，否则任务记忆会在压缩后静默消失。

```text
# 恢复卡 · 你刚经历上下文压缩
- 你在做：<工作项 / 阶段 / 目标>
- 已决定：<本会话决策列表 + 引用>
- 已改：<文件 + hash>
- 未决：<问题/阻塞/待决策>
- 下一步：<动作>
- 项目更新：<自检查点以来的 delta>
- 自检：先回答「我在做什么/已决定什么/下一步」，与以上不符请指出
```

**校验**：agent 的回答与 checkpoint 不符 → 写 `checkpoint_mismatch` 事件；收工回执提示人复核。
**版本/水位不可用时的降级**：NCC 每步重注 + 每 N 步 checkpoint，把压缩当普通上下文波动处理（牺牲描述精确性，不牺牲约束）。
**失败**：checkpoint 写失败 → 事件 + 下一安全点重试 + 回执标红；不许静默。
**验收**：U03 压缩保真三问。

### 4.4 T4 门禁与决策：把记忆变成依据

- **门禁前**：`project_gate(request)` 生成**门禁记忆快照**（工作集 + 关键事实 + 证据 + 未决争议 + 记忆健康），hash 进审计；材料不齐拒绝提交。
- **门禁通过**：人批准 = 一条不可变决策记忆（verified，source=human）；agent 不可代批。
- **阶段切换**：记忆 profile 切换（§7 阶段×kind 白名单）；生成下一阶段交接清单；上一阶段未验证假设**不得**直接进入下一阶段 verified（只能 claimed 或转任务）。
- **决策卡**：问题/选项/推荐/不决后果 + 相关记忆引用；人回答写 `decision` 事件并按升级规则处理超时。
- **争议**：双 verified 冲突 → `dispute` + 阻断相关门禁；人裁决 → supersede + 广播 + 重算导出。
- **失败**：记忆服务不可用 → 门禁与不可逆动作 fail-closed；只读阶段可继续。
**验收**：U15 冲突注入；U16 门禁对账。

### 4.5 T5 收工：确定性交接 + 回执

**触发**：显式「收工」；会话关闭；空闲超时（默认 30 分钟）；新 PM 会话替换旧会话；任务完成；门禁通过；进程退出（下次启动补生成）。

**两类工件（解决现有文档的「双作者」矛盾 C12）**：

| 工件 | 作者 | 范围 | 内容 |
|---|---|---|---|
| 工作项交接 `handoff.yaml` | 执行者（narrative）+ 服务（确定性字段） | 工作项 | 完成/证据/未决/风险/下一步 |
| 会话摘要 `session-digest.md` | PM/系统 | 会话 | 做了什么/写了哪些记忆/未完成/下次从哪开始 |

**确定性交接（always，不依赖 agent 自述）**：服务从事件流生成 `handoff.yaml`，agent 只能补 narrative 字段；校验器检查：

1. 必填字段齐全（五要素）；
2. 证据 URI 可解析、与工作项状态一致（不能「完成」无证据）；
3. 无未决 blocker 级评审发现；
4. 写租约已归还、临时分支/worktree 已登记；
5. 下一步有明确动作与 owner。

校验失败 → **不允许工作项标记完成、不允许进门禁**。这就是「格式通过 ≠ 内容属实」的机械化答案。
**蒸馏（可选后台）**：模型提炼候选 fact/decision/lesson，只能 claimed，PM 次日审。
**收工回执（人）**：本次新增/替代/待验证记忆、待决策、下次开工从哪开始、记忆健康变化；一键纠正入口。
**幂等**：同一会话重复触发只更新、不重复写。
**失败**：进程崩溃 → 下次启动补生成并标 `recovered`；校验失败 → 回执红条 + 阻断完成。
**验收**：U04 交接负向 fixture；U17 幂等。

### 4.6 T6 回来：隔天、换人、换机

- **隔天/新会话**：开工简报 + 「你不在时的变化」delta（≤10 条，按影响排序：阶段/决策/证据/风险，带 id 与时间）。
- **换人**：按角色裁剪简报；QA 只带验收标准、证据、未决争议，**不带实现者自述记忆**（防评审污染）。
- **换机/换 profile**：导出包（权威库 + 事件 + 文档版本 + artifacts 引用 + schema 版本 + 校验清单）→ 导入前校验（hash/条数/schema）→ 幂等合并（项目 ID + 事件 ID 去重）→ 冲突人裁决。DB 不进 git，导出物进 git。
- **冷项目**：长期不活跃项目只加载名片与指针（cold 标记），不自动注入全文或重建团队。
**验收**：U18 换机演练；U19 QA 隔离。

### 4.7 贯穿 A：纠错与遗忘

- **入口**：引用 chip 纠错 / 记忆中心逐条编辑 / 聊天自然语言（agent 转 `project_correct`）/ 争议裁决。
- **权限**：人 > QA（证据与验证状态）> PM（叙事与状态）> 执行者（仅本人工作项提案）。agent 不能直接 supersede verified，只能提案。
- **流程**：纠正事件 → 校验（是否需要证据）→ supersede/新增 → 依赖标 stale → 广播 delta → 下回合 revision 漂移提示 → 导出重算 → 使用日志。
- **回执**：纠正人看到影响面；被影响 agent 下回合收到「更正」；审计可查。
- **遗忘**：软删 + tombstone；索引/导出/缓存清理并出残留报告；审计保留；跨项目记忆同步遗忘。
- **禁止**：静默改写历史；硬删除（除合规要求，需人批准）。
**验收**：U08 纠正传播；U21 遗忘残留。

### 4.8 贯穿 B：并行与团队

- **单写者**：项目服务；claims 实体级租约（TTL）；revision CAS；迟到写拒绝。
- **可见性矩阵**（读/写/verified）：

| 角色 | 项目级 | 工作项级 | 私有 | 可标 verified |
|---|---|---|---|---|
| 人 | 全部 | 全部 | — | 是（人类通道） |
| PM | 读全部，写叙事/状态 | 读全部，写状态 | 本人会话 | 发起请求（QA/人授予） |
| 执行者 | 读 | 读写本人工作项 | 私有草稿 | 否（只能 claimed） |
| QA | 读证据/验收标准，不读实现自述 | 读全部证据 | — | 是（证据结论） |
| 会诊 subagent | 只读任务相关 | 只读 | — | 否（不写） |
| teammate | 读 | 读写任务范围提案 | — | 否 |

- **fork 的继承风险**：`context:fork` 会继承父会话已完成 turn 的前缀；执行型 teammate 默认 `fresh` + 简报，避免把父会话的假设带进任务。
- **teammate 开局（三条可用路径，按优先级）**：① 插件用 `systemPrompt.context` 按 scope 链对子会话生效（DSH 已确认）；② PM 调 `project_brief(role=teammate, task)` 把文本放入 spawn prompt（spawn 请求本身没有注入字段）；③ 插件在 `agent/created` 后 `child.inject(createUserMessage(...))`。三条都失败时，任务描述必须自带简报；teammate 冷恢复重建时按同一路径重新注入。
- **增量广播**：outbox → 活跃会话下回合 NCC 显示「项目有新变化 N 条」+ 指针，不自动灌全文。
- **多实例/多窗口**：工作区锁文件；第二实例只读并提示；worktree 统一解析主工作区项目根。
**验收**：U06 并发写；U07 越权；U08 纠正传播。

---

## 5. 写入路径：三类写入者 + 五道写入门

### 5.1 写入矩阵（谁在什么时候写什么）

| 类型 | 谁 | 写什么 | 状态上限 | 证据要求 | 时机 |
|---|---|---|---|---|---|
| **领域事件** | 项目服务（系统） | 阶段/领取/交接/证据/门禁/违规/工具摘要/文件变更 | L0 事件（事实源） | 天然带来源 | 每次领域动作，实时 |
| **叙事提案** | 任意 agent | 决策理由/约束/教训/事实/风险/备注 | `claimed` | 必须 `source_ref` | 回合结束或任务结束，批量 |
| **纠正与裁决** | 人；QA 限证据结论 | 更正/替代/验证/钉住/遗忘/偏好 | `verified`（人身份） | 人本身份 + 理由 | 随时 |
| **后台蒸馏** | 服务 + 廉价模型 | 候选事实/教训/摘要 | `claimed` | 必须挂事件或证据 | 会话结束/每日/每周期 |
| **门禁产物** | 服务 + 人 | 基线快照/批准决策 | `verified` | 人批准事件 | 门禁通过 |

**铁律**：agent 永远不能直接写 `verified`、不能物理删除、不能改历史；只能提案，由服务仲裁，人授予验证。

### 5.2 五道写入门（全部在服务端）

1. **作用域**：scope/ACL 校验；越权直接拒绝并记审计。
2. **来源**：叙事必须有 `source_ref`（path:line / commit sha / tool_call_id / url / doc id）；无来源只能进「草稿区」，不能进简报。
3. **密钥与隐私扫描**：命中即拒绝 + 告警；导出脱敏。不记录原始终端输出与文件全文。
4. **去重与仲裁**：content_hash 去重；同 `logical_key` 只留 canonical；冲突走 §4.7 或 dispute。
5. **阶段×kind 白名单**（§7.1）：设计阶段不能写「代码实现事实」；QA 只能写证据结论。

### 5.3 写入率：三率 + 止损线

WorkBuddy 的证据（`memory_write` 2475 次调用、0 次入库）说明「有工具」不等于「会写」。本设计用**自动捕获兜底 + 三率度量 + 门禁止损**：

| 指标 | 定义 | 目标 | 止损动作 |
|---|---|---|---|
| 调用率 | 有提案的会话 / 总会话 | ≥70% | 连续 3 个会话零提案 → 告警 PM |
| 入库率 | commit 数 / 提案数 | ≥80% | 低于 50% 说明提案质量差 → 回看抽取规则 |
| 覆盖率 | 有「决策 + 证据」记忆的工作项 / 完成工作项 | 100% | <90% → 门禁黄；<80% → 收尾对账失败（拒绝收工） |

> 注意分母：覆盖率以**工作项**为单位，不以「写了几条」为单位，防止刷条数。
> 质量用「被召回后使用率」与「人工纠正率」校准；三率是下限，不是目标本身。

### 5.4 写放大控制

- 每工作项默认 ≤20 条活跃记忆，超出必须合并/替代（自动生成「压缩建议卡」）；
- 叙事批量提交（回合/任务边界），事件实时；
- 后台蒸馏有每日预算（默认 ≤10 次模型调用/项目）；
- 同一事实重复写入 → NOOP，不产生新版本。

### 5.5 只记什么：四类白名单（外部产品的一致做法）

自动捕获（叙事类）只认四类：

1. 用户纠正/否决（含「别这样」）；
2. 稳定偏好与约定（不是一次性要求）；
3. 决策与理由（为什么选 A 不选 B）；
4. 环境坑与可复用经验（踩过一次、下次还会踩）。

**不记**（硬规则）：

- 可从代码/git/文档直接推导的事实（路径、依赖、函数签名）——必然陈旧；
- 任务状态与编号（由事件与工作项状态机回答，不写成记忆）；
- 密钥/凭据/个人信息；
- 原始聊天、终端输出、文件全文；
- 一次性上下文（临时要求、当日安排）。

理由：Claude Code 明确跳过架构/路径/调试修复等可推导事实；Copilot 只分「仓库事实 / 用户偏好」两类；
ChatGPT 的 summary 自己承认会遗漏。记可推导的事实 = 制造噪音与陈旧源。

---

## 6. 读取路径：四级注入 + 召回协议

### 6.1 四级注入（预算与载体）

| 级别 | 名称 | 何时 | 内容 | 预算 | 载体 |
|---|---|---|---|---|---|
| L0 | **NCC 核心** | 每步/每工具批次 | 阶段/写策略/当前项/门禁/待决数/项目 delta | ≤400 tokens | 宿主每步注入（首选）或 skill 强调用 |
| L1 | **开工/恢复** | 会话开始、恢复、换人 | 开工简报 / 恢复卡 | ≤2k / ≤1k | 同 L0 载体 |
| L2 | **按需召回** | 5 类触发（§4.2） | 实体相关片段 + 出处 + 状态 | ≤4k/次 | `project_recall` |
| L3 | **深读** | agent 显式读取 | 全文/代码/历史 | ≤8k/次 | 文件/工具 |

**总量约束**：单会话记忆类注入 ≤ 上下文预算 15%；超出时先降 L2、再降 L1，L0 永不删减（只可压缩到一句话）。

### 6.2 `project_recall` 契约

```text
project_recall({
  query?: string,
  entity?: { kind: 'work-item'|'requirement'|'module'|'file'|'decision', id?: string, path?: string },
  kinds?: ['decision','constraint','lesson','fact','doc','evidence'],
  scope?: 'project'|'requirement'|'work-item'|'module',
  asOf?: string,
  budget?: 4000,
  status?: 'verified'|'claimed'|'any'
})
```

返回契约（每条）：`{ id, kind, text, status, confidence, source, validFrom, validTo, stale?, disputedWith?, whyRecalled, tokens }`。

**规则**：

- ACL 先于检索；跨 scope 一律拒绝，不返回「部分结果」；
- 默认只返回当前有效 + verified；`claimed` 必须显式请求；
- 标注截断（`truncated: true, omitted: N`），让 agent 知道自己没看全；
- 无结果时返回 `{ found: false, suggestions: [...] }`，禁止模型自行补空。

### 6.3 漂移检测（解决长会话用旧事实）

- 简报/召回返回时记录 `snapshot_revision`；
- 每步 NCC 注入时对比当前 revision：变化 → 附 3 行 delta（谁改了什么），并标 `memory_updated`；
- 收到纠正事件 → 下回合强制注入「更正」卡片；
- 若本会话引用了已 superseded 的记忆 → 记 `stale_use` 事件，收工回执提示。

### 6.4 注入红线（全部可机检）

1. `superseded/rejected` 注入次数 = 0；
2. `disputed` 必须显示争议双方与状态；
3. `stale` 必须带原因（文件变化/超期/未复验）与最近验证时间；
4. 跨 scope 泄露 = 0；
5. 密钥/敏感命中 = 0；
6. 每条注入必须带 id 与 source（无来源内容不进上下文）。

---

## 7. 阶段、门禁与工作台的特殊性

### 7.1 阶段 × 记忆 kind 白名单（默认模板）

| 阶段 | 可写 kind | 禁止 | 说明 |
|---|---|---|---|
| S-1 接管审计 | fact（现状）、risk、lesson | decision（除审计结论） | 只记录观察，不定义方案 |
| S0 立项 | decision、constraint、risk | fact（代码实现） | 章程/预算/成功标准 |
| S1 产品 | decision、constraint、glossary | 代码事实、实现决策 | 需求卡 + 非目标 |
| S2/S3 设计 | decision、constraint、glossary | 代码事实 | UX/UI 决策 |
| S4 架构 | decision、constraint、fact（技术选型） | 实现细节 | ADR + 契约 |
| S5 实现 | 全部（含 fact/lesson） | 未验证的「完成」 | 证据驱动 |
| S6 验证 | 证据结论、defect、lesson | 实现叙事 | QA 写验证状态 |
| S7 发布 | decision、evidence、risk | 新功能事实 | 回滚预案 |
| 复盘 | lesson、decision（程序性） | 现状事实变更 | 经验升级 |

> 该表由 `process_profile` 携带并在 G0 冻结（与流程裁剪一致）；改表走决策卡。

### 7.2 门禁记忆快照与收尾对账

- 每个门禁请求生成快照（工作集 + 关键事实 + 证据 + 争议 + 健康 + hash）；
- 收尾对账门在既有「证据/记忆/计数/状态/恢复路径」五类之上，增加三项记忆判据：
  1. `HANDOFF_VALID`：交接单校验通过；
  2. `MEMORY_COVERAGE`：完成工作项覆盖率 ≥ 阈值；
  3. `NO_OPEN_DISPUTE`：无与本次门禁相关的未裁决争议。
- 任一失败 → 拒绝收尾/门禁（与 lumio 的 MEMORY_BEHIND 教训对应）。

### 7.3 代码锚定与陈旧检测

- 每条 fact/constraint/decision 可带锚点：文件路径 + 内容 hash，或 commit sha；
- 文件变化 → 锚点失效 → 标 `stale` + 生成「重验任务」（不是直接删除）；
- 人在收工回执/周报里看到「本次有 3 条记忆因代码变化需复验」；
- 这解决现场 C 的「记忆说已实现、仓库里没有」问题。

### 7.4 Git 与导出

- 导出物入 git：`.dsh/project/memory/brief.md`、`decisions.md`、`handoffs/*.yaml`、`MEMORY.md`；
- PR 里可 review 记忆变化（谁改了什么，带记忆 id）；
- commit trailer 建议：`Project-Memory: M-0042,M-0051`（可选）；
- DB 不入 git；导出带 manifest（revision + hash + 时间）；手改导出物会在下次导出被覆盖并告警。

### 7.5 会话编排与记忆归属

| 会话 | 记忆职责 |
|---|---|
| 项目办公室（常驻 PM） | 记忆的 owner：发起蒸馏、审提案、生成简报/摘要、维护项目 profile |
| 独立验收（QA） | 只读证据与验收标准；写验证结论；不读实现自述记忆 |
| 专家 teammate | 任务级简报 + 任务级提案；不写项目级 verified |
| 人类 | 纠正、裁决、批准、遗忘 |

---

## 8. 人的界面：四个触点 + 一个中心

### 8.1 触点与人的工作量

| 触点 | 何时 | 人做什么 | 时间预算 |
|---|---|---|---|
| 开工卡 | 打开/恢复会话 | 扫一眼「下一步 + 待决策」 | ≤30 秒 |
| 状态条（输入框 dock） | 全程常驻 | 看阶段/待决策/记忆健康灯 | 0（余光） |
| 收工回执 | 收工/下班 | 看新增记忆与待办，一键纠正 | ≤30 秒 |
| 决策卡 | 有决策时 | 选项/推荐/后果，拍板 | 决策收件箱，每天 1 窗口 |
| **记忆中心** | 主动打开 | 搜索/纠正/遗忘/看使用记录 | 每周 ≤5 分钟 |
| 周记忆摘要（可选） | 每周 | 确认/否决本周学到的 3 条 | 5 分钟，可关 |

### 8.2 记忆中心（驾驶舱「文档」页下的子 tab，不新增顶级视图）

- **全部**：按 kind/scope/status 过滤 + 全文搜索；
- **待验证**：claimed 且被引用过的记忆；人/QA 批量确认；
- **争议**：disputed 列表 + 双方证据 + 裁决按钮；
- **最近变更**：本周新增/替代/纠正（diff 形式）；
- **使用记录**：哪条记忆被哪个会话注入/引用/纠正（可信度依据）；
- **健康**：红黄绿灯 + 指标（stale 率、重复率、注入 tokens、纠正次数）。

### 8.3 依据与纠正

- 回答/决策卡/交接单里的记忆引用显示为 chip：`[M-0042|verified]`；点开看原文/来源/时间/使用记录；
- 纠正三步：点 chip → 编辑或「不对」→ 选影响面（只改这条 / 同时标依赖失效 / 通知相关会话）；
- 纠正后回执：「已更正 1 条、2 条记忆标 stale、下次开工生效；受影响会话 2 个（下回合收到更正）」；
- **不允许**：把记忆维护做成表单让用户填；把「记住这个」当默认交互；让用户读 SQL。

### 8.4 状态色与文案（主题 token）

| 状态 | 含义 | 界面 |
|---|---|---|
| 新鲜 verified | 证据在、未过期 | 绿点 |
| 未验证 claimed | 有来源但没人确认 | 黄点，提示「建议确认」 |
| 陈旧 stale | 锚点变了/超期 | 橙点 + 原因 + 重验按钮 |
| 争议 disputed | 两个 verified 冲突 | 红点 + 进决策收件箱 |
| 已替代 superseded | 只能历史查询 | 灰点，默认不显示 |

### 8.5 外部产品已验证的交互取舍（直接吸收）

| 取舍 | 外部证据 | 本设计对应 |
|---|---|---|
| 回答级 provenance | ChatGPT Sources 可点回源、当场纠正；Copilot 记忆引用到代码 | §8.3 依据 chip + 使用记录 |
| 纠正三档并列 | 改 / 别再提（mute，不删源）/ 删；删除要显示传播范围与延迟 | §4.7 + §8.3；本设计全部走软删 + 审计，UI 明示「停用 vs 删除」 |
| 捕获时声明作用域 | Copilot 写入时提示「用户级 vs 仓库级」 | §5.1 写入矩阵 + §4.8 可见性矩阵 |
| 不逐条打扰 | 默认记 + 事后可见 + 聚合回执（Devin 一张 Updated memory 卡片；Claude 仅敏感主题提示） | §8.1 收工回执聚合；只在敏感/作用域升级时打断 |
| 新记忆只对后续回合生效 | Devin：Updated memory 只影响后续会话 | §6.3 漂移检测：下回合 delta；当前回合不自我强化 |
| 共享/导出默认不带记忆源 | ChatGPT 共享链接排除 Memory Sources | §7.4 导出默认不带私有记忆引用；共享前脱敏 |
| 记忆不是策略 | 必须生效的规则放规则文件/钩子 | NCC 的阶段策略来自项目域配置，不来自叙事记忆（§4.2） |

---

## 9. 故障与降级（fail-visible 分级）

| 故障 | 检测 | 系统行为 | 人看到 | agent 看到 | 恢复 |
|---|---|---|---|---|---|
| 检索库缺失/损坏 | 打开/查询失败 | 降级：无 recall，简报可用 | 黄条「检索不可用，正在重建」 | 工具返回「检索不可用，请直接读文件」 | 自动重建 + 对照报告 |
| 权威库被锁 | busy_timeout 超时 | 写排队 + 读缓存；>10s 转只读 | 黄条 | NCC 标「记忆写入暂停」 | 锁释放后重放 outbox |
| 权威库损坏/迁移中 | 完整性检查失败 | 只读 + 禁 verified 写 + 门禁/不可逆动作阻断 | 红条 + 备份恢复入口 | 简报用最近导出（标 degraded） | 恢复演练 + 对账 |
| 磁盘满 | 写入失败 | 拒绝新写 + 保留读 | 红条 | 「记忆写不进去，收工可能失败」 | 清理/迁移 |
| 时钟异常 | 时间戳漂移 | 用单调 revision 排序，不依赖墙钟 | 提示 | 无感 | 校正 |
| 导出不一致 | manifest 校验失败 | 以 DB 为准重导 + 告警 | 黄条 | 无感 | 自动 |
| 多实例 | 锁文件 | 第二实例只读 | 提示「另一实例正在写入」 | 只读工具可用 | 关闭其一 |
| 写租约冲突 | claims 不匹配 | 拒绝 + 返回持有者 | 提示 | 「由会话 X 持有，请等待或转交」 | 过期回收 |
| 越权/跨 scope | ACL | 拒绝 + 审计 | 无 | 明确原因 | — |
| 密钥命中 | 扫描 | 拒绝入库 + 告警 | 红条 | 「内容疑似密钥，已拦截」 | 脱敏后重试 |
| 简报生成超时 | >2s | 极简版 | 黄点 | 极简简报 | 下一次完整 |

**原则**：降级等级写进 NCC 第一行（normal / search-off / read-only / blocked），任何一方都不能猜；
写事件先落本地 outbox（JSONL），恢复后按幂等键重放并出对账报告。

### 9.2 记忆投毒与不可信输入（新增安全边界）

外部研究显示：任何「外部内容 → 持久记忆 → 跨会话读回」的通路都是攻击面（SpAIware 持久记忆注入；
MemoryDojo 测试的记忆系统全部可被投毒）。因此：

1. **记忆内容是数据，不是指令**：注入上下文的记忆不得被当作系统指令执行；模型看到记忆里的「去做 X」，按普通数据对待。
2. **写入扫描**：叙事与外部内容入库前做指令注入扫描（URL、「忽略之前」、执行类措辞）；命中标 `suspicious`，不得进入 verified。
3. **来源校验**：只有 verified 且 source 可解析的记忆能影响门禁/不可逆动作；claimed 只能作线索。
4. **新项目级约束需人确认**：会影响全局行为的新约束/规则，必须人确认后才生效（防「一次对话埋毒」）。
5. **跨项目经验默认不自动加载**：只加载人确认过的 lessons；加载时显示来源项目。
6. **记忆不参与权限判断**：权限只来自 DSH 会话/角色/工具策略，记忆是数据不是授权。
7. **投毒回归测试**：U25 用公开投毒样本测「写入 → 召回 → 是否影响决策」。

---

## 10. 使用期验收：测试套件 + SLO

### 10.1 用例（每条都可自动化）

| # | 场景 | 预期 |
|---|---|---|
| U01 | 全新会话，只给开工简报 | 三问（做什么/上次结论/下一步）准确率 ≥90%，无编造 |
| U02 | 注入含 stale/disputed/superseded 的库 | 前两者带标记，第三者 0 次出现 |
| U03 | 任务中途强制压缩 | 恢复后下一步与基线一致率 ≥90%，约束违反 0 |
| U04 | 交接单缺证据/状态不符 | 校验器拒绝，工作项不能完成、门禁不能提交 |
| U05 | 代码改动导致记忆锚点失效 | 标记 stale + 生成重验任务 + 简报可见 |
| U06 | 两会话同时改同一实体 | 租约 + CAS 拒绝迟到写；无 lost update |
| U07 | 跨 scope 召回/写 | 一律拒绝，审计有记录 |
| U08 | 人纠正一条被两个会话使用的记忆 | 下回合两会话都收到「更正」，旧值 0 次再注入 |
| U09 | teammate 开局只有任务描述 | 首步拿到任务级简报；不重复问需求 |
| U10 | 杀死权威库/检索库 | 分级降级正确；不静默空记忆；恢复后对账通过 |
| U11 | 人因：看开工卡/收工回执 | 30 秒内能说出「下一步」与「要我决定什么」 |
| U12 | 注入预算压测（长会话） | 总量 ≤15% 上下文；超限降级；NCC 不丢 |
| U13 | 写前召回：写受约束路径 | 未读约束 → 被拒并提示；读后放行 |
| U14 | 召回空结果 | 明确 found:false + 建议；不幻觉 |
| U15 | 构造两个 verified 冲突 | 进 dispute、相关门禁阻断、人可裁决 |
| U16 | 门禁对账（证据/记忆/计数/状态/恢复路径） | 任一失败拒绝门禁，报告可读 |
| U17 | 交接重复触发 | 幂等：版本+1，无重复条目 |
| U18 | 导出包换机导入 | 校验通过、幂等合并、冲突人裁决 |
| U19 | QA 会话读取 | 看不到实现者自述记忆；验收结论不受影响 |
| U20 | 写入率下限 | 覆盖率低于阈值 → 收尾对账失败（负向 fixture） |
| U21 | 遗忘一条记忆 | 检索/导出/缓存无残留；审计保留 |
| U22 | 多实例并发 | 第二实例只读；无 WAL 双写 |
| U23 | 运行中迁移 | 记忆只读、新任务暂停、失败可回滚 |
| U24 | 记忆注入全部关闭（A/B） | 同一任务集：记忆开 vs 关的一次验收通过率/返工率/时长对比 |
| U25 | 记忆投毒样本（外部注入指令 → 写入 → 召回） | 被标 suspicious、不进 verified、不影响门禁/权限决策（§9.2） |

### 10.2 SLO 与指标

| 指标 | 目标 |
|---|---|
| 开工简报生成 p95 | <500ms，≤2k tokens |
| recall p95 | <300ms；precision@5 ≥70%（抽样人工） |
| NCC 注入 | ≤400 tokens/步 |
| 记忆类注入占比 | ≤15% 上下文 |
| stale 注入率 | 0（硬红线） |
| 纠正传播时延 | ≤1 个回合 |
| 冷启动三问 | ≥90% |
| 压缩保真 | ≥90% |
| 会话零写入率 | 0（自动事件兜底后） |
| 工作项记忆覆盖率 | 100%（低于 90% 门禁黄、80% 阻断） |
| 人记忆维护时间 | ≤5 分钟/周期 |

### 10.3 埋点事件（用于调优，不进账本事实）

brief_issued / brief_used / recall_used / memory_corrected / checkpoint_written /
post_compaction_restored / drift_detected / stale_use / guard_degraded / handoff_validated /
injection_truncated / memory_degraded。

> 埋点只记录 id/大小/结果，不记录正文；可关闭。

---

## 11. 需要拍板的事（把缺口收敛为 11 个决定）

| # | 决定 | 推荐 | 关联缺口 |
|---|---|---|---|
| D1 | 权威存储与 canonical schema | 以记忆文档 §9.2 为唯一 schema，WB §12.4 标 superseded；两库分离 | C01/C02/C04/C11 |
| D2 | 记忆工具命名与注册 | 统一 project_*：brief / recall / remember / correct / checkpoint / handoff / memory_admin；写进工具清单 | C18 |
| D3 | 冷启动注入载体 | 首选动态 context；保底工具契约 + 项目 skill；teammate 用 prompt 注入 | C06/Q01 |
| D4 | 交接工件 | 工作项交接 + 会话摘要两件，校验器 + 收尾对账门 | C12/Q10/Q11 |
| D5 | 写权限 | 系统写事件、agent 只提案、QA 给验证结论、人授予 verified | C07/C08 |
| D6 | 写入率止损线 | 覆盖率 90% 黄 / 80% 阻断；三率进周报 | Q21 |
| D7 | 可见性矩阵 | 最小可见 + QA 隔离（§4.8） | Q16 |
| D8 | 纠错入口与传播 | 记忆中心为主入口、聊天为快捷方式；传播四件套 | C15/Q14/Q15 |
| D9 | 降级分级 | normal/search-off/read-only/blocked；门禁 fail-closed | C16/Q18 |
| D10 | 跨机恢复 | export bundle（库+事件+哈希+schema+清单），DB 不入 git | Q13 |
| D11 | 阶段×kind 白名单 | 由 process_profile 携带，G0 冻结 | Q19 |

---

## 12. 与 DSH 运行时机制的映射（源码结论）

> 依据：[research/dsh-runtime-memory-facts.zh.md](research/dsh-runtime-memory-facts.zh.md)（0.2.1-rc.2 checkout；
> 本机运行 0.2.2-rc.1，差异待复核）。结论：本设计需要的四个关键机制都存在，但「压缩前拦截」不存在，已按 §4.3 改写。

| 需求 | DSH 机制 | 用法 | 限制/风险 |
|---|---|---|---|
| 每步注入 NCC | `systemPrompt.section({name,order,text})`：每步 assemble 求值、不进 durable 历史；全局 `system-prompt/assemble` waterfall | 首选；NCC 放 section | 0.2.2 需复核 API |
| 开工/恢复简报 | `systemPrompt.context`：变化才追加为 user 消息；`refreshContext` 每次 admission 重算；自带去重与冷恢复 | 简报作为 context，按内容哈希去重 | 会进会话历史；需控制变化频率 |
| 会话中途刷新 | `system-prompt/change` 事件；runtime-context 快照变化即追加新 user 消息 | 项目 revision 变化时刷新 | 频繁变化造成消息堆积 → 节流 |
| 压缩观测 | `session/event` 的 `compaction/start|summary|end|prune`；`compaction/summary-error` waterfall；摘要 + compact-checkpoint user 消息 | 事中记录 + 恢复卡 | **无 before 钩子**；start 已落锁 |
| 水位感知 | `ctx.tokenMeter.measure(session)` | 每步水位 → 提前冻结 | base bundle 已挂载 |
| 写前闸门 | `tools/pre-execute` waterfall 返回 `{kind:'deny', reason}`（模型可读）；`post-execute` 可 block 并附 additionalContexts | 写前召回闸门 | 不覆盖 PTC 内部 dispatch；bash 写文件靠门禁审计兜底 |
| 注入即历史 | `systemPrompt.context` 落 durable user/message；`section` 落 system head，永不压缩 | 关键约束进 section；简报带 source/digest 可重建 | 简报会被当普通聊天压缩/检索/冷恢复 |
| 默认无会话全文检索 | base 的 `session-query-sqlite` 默认 `openAt:never, path:':memory:'`，桌面 profile 未覆盖 | 自建可重建索引（或显式配置 openAt） | 不能依赖默认 FTS；不裸解析 JSONL |
| 规则文件/技能 | AGENTS.md/CLAUDE.md 64KiB 预算、skill 摘要 digest、正文按需加载 | 程序性记忆的天然载体 | 预算有限，别塞长文 |
| 多 agent | spawn 仅 `prompt`；`fork` 快照父 turn 前缀；团队任务板 = Lead 会话日志 | 执行型 `fresh` + 简报 | 继承与隔离要显式选 |
| 版本混合 | checkout 0.2.1-rc.2 vs 运行 bundles 0.2.2-rc.1；会话格式 v4 | 插件能力探测（`ctx.get`）+ engines 声明 + 自检降级 | experimental API 慎用 |
| teammate 注入 | spawn 无注入字段；`systemPrompt.context` 作用域链对子会话生效；`agent/created` + `child.inject`；团队消息仅 content | scope context 优先 + prompt/注入兜底 | target→sessionId 映射待验证；冷恢复重建 |
| 定时蒸馏/周报 | schedule 包 | 每日/每周记忆整理任务 | 已有设计 |
| 人读与操作 | projection + Remote + actionCards | 驾驶舱/记忆中心/收工回执 | 已有设计 |
| 记忆工具 | `ctx.tools` 注册 | `project_*` | 需进 preset 工具白名单 |

**由此修正的三处设计**：

1. §4.3「压缩前 flush」→「提前冻结」（无 before 钩子）。
2. §4.1「prompt-context 自动注入」→ 落实到 `systemPrompt.section/context` + 工具契约保底。
3. §4.8 teammate 注入从「prompt 唯一」→「scope context + prompt + child.inject 三路径」；执行型默认 `fresh`，防 fork 继承父假设。
4. 会话检索不能假设 base 默认开启 FTS（默认 `openAt:never`）→ 自建可重建索引或显式配置。

**明确不能做的**：

- 不能在压缩发生前拦截并强制 flush；
- 不能向会话追加自定义事件类型（会导致会话无法重开）；
- 不能替换全局 compaction 服务（preset 内 isolate 组，插件级替换只影响挂载域）；
- 不能给已接受的请求改消息（model-visible 内容必须走 logged channels）；
- 不能新增会话事件类型，出仓插件只能写实验性 `plugin:` 记录；
- 不能用记忆代替权限/门禁（记忆是数据）。

---

## 13. 与现有文档的关系、裁决与实施

### 13.1 本文补什么、不重复什么

- **补**：使用时刻表（§4）、读写入口契约（§4.2 / §6.2）、会话边界协议（§4.3 / §4.5 / §4.6）、人的纠错与界面（§8）、降级（§9）、使用期验收（§10）。
- **不重复**：四层/七类记忆定义、全量 SQLite schema、双时态与冲突算法、propose→commit 六步、lumio 复盘与开源方案调研（引用即可）。
- **canonical 声明**：schema 以 [项目记忆系统设计](project-memory-design.zh.md) §9.2 为唯一版本；本文只列「使用期新增的最小字段」（§13.3）。

### 13.2 对缺口审计 C01–C18 的裁决

| 缺口 | 裁决 |
|---|---|
| C01 权威存储 | **以 SQLite 为准**；WB §2.6/§8.2/§12.4 的 storageDomain 权威表述标 superseded |
| C02 三份 schema | **以 MEM §9.2 为 canonical**；本文 §13.3 只补使用期字段；WB 两份 schema 删除或标历史 |
| C03 四层 vs 七类 | 四层 = 存储架构；七类 = kind 词表 + 人读分组；出一张 4×7 映射表（另文补，不阻塞本文） |
| C04 audit_log vs memory_events | **memory_events 为唯一事实源**；audit_log 降级为安全审计投影 |
| C05 会话日志能否重建 | **不能**；会话日志只作证据线索，重建 = 导出版本 + 事件 + artifacts + git |
| C06 自动注入 vs 工具拉取 | **工具契约为准**（project_brief）；若 DSH 提供动态 context 则优先使用（§12） |
| C07 写入者 | 系统写事件、agent 提案、PM 会话摘要、执行者工作项交接（四类，§5.1） |
| C08 verified 权限 | agent 只能 claimed；**verified 由服务校验 + QA/人授予**，写 verified_by |
| C09 决策载体 | 保留独立 decisions 表（状态机/irreversible/期限）；memory_items 只存摘要投影 |
| C10 文档锁 | 统一用 claims（实体级租约），扩展覆盖 docs；删除 doc_locks |
| C11 FTS 位置 | 两库分离：权威库不做 FTS；FTS 在检索库，可重建 |
| C12 交接双作者 | 两件工件：工作项交接（执行者）+ 会话摘要（PM/系统） |
| C13 批量 vs 即时 | 热路径仅限：安全/权限规则、不可丢失决策、用户明确要求；其余批量 |
| C14 任务板映射 | 项目层 WorkItem 为权威；teamTaskId 是可空投影；补 session_link 表 |
| C15 编辑入口 | 驾驶舱「文档」页下新增「记忆中心」子 tab（不新增顶级视图） |
| C16 失败语义 | 统一分级 fail-closed：权威库坏 → 只读 + 禁 verified + 门禁阻断；仅检索坏 → 降级 |
| C17 备份范围 | 只备权威库（+ 导出版本）；检索库不备份，但恢复演练必须含「重建 + 对照」 |
| C18 工具命名 | 统一 project_* 前缀；写进工具清单与 preset 白名单（§13.4） |

### 13.3 使用期新增的最小字段/表（delta to MEM §9.2）

```sql
-- 会话状态：跨压缩/重启恢复的最小状态
CREATE TABLE session_states (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- pm/executor/qa/teammate/human
  work_item_id TEXT,
  snapshot_revision INTEGER NOT NULL, -- 简报/召回时的账本 revision
  checkpoint_json TEXT,               -- 最近一次 checkpoint
  status TEXT NOT NULL,               -- active/idle/handed_off/recovered
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE session_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state_json TEXT NOT NULL,           -- 工作项/决策/文件hash/未决/下一步
  created_at TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

-- 代码锚定：记忆随代码漂移
CREATE TABLE anchors (
  memory_id TEXT NOT NULL,
  path TEXT,
  content_hash TEXT,
  commit_sha TEXT,
  verified_at TEXT,
  PRIMARY KEY (memory_id, path, commit_sha)
);

-- 简报/召回签发记录：漂移检测与成本会计
CREATE TABLE brief_issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- start/resume/core/task/review
  snapshot_revision INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 导出清单：跨机恢复校验
CREATE TABLE export_manifests (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  project_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  counts_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

> `memory_usage` 表沿用 MEM §12.7.8，不重复定义。

### 13.4 工具与服务清单（草案）

| 名称 | 谁用 | 用途 | 备注 |
|---|---|---|---|
| `project_brief` | 所有 agent | 开工/恢复/核心/任务级简报 | 只读、幂等、记录 `brief_issues` |
| `project_recall` | 所有 agent | 实体/关键词召回 | 带 budget、status、asOf；返回出处 |
| `project_remember` | 所有 agent | 提交提案（claimed） | 幂等键、source_ref 必填 |
| `project_correct` | 人（UI）/QA/PM | 更正/替代/验证/钉住/遗忘 | 权限分级；传播四件套 |
| `project_checkpoint` | 会话 agent/系统 | 写检查点 | 幂等；压缩前强制 |
| `project_handoff` | 执行者/PM | 生成交接/会话摘要 | 服务生成确定性字段；校验器 |
| `project_memory_admin` | PM/人 | 健康、搜索、导出、重建、遗忘复核 | 导出/重建仅 Host 或人 |

Host 服务方法：`buildBrief / recall / propose / correct / checkpoint / handoff / gateSnapshot /
memoryHealth / exportBundle / rebuildSearchIndex / replayOutbox / attachAnchor / registerPromptContexts`
（后者把 NCC 与简报注册为 `systemPrompt.section/context` 提供者，注册失败自动降级到工具契约）。
Remote（驾驶舱）：记忆中心查询、纠正、遗忘、收工回执确认、健康面板。

### 13.5 实施顺序（研究→可用）

1. **P0（先跑通）**：自动事件捕获 + 开工简报 + 交接校验器 + 收尾对账（记忆三判据）→ 冷启动与收工可用。
2. **P1**：NCC 每步注入 + 写前召回闸门 + `project_recall` + checkpoint/恢复卡 → 压缩与长任务可用。
3. **P2**：记忆中心（纠正/遗忘/健康）+ 代码锚定 stale + 导出包 + 使用记录 → 人可治理。
4. **P3**：后台蒸馏 + 跨项目 lessons + 向量召回 + 多机共享 → 规模化。

### 13.6 本设计的主要风险

| 风险 | 缓解 |
|---|---|
| DSH 没有压缩前钩子（已确认） | 改为提前冻结（水位/周期/大动作）+ `compaction/summary` 事件触发恢复（§4.3） |
| teammate 无注入字段 | PM 用 `project_brief` 生成任务文本放入 spawn prompt（§4.8） |
| 工具守卫覆盖不到 bash 写文件 | 门禁审计兜底；记忆召回仅作「拒绝提示 + 重试」；不宣称绝对拦截 |
| 记忆写入门太严导致没人用 | 自动事件兜底 + 覆盖率按工作项算；只卡「完成/门禁」，不卡日常笔记 |
| 人的注意力被记忆管理占用 | §8.1 的时间预算 + 默认零维护 + 每周期 ≤5 次交互 |
| 过度记忆（什么都记） | 每工作项 ≤20 条 + 蒸馏预算 + 冷项目降级 + 定期合并建议 |
| 记忆投毒/提示注入 | 记忆视为数据而非指令；写入扫描；verified 需来源；项目级新约束人确认（§9.2）；U25 回归 |
| 版本混合（checkout 0.2.1-rc.2 / 运行 bundles 0.2.2-rc.1 / 会话格式 v4） | 能力探测（`ctx.get`）+ `engines.dsh` 声明 + 启动自检：section/context 注册失败则降级工具契约 |
| 注入即历史（简报变聊天） | 简报带 source/版本/digest 且可从账本重建；关键约束进 system head（§4.1/§12） |
| 单机 SQLite 成为单点 | 每日备份 + 导出版本 + outbox + 分级降级；多机共享留 P3 |

---

## 附录 A：模板与 schema

### A.1 工作项交接单 `handoff.yaml`

```yaml
# 自动生成字段（服务从事件流生成，agent 不可改）
handoff_id: HO-2026-11-11-WI-014-01
work_item: WI-014
stage: S5
session_id: sess_...
generated_at: 2026-11-11T18:00:00+08:00
status: validated            # validated / rejected / recovered
evidence:
  - id: EV-0031
    uri: artifacts/test-2026-11-11.log
    hash: sha256:...
    verified: true
changes:
  - path: src/auth/session.ts
    hash: sha256:...
open_disputes: []
leases_released: true

# 以下 narrative 由执行者补充，服务校验存在性
done: "实现了 token 轮换，覆盖 3 个用例"
decisions: ["沿用 ADR-0003 的 JWT 方案"]
blocked: []
risks: ["未覆盖并发刷新场景"]
next: "补并发用例；请 QA 验收 M-0042 相关约束"
```

校验器规则：`done/next` 必填；`evidence` 至少 1 条且可解析；`changes` 与工作项写作用域一致；
`open_disputes` 为空或已挂决策；`leases_released` 为 true。失败 → 工作项不能完成、门禁不能提交。

### A.2 会话摘要 `session-digest.md`（PM/系统）

```md
# 会话摘要 · <session> · <时间>
## 做了什么（≤10 条，带事件 id）
## 新增/替代记忆（id + 状态）
## 未完成（工作项/提案/租约）
## 下次从哪开始
## 记忆健康变化（stale/争议/覆盖率）
```

### A.3 恢复卡（见 §4.3）

字段与开工简报一致，但只含：工作项 / 已决定 / 已改 / 未决 / 下一步 / 项目 delta / 自检三问。

---

## 附录 B：使用期指标口径

| 指标 | 分子 | 分母 | 采样 |
|---|---|---|---|
| 冷启动三问 | 答对的会话数 | 被测会话数 | 测试集 + 每周抽 3 个真实会话 |
| 压缩保真 | 与基线一致的下一步数 | 压缩事件数 | 每次压缩 |
| stale 注入率 | 注入的 stale/superseded 条数 | 注入总条数 | 每会话 |
| 纠正传播时延 | 纠正事件到受影响会话感知的回合数 | 纠正事件数 | 全部 |
| 工作项覆盖率 | 有决策+证据记忆的完成工作项 | 完成工作项 | 每周期 |
| 人的维护时间 | 记忆中心/纠错耗时 | 每周期 | 自报 + 埋点 |
| recall precision@5 | 被引用/确认有用的前 5 条 | 前 5 条 | 抽样人工 |

---

## 附录 C：参考

- 记忆架构：[project-memory-design.zh.md](project-memory-design.zh.md)
- 工作台主设计：[project-workbench-design.zh.md](project-workbench-design.zh.md)
- 缺口审计：[research/memory-in-use-gap-audit.zh.md](research/memory-in-use-gap-audit.zh.md)
- DSH 运行时事实：[research/dsh-runtime-memory-facts.zh.md](research/dsh-runtime-memory-facts.zh.md)
- 外部交互模式：[research/memory-in-use-external-patterns.zh.md](research/memory-in-use-external-patterns.zh.md)
- lumio Git/CI 复盘：[lumio-git-ci-postmortem.zh.md](lumio-git-ci-postmortem.zh.md)
