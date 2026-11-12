# Anthropic《The components of agent memory》机制解析

> 来源：[The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)（Anthropic Engineering，2026-11-06）。正文依据本地抓取全文 `docs/research/sources/anthropic-components-of-agent-memory.txt`（约 2.5 万字符）；2026-11-11 官方页面可访问，小节锚点与官方文档链接已补全（见 §8）。
> 用途：为工作台「分层 + 分片」记忆方案提供机制依据；只写调研结论，不写完整设计。
> 标注：**〔原文〕** = 文章直接表述（附小节/图号）；**〔推断〕** = 我方基于原文的分析；「图 N」为文章图表编号。
> 局限：图未逐张核图，只依据正文与图注；文章日期为 2026-11-06，产品细节以其官方文档为准。

---

## 0. 六条结论（TL;DR）

1. **记忆 = 跨会话保留、之后可读回的「经验知识」**；文章明确把 weights、in-context learning、compaction 排除在外〔原文·Memory notes〕。
2. **写下规则/已验证事实，本质是对未来的预测**：写下规则 = 赌它以后会复用；「值得记」的判据是「不写就会消失、未来会用到」，不是「发生过」〔原文〕。
3. **salience 应由模型判断**：只告诉它记忆是干什么的，不要预设「记什么」；死规则（如「只记失败」）反而削弱强模型的记忆增益〔原文・Steering〕。
4. **结构比容量重要**：顶层 dashboard 只放目标/计划/记忆使用规则 + 链接；下层按需读/搜；Claude Code 顶层只注入 `MEMORY.md` 前 200 行或 25 KB〔原文〕。
5. **dreaming = 后台巩固**：纠错、建 wiki、提升/下沉、按目标塑形、跨会话补缺；代价是算力，且产出有延迟〔原文〕。
6. **多 agent 写记忆必须分片 + 单写者**：共享表格被并发覆盖只剩 41/57 条事实；改「一份合同一页、一人写、逐字引用」后 57/57〔原文・图 14〕。

---

## 1. 定义与边界：什么算 agent memory

**定义〔原文・Memory notes〕**：agent memory 指 Claude 从经验中获得（与用户交互、被指派的任务）、**跨会话保留**、并以「之后可读的 context」形式存下来的知识。

| 概念 | 文章定义 | 与 memory 的边界 |
|---|---|---|
| weights | 训练时设定的内部参数 | 不是记忆：改权重属于训练，不是运行时经验留存 |
| in-context learning | 单次对话内获得的知识 | 不跨会话，会话结束即消失 |
| compaction | Claude 写摘要替换旧轮次，以便在新上下文窗口继续工作 | 是「腾地方」的上下文管理，不是留给未来会话的知识库 |
| agent memory | 经验 → 跨会话可读的 context（memory notes、目录、wiki 等） | 三条判据：**跨会话** + **从经验获得** + **可读回** |

- **“Memory is, occasionally, a prediction.”〔原文・Memory can be a prediction about what the future will need〕** 写下一条规则，就是预测「这个模式以后还会相关」；写下已验证事实，就是预测「未来会话会直接依赖它、不再复核」。文章也承认边界：**没有模型能真正知道未来几轮会发生什么**（末节）。
- 开篇用 Kierkegaard「生活只能向后理解，却必须向前过」+ 海马体/睡眠巩固类比：**在线捕获（hippocampus）与离线巩固（neocortex）分工**，dreaming 对应后者〔原文〕。
- 〔推断〕对工作台的含义：记忆不是「聊天记录 / 状态快照」，而是**为未来任务预写的判断**；未来可重新读到、可查询、可计算出来的信息，不应占记忆位。

---

## 2. salience 与写入：记什么、谁来判

- **双通道写入〔原文・Memory notes〕**：会话中给 salient 事件打 tag（方便以后找），或直接写进 memory store（如 notes 文件夹）。难点是「在还不知道后面会发生什么时，判断此刻是否 salient」。
- **CL-Bench 1.0 学习闭环〔原文・图 3〕**：每题新开会话、只共享 memory 目录；答错后被告知正确答案，可写记忆帮助后续题。模型演进：

