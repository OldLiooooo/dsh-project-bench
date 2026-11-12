# 数据库型工作台记忆：方案草案 v0（回应四个决定）

> 2026-11-11 · 研究阶段，不是最终设计。
> 本文回应四个决定：① 用关系型数据库存文档/记忆并建索引 + 时间线；② 多工具是硬要求；③ 会话命名要一眼看清职责；④ 默认注入预算。
> 前置：[分层分片调研](layered-sharded-memory-research.zh.md)、[lumio 复盘](lumio-doc-system-audit.zh.md)、
> [Anthropic 机制](anthropic-agent-memory-components.zh.md)、[TencentDB 调研](tencentdb-agent-memory.zh.md)、
> [DSH 运行时事实](dsh-runtime-memory-facts.zh.md)。

---

## 0. 一页纸

**结论：用 SQLite（Node 内置 node:sqlite，单文件、WAL、FTS5 trigram）做「账本 + 索引 + 时间线」，长文档仍以仓库文件为编辑面、全文镜像进库供检索。**

- **DB 是权威的东西**：切片（工作项/模块）、会话登记、短结构化记忆（决策/约束/坑/交接）、事件时间线、文档元数据+版本+全文索引。
- **文件是编辑面**：PRD/ADR/设计/规格/证据仍放仓库，任何工具都能直接读写；wb sync 按 hash 增量把文件索引进库。
- **多工具**：一个零依赖 CLI（wb）+ git 里的 JSONL 导出/视图；DSH 插件直接读库并注入；codex/qoder/workbuddy 走 shell 调 CLI。
- **会话命名**：角色-切片-动作（如「产品-支付PRD」「码农-会话保持实现」），角色固定词表，工具/模型放元数据。
- **预算**：默认总注入 **2k tokens**（L0 400 / L1 300 / L2 900 / 余量 400），每步只刷 L0 ≤150；按需查询 ≤500/次；硬顶 3k、可配置。

**为什么这样切**：DB 的价值不是「查找本身快」，而是**只返回该返回的东西**（小载荷 + 时间线过滤 + 结构化状态），agent 的注意力成本才会降下来。而内容全放 DB 会丢掉 git diff/review 与多工具直接读写文件的便利，所以「短记忆入 DB、长文文件为编辑面、全文镜像入 DB」是折中。

---

## 1. 数据库 vs Markdown：边界与理由

| 维度 | 纯 Markdown | 纯 DB 存全文 | 本方案（DB 账本 + 文件编辑面 + 全文镜像） |
|---|---|---|---|
| 查找 | grep/rg 全库扫 | FTS5 + 索引，快 | 快；且能按 module/stage/role/time 过滤 |
| 时间线 | 靠 git log 拼 | events 表天然 | events 表 + git 双轨 |
| 编辑/评审 | 直接改、diff 清楚 | 需导出/工具编辑 | 直接改文件，diff 清楚；DB 自动索引 |
| 多工具 | 都能读文件 | 各工具要接 API/CLI | 文件 + CLI，工具无关 |
| 二进制进 git | 无 | DB 是二进制，冲突 | DB 不入 git；导出 JSONL/视图入 git，可重建 |
| 一致性风险 | 漂移靠人 | 单一源 | sync 按 hash 幂等；doctor 校验 |

> 1k 档实测（[基准报告](sqlite-vs-markdown-benchmark.zh.md)）：FTS5 查询 1–3ms vs rg 42–160ms；但 DB 默认返回 20 行是 5–10KB / 1.5–3k tokens，**真正收益是「只取该取的」而不是毫秒差**。中文必须 trigram + 两字词 LIKE 兜底。

**内容策略（推荐）**：

- 短结构化记忆（决策、约束、坑、交接、切片状态）→ DB 权威，生成只读 Markdown 视图入 git。
- 长文档（PRD/ADR/设计/规格/证据）→ 仓库文件权威；DB 存 path + content_hash + 版本 + 全文索引，用于搜索与时间线。
- 这两类都进 events，所以「谁在何时对哪个切片做了什么」可查。

> 这条「按数据类拆分」不是拍脑袋：agent 原生工具调研（[agent-native-db-tools.zh.md](agent-native-db-tools.zh.md)）发现 Beads 早期做「JSONL 文件 + SQLite 缓存」双源，最终为了摆脱 3-way merge/僵尸复活/daemon 的复杂度，**迁到 Dolt 单一真相、JSONL 只做被动导出**；basic-memory 则走「Markdown 为源 + DB 物化 + 双 checksum 状态机」。成熟项目的共同结论：**不要做 Markdown↔DB 双向双写**；一侧可写、另一侧只读物化/索引。本方案选择「文件可写、DB 物化/索引 + 短记忆 DB 可写」的分治。

