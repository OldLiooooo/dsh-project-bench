# 外部产品「使用时的记忆」交互与治理调研

> 调研范围：ChatGPT Memory、Claude（含 Projects/Claude Code）、Cursor、GitHub Copilot、Windsurf/Devin、OpenAI Codex、Google Jules、Notion、Manus、Letta、Mem0，以及记忆投毒/隐私感知相关研究。
> 信息基准日期：2026-11-11（以下引用均为当日公开可查页面；产品滚动更新，请以链接原文为准）。
> 标注约定：**[公开资料]** = 官方文档、发布说明或论文原文直接支持；**[推断]** = 本文基于公开材料的分析，未获官方确认。
> 边界：只谈「使用时」的捕获、可见、纠正、遗忘、作用域、信任与控制；不讨论底层存储架构（另见 DSH 源码审计与缺口审计两文）。
> 引用：正文用 [S1]… 标注，均可点开；文末「来源」同时列出完整 URL 与用途。

---

## 0. 六条结论（TL;DR）

1. **领先产品已从「静默自动记忆」转向「混合捕获 + 可见可改可关」**：ChatGPT 把记忆拆成 saved memories / reference chat history / memory summary 三套控制；Claude 把记忆做成可编辑的 memory summary 与逐项目记忆；Devin 用「Updated memory」卡片回执。[公开资料] [S1][S3][S14]
2. **共识是把记忆当「可变假设」而非事实**：Copilot 要求使用前核对引用、按验证结果升降权、28 天不用即过期；ChatGPT 明确记忆「会随上下文变化」。[公开资料] [S11][S13][S1]
3. **作用域分层是治理主轴**：个人偏好与项目/仓库事实必须分开（可见性、引用方式、删除权限都不同），跨团队只走「已审核产物」。[公开资料] [S11][S13][S3]
4. **「纠正」比「删除」更常被设计成主路径，而删除必须处理传播与延迟**：ChatGPT 区分「编辑/别再提/删除」，删除需清多个副本且可能有 30 天日志；Copilot「让它忘」只是降权，不等于删除。[公开资料] [S1][S10][S11]
5. **后台整理（dreaming/consolidation）正在成为标配，但共享产物只提议不直写**：GitHub 对记忆自动增删改、对入库指令走 PR；Devin/Letta 用后台会话合并去重。[公开资料] [S9][S12][S14][S17]
6. **记忆是新的攻击面**：持久化记忆可被网页注入变成跨会话间谍（SpAIware），所有被测记忆架构都可被投毒（MemoryDojo）；缓解主要靠作用域、来源校验与默认不记敏感项。[公开资料] [S22][S23][S24]

---

## 1. 样本一览（机制与可见面）

| 产品 | 记忆单元 | 写入方式 | 用户在哪看见 | 来源 |
|---|---|---|---|---|
| ChatGPT | saved memory / 改进记忆（连续摘要）/ chat history 派生 | 自动 + 显式「记住」 | Settings→Personalization→Memory；回答下方 Sources；memory summary | [S1] |
| Claude App | 逐主题记忆、项目记忆 | 对话中自动保存 + 显式「remember this」 | Memory 设置里的 memory summary；敏感主题保存时提示 | [S3][S4] |
| Claude Code | CLAUDE.md（人写）+ auto memory（Claude 写） | 人写 / Claude 自动记四类笔记 | `/memory`、`/context all` 的 Memory files | [S6] |
| OpenAI Codex | 本机 memory 文件（生成态） | 空闲后后台生成，默认关 | `/memories` 开关；memory 目录（仅供排查） | [S7] |
| GitHub Copilot | 仓库事实 + 用户偏好 | 会话自主生成、后台 dreaming 整理 | Copilot 设置页列表（按有用性排序）；仓库设置 | [S9][S11][S13] |
| Devin | memory drive（Markdown 笔记，git） | 工作中自动学、dreaming 整理 | Customize→Memory；会话内 Updated memory 卡片 | [S14] |
| Jules | 仓库级记忆 | 任务中保存偏好/纠正 | 仓库设置→Knowledge 开关 | [S15] |
| Notion Agent | 用户私有 Memories | 聊天中生成，MCP 工具可读写 | Settings→Notion AI→Memory 的 Memories 数据库 + About 摘要 | [S16] |
| Letta | MemFS（git 文件系统） | 自动学 + `/remember` | `/memory`、`$MEMORY_DIR`、`/doctor` 审计 | [S17] |
| Mem0 | 平台记忆条目（含 metadata） | API/平台侧 add/update/delete；文档提供 decay/dream 入口 | Dashboard 过滤/检索/校验 | [S18] |
| Cursor | 未见自动记忆；Rules/AGENTS.md 为显式上下文（Memories 移除说法见二手复盘） | 人写（或让 agent 写规则） | `.cursor/rules`、User/Team Rules、AGENTS.md | [S19][S20] |
| Windsurf/Devin Local | 未见独立自动记忆；原 Memories 文档链接现落到 rules 体系 [推断] | 人写 Rules/AGENTS.md | Customize 页的 Rules 等标签 | [S21] |
| Manus | 项目级 Instructions/Files/Connectors/Skills | 人配置 | 每个 Project 的工作区 | [S29] |