| 模型 | 记忆形态 | 闭环情况（据“首个闭环”推断） |
|---|---|---|
| Sonnet 4.6 | 散落文件，每条列若干未验证猜测 | 未闭环 |
| Opus 4.7 | 合并成单一参考文档，标记 checked / unconfirmed | 部分闭环 |
| Sonnet 5 | 标注已被 grader 确认的答案，答错写 correction | 部分闭环 |
| Opus 5 | 规则 + 「我怎么知道它为真」+ 往题答案 + 陷阱警告 | **首个闭环** |
| Opus 5.5 / Sonnet 5.5 | 同样闭环；有记忆时与 Opus 5 大致相当（无记忆基线略高） | 闭环 |

- **Pokémon 对照〔原文・Claude has learned to judge salience，图 4〕**：同游戏、约 10,000 步、各自一个可读写记忆文件夹：

| 维度 | Sonnet 3.7 | Fable 5 |
|---|---|---|
| 记忆规模 | **413 个文件 / 225 个文件夹** | **9 个文件 / 2 个文件夹 + 1 个 `global.md`** |
| 记录内容 | 遭遇档案：每场战斗、每件道具、每个 NPC 一个文件 | 策略、计划、验证过的规则 |
| 结果 | 1 枚徽章；约第 10,000 步起整理第 4 个 master 文件夹，之后 17 步内建 6 文件、删 9 文件、**游戏内零动作** | **4 枚徽章** |
| 根因 | 游戏状态每回合都变，详细记录持续过期；查记忆挤占游戏时间 | 只记「屏幕读不到」的东西 |

- **冗余判据〔原文〕**：金钱、地图位置等每回合可以从屏幕读出，存下来是冗余；**策略、计划、验证过的规则**「只有 Claude 想出来才存在，不写就消失」。例：连续 7 个球抓 Magikarp 失败后，它写下「3+ 球连续失败就改变时机（菜单步骤间插入 wait）」。
- **对照说明〔推断〕**：CL-Bench 的「检查/闭环」与 Pokémon 的「413 vs 9 files」指向同一结论——**记忆价值由「记什么」和「之后怎么用」决定，不由记录量决定**；写入策略差异直接对应分数/徽章差距。
- **steering〔原文・Steering Claude to write memory，图 5〕**：「告诉它记忆是干什么的」有用，「告诉它怎么用/记什么」未必。CL-Bench 只告知「有 memory 目录」就足以让 Opus 4.7 / Opus 5 显著提升；**「只记失败」规则让 Opus 5 / Opus 4.7 的增益大幅缩水**；强模型自由判断 salience 优于预先固定规则，固定规则可能反噬。老模型更需要 steering：提示「先读记忆再答 + 显式检验理论」让 Sonnet 4.6 分数近乎翻倍；Sonnet 5 无需提示，10 次有 9 次先读记忆，Sonnet 4.6 不到一半。

---

## 3. 大小与结构：dashboard + 分片 + 层次

- **Fable 5 的三层结构〔原文・图 4〕**：

| 位置 | 内容 | 作用 |
|---|---|---|
| `global.md`（顶层） | 当前目标 + 预写的道馆计划 + **自己使用记忆的规则** | dashboard：每回合/每会话都该看到 |
| `locations/` | 特定路线的导航计划 | 按「问题对象」分片，用到才读 |
| `gameplay/` | 从游戏机制中学到的策略/规则 | 可复用知识，按主题分片 |

- **memory hierarchy〔原文・Dreaming can promote notes up the memory hierarchy，图 13〕**：dreaming 把笔记提升到顶层，harness 在每次会话开始时**预注入**（context injection）；下层「需要时才读/搜」。好处是 Claude 不必搜、甚至不必知道有东西可搜。
- **顶层必须小**，三个理由〔原文〕：① 注入记忆消耗宝贵 token；② 一条错误笔记会被带进**每一个**会话；③ 加载 ≠ 遵循——Claude Code 文档警告「**更长的指令文件会降低遵循度**」。
- 因此 dreaming 很大一部分工作不是「加」，而是**把细节下移、只留链接**，让顶层保持小〔原文〕。
- **Claude Code auto memory 硬机制〔原文〕**：不把 auto memory 全量注入，只加载 `MEMORY.md` 的**前 200 行或 25 KB**；这个 header 充当**索引**——告诉 Claude「它知道什么、去哪里找」。
- 〔推断〕「大小」不是单一容量阈值，而是**注入预算**：顶层 = 索引 + 当前目标；单分片 = 一次能整篇读完的主题页；证据/原文放可搜索层。

---