---

## 2. 数据模型草案（SQLite）

```sql
-- 项目与阶段
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, root TEXT, created_at TEXT);
CREATE TABLE stages (id TEXT PRIMARY KEY, project_id TEXT, key TEXT, name TEXT,
                     status TEXT, gate TEXT, started_at TEXT, ended_at TEXT);

-- 切片：工作项 / 模块（分片与 owner 的载体）
CREATE TABLE slices (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('work-item','module')),
  key TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
  stage TEXT, owner_role TEXT, owner_session TEXT,
  current_handoff_id TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(project_id, type, key)
);

-- 会话登记：命名、角色、工具、模型、时间线
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- 产品-支付PRD / 码农-会话保持实现
  role TEXT NOT NULL,                    -- 产品/UX/架构/码农/测试/发布/复盘
  slice_id TEXT, tool TEXT, model TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active/ended/abandoned
  started_at TEXT NOT NULL, ended_at TEXT, handoff_id TEXT
);

-- 文档：长文文件为编辑面，DB 存元数据 + 版本 + 全文镜像
CREATE TABLE documents (
  id TEXT PRIMARY KEY, project_id TEXT, slice_id TEXT,
  type TEXT NOT NULL,                    -- prd/adr/spec/design/evidence/wiki
  title TEXT NOT NULL, path TEXT NOT NULL,
  status TEXT, stage TEXT, owner_role TEXT, owner_session TEXT,
  current_version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT, updated_at TEXT,
  UNIQUE(project_id, path)
);
CREATE TABLE doc_versions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL,
  version INTEGER NOT NULL, path TEXT NOT NULL,
  content_hash TEXT NOT NULL, content TEXT NOT NULL,   -- 全文镜像，供 FTS/历史
  commit_sha TEXT, author_session TEXT, created_at TEXT,
  UNIQUE(document_id, version)
);

-- 短结构化记忆：决策/约束/坑/交接/技能
CREATE TABLE entries (
  id TEXT PRIMARY KEY, project_id TEXT, slice_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('decision','constraint','pitfall','handoff','note','skill')),
  title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active/superseded/expired
  source_ref TEXT,                         -- file/commit/session/tool
  author_session TEXT, valid_from TEXT, valid_to TEXT,
  created_at TEXT, updated_at TEXT
);

-- 时间线：append-only，所有写操作落一条
CREATE TABLE events (
  id TEXT PRIMARY KEY, project_id TEXT, at TEXT NOT NULL,
  kind TEXT NOT NULL,                      -- session.start/session.end/doc.version/entry.add/handoff/slice.status...
  actor_session TEXT, role TEXT, slice_id TEXT,
  subject_type TEXT, subject_id TEXT, payload_json TEXT NOT NULL
);

-- 关系：切片↔文档↔条目↔证据
CREATE TABLE links (
  src_type TEXT, src_id TEXT, dst_type TEXT, dst_id TEXT, rel TEXT,
  created_at TEXT, PRIMARY KEY (src_type, src_id, dst_type, dst_id, rel)
);

-- 单写者租约
CREATE TABLE leases (
  slice_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, reason TEXT
);

-- 检索（派生、可重建）
CREATE VIRTUAL TABLE fts_docs  USING fts5(title, body, tokenize='trigram');
CREATE VIRTUAL TABLE fts_entries USING fts5(title, body, tokenize='trigram');

CREATE INDEX idx_slices_status ON slices(project_id, type, status);
CREATE INDEX idx_docs_slice   ON documents(project_id, slice_id, type);
CREATE INDEX idx_events_at    ON events(project_id, at);
CREATE INDEX idx_sessions_act ON sessions(project_id, status);
```

> 说明：trigram 对中文/子串/标识符都友好（SQLite 3.53.4 实测可用）；英文标识符也可走 unicode61 或 trigram，基准测试后定默认。
> 所有写操作必须带 session_id（CLI 从环境变量或参数取），时间线因此自动成立。

---

## 3. 读写路径与 CLI

**CLI（零依赖，Node ≥22，单文件 wb.mjs）**