[推断] 这 13 个样本可排成一条「自动化程度」光谱：Cursor/Manus 几乎全人工 → Copilot/Devin 自动写但后台整理 → ChatGPT/Claude 自动写且自动改。越靠自动端，产品越依赖「可见面 + 作用域 + 过期」三件套，而不是靠用户记得去管理。

---

## 2. Q1 捕获时刻：什么时候写、谁决定、用户感知吗

### 2.1 五种捕获触发（都有产品证据）

- **显式指令**：用户说「记住…」时直接落一条。ChatGPT saved memories、Claude「remember this」、Codex/Letta 的 `/remember`、Copilot 的「Remember to…」都是这条路径。[公开资料] [S1][S4][S7][S17][S9]
- **对话中的纠正/偏好（自动）**：Claude「保存为一条条独立主题，而不是聊完再总结」，Devin「你纠正、解释偏好或它自己摸出一条可复用经验时就改笔记」，Jules「任务中保存偏好、提示和纠正」。[公开资料] [S3][S4][S14][S15]
- **任务/会话边界后后台抽取**：Codex 等聊天空闲足够久才在后台生成记忆，避免总结进行中的工作；额度不足还会跳过。[公开资料] [S7]
- **后台整理生成（dreaming）**：Devin 约每天一次审阅近期会话并合并/清理/补漏；Copilot Dreaming 处理个人、仓库、代码评审三类；Letta 按步数或上下文压缩触发。[公开资料] [S14][S12][S17]
- **外部输入派生**：ChatGPT 可从连接应用（如 Gmail）、Library/Space 文件取上下文；Codex 桌面端「Computer History」把允许的应用/网页活动变成记忆和时间线；Notion 记忆还能被 MCP 工具写入。[公开资料] [S1][S7][S16]

### 2.2 自动/手动/混合谱系

| 产品 | 默认 | 主要触发 | 捕获可感知度 | 用户能否阻止 |
|---|---|---|---|---|
| ChatGPT | 开（因套餐/地区而异） | 自动 + 显式；改进记忆持续更新 | 中：事后 Sources/summary，非逐条回执 | 全局关、项目限定、临时聊天不个性化 |
| Claude | 开（2026-10-31 后新建组织默认开） | 对话中自动 + 显式 | 中高：敏感主题保存时提示 | 暂停/重置、单聊关闭、incognito |
| Claude Code | 本机默认开 | Claude 自判是否值得记 | 低：[推断] 无逐条提示，需 `/memory` 查 | `/memory` 开关、项目级关闭、环境变量 |
| Codex | **默认关** | 空闲后台生成 | 低：[推断] 无逐条提示 | `/memories` 单聊开关、设置关闭、删除本机库 |
| Copilot | 开（付费计划） | 会话自主生成 + dreaming | 中：权限提示说明作用域；无逐条卡片 | 设置/仓库开关、`/memory on/off` |
| Devin | 开（管理员可关） | 自动 + dreaming | 高：会话内「Updated memory」卡片 | 个人关、组织/企业策略 |
| Notion | 开（工作区可关；自定义 agent 默认关） | 聊天中生成 | 中低：[推断] 主要靠事后看数据库 | 工作区开关、个人开关、单 agent 开关 |

ChatGPT 在 2024-02 上线记忆时即以「You're in control」为定位 [S2]；[推断] 后来的 summary、Sources 与分层控制，是把这句承诺具体化——也说明「可控」必须落到界面动作，而不只是产品口号。