## 4. dreaming：离线巩固的五个动作与效果边界

- 定位〔原文・开篇 / 图 1〕：借鉴 Letta & UC Berkeley 的 sleep-time compute，用空闲算力反思日志，**纠错、产生新笔记/新表示、塑形预加载**。

| dreaming 动作 | 原文证据 | 机制/效果 |
|---|---|---|
| 纠错 | Pokémon Mt. Moon（图 6–8） | 用**会话 transcript 作 ground truth** 校验笔记；改对 PokéCenter 方位后重进山洞、抵达 Cerulean City；未纠错运行 3 次掉回原路、写下「我不再循环了」，最终从未抵达；**无记忆运行同样过不了山** |
| 建表示（wiki） | Stainless 语料（图 9–10） | wiki = 一主题一页 + 互链，链接就是「地图」。约 35 万文件 / 4.2 亿 token、25 题；128 个 dreaming 会话，**2 → 128 会话把得分从 13% 提到 48%** |
| 提升到顶层 | 图 13 | 把稳定、重要笔记提升为「每会话注入」；同时负责把细节下移，保持顶层小 |
| 按目标塑形 | 合同 LAB 任务（图 14） | 指令不同 → 长出的记忆不同；「反思失败 → 改指令 → 重建 wiki」的循环发现**合同条款最重要** |
| 跨会话补缺 | 图 15 | 单会话笔记只看得到当次上下文；dreaming 跨会话找共性错误、补断链：一次把 9 个指向缺失页的链接改指已有页，另加 3 页（含索引） |

- **wiki + search 的效果〔原文・图 10–12〕**：

| 组合 | 结果 |
|---|---|
| 只有 search | 53% |
| search + wiki（随 wiki 增长） | 54% → **61%**，每题约省 **20,000 token** |
| 只有 wiki | 最好 48% |
| Harvey LAB 跨文档题（24 题中超半数需跨文件） | wiki **87%** vs search 73% |
| 单文档即可作答的 LAB 题 | wiki 无清晰增益 |
| 反例：某 LAB 任务 wiki **比原始文档还大** | 博尔赫斯《论精确的科学》地图与帝国等大——「实际上没有抽象任何东西」 |

- **边界〔原文・Thinking backward, looking forward〕**：dreaming 需要算力，「持续检查所有记忆」不现实；更合理的是**聚焦易变信息**或**按访问频率调节 cadence**；表示（wiki）也要持续维护，否则会积累错误/幻觉；**transcript search 可以作为记忆的地基**。
- **时机权衡〔原文〕**：会话内写记忆「捕获 salience 在源头、立刻可用」，但**分散主任务注意力**；dreaming 放后台，但**产出不能立刻用于当前任务**。

---

## 5. 多 agent 与并发：单写者分片是硬约束

- **合同 wiki 案例〔原文・Dreaming can focus memory on a specific goal，图 14〕**：LAB 收购合同任务，wiki 是评分依据。第一版让**多个 agent 同时写同一张合同条款共享表**：

| 版本 | 写法 | 评分事实 | 结果 |
|---|---|---|---|
| 改前 | 多 agent 写同一共享表 | **41 / 57（72%）** | 共享表把条款总结得很差、部分缺失；**agent 互相覆盖** |
| 改后 | **一份合同一个页面、一个 agent 写、逐字引用条款**（不汇总进共享表） | **57 / 57（100%）** | 全部评分标准可满足 |

- 关键不是「多写点」，而是**消除并发写同一位置的冲突**：单写者 + 一对象一页 + 逐字引用（保真）三件事一起做，才从 72% 到 100%〔原文〕。
- 「单写者」不等于让 agent 各写各的：改前失败恰因**共享产物没有 owner**；改后仍要**在指令里说明什么最重要**（第一版没说合同条款重要）〔原文〕。
- **128 个 dreaming 会话的协调〔原文・图 10〕**：每个会话建立在**前面会话的进度**上，用**共享日志**协调（探索文件、写/改链接页、合并重复、核对来源）。2 → 128 会话带来 13% → 48% 的扩展收益，说明「分片 + 共享日志 + 增量推进」可以并行扩，而不是多个 agent 抢同一份记忆。
- 〔推断〕对工作台：**分片单位 = 可写对象**（一个模块/一份合同/一个决策域），不是「一个 agent 一个大文件夹」；跨片共享只读或走提案；合并/去重交给 dreaming 或分片 owner。

