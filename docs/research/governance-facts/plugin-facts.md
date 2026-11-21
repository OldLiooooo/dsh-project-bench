# 工作台插件机制：事实清单（只读核查）

范围：`workbench/**`（Host 31 个 js 文件）+ `docs/workbench-architecture-v1.zh.md`、`docs/implementation/contracts-v1.zh.md`、`docs/project-workbench-design.zh.md` §2.7/§8.3/§8.5/§12.1/§12.2、`docs/delivery.zh.md` §6。全部结论来自阅读代码，未执行代码、未做 git 操作。

## 1 权威源与写路径

- 事实源：`<workspace>/.project/project.db`（SQLite，WAL），路径定义 `workbench/host/registry.js:13,128-141`。同一规范根缓存一个 `ProjectDb`（`registry.js:145,254-292`）。
- 表清单 20 张（`workbench/host/schema.js:5-41`）：schema_migrations、project_meta、projects、stages、slices、tasks、sessions、documents、doc_versions、doc_sections、doc_fts(FTS5 trigram)、decisions、approvals、evidence、artifacts、events、links、leases、exports、imports；另有 15 条索引，其中 3 条唯一索引（`schema.js:16,17`；`schema.js:13` 的 `UNIQUE(project_id,dsh_session_id)`）。
- 唯一可写：只有 `ProjectDb` 实例，其 `tx()` 用 `BEGIN IMMEDIATE`（`db.js:91-103`），`appendEvent` 在同一事务内取 `MAX(seq)+1` 分配 seq（`db.js:109-118`）。上层全部写经 store/docs/export/import 领域函数（`store.js:1-6`、`docs.js:1-6`、`export.js:1-6`、`import.js:1-2`）；HTTP POST 只有 3 条人操作路由（`http.js:13,328-373`）；工具层写经 `deps.store/docs/leases/exporter/importer`（`workbench/host/tools/index.js:13-27`）。
- 单写者怎么保证：只靠「只有一个 ProjectDb 实例 + 每次写都过领域函数」。没有数据库级写保护：schema 无触发器、无 CHECK（grep `CREATE TRIGGER|CHECK(` = 0），只开 `PRAGMA foreign_keys = ON`（`db.js:49`）。
- 绕过面 1（sqlite 直连）：未封堵。`project.db` 是普通文件，任务会话 preset 带 `tool-bash`/`tool-pwsh` + `tool-fs` write/edit（`workbench/cordis.patch.yml:108-121`），可直接读写该文件；代码里没有任何「禁止直连 DB」的检测或校验。
- 绕过面 2（导出文件回读）：导出器只写不读（`export.js:1-6,143-177`；全库 `readFileSync` 只有 `export.js:50` 读 project.json 的 exportMap）。导入只接受 `.project/inbox` 内文件，且有 realpath 包含检查（`import.js:18-40`，拒绝码 INVALID `import.js:32`）。但入库内容与 `exports` 表无 hash 比对：把 docs/ 文件拷进 inbox 再 import 会被当作合法新版本，代码无法区分。
- 绕过面 3（project.json 手改）：人可直接编辑 `project.json`（`registry.js:39-48,242-252`），可改 exportMap（`export.js:45-55`）；但 stageTemplate 改动不生效——阶段行由模块常量 `STAGE_TEMPLATE` 建（`registry.js:12,79-125`）。

## 2 硬约束矩阵（约束 | 校验位置 file:line | 拒绝码 | 是否可绕过）