### 2.3 可借鉴的「捕获即确认」接口

- **写入回执卡**：Devin 在会话内显示「Updated memory」卡片，列出改了什么；新记忆只对**后续**会话生效，不污染当前会话。[公开资料] [S14]
- **捕获时声明作用域**：Copilot 的 store_memory 权限提示明确写「这是用户级偏好（仅你可见、跨仓库生效）还是仓库级事实（所有贡献者可见）」——把作用域决策放在写入那一刻。[公开资料] [S10]
- **敏感内容单独确认**：Claude 默认不存健康、种族、宗教、政治、性别认同等主题；用户显式打开后才存，且每次保存都在输入框上方出现提示供复核；关闭时删除已保存的敏感项。[公开资料] [S4]
- **不频繁弹问的三种替代**：把「要记住吗」留给显式偏好与敏感内容，其余靠「事后可见（Sources/summary）+ 捕获时作用域提示 + 聚合变更卡片」。[推断] 逐条询问会迅速变成打扰，产品普遍选「默认记 + 可撤回」而不是「每次确认」。[S1][S10][S14]
- **事后可见不等于捕获可见**：ChatGPT 的 Sources 只在回答用到个人上下文时出现，且「不保证列出所有因素」；[推断] 这对用户是「抽查式透明」，不足以支撑逐条信任。[公开资料] [S1]

---

## 3. Q2 可见性与透明度：用户在哪看到「它记住了什么」

### 3.1 三个层级，缺一不可

| 层级 | 作用 | 产品实例 | 来源 |
|---|---|---|---|
| L1 响应级 provenance | 这条回答用了哪条记忆/哪个源 | ChatGPT Sources（可打开源、纠正/删除、标相关/不相关）；Copilot 仓库事实带指向代码的引用 | [S1][S11] |
| L2 条目级管理面 | 逐条看、搜、排序、改、删 | ChatGPT saved memories（部分套餐有搜索/排序/自动优先级/版本历史）；Copilot 设置页按有用性排序；Notion 的 Memories 是数据库页面 | [S1][S11][S16] |
| L3 摘要/索引 | 一眼看「它对我的整体理解」 | ChatGPT memory summary（可直接改）；Claude memory summary（可对话更新）；Notion「About」摘要；Claude Code 的 MEMORY.md 索引（首 200 行/25KB 入上下文） | [S1][S4][S16][S6] |

### 3.2 透明度做得好/差的分界

- **好的做法是给出「可定位 + 可验证 + 可操作」的三角**：能点回原始会话或代码、能核对来源、能当场纠正。Copilot 的仓库事实引用到代码，ChatGPT Sources 能跳到源会话，都属于此。[公开资料] [S1][S11]
- **诚实声明局限**：ChatGPT 明确说 memory summary 只是高层视图、可能遗漏不重要或不宜展示的细节，Sources 也可能未列全；这种「承认不完整」比假装全量更可信。[公开资料] [S1]
- **投票/权重不展示是刻意设计**：Copilot 不显示每条记忆的投票数，只看列表排序；被判定不再使用的记忆会从列表隐藏但可能仍存储至过期——[推断] 这是为了防止「刷分」，但牺牲了可解释性，必须配「显式删除」入口。[公开资料] [S11][S13]
- **动态加载要可见**：Claude Code 子目录的 CLAUDE.md 不在启动时加载，加载时打印 `Loaded` 行；`/context all` 的 Memory files 列表能核对本次到底读了哪些记忆文件。[公开资料] [S6]
- **别把文件树当主界面**：Codex 明说 memory 文件是生成态，排查/分享前可看，但「不要把手工编辑它们当作主要控制面」——这与我们「人不直接读库、只读导出视图」的判断同向。[公开资料] [S7]

---

## 4. Q3 纠正与遗忘：怎么改/删/关、传播多远、有没有审计

### 4.1 三档动作应并列，而不是只给「删除」