```text
wb init                           # 建库 + 导出目录 + 默认角色卡
wb session start --name 码农-会话保持实现 --role 码农 --slice WI-014 --tool codex --model gpt-5
wb brief                          # 打印装载包（L0+L1+L2，≤2k tokens）
wb find "会话保持" --module auth --stage S5 --limit 5
wb timeline --since 2026-11-01 --role 码农 --slice WI-014
wb show WI-014                    # 切片详情 + handoff + 最近事件
wb note --kind decision --title "沿用 JWT" --body "..."   # 短记忆
wb handoff --status 实现完成 --next "补并发用例" ...       # 收工（必填）
wb session end                    # 结束会话，写回 handoff
wb sync                           # 索引变更的文档（hash 增量）
wb doctor                         # 一致性检查（DB↔文件↔导出）
wb rebuild                        # 从 JSONL 导出重建 DB
```

- **读**：brief 是唯一装载入口；find 返回 **id + 标题 + 片段 + 出处 + 时间**，单条 ≤500 tokens；不带全文。
- **写**：短记忆走 wb note；长文改文件后 wb sync；所有写落 events 与时间线。
- **同步**：hash 增量；文件删除 → status=deleted 事件；导出 JSONL + 只读 Markdown 视图入 git；DB 不入 git。
- **收工校验**：wb handoff 检查当前 session 的写作用域（git diff --name-only 与 slice 允许路径比对），片外改动即失败；wb session end 无 handoff → 拒绝/标 abandoned。

---

## 4. 多工具接入（硬要求）

| 工具 | 读装载 | 写文档 | 写短记忆/交接 | 备注 |
|---|---|---|---|---|
| **DSH** | 插件直接读库，注入 systemPrompt.section/context | 文件工具改 | 工具/CLI | 唯一能做「每步注入 + 写前 guard」的地方 |
| **Codex / GPT** | shell 跑 wb brief | 直接改文件（它的强项） | shell 跑 wb note/handoff | 文档写作用域由 wb handoff 校验 |
| **Qoder / WorkBuddy** | shell 跑 wb brief | 直接改文件 | shell 跑 CLI | 同上 |
| **人** | 打开 NOW.md 视图 / UI | 直接改 | CLI/UI | 只读视图自动生成 |

**工具无关协议**：开工跑 wb brief → 只改本切片 → 收工跑 wb handoff。没有插件、没有 MCP、没有 proxy；只要工具能执行 shell 命令就能接入。无法执行 shell 的工具，降级为「写 inbox/proposal.md → wb sync 收取」。
**文档写作分工**：GPT/Codex 擅长的长文档（PRD、规格、对外说明）走文件 + wb sync；DSH 负责生成、校验、时间线与驾驶舱。

---

## 5. 会话命名与角色

**命名格式**：角色-切片-动作，人类一眼可读，机器可解析。

| 角色词表（固定） | 示例 |
|---|---|
| 产品 | 产品-支付PRD、产品-退款规则 |
| UX | UX-登录页优化、UX-结算流程 |
| 架构 | 架构-会话服务ADR、架构-接口契约 |
| 码农 | 码农-会话保持实现、码农-支付回调 |
| 测试 | 测试-支付回归、测试-并发用例 |
| 发布 | 发布-v1.2发版 |
| 复盘 | 复盘-周期3 |

规则：

- 切片 = 工作项/模块的 key（如 WI-014）或短名；动作 = PRD/实现/测试/优化/评审/发布/复盘。
- **同一（项目, 切片, 角色）同时只有一个 active 会话**；再开必须 --force 并写原因（记 events）。
- 工具/模型**不进名字**，进 sessions.tool/model：UI 显示为「码农-会话保持实现 · codex/gpt-5 · 进行中」。
- 会话列表按「角色 → 切片 → 状态」组织；驾驶舱可一眼看到每个切片当前谁在写、用什么工具。
- 历史会话保留 handoff_id 与事件；sessions 是时间线的一等公民。

---

## 6. 上下文预算（回应「2k 够不够」）

**结论：2k 够用，按「总预算 + 分层额度 + 硬顶」管理，不够再调。**

| 层 | 内容 | 默认额度 | 刷新时机 |
|---|---|---|---|
| L0 全局卡 | 项目名/阶段/周期/当前切片/全局规则指针 | 400 tokens | 每步注入（只刷变化部分，≤150） |
| L1 角色卡 | 该角色读/写/禁止 + 开工收工清单 | 300 tokens | 会话启动/角色切换 |
| L2 当前切片 | task + handoff + 模块 README 摘要 | 900 tokens | 会话启动/切片切换/收工后 |
| 余量 | 用户输入、工具返回、模型自己 | 400 tokens | — |
| **合计** | | **2,000** | |

