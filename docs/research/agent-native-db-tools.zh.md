# Agent 原生 / DB 型 / CLI 接入工具调研

> 2026-11-11 · 研究（非设计提案）。回答「用关系型数据库存文档/记忆并建索引，是否比 Markdown 检索快、能对应时间线；多工具（codex/dsh/qoder/workbuddy）如何接入」。
> 方法：GitHub 仓库整仓 tarball（Beads main @2026-11-10、Beads v0.49.6、claude-mem、basic-memory、sqlite-memory-mcp、Backlog.md）+ 各项目 README + 源码；抓取原文在 [sources/](sources/)，标 `agent-db-*`。**未获取**的项在 §8 列出。

## 0. 一页纸结论

| # | 结论 | 最强证据 |
|---|---|---|
| 1 | Beads 已从「JSONL + 本地 SQLite 缓存」演进为「Dolt 数据库是唯一真相，JSONL 只是可选被动导出」；Git 里不再放数据库文件 | [README](https://github.com/gastownhall/beads/blob/main/README.md)「Storage Modes」；[v0.49.6 ARCHITECTURE](https://github.com/gastownhall/beads/blob/v0.49.6/docs/ARCHITECTURE.md) |
| 2 | Beads 把**全文放在 DB 列里**，但检索是 SQL 过滤 + `LIKE`（搜标题/ID），**没有 FTS5/BM25/向量**；10K 条基准：search 12.5ms、ready 30ms、create 2.5ms | [BENCHMARKS](https://github.com/gastownhall/beads/blob/main/BENCHMARKS.md)；[filter.go](https://github.com/gastownhall/beads/blob/main/internal/storage/sqlbuild/filter.go) |
| 3 | 「DB 全文 + 索引 + 时间线」的成熟参考在记忆类工具：claude-mem（SQLite+FTS5+向量）、sqlite-memory-mcp（WAL+FTS5+sqlite-vec）、basic-memory（Markdown 为源、DB 物化+FTS5） | §3 表 |
| 4 | 多工具接入的公共分母是 **CLI + JSON**；hooks 负责注入（prime），MCP 只做无 shell 环境兜底（Beads 实测 1–2k vs 10–50k tokens） | [claude-code 集成](https://github.com/gastownhall/beads/blob/main/docs/integrations/claude-code.md)、[MCP server](https://github.com/gastownhall/beads/blob/main/docs/integrations/mcp-server.md) |
| 5 | 并发不靠「大家小心」：原子 claim + 租约/heartbeat/reclaim + 事件日志 seq/快照/checkpoint + 单写者（嵌入模式）或服务端多写 | [Dolt 并发设计](https://github.com/gastownhall/beads/blob/main/engdocs/design/dolt-concurrency.md)、[events-journal](https://github.com/gastownhall/beads/blob/main/docs/reference/events-journal.md) |
| 6 | 对「中大型项目文档多」：推荐**按数据类拆分**——正文/规范留在 Markdown（git 可评审），SQLite 存物化全文+FTS5 索引+事件/时间线；任务/claim/租约/记忆条目以 DB 为源。不要做双向双写 | §7 |

## 1. 速览（10 个工具 + 1 个二手参考）

| 项目 | 定位 | 内容存哪 | 检索 | 时间线/版本 | 多工具接入 | 并发/共享 |
|---|---|---|---|---|---|---|
| **Beads (bd)** | 给 agent 的依赖图 issue tracker / 工作记忆 | 全文在 DB 列；JSONL 可选导出 | SQL 过滤 + `LIKE` 标题/ID；无 FTS/向量 | Dolt 每次写自动 commit；audit events；events journal；`bd history` | CLI + `bd setup` 13 种 recipe + hooks；MCP 兜底 | 嵌入 Dolt 单写者 / server 多写；cell 级 3-way merge；claim+租约 |
| **claude-mem** | 自动记录会话观察（第二 agent 写笔记） | SQLite 全量 observation/summary + FTS5；Chroma 向量 | FTS5 BM25 + 向量（混合） | sessions/summaries + `timeline` MCP 工具 | hooks（多 agent 适配器，含 Qoder 插件 `qoder.mcp.json`）；MCP search 工具 | 本地 worker 服务；SQLite 单文件；云同步可选 |
| **basic-memory** | Markdown 知识图谱 + MCP | **Markdown 文件为源**；SQLite `memory.db` 物化正文+索引 | FTS5 + embeddings（语义/混合） | entity/observation 时间索引；文件 watcher 同步 | MCP-native | 文件+DB 双版本 checksum 状态机 |
| **sqlite-memory-mcp** | 单文件 SQLite 记忆栈（MCP） | 全文在 SQLite（entities/observations） | FTS5 BM25 + sqlite-vec + RRF | sessions/audit/replay；provenance | MCP（多 server） | WAL，10+ 会话；跨机 bridge 走私有 git repo |
| **官方 MCP memory** | 知识图谱 MCP server | 单个 `memory.jsonl` 全图 | 子串（无 FTS/向量） | 无（文件 git 历史） | MCP | 写锁文件 + 临时文件原子替换；整图重写 |
| **mem0** | 通用记忆层（SDK/服务） | 向量库 + SQLite `history` 审计 | 语义+BM25+实体三路融合 | history 表；时间推理 | CLI + skills + SDK | 库/自托管/云三种；基准数据来自托管平台 |
| **cipher / ByteRover** | 上下文树 + 记忆 | README 未说明底层格式（**未获取**） | `brv query`（LLM/索引） | git-like VC：branch/commit/merge/push | CLI + MCP；22+ agent | 本地 daemon；云同步可选 |
| **Backlog.md** | Markdown 任务管理器 | 每任务一个 `.md` + YAML frontmatter | CLI 过滤；文档 search | git 历史 | CLI + MCP + web；AGENTS.md 指令 | 无 DB；git 天然并发 |
| **taskmd / task.md** | 极简文件任务 | Markdown（YAML frontmatter / 文件名即元数据） | grep/CLI | git log / rename 即提交 | CLI + MCP/skills | 无锁；靠 git merge |
| GBrain（二手） | Markdown+git+PGLite+pgvector 记忆 | Markdown 为源 + 向量 | 混合 | dream 巩固周期 | — | 据 sqlite-memory-mcp README 对比表，未独立核验 |

## 2. Beads 深潜（最重要样本）

### 2.1 三代存储架构（路线反转是本报告最大证据）

| 时期 | 内容源（真相） | 本地库 | git 中的东西 | 证据 |
|---|---|---|---|---|
| ≤ v0.49.x | `.beads/issues.jsonl`（git-tracked，一行一实体） | SQLite `.beads/beads.db`（gitignored 缓存） | JSONL；git 做分发 | v0.49.6 ARCHITECTURE 三层模型 + SYNC.md |
| 过渡 | SQLite 成为本地主库；提供 SQLite→Dolt 自动迁移 | SQLite（legacy reader 只接受 0.49.6 / 0.50.3 两种布局） | JSONL 导出 | [legacysqlite/reader.go](https://github.com/gastownhall/beads/blob/main/internal/migration/legacysqlite/reader.go) |
| 现在（0.55 起迁移，1.x） | **Dolt 数据库**（embedded 默认 / server 可选） | Dolt；JSONL 只是「viewers/interchange」被动导出 | 只有 config/metadata；DB 目录 gitignore，禁止 LFS | README「Storage Modes」「Directory Layout」；CHANGELOG「Removed: Beads Classic SQLite backend」 |

**为什么反转**：JSONL+SQLite 时代要自己实现 3-way merge、LWW/union/append 字段策略、时钟偏移、僵尸复活、daemon、`.sync.lock`；Dolt 直接提供数据库级版本控制、cell 级合并、branch/merge/diff、push/pull，把「数据同步」变成引擎问题（[dolt.md](https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md)、[sync-concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)）。

### 2.2 Schema（旧 SQLite 版是唯一可直接对照的关系模型）

旧版（v0.49.6 [schema.go](https://github.com/gastownhall/beads/blob/v0.49.6/internal/storage/sqlite/schema.go)）7 张表：

| 表 | 关键列 | 作用 |
|---|---|---|
| `issues` | `id`(hash)、`content_hash`、title/description/design/notes/acceptance_criteria(全文)、status、priority 0-4、issue_type、assignee、created_at/updated_at/closed_at、external_ref、metadata JSON、compaction_level/compacted_at/original_size、ephemeral/wisp_type | 工作项主体；全文进列 |
| `dependencies` | (issue_id, depends_on_id, type) 主键，type 含 blocks/parent-child/discovered-from/related 等 | 依赖图边，`bd ready` 由它算 |
| `labels` / `comments` | 标签；评论（author/text/created_at） | 分类与讨论 |
| `events` | event_type/actor/old_value/new_value/created_at | 审计时间线 |
| `config` / `metadata` | key/value | 配置与导入哈希 |

当前 Dolt schema 用 141 个 SQL 迁移文件演进（首批 0001–0005 仍是 issues/dependencies/labels/comments/events），另有 wisps（临时平面）、kv 记忆、租约、事件日志等表；开库时做 schema 版本闸门，旧 binary 打开新库直接报「schema version mismatch」并给升级路径（[migrations/README](https://github.com/gastownhall/beads/blob/main/internal/storage/schema/migrations/README.md)、README「Schema Version Guard」）。

### 2.3 CLI 契约（agent 调用的最小面）

| 命令 | 语义 | 证据/细节 |
|---|---|---|
| `bd create / show / update <id> --claim / close` | 创建/查看/原子认领/关闭 | claim = assignee + in_progress，一次事务 |
| `bd ready --claim --json` | 取「无未关闭 blocker」的前沿并原子认领 | ready 排除 in_progress/blocked/deferred/gate |
| `bd dep add` / `bd blocked` / `bd graph` | 建边、查阻塞、看依赖图 | type 决定是否影响 ready |
| `bd prime` | 输出 agent 工作流上下文 + 注入持久记忆 | CLI 模式 1–2k tokens；MCP 模式 ~50；`--hook-json` 给 SessionStart |
| `bd remember / recall / memories / forget` | 持久记忆（k/v），prime 时注入 | `--max-memories`/`--max-memory-chars` 封顶，防溢出 |
| `bd export / import` | JSONL 导出/导入（含 labels/deps/comments） | import 仅 upsert：只在新 `updated_at` 严格更新时覆盖，平局保留本地；**不能推断删除** |
| `bd events tail --since N` / `bd history` | 事件流/单条审计 | seq 无空洞、快照、checkpoint 续读 |
| `bd reclaim / heartbeat` / `merge-slot` | 死 worker 租约回收 / 续租 / 串行化冲突工作 | 租约表 node-local，心跳不写 Dolt commit |
| `bd dolt push/pull / backup / doctor` | 跨机同步/备份/诊断 | 嵌入式单写者；server 模式多写 |

所有命令支持 `--json`；v2.0 起统一 `{"schema_version":1,"data":...}` 信封，错误也机器可读（[json-schema](https://github.com/gastownhall/beads/blob/main/docs/reference/json-schema.md)）。**这是「多工具」的关键：契约是一份 JSON，不是某家 IDE 的格式。**

### 2.4 多工具接入（Beads 的工程化答案）

- **13 个 `bd setup` recipe**：aider、claude、codex、cody、cursor、factory、gemini、junie、kilocode、kiro、mux、opencode、windsurf；每个写入该工具认识的指引/hook（如 Claude `.claude/settings.json` SessionStart → `bd prime --hook-json`；Codex `.agents/skills/beads/` + AGENTS.md + `.codex/hooks.json`）。（[integrations/index](https://github.com/gastownhall/beads/blob/main/docs/integrations/index.md)、[Codex 集成](https://github.com/gastownhall/beads/blob/main/docs/integrations/codex.md)）
- **CLI + hooks 优先，MCP 兜底**：MCP 工具 schema 每次请求常驻 10–50k tokens；`bd prime` 只 1–2k。MCP 只在 Claude Desktop 等无 shell 环境用，且没有 sync 工具（[mcp-server](https://github.com/gastownhall/beads/blob/main/docs/integrations/mcp-server.md)）。
- **压缩后恢复**：Claude Code 的 SessionStart 在 compaction 后再次触发；Codex 用 PreCompact/PostCompact/UserPromptSubmit 标记 + 首次 prompt 刷新。解决「agent 忘了 CLI」。
- **身份**：`BD_ACTOR` 环境变量 + commit `Executed-By:` trailer；assignee 只是字符串，无 agent 注册表。
- **我们的四个工具**：Beads 仓库中 `qoder`/`workbuddy` 均 0 命中（**无原生 recipe**）；claude-mem 有 Qoder MCP 插件（`plugin/qoder.mcp.json` + hook 环境变量），workbuddy **未获取**。结论：对 qoder/workbuddy 只能走「CLI + AGENTS.md 指引 + 可选 MCP」。

### 2.5 时间线 / 版本 / 恢复（可抄的具体件）

- **Dolt 提交即版本**：每次写自动 commit，可 branch/merge/diff/回滚；跨机 `bd dolt push/pull`（远端 ref `refs/dolt/data`，不占代码分支）。
- **events journal**：一工作区一条顺序流，`seq` 在写事务内分配、无空洞；7 种 op（create/update/close/delete/dep_add/dep_remove/comment）；每条带**变更后的完整 issue 快照** + labels + `is_blocked`；消费者记 checkpoint 从 `--since` 续读；默认保留 7 天/10 万条，可 prune；默认关闭，且「空 journal 与已追平不可区分」（[events-journal](https://github.com/gastownhall/beads/blob/main/docs/reference/events-journal.md)）。
- **audit history**：`bd history <id> --events` 给「谁在何时把哪个字段从 A 改到 B」。
- **JSONL 在 git 里的用法**（旧时代）：一行一实体、hash ID 使新增行极少冲突；同 issue 更新冲突用 3-way merge + 字段策略（scalar LWW / labels&deps union / comments append）；import 遇到 `<<<<<<<` 直接拒绝。现在：`export.auto` 默认 false，pre-commit 可生成 JSONL，但文档明确「不是跨机同步、不是备份、不是删除源」。
- **压缩/衰减**：`bd compact` 压缩旧 Dolt 提交；`bd admin compact` 摘要化旧 closed 工作项（旧库配置 tier1=30 天、tier2=90 天，模型 claude-haiku），控制上下文与库体积。

### 2.6 检索与性能：DB 不等于全文检索

- **无 FTS5、无 BM25、无向量**（全仓 grep `fts5`/`FULLTEXT` 0 命中；当前搜索是 `LOWER(title) LIKE ?`，描述需 `--desc-contains`）。Beads 是结构化工作图，不是文档搜索引擎。
- 10K 条、M2 Pro：[BENCHMARKS](https://github.com/gastownhall/beads/blob/main/BENCHMARKS.md)——ready 30ms、search 12.5ms、create 2.5ms、update 18ms、100KB 描述 3.3ms、100 条批量 close 1.9s、20 次 sync merge 29ms；数据集 10K≈16.6MB。
- 结论：**SQLite/Dolt 的毫秒级来自「结构化过滤 + 索引」，不是来自「全文倒排」**；文档全文检索必须另加 FTS5（见 §3/§4）。

### 2.7 失败模式与坑（全部带证据）

| 坑 | 证据 | 缓解 |
|---|---|---|
| 双源漂移/删除丢失 | import 仅 upsert，无法推断「导出里没有 = 被删」；JSONL 长期不是删除源 | 单一写者；导出/导入只做迁移；删除用 tombstone/事件 |
| 时钟偏移 + 僵尸复活 | 旧版 LWW 依赖 `updated_at`；一方删、一方改 → 保留修改（resurrection） | 换 DB 事务/版本向量；冲突显式暴露 |
| 二进制进 git | 「Never track the database directory in git or via Git LFS」；`.beads/.gitignore` 自动生成 | DB 只走 Dolt remote/备份；git 里只放导出 |
| 迁移不可回滚 | 迁移文件 merge 后冻结；Dolt DDL 逐条隐式提交；FK 名 database-scoped、generated column 上 FK 受限、需 pre-migration repair | schema 版本闸门 + 迁移前修复注册表 + 升级前 `bd export --all` 备份 |
| 锁/崩溃恢复误判 | 残留 `LOCK` 文件不是持有锁的证据；删 `.dolt/` 内部文件才真会损坏；`bd doctor --fix` 可能误删合法依赖 | 先 `--dry-run`、先备份、只停真正持有者 |
| 单写者撞车 | 嵌入 Dolt「single writer（file-locked）」；多 clone 同时 push/pull 会 race | 多写用 server 模式；切换 clone 前 `bd dolt stop`；CI 用嵌入模式 |
| 死 worker 占坑 | 租约 TTL + heartbeat；`reclaim` 回收；跨 replica 租约不可信 | reaper 定时跑，TTL/grace > 同步间隔 |
| agent 忘记调用 | prime 靠 SessionStart hook；hook 可超时/被外部 hook 管理器覆盖 | `bd setup --check`、`bd onboard` 片段、pre-commit/收工门禁 |
| 敏感记忆外泄 | `bd export` 默认排除 memories；`.beads/.env` 限制变量 | 导出显式 `--include-memories`；secret 扫描 |
| HTTP 后端非等价 | 实验性 `bd serve` 有 divergence ledger，部分操作拒绝/退化 | 实验面 pin 版本；关键路径只用本地 |

## 3. 同类工具（每种一句话 + 关键事实）

| 工具 | 存储模型 | 检索 | 时间线/版本 | 接入 | 坑/边界 |
|---|---|---|---|---|---|
| **claude-mem** | SQLite `~/.claude-mem/claude-mem.db`：projects/server_sessions/agent_events/memory_items/memory_sources/audit_log；**FTS5 虚表** `memory_items_fts`（porter unicode61）；Chroma 向量 | FTS5（关键词）+ 向量混合；MCP 三步：`search`(索引,~50-100 tokens/条)→`timeline`→`get_observations`(详情,~500-1000)，约 10x token 节省 | sessions/summaries；timeline 工具；schema version 33 | hooks 适配多 agent（含 Qoder 插件）；MCP search | FTS 与主表行数不一致时整表重建（漂移修复）；`<private>` 不落库；云同步 opt-in |
| **basic-memory** | **Markdown 为源**；SQLite `memory.db` 存 entity/note_content（物化 `markdown_content` + `db_checksum`/`file_checksum` +`file_write_status` 状态机）/observation/relation/memory_time_index | FTS5 + embedding 语义/混合 | 文件 git 历史 + DB 时间索引 | MCP-native；watcher 同步文件 | 双版本校验是「文件+DB」不漂移的关键；Postgres/Milvus 可选、云可选 |
| **sqlite-memory-mcp** | 单 SQLite 文件（WAL，busy_timeout 10s/30s，SQLITE_BUSY 重试）；entities/observations/relations/sessions/tasks/pending_shared_*/tombstones | FTS5 BM25 + 可选 sqlite-vec，RRF 融合 + 6 个上下文信号重排 | sessions/audit/replay；provenance；审批式 promote（human_confirmed） | MCP（多 micro-server） | WAL 下不能只 `cp memory.db`（丢 -wal）；跨机 bridge 用私有 git repo + LWW-Register CRDT |
| **官方 MCP memory** | 单个 `memory.jsonl` 整图（entities/relations/observations） | 子串匹配，无 FTS/向量（竞品表说法） | 无内建；靠 git | MCP | 写时锁文件 + 临时文件原子 rename；每次写整图重写，规模/concurrency 受限 |
| **mem0** | 向量库（可插拔）+ SQLite `history` 表（操作审计） | 语义 + BM25 + 实体三路并行融合；时间推理 | history 表记录每次 add/update | CLI + skills + SDK | 官方基准来自托管平台，OSS 「directionally similar」；需 embedding 供应商 |
| **cipher→ByteRover** | 上下文树；底层存储格式 **未获取** | LLM 查询/索引 | **git-like VC**：branch/commit/merge/push/pull + 云端 remote | CLI + MCP；22+ agent | LLM 单任务 10 分钟预算；curate 需 review/approve；云依赖可选 |
| **Backlog.md** | `backlog/tasks/*.md`（YAML frontmatter，ID TASK-/BACK-） | CLI 过滤；doc search | git log；archive 目录 | CLI + MCP（tasks/documents/milestones/workflow/DoD）+ web；AGENTS.md 指令 | 无 DB/无锁；并发依赖 git；结构化字段靠约定 |
| **taskmd / task.md** | Markdown 文件（YAML frontmatter 或「文件名即元数据」） | grep/CLI | git log；改名即提交 | CLI + MCP/skills | 无跨机协调；scottopell 版 `next` 两个并发调用可得同一 ID，ID 前缀 hash 的 50% 碰撞点约 12 个并发 worktree |

## 4. 六个重点问题（证据化回答）

| 问题 | 证据与结论 |
|---|---|
| **内容存哪？** | 两种先例都存在：①「全文进 DB」——Beads（description/design/notes 全在列）、claude-mem（全文 observation+FTS）、sqlite-memory-mcp；②「文件为源、DB 物化+索引」——basic-memory（`note_content` 物化 Markdown + 双 checksum）、v0.49 Beads（JSONL 源+SQLite 缓存）。**没有成熟项目做「文件与 DB 双向可写」**；basic-memory 用 `db_version/file_version/checksum/file_write_status`（pending→writing→synced→failed→external_change_detected）显式处理漂移 |
| **检索？** | Beads 无 FTS（LIKE 标题）；claude-mem FTS5+向量；basic-memory FTS5+embeddings；sqlite-memory-mcp FTS5 BM25+sqlite-vec+RRF；mem0 语义+BM25+实体。**数据量与延迟**：Beads 10K 12.5ms（结构化搜索）；claude-mem 用 token 经济性（索引 50–100/条、详情 500–1000/条，~10x）；mem0 托管基准 top_200 0.88–1.09s；**10 万+文档的独立 FTS5 延迟未获取**（待本仓 db-benchmark） |
| **时间线/版本？** | Beads：Dolt commit + audit events + events journal（seq/快照/checkpoint/保留）+ compaction；claude-mem：session/summary + timeline 工具；basic-memory：`memory_time_index` + 文件 git；sqlite-memory-mcp：sessions/audit/replay；cipher：git-like VC；文件类：git log。**JSONL 在 git 里**：一行一实体、hash ID 防冲突；同 issue 冲突走 3-way merge；import 拒绝冲突标记；现代 Beads 已明确 JSONL 非同步/备份/删除源 |
| **多工具？** | 统一模式=「**CLI+JSON 契约**（可选 MCP）+ **per-tool hook/skill/plugin 薄适配** + **AGENTS.md 指引**」。Beads 13 个 setup recipe（`bd setup`；`bd init` 默认装 Claude/Codex/Cursor 三家），`--check` 验证；claude-mem 每个 agent 一个 adapter（含 Qoder）；Backlog.md/taskmd 两种都提供。工具无关性靠「能力在 CLI，不在 IDE」；MCP 只做无 shell 兜底，因 token 成本 |
| **并发？** | SQLite 侧：WAL + busy_timeout + 重试（sqlite-memory-mcp 10+ 会话）；单写者 daemon（Beads 旧 daemon、claude-mem worker）；Dolt：嵌入单写者 / server 多写、MVCC 三方合并、commit graph 全局锁、事务包裹 `DOLT_COMMIT`；**branch-per-worker 已废弃**（worker 互相看不见，50 writers/250 commits 测试全成功但语义错）。协调原语：hash ID、原子 claim、租约/heartbeat/reclaim、merge-slot |
| **失败模式？** | 见 §2.7；跨工具共性：①双源漂移/删除不可推断（Beads import、basic-memory 状态机）；②二进制 db 进 git；③迁移无版本闸门（141 个迁移、DDL 非事务）；④锁误判/崩溃恢复；⑤agent 忘调用（靠 prime/hooks/门禁）；⑥FTS 索引漂移（claude-mem 行数校验重建）；⑦大文件/全图重写（官方 MCP memory）；⑧敏感信息进记忆（Beads 导出默认排除） |

证据文件/链接（§4 用到的）：Beads [schema.go](https://github.com/gastownhall/beads/blob/v0.49.6/internal/storage/sqlite/schema.go)、[BENCHMARKS](https://github.com/gastownhall/beads/blob/main/BENCHMARKS.md)、[events-journal](https://github.com/gastownhall/beads/blob/main/docs/reference/events-journal.md)、[import.md](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/import.md)；claude-mem [schema.ts](https://github.com/thedotmack/claude-mem/blob/main/src/storage/sqlite/schema.ts)、[README](https://github.com/thedotmack/claude-mem/blob/main/README.md)；basic-memory [knowledge.py](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/models/knowledge.py)、[search_service.py](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/services/search_service.py)；sqlite-memory-mcp [schema.py](https://github.com/RMANOV/sqlite-memory-mcp/blob/main/schema.py)、[db_utils.py](https://github.com/RMANOV/sqlite-memory-mcp/blob/main/db_utils.py)；官方 MCP memory [README](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)；mem0 [storage.py](https://github.com/mem0ai/mem0/blob/main/mem0/memory/storage.py)。

## 5. 可直接借鉴的 8 条机制

1. **CLI 是唯一契约**：所有能力做成命令 + `--json` + `schema_version` 信封 + 机器可读错误；IDE/agent 只做薄适配（Beads 13 recipe、taskmd/backlog 的 CLI+MCP 双面）。
2. **prime 注入**：会话启动/SessionStart 注入「≤2 页工作流 + 记忆」；compaction 后再次注入；记忆按条数与字节封顶（Beads `--max-memories/--max-memory-chars`）。
3. **ready 前沿 + 原子 claim + 租约/reclaim**：agent 不扫全库，只问「现在能做什么」；claim 一次事务；TTL+heartbeat 处理死 worker；merge-slot 串行化冲突工作。
4. **只追加事件日志**：`seq` 无空洞 + 变更后快照 + checkpoint 续读 + 保留/清理策略 → 时间线/回放/下游同步三合一（Beads events journal）。
5. **hash ID + 层级 ID**：内容派生、自适应长度、`parent.child` 层级，天然避免多 agent/多分支 ID 冲突与重编号（Beads）。
6. **FTS5（BM25）+ 可选向量 + 渐进披露**：索引→时间线→详情三步取数，先便宜后精确（claude-mem ~10x；sqlite-memory-mcp RRF 融合）。
7. **双版本校验 / 索引可重建**：`content_hash`、db/file checksum、写状态机、FTS 行数校验重建；索引视为 disposable，可全量重建以证明不漂移（basic-memory、claude-mem）。
8. **setup + doctor 自检**：每个 agent/编辑器一条安装 recipe，自动写 AGENTS.md/CLAUDE.md/hook/skill；`--check` 验证、`doctor` 诊断——把「接入」变成可测试的工程，而不是文档约定。

## 6. 不要抄的 3 个坑

1. **不要做 Markdown↔DB 双向双写（尤其可变正文）**：Beads 为此写了 3-way merge、LWW/union/append、僵尸复活、daemon、文件锁，最终仍改为「DB 单一真相 + 被动导出」；basic-memory 也用 checksum 状态机绕。若必须双面，只允许一侧可写、另一侧只读物化。
2. **不要把数据库二进制（或当成 diff 的大 JSONL）放进 git 当内容源**：Beads 明确 DB 目录 gitignore、禁止 LFS；JSONL 不是备份/同步/删除源。二进制冲突无法 review，merge driver 是长期债务。
3. **不要依赖 agent「记得调用 CLI」或用常驻 MCP schema 代替注入**：context compaction 后 agent 会忘；MCP 全量 schema 10–50k tokens。必须 SessionStart/PostCompact 注入 + pre-commit/收工门禁 + `--check` 自检，MCP 只做无 shell 兜底。

## 7. 路线取舍：「DB 全文 + Markdown 视图」 vs 「Markdown 源 + DB 索引」

| 维度 | A. DB 存全文 + MD 视图（DB 为源） | B. Markdown 为源 + DB 为索引（文件为源） | B+：按数据类拆分（推荐） |
|---|---|---|---|
| 多 agent 写 | 事务/行锁可串行化；适合高频小记录 | 文件 rename/冲突交给 git；正文大改易冲突 | 正文走 B，任务/claim/事件走 A |
| 评审/diff | MD 是导出物，PR 里看不到真实改动；需 review 导出 | git diff 直接可评审；merge 可解 | 文档 PR 正常评审；DB 侧用事件/JSONL 审计 |
| 检索速度 | 全文+FTS5 最快、可加向量；时间线 SQL 天然 | 需索引与文件同步；freshness 要 watcher/重建 | FTS5 物化索引 + 正文文件 |
| 漂移风险 | 低（单一真相），但导出物会过期 | 中（双版本/状态机；删除难推断） | 低-中：只物化不反写；删除用事件/tombstone |
| 时间线 | 每写一事件，最完整 | git log + DB 时间索引 | 事件表 + git log 双轨 |
| 实现/运维 | 需 SQLite/DB 服务、备份、迁移；二进制不进 git | 最轻，无 DB 也能跑 | 中等：SQLite + CLI + 可选 FTS5/向量 |
| 适合数据 | 任务、状态、记忆条目、事件、索引元数据 | 长文档、规范、ADR、模块 README | 两者分治 |

**判断**：用户场景（中大型项目、文档多、要时间线、多工具）不是「二选一」，而是**按数据类拆分**：

- **正文/规范/ADR/模块 README → Markdown 为源**（git 可评审、agent 可读写、可离线），DB 只做「物化全文 + FTS5 索引 + 时间索引」，索引可随时全量重建；这是 basic-memory 与 v0.49 Beads 的共同结论。
- **任务/工作项/claim/租约/事件/记忆条目/索引元数据 → SQLite 为源**（WAL + 单写者 daemon 或单进程 CLI），用 JSONL 导出做审计/迁移，但不当删除源；这是 Beads 现代路线与 claude-mem/sqlite-memory-mcp 的共识。
- **多机/多写再升级**：单机 SQLite 先行；跨机同步再考虑 Dolt（cell merge，但重）或 Postgres/server（简单，但要运维）。**不要一上来为「关系型」上分布式 DB**。
- 与现有分层分片方案衔接：**片 = Markdown 目录/文件**；DB 是「索引 + 账本」不是第二份正文；装载仍由 CLI `prime` 在 1–2k token 预算内输出；时间线由事件表 + git log 对齐。

## 8. 证据、抓取与未获取

- 抓取原文：本目录 [sources/](sources/) 下 `agent-db-beads.*`、`agent-db-claude-mem.*`、`agent-db-basic-memory.*`、`agent-db-sqlite-memory-mcp.*`、`agent-db-mem0.*`、`agent-db-official-mcp-memory.*`、`agent-db-backlog-md.*`、`agent-db-taskmd.*`、`agent-db-cipher.*`（README + 关键源码摘录）。
- Beads：[README](https://github.com/gastownhall/beads/blob/main/README.md)、[architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md)、[sync-concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)、[CLI 参考](https://github.com/gastownhall/beads/tree/main/docs/cli-reference)、[integrations](https://github.com/gastownhall/beads/tree/main/docs/integrations)、[events-journal](https://github.com/gastownhall/beads/blob/main/docs/reference/events-journal.md)、[Dolt 并发](https://github.com/gastownhall/beads/blob/main/engdocs/design/dolt-concurrency.md)、[BENCHMARKS](https://github.com/gastownhall/beads/blob/main/BENCHMARKS.md)、[v0.49.6 架构](https://github.com/gastownhall/beads/blob/v0.49.6/docs/ARCHITECTURE.md)、[经典 SQLite schema](https://github.com/gastownhall/beads/blob/v0.49.6/internal/storage/sqlite/schema.go)。
- 同类：[claude-mem](https://github.com/thedotmack/claude-mem)（[schema.ts](https://github.com/thedotmack/claude-mem/blob/main/src/storage/sqlite/schema.ts)）、[basic-memory](https://github.com/basicmachines-co/basic-memory)（[knowledge.py](https://github.com/basicmachines-co/basic-memory/blob/main/src/basic_memory/models/knowledge.py)）、[sqlite-memory-mcp](https://github.com/RMANOV/sqlite-memory-mcp)、[官方 MCP memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)、[mem0](https://github.com/mem0ai/mem0)、[cipher/ByteRover](https://github.com/campfirein/cipher)、[Backlog.md](https://github.com/MrLesk/Backlog.md)、[taskmd(driangle)](https://github.com/driangle/taskmd)、[task.md(scottopell)](https://github.com/scottopell/taskmd)。
- **名称歧义**：「mcp-memory-server」本文同时覆盖官方 `@modelcontextprotocol/server-memory`（JSONL 整图）与 `RMANOV/sqlite-memory-mcp`（SQLite 栈）；「taskmd」分别指 driangle 版与 scottopell 版。
- **未获取**：Beads 0.50–0.57 的过渡细节（仅有 legacy reader 接受 0.49.6/0.50.3 布局 + CHANGELOG 迁移条目）；Beads 对 qoder/workbuddy 的原生支持（0 命中）；claude-mem 对 workbuddy 的支持；cipher/ByteRover 的底层存储格式；mem0 OSS 默认向量库/图库配置；10 万+文档 FTS5 独立延迟（本仓 db-benchmark 待补）；taskmd 有两个同名项目，本文按「driangle 版」与「scottopell 版」分别标注。