- **改（就地编辑）**：ChatGPT 可直接改 memory summary 或单条 saved memory；Claude 通过与 Claude 对话更新 summary；Notion 记忆是数据库页面（[推断] 可按页面编辑）。[公开资料] [S1][S4][S16]
- **压制（别再提，不删源）**：ChatGPT「Don't mention this again」改变个性化行为，但**不删除**底层聊天/文件/邮件；Copilot 让 agent「forget」会降权并指路到真正的删除入口，而**降权不等于删除**。[公开资料] [S1][S10][S11]
- **删（从记忆与索引移除）**：ChatGPT 需分别清 memory summary、saved memories、原始聊天、Library 文件、连接应用，删除还会「需要时间传播」；删聊天不会自动删由它生成的 saved memory；被删 saved memory 的日志最多保留 30 天。[公开资料] [S1]
- **关（停用而非删除）**：Claude 的「Pause memory」保留已有记忆但不用不记；「Reset memory」永久删除全部（含项目记忆）且不可撤销——两档必须命名清楚。[公开资料] [S4]
- **单会话级关闭**：Claude 可在发第一条消息前关掉本聊记忆，开始后锁定，标题旁出现划掉的记忆图标；ChatGPT 临时聊天开始前可选「Unpersonalized」，之后不能改。[公开资料] [S4][S1]

### 4.2 传播范围与延迟（设计时必须写清）

| 动作 | 影响面 | 延迟/不可逆 | 证据 |
|---|---|---|---|
| 改一条记忆 | 未来会话的个性化；不改历史对话文本 | 即时（但摘要类记忆可能被后台重写） | [S1][S4] |
| 别再提 / 降权 | 未来引用概率；源数据仍在 | 无回执；Copilot 直到过期才真正删 | [S1][S11] |
| 删记忆条目 | 该条不再用于个性化；历史对话中的提及仍在 | 传播需时间；日志保留至多 30 天 | [S1] |
| 删仓库级事实 | 该仓库所有使用者 | 需仓库写权限；影响他人 | [S11][S13] |
| Reset memory | 全部个人 + 项目记忆 | 立即且不可撤销 | [S4] |
| 关 Reference chat history | 派生信息计划在 30 天内从系统删除；原聊天保留 | 30 天内 | [S1] |

### 4.3 审计的最小形态

- **每条记忆带元数据**：Copilot 每条记录 memory 文本、主题域、产生它的 agent、模型、计费实体，并写审计日志；但引用、存储理由、投票、过期时间**不展示**。[公开资料] [S11]
- **每条记忆带出处与时间**：Devin 的笔记是一行一条 bullet，尾部带「来源会话 ID + 添加日期」；dreaming 保留 source links 和显式偏好。[公开资料] [S14]
- **整理过程可回看**：Devin 的 Memory 页能看到最近 dreaming 会话及每次改了什么；Letta 用 `/doctor` 审计摆放、重复与 system-prompt token 占用，重排前备份 git 仓。[公开资料] [S14][S17]
- **共享物的审计走 PR**：Copilot dreaming 对记忆自动增删改，但对 `.github/copilot-instructions.md`、`AGENTS.md`、skills 等**入库文件只开 PR**，合并前不改。[公开资料] [S12]

### 4.4 压缩与交接：记忆要在压缩点前后发力

- **上下文腐化（context rot）是硬约束**：Chroma 测 18 个模型发现输入越长、回忆越不可靠且退化不均匀；Anthropic 因此把上下文当有限资源、追求「最小高信号 token 集」。[公开资料] [S26][S25]
- **产品把三条路径分开**：compaction（压缩整段对话）、工具结果清理、memory（外部结构化笔记）；Claude Code 生产上同时用 compression + 两套记忆，API 三者都是一等能力。[公开资料] [S27]
- **交接靠文件而非只靠摘要**：Claude 记忆工具给出多会话开发模式——初始化会话先写进度日志、功能清单、启动脚本引用，后续会话从记录恢复。[公开资料] [S28]
- [推断] 压缩是不可逆的信息损失，必须在压缩前把「已定决策/未决问题/下一步/证据链接」先落到记忆，否则丢的是可审计性与交接能力。

---

## 5. Q4 作用域：跨会话/跨项目/跨团队怎么表达

### 5.1 五层边界，产品大致对齐

| 层 | 典型实现 | 来源 |
|---|---|---|
| 单会话 | ChatGPT 临时聊天、Claude incognito / 单聊记忆开关、Codex `/memories` 单聊开关 | [S1][S4][S7] |
| 项目/仓库 | Claude 每项目独立记忆；Jules 仓库级记忆；ChatGPT 受监管工作区的 Project-only memory | [S3][S4][S15][S1] |
| 个人跨项目 | Copilot user-level preferences；Claude 账户记忆（项目可关「Use account memory」） | [S11][S4] |
| 团队/组织 | Copilot 仓库事实对协作者可见；Notion 工作区开关；Devin 组织级开关 | [S11][S16][S14] |
| 企业/策略 | Claude Enterprise 管理员可禁用；Copilot 企业策略；Devin Always on/off | [S3][S11][S14] |