| 约束 | 校验位置 | 拒绝码 | 可绕过 |
|---|---|---|---|
| events.seq 无空洞 | `db.js:109-118`（同事务 MAX+1）；`schema.js:32` UNIQUE(project_id,seq) | 无专用码；重复仅 SQLite 约束错 | 是：外部 DELETE 无检测；读取侧无空洞校验器 |
| doc_versions 只增 | `docs.js:162`（version = currentVersion+1）；`schema.js:20` UNIQUE(document_id,version)；doc_versions 唯一 UPDATE 是 `SET frozen=1`（`docs.js:192`） | 无（构造性保证） | 是：sqlite 直改 |
| DOC_FROZEN | `docs.js:150`（writeDocumentVersion 前置检查）；`docs.js:161` 拒绝 status=frozen；冻结写入 `docs.js:181-204` | DOC_FROZEN / INVALID | 部分：不绕过冻结而是换名——任务会话写 handoff 撞冻结会自动新建 `handoff/<key>-<时间戳>` 文档（`task-tools.js:44-57`） |
| lease：他人有效租约 | `leases.js:56-62`（acquire）、`leases.js:148`（assertWriteScope）、`leases.js:99-104`（释放） | LEASE_HELD | 是：只对 4 处工具生效（见下行），PM 与 gate 路径无检查 |
| lease：过期抢占 | `leases.js:55`（active = expiresAt>now）；抢占重写行 `leases.js:67-74`，事件记 previousHolder `leases.js:86` | 无（允许） | — |
| lease：续期 | `leases.js:63` renewed；保留 created_at `leases.js:69-70`；默认 TTL 30min `leases.js:10` | — | — |
| 写作用域校验（切片维度） | 仅这 4 处调 assertWriteScope：`task-tools.js:108`(doc_write)、`task-tools.js:142`(evidence_add)、`shared-tools.js:66-68`(artifact_add)、`shared-tools.js:95-98`(doc_freeze)。另有切片归属校验：`pm-tools.js:81-84`、`shared-tools.js:38-40`、`shared-tools.js:95-97` | LEASE_HELD / PERMISSION_DENIED | 是：PM 写路径（`pm-tools.js:351-376` import_inbox、`pm-tools.js:318-348` export、`project.js:96-141` 门禁冻结/导出）完全不查租约 |
| 写作用域校验（路径维度） | **无实现**。`session_finish_task` 只要求自述 `noOutOfScopeChanges===true`（`task-tools.js:214-216`），`files[]` 只做相对路径规范化（`spec-helpers.js:94-101`）并登记 artifact（`task-tools.js:239-244`），不与工作区实际 diff 比对 | INVALID | 是：声明即通过，无任何实际检测 |
| 阶段写路径策略 | **无实现**：grep `allowedPaths|forbiddenPaths|stagePolicy|toolPolicy|scaffold|pre-execute|tools.guard|restrict(` 在 workbench 下 0 命中；无 stage-violation / stage_override 事件（`db.js:163-188` 事件表无此 kind） | — | — |
| 门禁/不可逆只能人批 | agent 工具层不暴露 approve：`pm-tools.js:219-253` 只有 decision_create，`register.js:50-56` 工具全集无 decision_resolve（测试反证 `tests/e2e/negative.test.mjs:109`、`replay-14-steps.mjs:478`）。落定在 `project.js:210-237`：`project.js:221` 不可逆未确认→CONFIRM_REQUIRED(409)；`project.js:219`→CONFLICT(409)；`store.js:547`→INVALID；`store.js:548-550` 要求 decidedBy 非空且 confirmed；gate_submit 证据≥1 `pm-tools.js:279` | CONFIRM_REQUIRED / CONFLICT / INVALID / NO_EVIDENCE | 是（身份层）：见 §5，无鉴权身份，HTTP 由传输通道充当「人」 |
| CAS expectedRevision | **无实现**：grep `expectedRevision` 在 workbench 下 0 命中。`revision` 只是单调变更号（`db.js:72-76`），用于 SSE 推送（`http.js:254-268`）与响应字段 | — | 并发只靠 BEGIN IMMEDIATE 串行 + 唯一约束 |
| 2k 上下文硬上限 | `context.js:243` hardLimit 判定；裁剪顺序 L2→L1→L0 `context.js:243-253`；层预算 l0 400/l1 300/l2 900 `project-defaults.js:31`、`context.js:34-44`；降级标记 `context.js:254-256`；注入挂载 `prompts.js:80-99` | 无拒绝码（只降级 + `context/downgrade` 事件 `prompts.js:14-33`） | 是（边界）：只约束注入；工具结果不受限——`doc_get` 单次 ≤1500 token（`read-tools.js:225`）、`project_recall` ≤500（`read-tools.js:9,181`） |
| 导出单向 | 写路径 `export.js:125-137`；越界拒 `export.js:78-80`；不强制冻结（`export.js:140` 注释「调用方策略」）；无回读代码；索引器显式跳过 docs（`indexer.js:17`） | INVALID / NOT_FOUND | 否（代码层无回读）；但无 hash 对账器验证 docs/ 未被手改 |
| 会话唯一（同切片+角色 / PM 单活 / 名字） | `store.js:389-398`（显式查询）+ `schema.js:16-17` 唯一索引；DSH 会话绑定 `store.js:353-357` | DUPLICATE_ACTIVE_SESSION / DUPLICATE_DSH_SESSION | 否（DB 约束兜底） |
| 会话命名 角色-切片-动作 | `store.js:333-351`（validateTaskSessionName） | INVALID | 否 |

## 3 编排与 Agent Teams 的关系