---

## 6. 失败模式与风险（按文章证据整理）

| 失败模式 | 文章证据 | 机制 | 缓解 |
|---|---|---|---|
| 过度记忆 | 413 files / 225 folders；17 步内建 6 删 9、零游戏动作 | 记录变成维护负担，挤占主任务 | 只记不可从环境重读的东西〔原文〕 |
| 陈旧/漂移 | 游戏状态不断变；笔记随环境变化而过时 | 记忆是过去写下的预测，未来可能已不成立 | dreaming 对 transcript 纠错；聚焦易变项、调 cadence〔原文〕 |
| 共享页并发覆盖 | 41/57 条款存活 | 多 agent 写同一页，后写覆盖先写 | 一对象一页 + 单写者〔原文〕 |
| 注入的错误被误信 | 「错误笔记会被带进每个会话」；PokéCenter 方位错误 | 顶层注入 + 后续会话天然信任 | 顶层只放已验证内容；保留来源与验证状态〔原文/推断〕 |
| 长指令降低遵循度 | Claude Code 文档警告更长指令文件降低 adherence | 上下文有限、注意力被稀释 | 顶层小、细节下移、留链接〔原文〕 |
| dreaming 算力成本 | 128 sessions；「需要 compute」；持续全量检查不现实 | 后台巩固不是免费 | 按易变/访问频率调度；抽样校验〔原文〕 |
| 固定写入规则反噬 | 「只记失败」削弱 Opus 5 / Opus 4.7 增益 | 规则替代了模型的 salience 判断 | 给目的、留判断权〔原文〕 |
| 笔记不读/不用 | Sonnet 4.6 常不读记忆；Sonnet 5 9/10 会读 | 写 ≠ 用，老模型需要 steering | 提示「先读再答」；把读记忆放进流程〔原文/推断〕 |

---

## 7. 对工作台的 10 条可执行启示（调研结论）

| # | 主题 | 结论（研究层面） | 依据 |
|---|---|---|---|
| 1 | 怎么分片 | 按**可写对象/决策域**切，不按会话、时间或 agent 切；片内自包含，片间用链接 | Fable 5 的 locations/gameplay；合同一页一合同〔原文〕 |
| 2 | 每片多大 | 单片 = 一次能整篇读完的主题页；顶层 = 索引 + 当前目标，量级参考 200 行 / 25 KB，超出即拆或下沉 | Claude Code auto memory；长指令降低遵循度〔原文〕 |
| 3 | 什么放顶层 | 放当前目标/阶段、下一步计划、跨片使用规则、路由索引；**不放**细节、流水、易变状态 | `global.md` 是 dashboard；顶层错误会被注入所有会话〔原文〕 |
| 4 | 谁写 | 一片一写者（owner agent）；其他 agent 只读或提提案；跨片合并在 dreaming/owner 轮次执行 | 合同 72%→100%；共享表覆盖；128 会话靠共享日志协调〔原文〕 |
| 5 | 谁读 | 顶层全员注入；下层按需读：owner 全读，相关角色经索引读；禁止「全量读所有片」 | memory hierarchy 图 13；Sonnet 4.6 不读需提示〔原文〕 |
| 6 | 写什么 | 只写不可推导的判断/规则/计划/坑/决策理由；进度、CI、文件位置等状态走查询 | Pokémon 冗余判据；413 vs 9 files〔原文〕 |
| 7 | 条目元数据 | 至少带：来源引用（transcript/session/file）、验证状态、易变性、owner、最后使用时间 | Opus 4.7 标 checked/unconfirmed；Opus 5 带「怎么知道为真」〔原文〕 |
| 8 | 怎么合并/提升 | dreaming 定期去重、合并、补链、提升/下沉；提升标准建议：多会话复用 + 已验证 + 稳定 | 五类 dreaming 动作；2→128 会话〔原文〕；标准值〔推断〕 |
| 9 | 怎么检索 | wiki 只做导航，原文保留可搜索；单文档能答的问题不建 wiki；wiki 规模超过语料即失败信号 | wiki+search 61% vs 仅 wiki 48%；wiki 比语料还大〔原文〕 |
| 10 | 并发与成本 | 每个会话写自己负责的片，用共享日志登记「在写哪片」；dreaming 只跑高价值/易变片，按访问频率调 cadence | 128 sessions shared log；「持续全量检查不现实」〔原文〕 |