### 5.2 项目知识 vs 个人偏好：三种分离手法

1. **类型分离**：Copilot 把记忆分成「仓库事实（共享、引代码）」和「用户偏好（个人、跨仓库、可引用你说过的话）」，可见者、创建者、删除者各不相同。[公开资料] [S11]
2. **容器分离**：Claude 每个 project 有自己的记忆，项目内默认还能用账户记忆，但可关「Use account memory」把项目彻底隔离；ChatGPT 受监管工作区可用 Project-only memory，项目内聊天不能引用项目外；项目知识超出上下文窗口时 Claude 自动切 RAG 并在界面显示指示。[公开资料] [S4][S1][S5]
3. **文件/权限分离**：Claude Code 的 CLAUDE.md 分 managed policy / user / project / local，auto memory 按仓库存、机器本地、worktree 共享；VS Code 本机记忆分 user / repo / session 三档，并明确写「repo memory 不是共享项目文件，评审过的约定应放进源码管理文档或 custom instructions」。[公开资料] [S6][S13]

### 5.3 跨团队传播只走「已审核产物」

- GitHub 的规则是「记忆自动、入库指令提议」：个人/仓库记忆由 dreaming 自动增删改，但 checked-in 的 instructions/skills 变更必须 PR 评审。[公开资料] [S12]
- VS Code 文档同样建议：仓库记忆里只放尚未评审的临时项目知识，稳定后升级为源码管理文档。[公开资料] [S13]
- Devin 的 memory 是**个人**的（组织内不共享），团队流程知识放 Skills（明确由人或团队编写）；Letta 的 MemFS 本身是 git 仓，天然可审。[公开资料] [S14][S17]
- [推断] 给工作台的直接含义：项目知识一旦要「团队共用」，就应进入可评审的导出物（文档/规则/技能），而不是直接共享个人记忆库。

---

## 6. Q5 失败模式：真实案例与公开教训

| 失败模式 | 公开证据 | 机制 | 可抄的缓解 |
|---|---|---|---|
| 记忆投毒/注入 | SpAIware：网页提示注入把「间谍指令」写进 ChatGPT 长期记忆，之后每个会话持续外泄输入与回复；作者明确「未修复」 [S22] | 不可信内容 → 写记忆 → 跨会话读回执行 | 记忆视为不可信输入；来源标注；敏感动作二次确认（[推断]） |
| 记忆投毒规模化 | MemoryDojo 基准：155 条多会话轨迹、4 领域、5 种记忆系统，**所有被测系统都可被投毒**，且不同架构下游影响差异显著 [S23] | 一次会话埋毒，后续检索放大 | 引用校验、过期、按作用域隔离、投毒回归测试 |
| 隐形记忆操纵 | MemIncept（ICML 2026）研究用「合作式隐蔽记忆注入」在会话间操控 agent 行为 [S30] | 写入看似无害、组合后改变行为 | 写入审计 + 异常模式检测（[推断]） |
| 错误/幻觉记忆 | 18 人访谈研究：用户报告不准确记忆，「缺乏有意义的控制与透明」是核心痛点；用户想要可复核、可编辑、可删除、可分类，以及「记忆与推断如何使用」的透明说明 [S24] | 推断被当事实、摘要失真 | 每条记忆带来源/时间/置信度；纠正入口 |
| 过度记忆/侵入感 | ChatGPT 改进记忆会持续更新「更广泛的摘要」，官方也承认 summary 可能遗漏；Claude 为敏感主题设默认不记 [S1][S4] | 记太多、记错重点 | 白名单捕获 + 摘要不等于全量 + 敏感默认拒绝 |
| 陈旧记忆 | Copilot：事实/偏好在无强化一段时间后过期（VS Code 文档写 28 天），使用/验证会重置；Devin dreaming 删除陈旧条目 [S13][S14] | 世界变了，记忆没变 | TTL/衰减 + 后台整理 + 显式「可能过期」提示 |
| 隐私/共享边界误判 | ChatGPT：删除需清多源且日志保留 30 天；Claude：企业版 incognito 仍进入数据导出与保留策略 [S1][S4] | 用户以为「临时/删除=没痕迹」 | 状态边界常驻可见；保留策略如实披露 |
| 记忆影响安全对齐 | Claude 博文：上线前专门测「记忆是否会强化有害模式、过度迎合、被用来绕过防护」 [S3] | 长期记忆放大谄媚/越界 | 对记忆做安全评测；敏感主题策略 |