- `session_spawn_task`（`pm-tools.js:122-179`）→ `spawnTaskSession`（`orchestration.js:240-322`）：校验角色词（`pm-tools.js:140`、`roles.js:90-92`）→ 查重复 active（`pm-tools.js:151-154`）→ 自造 childId UUID（`orchestration.js:245`）→ 写 sessions 行（`orchestration.js:250-267`）→ 占切片租约（`orchestration.js:270-275`）→ 任务置 in_progress（`orchestration.js:280-282`）→ 组装开场简报（角色卡+2k L2+验收+PM 交代+纪律，`orchestration.js:189-234`）→ `ctx.subagents.startActivation({delivery:'parent', provider:'spawn', childId, agentPreset:'project-task'})`（`orchestration.js:298-310`）。失败回滚：endSession(failed)+releaseLease+SPAWN_FAILED（`orchestration.js:311-320`）。
- `session_send_task`（`pm-tools.js:182-216`）：要求目标 kind=task、status=active、有 dshSessionId，否则 INVALID；投递走 `ctx.subagents.sendMessage`，失败 → DELIVERY_FAILED（`pm-tools.js:212`）。反向：任务→PM 用 `notifyPm`（`orchestration.js:340-365`），回退 `agent.followup/steer`（`project.js:175-202`）。
- 关系判定：**复用 DSH 原生 subagent 服务（startActivation / sendMessage / agent followup-steer），替代原生 team 任务板与 roster**。代码中 `spawn_teammate` / team task board / agentTeam 调用 0 命中（全 workbench 仅 `client.js:3097` 一句 roster 注释）；契约明确「不挂 native team 工具」（`docs/implementation/contracts-v1.zh.md:179`）。PM preset 不含 delegation/tool-subagent（`cordis.patch.yml:29-83`），任务 preset 才含（`cordis.patch.yml:149-163`），`maxDepth: 2`（`cordis.patch.yml:14-18`）。
- 插件确实自建一套团队/任务板：自有 `slices`/`tasks`/`sessions` 表（`schema.js:9-13`）+ 自有面板树/决策收件箱（`client.js`），不写 DSH 原生 team 表。
- 依赖原生 `writeScopes`（提示性）的地方：**无**（grep `writeScope` 在 workbench 下 0 命中）。实现里 `slices` 表没有 write_scopes 列（`schema.js:10`），替代物是「切片 id 归属 + lease 租约」；设计文档 §2.7#3/§8.3 的 writeScopes 提示语义在当前代码中未落地。

## 4 git/CI 治理实现度（§12.2 十条逐条）

前提事实：Host 无 repo / deliver / reconcile / process_health 模块（`workbench/host/` 31 个文件，无同名文件；`reconcileStaleSessions` `orchestration.js:371-406` 只对账会话状态）。grep：`worktree` 0、`check-?run` 0、`pull request|PR|merge`（host）0、`node:child_process`（host）0。仅 `registry.js:61-76` 生成 `.project/.gitignore`（排除 project.db/-wal/-shm/exports/inbox/packages）。dev 脚本的 child_process 只用于起 DSH（`scripts/dev-instance.mjs:15`），非 git。

| # | §12.2 规则 | 结论 | 证据 |
|---|---|---|---|
| 1 | WorkItem→Claim→Branch→Delivery→PR→CheckRun→Evidence 唯一状态 | 未实现 | 无 repo/deliver 服务、无 branch/PR/check_run 表（`schema.js:5-41`）；只有 slices/tasks/evidence |
| 2 | 唯一交付入口 deliver，手工 commit/push 被双重拒绝 | 未实现 | 无 deliver API；任务会话可用 bash/pwsh（`cordis.patch.yml:108-113`）直接 git |
| 3 | 开工前自检：同工作项已有开放分支/PR/未合入 → 拒绝再开 | 未实现 | 近似物仅会话层面：`pm-tools.js:151-154`、`leases.js:56`；与分支/PR 无关 |
| 4 | 一工作项至多一交付分支、一开放 PR，合并后自动清扫 | 未实现 | 无对应实体 |
| 5 | 多会话共享主树时拒绝收尾，强制 worktree 隔离 | 未实现 | 无 worktree 调用；`session_finish_task` 不检测主树（`task-tools.js:210-277`） |
| 6 | 收尾对账门：证据/记录/计数/状态/恢复路径/旧协议引用 | 未实现（有部分近似） | 仅有：handoff 非空 `task-tools.js:213`、证据≥1 `task-tools.js:235-237`、`noOutOfScopeChanges` `task-tools.js:214-216`；无记录/计数/恢复路径/旧协议检查 |
| 7 | 计数、索引、仪表盘、摘要全部由权威源生成 | 未实现（有部分近似） | overview counts 由 SQL 生成 `snapshot.js:107-141`；timeline.md 由 events 生成 `db.js:218-241`；但无「手写数字入文档即失败」校验 |
| 8 | CI 能力分级：远端/check-run 只是证据，人类批准是唯一批准来源 | 未实现（有部分近似） | 无 CI/check-run 概念；人批准侧成立：`project.js:220-222` CONFIRM_REQUIRED、`store.js:548-550` |
| 9 | 流程迁移带清扫 + 回滚门槛 | 未实现 | 只有线性 `schema_migrations`（`schema.js:6,45-52`） |
| 10 | 度量流程成本（治理占比/重复收尾/滞留分支/未验收积压/假绿） | 未实现 | 无 process_health；面板 health 仅 blocked/attention/on_track 三值（`snapshot.js:116`） |

