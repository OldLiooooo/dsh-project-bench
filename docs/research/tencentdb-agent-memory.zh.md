# TencentDB Agent Memory 深度调研：四类资产、L0–L3 分层分片与团队治理
> 对象：[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT，腾讯云数据库团队）。快照：2026-11-11，默认分支 `feat/server_team`，CHANGELOG 最新 v2.0.3（2026-10-26）。方法：Node fetch 抓 GitHub raw/HTML 与腾讯云文档（本机 web_fetch 不可用）；原始文本存 [docs/research/sources/](docs/research/sources/)，未获取项见 §9。

## 0. 一页结论
| 问题 | 结论 |
| --- | --- |
| 是什么 | 团队级 Agent 记忆资产中枢：把对话/文档/代码沉淀为 4 类可治理资产，再按 Agent 装配 |
| 与 RAG 差别 | RAG 答"能查到什么"；它还要答"谁可用、哪个版本有效、装给哪个 Agent" |
| 核心分层 | Chat Memory L0 原始会话→L1 原子事实→L2 场景→L3 画像；Proxy 侧 L2/L3 预注入，L0/L1 用只读工具按需查 |
| 分片键 | 实例 spaceId × team/agent/user/task × 资产类型 × 可见性/ACL；会话另绑定 team/agent/task |
| 治理 | private/team/restricted/agent/task 五档可见性 + User/Role/Agent ACL + Owner + 版本/状态/用量 |
| 接入 | MemoryProxy 改 base URL + user key；DSH v0.2+ 走 `/dsh/<spaceId>` 的 Anthropic 路径 |
| 部署 | 三容器 Docker（Core 8420 / Panel 8125 / Knowledge 8424 / Proxy 8096），默认 SQLite |
| 云端 | 腾讯云"Agent 记忆服务"：Memory 实例（存+算）+ 本地 Memory Hub 面板；按量计费 |
| 我们的取舍 | 值得抄 5 个机制、不抄 3 块（§7）；多人多 Agent、跨会话复用明显的团队才值得完整栈 |

## 1. 项目定位与要解决的问题
从三个重复劳动出发：项目背景讲过了不该换个 Session 再讲；文档读过了不该每个 Agent 从第一页重读；跑通的流程不该下次再摸索。它解决三个问题：**什么值得留下、谁可以使用、下次怎样少拿但拿对**，不是"存下所有东西"。经验循环是：工作产生资产 → 资产在团队流动 → 新成员/新 Agent 直接读档；资产与 Agent 框架解耦，可跨框架迁移、多 Agent 维护。官方 Benchmark：PersonaMem 48%→76%（相对 +59%）；云产品页细化到 47.85%→76.10%、事实召回 29.63%→79.07%，均未独立复现。

| 能力 | 聊天历史 | 普通 RAG | TencentDB Agent Memory |
| --- | :---: | :---: | :---: |
| 跨会话理解用户 | △ | △ | ✅ Chat Memory |
| 沉淀可执行经验 | — | — | ✅ Skill |
| 文档结构与关系 | — | △ 切片检索 | ✅ Wiki + Link Graph |
| 代码调用与影响范围 | — | △ 文本命中 | ✅ CodeGraph |
| Owner / 版本 / 状态 | — | — | ✅ |
| 团队分享与 Agent 配装 | — | — | ✅ |
| private / team / ACL | — | △ | ✅ |

## 2. 四类记忆资产：产生、使用、治理
| 资产 | 是什么 | 怎么产生 | 怎么用 | 怎么治理 |
| --- | --- | --- | --- | --- |
| **Chat Memory** | 跨会话的偏好、事实、决策、交互历史 | 每轮写 L0；异步 pipeline 抽 L1→L2→L3；可导入历史会话 | 绑定后 L2/L3 注入，L1/L0 工具按需召回；面板逐层查看/编辑 | 默认私有；按 Agent 记忆块共享/分配；Owner 可清空/删层 |
| **Skill** | 可复用的经验单元（SOP） | 对话结束回流 `/v3/skill/conversation/add`，达阈值归档后后台抽取；面板创建/导入 | `<available_skills>` 目录 + skill 工具；或按需选择 0–1 个/轮 | 版本单调递增、head/expired、资源文件、active/archived、默认私有 |
| **Wiki** | 文档知识库：结构化页面 + 链接图 | 上传 raw 文件 → ingest 异步抽页+建图；可外部源导入 | BM25 搜索 + 沿链接下钻读页；`/v3/tools` 自发现调用 | 以 wiki 为资产登记 Owner/version/status，按团队共享，可 allocate 给 Agent |
| **CodeGraph** | 代码符号/文件/调用关系/影响面 | 导入仓库（HTTPS 或 SSH 私有仓）→ clone → 预索引；可 auto-sync | search/explore/callers/callees/impact/node/files | 同 Wiki 的资产元数据；状态 pending/building/ready/failed |

### 2.1 Chat Memory 的 L0–L3
| 层 | 存什么 | 生成 | 召回方式 | 备注 |
| --- | --- | --- | --- | --- |
| L0 Conversation | 原始对话、工具调用日志、文档片段 | 每轮写回/导入 | 不注入；工具查询、面板核对 | 默认 SQLite，Mongo 为试验后端 |
| L1 Atom | 事实、偏好、约束、事件 | LLM 异步抽取+去重 | 检索工具，默认最多 5 条 | 云文档称每条保留下层来源链接 |
| L2 Scenario | 按项目/场景组织的知识块（Markdown） | LLM 场景抽取 | 注入 system prompt，默认 ≤3 条 | 面板可读可编辑 |
| L3 Core/Persona | 长期画像、稳定模式、团队认知 | LLM 画像合成 | 注入 system prompt | 面板显示为 core memory |

> 命名有漂移：Proxy 配置注释把 L2 写作 Agent Profile、L3 写作 Team/Global，与内核"L2 场景/L3 画像"不一致；部署时以配置和 API 为准。

### 2.2 Skill 的结构与治理
| 维度 | 实现（以 `agents/skills/setup-proxy/SKILL.md` 为样本） |
| --- | --- |
| 形态 | YAML frontmatter + Markdown 正文 + 资源文件（≤100 个，含可执行脚本） |
| 触发边界 | frontmatter `triggers:` 列表；Proxy 注入技能目录或按策略选择；默认不开启"每轮选 1 个" |
| 执行步骤 | 正文写背景、Step 1..N、每步验证、错误处理原则（样本为 10 步接入向导） |
| 版本/状态 | version 单调递增；update/patch 需 `expected_version` 乐观锁；versions 含 is_head/is_expired；active/archived |
| 提取/校验 | 对话阈值（tool_call ≥10 或 bytes ≥40KB）触发，也可 `/skill/extract` 手动；创建时校验 name 与 frontmatter 一致、路径、重名/配额；无独立"验证规则 DSL" |

### 2.3 Wiki 与 CodeGraph
| 维度 | Wiki | CodeGraph |
| --- | --- | --- |
| 产物 | Page{ref,title,path} + 图 nodes/edges/communities | 文件/符号/调用边，stats{files,nodes,edges} |
| 输入格式 | Markdown、纯文本、HTML、Word、Excel、PowerPoint、PDF（v2.0.3 新增富文档） | 代码仓库（HTTPS 公开仓、带凭据私有仓、SSH 拉取） |
| 检索 | BM25 全文；hop 0–5 图扩展、decay、minScore | search（符号名，可过滤 function/class/route 等）、explore（按文件分组返回源码）、callers/callees、impact（depth 1–10，默认 2） |
| 构建/调用 | raw write→ingest 异步，draft/processing/ready/failed；`/v3/tools/list→call` 两步自发现，7 个只读工具 | create 即 build、sync 重建、auto-sync 定时（默认关）；同左，9 个工具，非 ready 返回空结果 |

## 3. 分层与分片：什么常驻、什么按需
### 3.1 预加载 vs 按需检索
| 内容 | 进入上下文的方式 | 默认预算/开关 |
| --- | --- | --- |
| L2 + L3 记忆 | 每轮注入 system prompt | `injectL2L3=true`，`l2Limit=3` |
| L1 原子记忆 | **不注入**，暴露 `<tdai_memory_tools>` 只读工具 | `recallL1=true`，`l1Limit=5` |
| L0 原始对话 | 只写不读（工具可 search） | `writeL0=true` |
| Skill | legacy：注入 `<available_skills>` 目录 + `<skill_tools>`；按需模式每轮最多选 1 个 | 选择默认关闭；开启后上下文预算 6000 字符、正文 24000，最多加载 3 个，失败 2 次停 |
| Knowledge | `<knowledge_tools>` 两步自发现，授权后才可调 | 工具按需 |
| 会话上下文 | `<session_context>` 追加 agent/task 信息 | 每轮，可分别关闭 |

Proxy 注入块还包括 `<agent_skills>`、`<user_memory>`、`<tdai_profile_memory>`；设计原则是**不把 L0/L1 直接塞进 prompt，避免破坏上游 KV cache**。

### 3.2 检索策略
| 对象 | 策略 | 关键参数/限制 |
| --- | --- | --- |
| Chat Memory | hybrid：BM25(FTS5) + 向量 + RRF；可配 hybrid/embedding/keyword | maxResults 5、scoreThreshold 0.3；Node 无 FTS5 时关键词静默失效，降级 embedding-only |
| Skill | BM25 / embedding / hybrid | `top_k` ≤50 |
| Wiki | BM25 + 图扩展 | hop 0–5、decay 0–1、minScore |
| CodeGraph | 预索引符号图查询 | 工具参数白名单，未知字段直接 400 |
| 云 SDK | 主动召回 L1≤5 + L3 全文 + L2 仅路径；工具召回 `memory_search`/`conversation_search`/`read_scenario` 每轮合计 ≤3 次 | 稳定块放 system 末尾、动态块放 user 前，利于前缀缓存 |

### 3.3 资产如何分片
| 维度 | 切法 | 机制/证据 |
| --- | --- | --- |
| 实例 | spaceId / Memory 实例 | 路由 `/:agent/:spaceId/...`；云按实例计费与配额 |
| 团队 | team_id | 资产归属容器；成员与角色在 team 层 |
| Agent | agent_id | 云 SDK 明确"记忆抽取以 agent_id 为粒度"；Chat Memory 块 ID 为 `chat_memory-{team}-{agent}` |
| 用户/任务 | user_id、task_id（可选） | user_key 鉴权与 ACL 主体；Task 是会话绑定三元组之一 |
| 资产类型 | skill / llm_wiki / code_graph / chat_memory | `meta_asset.asset_type` |
| 可见性 | private/team/restricted/agent/task | 先按身份缩小权限范围，再检索 |
| 存储 | SQLite（本地）/ TCVDB+COS（服务化）；Wiki/CodeGraph 独立知识库 | Proxy 状态另有 Redis/COS/SQLite/FS 后端，key 含 `spaceId/userId/agentSource/sessionId` |

## 4. 团队与权限（与我们最相关，展开）
### 4.1 角色体系
| 角色 | 范围 | 能做什么 | 来源 |
| --- | --- | --- | --- |
| System Admin（全局） | 全局 | 建团队/录成员/管用户；也可用 Wiki、CodeGraph、Skill 资产管理 | OSS README / INSTALL |
| Team Admin | 团队 | 团队管理与资产协作、权限控制 | OSS README |
| Team Member | 团队 | 管理自己的 Agent 与资产、使用被授权资产 | OSS README |
| 云 Admin / Member | 团队 | Admin 用实例 API Key 登录，建/切团队、建成员发 user key、只读看 Agent；Member 用 user key 登录，管 Agent/资产/Key、可邀请成员 | 云 Memory Hub 文档 |

资产归属统一用 **Owner** 标记；Owner 自动获得该资产的管理权限。

### 4.2 可见性与 ACL
| 可见性 | 语义 | 读权限 | 管理 |
| --- | --- | --- | --- |
| `private` | 严格属于 Owner，**团队管理员也不可读** | 仅 Owner | Owner |
| `team` | 面向全队 | 团队成员 | Owner / Admin |
| `restricted` | 通过 User / Role / Agent ACL 精确授权 | 被授权主体 | Owner |
| `agent` | 用于同团队 Agent 的定向装配 | 绑定该 Agent | Owner |
| `task` | 任务维度绑定（API 支持，README 未展开） | 任务相关方 | Owner |

| ACL 项 | 取值/说明 |
| --- | --- |
| subject_type | `user` / `team_role` / `agent` |
| permission | `read` / `write` / `delete` / `assign` / `share` / `use` |
| effect / 校验 | `allow` / `deny`（默认 allow）；`/v3/meta/acl/check {asset_id, action, user_id 或 user_key, agent_id?}` |
| 级联 | 删 Skill 清 meta_asset/ACL/agent 绑定；删 Agent 先删其 skill 再 archive |

资产登记字段（`AssetEntity`）：`asset_id/team_id/asset_type/name/owner_user_id/source_type/source_ref/version/visibility/status/confidence/expires_at/last_used_at/usage_count/content_ref/metadata_json`；列表可先按类型/Owner/可见性过滤，再走 `list-accessible` 做权限筛选。

### 4.3 Agent Loadout（不同角色装载不同资产）
| 机制 | 说明 | 注意 |
| --- | --- | --- |
| 固定资产绑定 | `agent-fixed-asset/set`：`bindings[{asset_id, asset_type, injection_mode?, priority?}]` | 每 Agent 按类型挂载；priority 影响注入顺序/取舍 |
| 记忆借用 | `chat-memory/allocate` 把他人共享记忆借给 Agent，**借入 ≤2 条**；`set-agent-fixed` 全量原子替换 | 不能把 Agent 自己的记忆再分配给自己 |
| 知识装配 | `knowledge/allocate` 把 Wiki/CodeGraph 绑给 Agent，`injection_mode='tool'` | 只以工具按需出现，不整库注入 |
| 角色差异 | 官方示例：Scout 装访谈记忆/市场 Wiki/竞品 Skill；Builder 装产品 Wiki/CodeGraph/交付 Skill；Reviewer 装事故记忆/CodeGraph/发布清单 | "少给噪音，多给完成工作真正需要的记忆" |
| 默认模板/会话绑定 | `agent/set-default-template`（仅 system_admin）写 Panel 本地模板，`team-member/add` 后 best-effort 复制资产；v2.0.3 支持保存 Team/Agent/Task 默认组合 | 新成员/新 Agent 继承团队起手式；默认组合失效自动回表单 |

运行时权限流：`user_key` → `auth/verify` 拿 user_id → 首轮 session-init 选 team/agent/task（或 header 预选 `x-team-id/x-agent-id/x-task-id`）→ 按 Team/User/Agent/可见性缩范围 → 固定资产 + ACL 可读资产注入或暴露为工具 → 会话中 `mem:sync` 刷新。已知限制：Hermes/OpenClaw 当前 `x-task-id` 必填；`x-conversation-id` 需客户端管理，换新对话要换 ID；变更绑定通常要新会话。

## 5. 接入方式：本地、Proxy、云端
### 5.1 MemoryProxy"改 base URL 零代码"
Proxy 透明转发 OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`，在转发前后做 session 初始化、注入、回写、鉴权、限流与用量上报；自身不存记忆。

| 客户端 | 协议 | 配置入口 | 路由 |
| --- | --- | --- | --- |
| Claude Code | Anthropic Messages | env / `settings.json` | `/claude-code/<spaceId>/v1/messages` |
| CodeBuddy | OpenAI Chat | `~/.codebuddy/models.json` | `/codebuddy/<spaceId>/v1/chat/completions` |
| Codex | OpenAI Responses | `~/.codex/config.toml` | `/codex/<spaceId>/v1/responses` |
| WorkBuddy | Chat/Responses | `~/.workbuddy/models.json` | `/workbuddy/...` |
| **DeepSeek Harness** | Anthropic（v0.2+）/ Chat（v0.1） | `~/.dsh/profiles/web/cordis.patch.yml` + `.credentials.yaml` | `/dsh/<spaceId>/v1/messages` |
| Hermes / OpenClaw | OpenAI Chat + header 预选 | yaml / json | `/<agent>/<spaceId>/v1/chat/completions` |
| OpenCode / Pi | adapter / plugin | — | 复用对应协议（文档口径 7/8/9 类不一致，以 `agents/` 目录为准） |

### 5.2 DSH 接入细节（直接可用性最高）
| 项 | 结论 |
| --- | --- |
| 协议 | v0.2+ 走 **Anthropic Messages**（硬发 `anthropic-version: 2023-06-01`）；v0.1.x 走 OpenAI Chat |
| baseURL | `http://<proxy>:8096/dsh/<spaceId>`，**不带 /v1**（adapter 内部拼 `/v1/messages`） |
| 配置 | profile patch 数组 + `.credentials.yaml refs`；`chmod 700 ~/.dsh`、`600` 凭据 |
| session | 主 header `x-deepseek-harness-session-id`（备选 `x-session-id`）；compact 请求带 `x-deepseek-harness-compact: 1` |
| 表单 | 复用 dsh 原生 `ask_user_question`（snake_case，questions[].id 必填），不分页；无该工具时 headless bypass |
| 桌面版 | 只能选 "DeepSeek (deepseek-official)" 卡（`dsh-llm-deepseek-api-key`）；"自定义设置"走 pi-ai adapter 会过滤 `x-deepseek-harness-*` 头，session-init 永远不弹 |
| 上游/风险 | 必须为 dsh 显式配 upstream（如 `https://api.deepseek.com/anthropic`），否则 fallback 404；文档自述"生产环境暂未大规模验证"，dsh 迭代快需跟版本 |

### 5.3 本地部署与运维代价
| 形态 | 组件/端口 | 依赖 | 适用 |
| --- | --- | --- | --- |
| 三件套 Docker | memory-core 8420；memory-hub 8125+8424；proxy 8096 | Docker、两组 LLM key（memory 组 + proxy 组）、SQLite 卷 | 本地/单机小团队，一键 `start-all.sh` |
| 只装 Hub | `agentmemory/memory-hub` + 已有 core | 同上 | 已有 core |
| 源码 | Node ≥22.16；SQLite FTS5；Proxy 默认要 Redis | 开发/调试 | 单机 |
| 服务化 | TCVDB 向量库 + COS 对象存储 + Redis + Shark 配置服务；K8s | 多租户、多副本 | 云/大团队 |
| MongoDB 试验 | `start-all-mongo.sh`，mongod+mongot | 默认关；切后端不迁数据；不建议生产默认 | 观望 |

运维注意：默认凭据 `local`/admin 必须替换；Panel 与 Knowledge 是两进程；多节点需 COS + 外部 gateway，否则注入缓存互相覆盖；FTS5 缺失会让 BM25 静默失效；ClickHouse/Langfuse/Opik 均为可选埋点。

### 5.4 云端服务（腾讯云）
| 项 | 内容 |
| --- | --- |
| 产品 | 腾讯云"Agent 记忆服务 / 云数据库 Agent Memory"，产品页 `/product/agm`，文档在"腾讯云数据库 AI 服务"（product 1813） |
| 形态 | 云端 Memory 实例（存储 + 向量检索 + 内置模型算力）+ **本地部署的 Memory Hub**（Panel + Knowledge Service，Docker，挂实例配置） |
| 接入 | 控制台新建 Memory → 拿 instance_id / endpoint / API Key → Python SDK（`tencentdb-agent-memory-sdk`，自研 Agent 可用 Python/Go 接入）做"召回+写入"两步；也提供 OpenClaw/Hermes 接入指引 |
| 召回 | 主动召回 L1≤5 条、L3 全文、L2 只取路径列表；工具召回每轮 ≤3 次；写入只传清洗后的 user/assistant 原文 |
| 计费 | 按量：存储 0.02 元/万条/小时 + 模型调用 0.01 元/Credit；按小时结算；20M 条记忆上限；欠费→回收站 15 天 |
| 短期记忆 | 云产品文档特有：上下文窗口管理、冷数据卸载、关键状态保留；开源 README 未提供对应实现 |
| 角色 | 云 Memory Hub：Admin（实例 API Key）/ Member（user key） |

### 5.5 "零代码"的含金量
真正省掉的是客户端代码改动；仍需：① 改 base URL + 填 user key；② 首轮交互表单选 team/agent/task（或预置 header）；③ Proxy 配上游 LLM/模型；④ 客户端切到 Proxy 模型（不切不生效）；⑤ DSH 必须走 `/dsh/*` 且桌面版选对卡片。结论：**配置级接入，不是零配置**；对 DSH 工作台主要是"一次性配置 + 版本跟随"成本。

## 6. 冷启动与导入
| 对象 | 方式 | 结果 |
| --- | --- | --- |
| 代码库 | 面板导入公开仓/私有仓（凭据或 SSH 公钥） | CodeGraph 异步建图，ready 后可按需查询 |
| 文档 | 面板导入或外部来源 | Wiki 异步 ingest → 结构化页面 + 链接图 |
| 历史会话 | `tsx agents/asset-import.ts --source <ide> --agent-id ... --team-id ...`；dsh 扫描 skills + `session.jsonl.zstd` | 默认触发 Skill + Chat Memory 抽取，可只选一种、部分导入、断点续传 |
| 默认模板 | v2.0.1 团队自带默认 Agent；管理员可配默认模板；v2.0.3 会话默认绑定 | 新成员/新 Agent 直接读档开工 |
| 旧数据 | `migrate-v2-to-v3` 脚本 | v2→v3 数据格式迁移；先备份 |

dsh 扫盘范围：项目 `.dsh/skills`、`.agents/skills`、settings `customSkillDirs`、`~/.dsh/skills`、`~/.agents/skills`、bundled skill dir 六级 rank，只扫一层。

## 7. 客观评价：值得抄什么，哪里过重
### 7.1 我们会用到的 5 个机制
| # | 机制 | 为什么值得抄 | 我们的落点 |
| --- | --- | --- | --- |
| 1 | **资产登记表 + 绑定表**（类型/Owner/版本/可见性/状态/用量 + Agent 绑定） | 把"记忆"变成可审计、可回滚、可配额的治理对象 | DSH 侧加 asset manifest + binding 元数据 |
| 2 | **L2/L3 预加载 + L1/L0 工具按需 + 预算上限** | 既有团队语境又不炸上下文；对前缀缓存友好 | 常驻"项目/团队摘要"，明细走工具查 |
| 3 | **会话初始化绑定 team/agent/task** | 注入有明确作用域，避免"全局记忆"污染 | 工作台会话绑定 workspace/agent/role |
| 4 | **协议层透明 Proxy**（Anthropic/OpenAI 双协议） | 客户端零代码、跨框架复用；DSH 已端到端验证 | 作为可选记忆网关，不侵入 agent loop |
| 5 | **Skill 版本化 + 两段式工具自发现** | 经验可复用/可回滚；知识不整库注入 | SKILL.md 规范 + 工具发现，先人工策展 |

额外可借：`/analyse` URL marker 让模型自评"本轮资产工具是否有用"，是低成本效果验证手段（不建议常开）。

### 7.2 我们不用的 3 个部分
| 不抄 | 原因 | 替代 |
| --- | --- | --- |
| 云端托管 Memory 实例 + Credit 计费 | 数据出本地、绑定腾讯云、按量账不可控；20M 条上限我们用不上 | 本地资产库 + 自带模型 key |
| MongoDB 试验后端 + ClickHouse 分析 + 多节点 COS/Redis/Gateway | 运维半径远超收益；文档默认值与分支不一致 | SQLite + 文件；确有需要再加 |
| 默认全自动 L1→L3 蒸馏 + 自动 Skill 抽取 | 阈值/提示词模式需调；纯闲聊可能 0 产出；噪声与 LLM 成本不可控 | 人工策展 + 只对高价值会话抽取 |

其余过重点：依赖（Node/Redis/FTS5/三容器/两套 LLM key）、部署（多端口、公网可达、默认凭据必须换）、运维（300+ issues、分支/文档漂移、Mongo 无自动迁移）、多租户假设（instance/user_key/credit）、云端绑定（Memory Hub 本地壳也要连云实例）。

### 7.3 什么规模才值得用
| 规模 | 建议 |
| --- | --- |
| 单人单 Agent、临时会话 | 不用；SKILL.md + 项目摘要即可 |
| 2–5 人、2+ Agent、项目 >3 个月 | 选择性抄机制（资产表/分层/绑定），不部署全栈 |
| 10+ 人、多项目、需审计与复用 | 本地三件套或云；前提是有 Docker/Node 运维能力 |
| 要求免运维且数据可出域 | 云 Memory 实例 + 本地 Memory Hub |

## 8. 链接清单
| 名称 | 链接 | 说明 |
| --- | --- | --- |
| GitHub 仓库 | https://github.com/TencentCloud/TencentDB-Agent-Memory | 主仓库（MIT） |
| 官方文档站 | https://tencentcloud.github.io/TencentDB-Agent-Memory/ | SPA，含 best-practices 路由 |
| 腾讯云产品页 | https://cloud.tencent.com/product/agm | 托管版 Agent 记忆服务 |
| 云文档总入口 | https://cloud.tencent.com/document/product/1813 | 腾讯云数据库 AI 服务（含 Agent Memory） |
| 云 · Memory 介绍/接入 | https://cloud.tencent.com/document/product/1813/132100 、 /132102 、 /132103 | 短期/长期/团队记忆、实例与 SDK |
| 云 · 计费/用量 | https://cloud.tencent.com/document/product/1813/133512 、 /133513 、 /133760 | 按量计费、Credit、上限 |
| 云 · Memory Hub | https://cloud.tencent.com/document/product/1813/134572 | 本地 Hub + 云实例混合架构 |
| DSH 接入文章 | https://cloud.tencent.com/developer/article/2757744 | "新增 DeepSeek Harness 桌面端接入" |
| 致谢项目 | https://github.com/colbymchenry/codegraph · https://github.com/nousresearch/hermes-agent | CodeGraph / Skill 代码来源 |

## 9. 未获取与存疑（不编造）
- 官方文档站是 JS SPA，静态只抓到壳；`/best-practices` 直连 404（浏览器路由），正文未获取。
- `raw.githubusercontent.com` 间歇性失败；`api.github.com` 被限流（403），未取到 release 列表、精确 star 历史。
- 两份云文档页（132101/132104）只抓到导航壳，已从 sources 删除；云"短期记忆/上下文卸载"只拿到产品介绍级描述，未找到开源对应实现。
- Skill 的"验证规则"没有独立 schema 文档，只有示例与字段级校验（name/frontmatter、路径、重名、版本锁），"触发边界/执行步骤/校验"更接近约定而非强制 DSL。
- 分支/文档漂移：默认分支 README 显示 v2.0.3，master 的 ROADMAP 仍写 v2.0.1-beta.1；deploy README 称 proxy 默认关闭 auth/sessionInit，INSTALL_CN 称 `start-all` 默认全链路。引用时以具体文件为准。
- Star/fork/issue 数为首页快照（30.8k/3.0k/308），未独立核验；PersonaMem 提升为官方口径，未复现。

原始抓取文本均在 `docs/research/sources/`：仓库首页/中文 README、安装指南、DSH 接入、agents 接入总览、四卷 v3 API、Proxy README 与配置、Core/Knowledge README、SKILL.md 样本、CHANGELOG/ROADMAP/部署文档，以及腾讯云产品页与 6 份云文档、DSH 桌面端文章。