**三条公开教训**：(1) 记忆的写入面就是攻击面，任何「外部内容 → 记忆」通路都要按不可信输入处理 [S22][S23]；(2) 用户对记忆的心理模型普遍不完整，靠设置页自解释不够，必须在捕获与使用两个时刻给可见反馈 [S24]；(3) 「删除」若只做降权/隐藏，会直接摧毁信任——隐藏但仍在库里的设计必须被显式标注 [S11][S13]。

---

## 7. 给 DSH 工作台的 14 条设计规则

> 每条一句可执行规则；来源指外部证据，落地细节需结合本项目七类记忆与 propose→validate→commit 协议（[推断]）。

1. **每次写入产出一张「记忆变更卡」**：条目、作用域、来源会话、证据链接、生效时机（默认下一次会话），会话内可撤销；超过阈值（如一次 >3 条）需人确认。[S14][S4][推断]
2. **自动捕获只认四类**：用户纠正、稳定偏好、决策与理由、环境坑；任务状态/编号、秘密凭据、可从代码或 git 推导的事实一律不写。[S14][S6][S7]
3. **捕获时就声明作用域**：仅我 / 本项目 / 本仓库协作者 / 团队，默认「仅本项目」，跨层需显式确认并显示可见人范围。[S10][S11][S4]
4. **新记忆默认只对后续会话生效**，当前会话要显式「刷新记忆」才读，避免边写边自我强化。[S14][推断]
5. **回答用记忆必给 provenance**：可点回记忆条目/原始会话/代码位置，并声明「可能未列全」；共享出去的对话默认不带记忆源。[S1][S11]
6. **记忆首页三视图**：按作用域分组的条目列表、可纠正摘要、按「最近被使用/被纠正」排序；支持搜索、版本历史、导出（Markdown/JSON）。[S1][S11][S16][S17]
7. **纠正三档并列**：改（就地编辑）/ 别再提（mute，不删源）/ 删（记忆+索引）；每档显示传播范围与延迟。[S1][S10][S4]
8. **删除闭环**：列出受影响副本（条目、源会话、导出视图、检索索引）、处理中状态、完成回执；不可逆操作二次确认。[S1][S4][S11]
9. **遗忘自动化但可审计**：只对长期未被验证/引用的条目衰减；后台整理先出 diff，个人记忆可自动应用，共享/入库记忆只出 PR 或评审件。[S13][S12][S14]
10. **过期与冲突显式化**：每条带 as-of、来源、最近验证时间；与当前证据冲突时回答提示「记忆可能过期」并给一键更新。[S11][S1][推断]
11. **项目知识与个人偏好分层隔离**：提供「本项目不使用账户记忆」开关；跨项目默认不继承，跨团队只走已评审导出物。[S4][S1][S13]
12. **临时/不记忆通道一键可达且状态常驻**：开始前选「是否使用已有记忆」，开始后锁定并在标题/图标显示；如实说明企业保留策略下 incognito 仍可能被导出。[S1][S4]
13. **敏感默认拒绝**：健康/政治/宗教/性别认同等默认不记，需 opt-in；每次保存给可复核提示；秘密硬拒；关闭时回溯删除。[S4][S7][S28]
14. **记忆不是策略**：必须始终生效的规则放显式规则文件/钩子（AGENTS.md/CLAUDE.md/hook），记忆只作召回层；UI 上分栏展示、回答里分开引用。[S6][S8][S11]

---

## 8. 反面清单：不要抄的交互