结论：§12.2 十条**完全实现 0 条**；#6/#7/#8 存在局部近似物，其余 7 条在代码中无任何对应实现。

## 5 人批准入口与鉴权

- HTTP 入口：前缀 `/project-workbench/api`（`http.js:8,420-436`）。GET 6 条、POST 3 条（`http.js:12-13`）：`POST /decision`（`http.js:341-354` → `resolveDecisionAction`）、`POST /init`、`POST /pm`。门禁批准动作（冻结+导出+阶段推进+approvals 行）由 `project.js:96-141` 在同事务内执行。
- UI 入口：面板决策收件箱，approve/reject + 不可逆勾选二次确认（`client.js:3354-3460`，confirmed 组装 `client.js:3399`），请求 `client.js:1708`。第三入口：actionCards kind `project-decision`（`cards.js:9-15,40-88`），但 `cordis.patch.yml` 未挂 action-cards（grep 0），仅在服务存在时经 `ctx.inject` 注册（`cards.js:92-105`、`index.js:31`）。
- 鉴权：`handler` 第一行即 `rejectRequest`（`http.js:376` → `http.js:75-98`），调用宿主 `ctx.connection.requestRejection(req)`；connection 服务缺失时 fail-closed 直接 401（`http.js:77-80`）；抛错 → 403；返回码按 401/403。另有 64KB body 上限 → 413（`http.js:10,101-123`）、content-type 必须 application/json → 415（`http.js:126-129`）。
- 人身份判定：无独立人身份/角色/权限模型。`decidedBy` 在 HTTP 路径不取自请求体（`http.js:345-350` 只传 id/status/rationale/confirmed），下游默认字符串 `'user'`（`project.js:223`）；actionCards 路径硬编码 `decidedBy:'user'`（`cards.js:71`）。因此「人」＝通过宿主 Host/Origin 围栏 + 登录 cookie 的请求（契约 §0 `contracts-v1.zh.md:18-19`）；`approvals.approved_by`（`schema.js:26`）只存该字符串，无 per-user 追溯。
- agent 到达面：任务会话持有 bash/pwsh（`cordis.patch.yml:108-113`），代码层没有对「请求是否来自 agent」的额外拦截；防护完全落在宿主 cookie/origin 围栏上。

## 6 已知边界核对（docs/delivery.zh.md §6）

| delivery §6 项 | 是否仍成立 | 核对证据 |
|---|---|---|
| 1 Team 只读转录视图暂缓 | 成立 | `client.js:3097` 注释明示 deliberate deferred；无 transcript 组件；面板只有会话列表/状态 |
| 2 actionCards 决策卡默认未挂载，用 ctx.inject 安全注册 | 成立 | `cards.js:92-105` 走 `ctx.inject(['actionCards'])`；`cordis.patch.yml` 无 action-cards 行（grep 0）；未挂载时 state 记 not-mounted 并跳过 |
| 3 任务会话收工后 DSH agent 仍 idle 存活 | 成立 | `session_finish_task` 仅 `endSession`（`task-tools.js:258`）+ `invalidateActorCache`（`task-tools.js:260`）；host 内无 agent dispose/interrupt 调用（grep 仅 `http.js:429` api.dispose） |
| 4 无 WebGL/3D，只做 2D 树 | 成立 | `client.js` grep `webgl|three.js|css3d` = 0 命中 |
| 5 project.db 不入 git，project.json 与导出 docs 入 git | 成立 | `registry.js:61-76` 写入的 required 名为 project.db / project.db-wal / project.db-shm / exports/ / inbox/ / packages/；project.json 不在排除列表 |