- 按需查询：单条 ≤500 tokens，每回合 ≤2 次（默认），超出提示「先收窄查询」。
- 硬顶：3k（可配）；超过则裁剪 L2 到摘要 + 指针。
- 每回合记录 injected_tokens，进时间线/指标；连续超限自动降级。
- 2k 之所以够：任务拆得小（一个切片一页）、状态查询不进记忆、跨片信息靠 wb find 按需取。**预算不是窗口限制，是注意力限制**；即使 1M 窗口也不建议把记忆扩容到时序注水。

---

## 7. 风险与对策

| 风险 | 表现 | 对策 |
|---|---|---|
| DB/文件漂移 | 文件改了库没同步、时间线缺项 | hash 增量 wb sync + wb doctor + git hook 提示 |
| 双写心智负担 | agent 不知道写哪 | 只有两条路径：短记忆 wb note、长文改文件；不让 agent 直接写 DB |
| 工具不执行 CLI | 忘记 wb brief/handoff | DSH 强制注入；其他工具在任务 prompt 里写「第一步/最后一步」；wb doctor 检查未收工会话 |
| SQLite 并发 | 多进程写冲突 | WAL + busy_timeout；单写租约 leases；写事务短 |
| 中文分词 | unicode61 不分词 | 默认 trigram；基准测试确认 |
| DB 不进 git 的协作 | 换机/多人看不到 | JSONL 导出 + 视图入 git；wb rebuild 可重建 |
| 迁移 | schema 变更 | schema_version + 迁移脚本 + 每日 VACUUM INTO 备份 |
| 双向双写 | Markdown 与 DB 互相覆盖、删除不可推断 | 只允许一侧可写：长文文件可写、DB 只读物化/索引；短记忆 DB 可写、视图只读 |
| agent 忘记调 CLI | 不执行 brief/handoff | 参照 Beads：SessionStart/Compact 注入 + 各工具 setup 薄适配 + doctor 自检；MCP 只在无 shell 时兜底 |
| 过度设计 | 又回到上一个大而全 | 首版只做 §3 的 12 条命令、§2 的 11 张表；其余后置 |

---

## 8. 开放问题

| # | 问题 | 推荐 |
|---|---|---|
| Q1 | 长文档全文是否也以 DB 为权威？ | 否：文件权威 + 全文镜像；如果想全 DB，先小规模验证 diff/review 体验 |
| Q2 | CLI 名称与位置 | wb（workbench），每项目根 .wb/；DB 在 .wb/memory.db（gitignore），导出/视图入 git |
| Q3 | 角色词表是否加「PM/项目办公室」 | PM 是编排者，不是切片执行者；可用「产品」或单设「PM」会话负责派单 |
| Q4 | session 名是否带工具有后缀 | 不带；工具/模型放元数据，UI 显示 |
| Q5 | 默认 2k 是否够 | 先按 2k 跑 2 个真实任务，用 injected_tokens 和「漏读/误读」调整 |
| Q6 | 是否要只读 Web 视图 | 首版可以只生成 NOW.md/timeline.md；驾驶舱后置 |
| Q7 | 导出 JSONL 粒度 | 每事件一行；按项目一份 events.jsonl + 每切片一份视图，便于 git diff |
| Q8 | 时间线保留期 | 全留；视图只显示最近 N 天，历史可 wb timeline --all |

---

## 9. 参考

- [分层分片调研](layered-sharded-memory-research.zh.md) / [lumio 复盘](lumio-doc-system-audit.zh.md) /
  [Anthropic 机制](anthropic-agent-memory-components.zh.md) / [TencentDB 调研](tencentdb-agent-memory.zh.md) /
  [DSH 运行时事实](dsh-runtime-memory-facts.zh.md)
- agent 原生 DB 工具调研：[agent-native-db-tools.zh.md](agent-native-db-tools.zh.md)（Beads 三代存储反转、CLI JSON 契约、prime 注入、8 条可借鉴机制）
- 检索基准：[sqlite-vs-markdown-benchmark.zh.md](sqlite-vs-markdown-benchmark.zh.md)（1k 档实测，5k/20k 待补）