1. **不要「静默全自动 + 只给总开关」**：无逐条回执、无来源，用户只能靠抽查建立信任；改进记忆越自动越要配可见面。[S24][推断]
2. **不要把「删除」做成降权/隐藏**：Copilot 的 forget 只是降权，被隐藏的记忆可能仍在库里直到过期——用户预期是删除，必须在 UI 说清或干脆真删。[S11][S13]
3. **不要用单一摘要冒充全部记忆**：ChatGPT 自己承认 summary 会遗漏；只给摘要等于把可纠正性锁在模型手里。[S1]
4. **不要让用户只能「跟 AI 说话」来改记忆**：Devin 在 app 内只读、Codex 明说文件别手改——这是可维护性选择，但对终端用户需要直接可编辑的条目视图。[S14][S7]
5. **不要把个人偏好写进仓库/团队记忆**：Copilot 用两套类型隔离，VS Code 明说 repo memory 不是共享项目文件。[S11][S13]
6. **不要让记忆文件树/数据库表成为主界面**：生成态文件适合排查，不适合日常治理。[S7]
7. **不要记录可推导的事实**：Claude Code 主动跳过架构、文件路径、调试修复等可从代码得出的事实；记了只会陈旧。[S6]
8. **不要跨项目默认继承记忆**：Claude 每项目独立、项目默认可用账户记忆但可关闭；默认继承会把客户 A 的信息带进客户 B。[S4][S3]
9. **不要用「记忆已更新」通知刷屏**：Devin 用一张聚合卡片、Claude 只在敏感保存时提示——按事件分级，而不是每条弹窗。[S14][S4][推断]
10. **不要让记忆参与权限判断**：记忆是数据不是授权；SpAIware 证明被污染的记忆会获得「跨会话影响力」。[S22][推断]
11. **不要在共享链接/导出里默认带记忆源**：ChatGPT 在共享链接中排除 Memory Sources 是正确默认。[S1]
12. **不要让后台整理直接改入库文件**：GitHub 记忆可自动增删改，但入库 instructions/skills 只开 PR；直接改会绕过评审。[S12]

---

## 9. 对 DSH 工作台的直接含义（[推断]，供设计文档吸收）

- **把「写入协议」外化成 UI**：propose→validate→commit 的每一步都对应一张可读卡片（提议了什么、验证了什么、提交到哪层），否则用户只会看到「AI 又记住了什么」。
- **人读层要回答三个问题**：这条记忆从哪来（来源回链）、最近有没有被用/被纠正（使用计数）、它现在还算数吗（as-of + 冲突标记）。
- **共享记忆的评审边界**：个人/项目内记忆可自动整理，一旦要进 git、进团队视图或跨项目，就降级为「提议」，走评审或 PR——这是外部产品最一致的治理线。[S12][S13]
- **评测指标**：优先看「被回答引用次数」「被人纠正/否决次数」「过期后误用次数」，而不是记忆条数；Copilot 已用「坚持偏好/效率提升」做产品级度量。[S9][推断]

---

## 10. 来源（完整 URL + 用途）

**OpenAI / ChatGPT**
- [S1] https://help.openai.com/en/articles/8590148-memory-in-chatgpt — Memory 控制、summary、Sources、删除传播、临时聊天、30 天日志。
- [S2] https://openai.com/index/memory-and-new-controls-for-chatgpt/ — 2024-02 记忆上线时的「用户可控」定位。
- [S7] https://learn.chatgpt.com/docs/customization/memories.md — Codex 本机记忆：默认关、后台生成、`/memories`、生成态文件。
- [S8] https://learn.chatgpt.com/docs/customization/overview.md — AGENTS.md 与 memories 的分层（持久规则 vs 召回层）。

**Anthropic / Claude**
- [S3] https://claude.com/blog/memory — 记忆上线：项目级记忆、memory summary、incognito、安全评测。
- [S4] https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context — 记忆与聊天搜索完整规则（暂停/重置、单聊关闭、敏感主题）。
- [S5] https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects — 项目知识超限后自动切 RAG、视觉指示。
- [S6] https://code.claude.com/docs/en/memory — CLAUDE.md 作用域、auto memory 四类、`/memory`、加载与排查。
- [S25] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — 上下文是有限资源、context rot、压缩与检索原则。
- [S27] https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools — compaction / 工具结果清理 / memory 三者区分。
- [S28] https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool — 客户端记忆工具、`/memories`、路径穿越与过期、多会话开发模式。

**GitHub Copilot**
- [S9] https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/ — Memory GA、Dreaming 预览、93%/42% 指标、PR 评审边界。
- [S10] https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/ — 删除引导、仓库开关、`/memory on/off/show`、捕获时作用域提示。
- [S11] https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory — 仓库事实 vs 用户偏好的权限/引用/审计/过期规则。
- [S12] https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming — dreaming 自动改记忆、入库文件只开 PR。
- [S13] https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/run/memory.md — VS Code 记忆：28 天过期、审查/删除入口、user/repo/session 三作用域。