> 说明：上表是**调研结论 + 可参考量级**，不是最终设计；具体 schema、注入协议、权限模型需在「分层分片」方案定稿时另行设计。〔推断〕

---

## 8. 引用清单（文章内部小节/图表 + 官方链接）

**文章小节（官方锚点）**

| 小节 | 锚点 | 关键图 |
|---|---|---|
| Memory notes | [#memory-notes](https://www.anthropic.com/research/components-of-agent-memory#memory-notes) | 图 1–2 |
| Memory can be a prediction about what the future will need | [#memory-can-be-a-prediction-about-what-the-future-will-need](https://www.anthropic.com/research/components-of-agent-memory#memory-can-be-a-prediction-about-what-the-future-will-need) | 图 3 |
| Claude has learned to judge salience | [#claude-has-learned-to-judge-salience](https://www.anthropic.com/research/components-of-agent-memory#claude-has-learned-to-judge-salience) | 图 4 |
| Steering Claude to write memory | [#steering-claude-to-write-memory](https://www.anthropic.com/research/components-of-agent-memory#steering-claude-to-write-memory) | 图 5 |
| Dreaming can correct memory | [#dreaming-can-correct-memory](https://www.anthropic.com/research/components-of-agent-memory#dreaming-can-correct-memory) | 图 6–8 |
| Dreaming can build new memory representations | [#dreaming-can-build-new-memory-representations](https://www.anthropic.com/research/components-of-agent-memory#dreaming-can-build-new-memory-representations) | 图 9–12 |
| Dreaming can promote notes up the memory hierarchy | [#dreaming-can-promote-notes-up-the-memory-hierarchy](https://www.anthropic.com/research/components-of-agent-memory#dreaming-can-promote-notes-up-the-memory-hierarchy) | 图 13 |
| Dreaming can focus memory on a specific goal | [#dreaming-can-focus-memory-on-a-specific-goal](https://www.anthropic.com/research/components-of-agent-memory#dreaming-can-focus-memory-on-a-specific-goal) | 图 14 |
| Dreaming can fill in gaps a session leaves behind | [#dreaming-can-fill-in-gaps-a-session-leaves-behind](https://www.anthropic.com/research/components-of-agent-memory#dreaming-can-fill-in-gaps-a-session-leaves-behind) | 图 15 |
| Thinking backward, looking forward | [#thinking-backward-looking-forward](https://www.anthropic.com/research/components-of-agent-memory#thinking-backward-looking-forward) | — |

**图表索引（正文引用）**：图 1 dreaming 总览；图 2 memory notes；图 3 CL-Bench 数据库任务；图 4 Pokémon 记忆目录（413 vs 9）；图 5 steering 与「只记失败」；图 6–8 纠错与 Mt. Moon 结果；图 9 表示构建；图 10 2→128 会话与 wiki 规模；图 11 LAB 跨文档 vs 单文档；图 12 wiki 大于原始文件；图 13 记忆层次与注入；图 14 合同事实 41/57 vs 57/57；图 15 第二轮 dreaming 补缺。

**官方链接（文章内链，2026-11-11 抽查可访问）**

| 链接 | 用途 |
|---|---|
| [文章原文](https://www.anthropic.com/research/components-of-agent-memory) | 全文与图 |
| [Claude Code memory](https://code.claude.com/docs/en/memory) | auto memory、`MEMORY.md` 200 行/25 KB、长指令降低遵循度 |
| [Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory) | memory directory（跨会话记忆目录） |
| [Managed Agents dreams](https://platform.claude.com/docs/en/managed-agents/dreams) | dreaming 的官方说明 |
| [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool) | memory 工具的官方文档 |
| [Dreaming cookbook](https://platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow) | 动手示例 |
| [Knowledge wiki 示例](https://github.com/anthropics/claude-quickstarts/tree/main/managed-agents/knowledge-wiki) | wiki + 搜索的参考实现 |

---

## 9. 未获取与待核

- 未获取：图 1–15 的图像内容（仅有正文与图注）；文章未给出各实验的完整统计置信区间。
- 待核：CL-Bench 1.0、Harvey LAB 的官方基准定义与评分细则（文章只引用结论，未展开方法）；Claude Code 的 200 行/25 KB 阈值是否随版本变化，需以官方文档为准。