**编码 agent / 工作台**
- [S14] https://docs.devin.ai/product-guides/memory — 记忆盘 git、Updated memory 卡片、dreaming、只读与「让 Devin 忘」。
- [S15] https://jules.google/docs/changelog/2025-09-30 — Jules 仓库级记忆与 Knowledge 开关。
- [S16] https://www.notion.com/help/view-your-notion-agent-memories — Memories 数据库 + About 摘要、私有、MCP 可移植、权限受限。
- [S17] https://docs.letta.com/configuration/memory — MemFS、`/init` `/remember` `/memory` `/doctor`、dreaming 与「先审后应用」。
- [S18] https://docs.mem0.ai/platform/advanced-memory-operations — 记忆 add/search/update/delete、元数据过滤与平台化操作。
- [S19] https://cursor.com/docs/context/rules — Cursor 以 Rules/AGENTS.md 提供持久上下文。
- [S20] https://gethrbr.com/blog/cursor-memories — 第三方复盘：Cursor Memories 1.0 上线、2.1 移除（[公开资料·二手]）。
- [S21] https://docs.devin.ai/desktop/cascade/memories — 原 Windsurf Cascade Memories 链接现落到 Devin Local 的 rules/AGENTS.md 页。
- [S29] https://manus.im/features/projects — Manus 的每项目 Instructions/Files/Connectors/Skills。

**研究与攻击案例**
- [S22] https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/ — SpAIware：注入持久记忆、跨会话外泄。
- [S23] https://arxiv.org/abs/2611.09721 — MemoryDojo：155 轨迹/5 种记忆系统，全部可被投毒（2026-11-06）。
- [S24] https://arxiv.org/abs/2508.07664 — 18 人访谈：记忆心理模型、隐私权衡、细粒度控制与透明诉求。
- [S30] https://icml.cc/virtual/2026/poster/66667 — MemIncept：隐蔽记忆注入在会话间操控 agent。
- [S26] https://www.trychroma.com/research/context-rot — 输入越长性能越不稳定（context rot，18 个模型）。

> 说明：产品行为均以 2026-11-11 抓取页面为准；S20/S21 为二手观察与重定向证据，已在正文标注；S30 仅用其研究主题，不引用效果数字。

<!-- 引用定义（渲染后隐藏，供 [S#] 跳转） -->
[S1]: https://help.openai.com/en/articles/8590148-memory-in-chatgpt
[S2]: https://openai.com/index/memory-and-new-controls-for-chatgpt/
[S3]: https://claude.com/blog/memory
[S4]: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
[S5]: https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects
[S6]: https://code.claude.com/docs/en/memory
[S7]: https://learn.chatgpt.com/docs/customization/memories.md
[S8]: https://learn.chatgpt.com/docs/customization/overview.md
[S9]: https://github.blog/changelog/2026-10-28-github-intelligence-puts-your-code-context-and-history-to-work/
[S10]: https://github.blog/changelog/2026-05-26-copilot-memory-has-more-controls-for-deletion-scope-and-the-copilot-cli/
[S11]: https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-memory
[S12]: https://docs.github.com/en/copilot/concepts/prompting-and-context/copilot-dreaming
[S13]: https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/run/memory.md
[S14]: https://docs.devin.ai/product-guides/memory
[S15]: https://jules.google/docs/changelog/2025-09-30
[S16]: https://www.notion.com/help/view-your-notion-agent-memories
[S17]: https://docs.letta.com/configuration/memory
[S18]: https://docs.mem0.ai/platform/advanced-memory-operations
[S19]: https://cursor.com/docs/context/rules
[S20]: https://gethrbr.com/blog/cursor-memories
[S21]: https://docs.devin.ai/desktop/cascade/memories
[S22]: https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/
[S23]: https://arxiv.org/abs/2611.09721
[S24]: https://arxiv.org/abs/2508.07664
[S25]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[S26]: https://www.trychroma.com/research/context-rot
[S27]: https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools
[S28]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
[S29]: https://manus.im/features/projects
[S30]: https://icml.cc/virtual/2026/poster/66667
