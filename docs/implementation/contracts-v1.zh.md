# 工作台插件实现契约 v1（Lead 定稿，模块间接口）

> 2026-11-11。施工图：docs/workbench-architecture-v1.zh.md；UI：workbench-ui-architecture-v1.zh.md。
> 本文只定义模块边界/接口/文件所有权，供并行实现使用；不改架构。

## 0. 运行环境事实（已实测，不要重复踩坑）

- 运行版 DSH 0.2.2-rc.1；源码/包解包在 workspace/.runtime/（只读参考，可 grep/read）。
- DSH CLI 调用方式（bash）：
  ELECTRON_RUN_AS_NODE=1 "C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe" --expose-internals "C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" ...
- 本会话沙箱只允许写 workspace；~/.dsh 不可写。验证一律用 workspace 内隔离 DSH_HOME（如 .devhome）。
- 插件 Host 代码**不要 import @deepseek-ai/* 包**（模块解析不保证）。只用 node: 内置模块 + ctx 服务。
- 工具注册直接给出 JSON Schema 定义对象（等价 defineTool 产物）：
  { name, description, parameters: {type:'object',properties:{...},required:[...]}, output:{schema:{...}, render(args,value){return [{type:'text',text:'...'}]}}, async execute(args, exec) }
  exec: { agent?, signal }; exec.agent.session.id = DSH 会话 id；exec.agent.session.header.cwd = 会话 cwd。
- 系统提示注入：ctx.systemPrompt.section({name,order,text}) 与 ctx.systemPrompt.context({name,order,text: fn(context)})；
  context 的 text 函数每步组装/刷新时重算，context.agent 是当前 agent，context.scope 同。返回 '' 表示不注入。
- 自定义 HTTP 路由必须鉴权：ctx.webServer.register({kind:'exact'|'prefix',path,handler})，
  handler 内先 if (ctx.connection.requestRejection(req)) → 401/403。SSE 不会被 gzip 包装，可写 text/event-stream。
- 客户端插件：client.js 用 window.__ModuleLoader__.load({id:'@local/dsh-project-workbench', factory(require){...}})；
  React 用 require('react')；不要 import 其它 @deepseek-ai client 包。
  slot 注册：ctx.slots.inject(name,()=>ctx.slots.register({name, key|id, order, locale, inject:(sessionId)=>({...})}, Component))；
  session 作用域 slot 的组件收到 sessionId 与 t；根作用域（main/sidebar.panellist）没有 sessionId。
- 客户端可用 ctx 服务：slots, locale, layout（selectPanel）, uiWorkspace（openSession/startSession）, sessions, workspaces。
- 任务会话编排：ctx.subagents.startActivation({delivery:'parent', childId, provider:'spawn', label, request:{prompt:[{type:'text',text}], parent: pmAgent, agentPreset:'project-task', agentOptions:{provider,model}}, signal})
  → 返回 { childId, result, dispose }；childId 先自己生成 UUID 再传入（本地后端要求）。
  PM→任务消息：ctx.subagents.sendMessage(pmAgent, childDshSessionId, [{type:'text',text}], {signal})。
  任务→PM 消息：ctx.subagents.sendMessage(taskAgent, pmSessionId, [...], {signal})。
  唤醒 PM 的宿主通知：构造 UserMessage { id: randomUUID(), role:'user', content:[{type:'text',text}], source:{kind:'project-workbench'} }，
  对 ctx.agents.get(pmDshSessionId) 调 .followup(msg)（空闲时启动）或 .steer(msg)（运行中）。
- 会话识别：ctx.on('session/created', session => ...)；session.header.agentPreset / session.header.cwd / session.id。
- PM 会话由用户在客户端用 preset 'project-office' 新建（ctx.uiWorkspace.startSession(workspaceId,{agentPreset:'project-office'})）。
- 技能注册：ctx.skills.register({name, description, content, invocation:{modelInvocable:true,userInvocable:true}})。
- 工作区列表：ctx.workspaceRegistry.list() → entity { id, path, title, sessionIds, status() }。
- SQLite：node:sqlite DatabaseSync；WAL；FTS5 trigram 可用。

## 1. 目录与写作用域（禁止越界写）

workbench/  = 插件 bundle 根
- package.json / icon.svg / locale/*           → Lead
- index.js（host 入口组装）                     → Lead
- host/schema.js / host/util.js                → Lead
- host/db.js / host/store.js / host/events.js  → T1 db-core
- host/docs.js / host/leases.js / host/export.js / host/import.js → T1 db-core
- host/registry.js / host/project.js / host/snapshot.js / host/http.js → T2 host-api
- host/tools/**（全部工具定义与注册）            → T4 orchestration
- host/orchestration.js / host/prompts.js / host/context.js / host/skills.js / host/cards.js → T4 orchestration
- host/session-hooks.js                        → T4 orchestration
- cordis.patch.yml / presets/*                  → T4 orchestration
- client.js                                    → T3 client-ui
- tests/unit/db*.mjs, docs/... 笔记             → T1;  tests/unit/api*.mjs → T2
- tests/e2e/**, scripts/**, docs/implementation/implementation-notes.zh.md → T5 verify

## 2. host/registry.js（T2）— 项目库注册表

const registry = createRegistry(ctx)
- registry.rootForWorkspace(workspaceId|rootPath) → { workspaceId, root, title }
- registry.open(rootPath, {create:false}) → ProjectDb | undefined
- registry.ensure(rootPath, {name, workspaceId}) → ProjectDb（create=true 时建 .project/、DB、project.json、阶段行）
- registry.listProjects() → [{workspaceId, root, title, exists, project?}]（按 workspaceRegistry 顺序）
- registry.pmSession(rootPath) → 项目 sessions 表 kind='pm' status='active' 行 | undefined
- registry.closeAll()
所有 workspace 必须在 workspaceRegistry 中存在（root 校验 realpath 相等），否则拒绝。

.project/ 布局：project.db / project.json / exports/docs/ / exports/timeline.md / inbox/ / packages/
project.json：{format:1, projectId, name, root:'.', createdAt, stageTemplate:[{key,name,gate}], exportMap:{type→docs/子目录}, budget:{l0:400,l1:300,l2:900,spare:400,recall:500}}
阶段模板（7 段）：S1 产品(G1) S2 UX(G2) S3 架构(G3) S4 实现(G4) S5 测试(G5) S6 发布(G6) S7 复盘(G7)

## 3. host/store.js（T1）— 领域写操作（全部接收 db, input；返回数据对象）

幂等 ID：newId('doc') 等。全部写操作必须在 db.tx(() => {...; db.appendEvent(...)}) 内。
错误用 Error + error.code（如 'LEASE_HELD','DOC_FROZEN','DUPLICATE_ACTIVE_SESSION','NOT_FOUND','INVALID'）。

slices: createSlice(db,{type,key,title,parentId,acceptance}) → slice; getSlice; listSlices(db,{status}); updateSliceStatus
tasks: createTask(db,{sliceId,title,acceptance}) → task; updateTask(db,{id,status,assigneeSession}); listTasks(db,{sliceId,status})
sessions: createSession(db,{name,kind,role,sliceId,dshSessionId,parentSessionId,provider,model,reasoningEffort,context}) → session
  （校验命名：kind='task' 必须 role-切片-动作 三段；role ∈ 产品/UX/架构/码农/测试/发布/复盘；
    同一(project,slice,role) 已有 active 任务会话 → code DUPLICATE_ACTIVE_SESSION；kind='pm' 名称固定 项目办公室）
  findSessionByDshId(db,dshSessionId); listSessions(db,{kind,status}); endSession(db,{id,status,handoffId})
decisions: createDecision(db,{sliceId,kind,title,question,options,recommended,consequences,irreversible,stage,gate,createdBy}) → decision
  resolveDecision(db,{id,status,decidedBy,rationale}) → decision（pending→approved/rejected；irreversible 必须 decidedBy 非空且 payload.confirmed===true）
  listDecisions(db,{status,sliceId})
docs: createDocument(db,{sliceId,type,logicalKey,title,stage,ownerSession}) → doc
  writeDocumentVersion(db,{docId,content,authorSession,title?,status?}) → {doc, version}（旧版本不可变；frozen 文档拒绝覆盖 → DOC_FROZEN；同内容 hash 返回已有版本不新增）
  freezeDocument(db,{docId,version?})；getDocument(db,id)；listDocuments(db,{sliceId,type,status})；
  listDocVersions(db,docId)；getDocVersion(db,docId,version)；searchDocSections(db,{query,limit,sliceId}) → [{documentId,title,version,heading,snippet,score}]
  rebuildDocSections(db,docId)（从最新版本重建 doc_sections+doc_fts，可重复执行）
evidence: addEvidence(db,{sliceId,taskId,kind,uri,contentHash,command,resultSummary,createdBy})；listEvidence(db,{sliceId})
artifacts: addArtifact(db,{sliceId,kind,path,contentHash,bytes,metadata}); listArtifacts
leases: acquireLease(db,{sliceId,sessionId,ttlMs,reason}) → lease（未过期他人持租 → LEASE_HELD；同 session 覆盖续期）
  releaseLease(db,{sliceId,sessionId}); checkLease(db,{sliceId,sessionId}) → {ok, holder?}
  assertWriteScope(db,{sliceId,sessionId})（写文档/证据/任务状态前调用；PM 无租约限制，项目 role check 由工具层做）
events: timeline(db,{afterSeq,limit,kinds,sliceId})→已提供； timelineMarkdown(db) → string
export: exportDocument(db,{docId,version,root,exportMap}) → {path,hash}（写 docs/ 下；只在 frozen/门禁/发布调用；记录 exports 行+事件；文件不读回）
  exportTimeline(db,{root}); exportSnapshot(db,{root})（exports/docs 全量快照 + exports/timeline.md）
import: importInboxFile(db,{sourcePath,docId?,type?,title?,importedBy}) → {doc,version}（读 .project/inbox 下文件为**新版本**；记录 imports+事件）

文档类型 type：prd|ux|adr|design|spec|report|handoff|retro；logicalKey 例 prd/payment-refund。
事件 kind（全部小写，前缀分类）：project/init, stage/change, slice/create, slice/status, task/create, task/status,
session/create, session/end, doc/create, doc/version, doc/freeze, doc/export, decision/create, decision/resolve,
gate/submit, gate/approve, gate/reject, evidence/add, artifact/add, lease/acquire, lease/release, import/inbox, export/snapshot, context/downgrade

## 4. host/project.js + snapshot.js（T2）

- initProject(registry,{workspaceId})：ensure + 写 project.json（若不存在）+ 初始化 S1 为 active（stage/change 事件）+ 返回 overview
- overview(db) → {project:{id,name,root,stage,period,health}, counts:{slices,tasks,sessions,docs,pendingDecisions}, stage, stages}
- tree(db) → [{stage, slices:[{slice,counts,tasks:[],sessions:[],documents:[],decisions:[],evidence:[]}], timeline:[...]}]（节点限制：默认只展开 stage→slice，子对象按 counts 汇总；>200 节点时带 truncated:true）
- sliceDetail(db,sliceId) → 全量子对象 + 最近事件
- docPreview(db,docId,{version}) → {doc, versions:[], content, frozen}
- timelinePage(db,{afterSeq,limit,kinds,sliceId})
- pmEnsure(db)（宿主不建会话，只读记录）

## 5. host/http.js（T2）— 客户端数据通道（全部先过 requestRejection）

前缀 /project-workbench/api（kind:'prefix'）。GET 返回 JSON；POST 只接受人操作。
- GET  /projects → {projects:[{workspaceId,root,title,exists,initialized,projectId,stage,pendingDecisions}]}
- GET  /snapshot?root=<abs> → {revision, project, stages, tree, sessions, pendingDecisions, recentTimeline}
- GET  /slice?id= → sliceDetail；GET /doc?id=&version= → docPreview
- GET  /timeline?root=&after=&limit= → events
- GET  /events?root=&after= → SSE（event: change，data:{revision}，25s 心跳）；客户端收到后重新 GET snapshot
- POST /init {root} → 初始化项目
- POST /decision {root,id,status:'approved'|'rejected',rationale,confirmed} → resolveDecision + 若 kind=gate 执行门禁动作 + 唤醒 PM
- POST /pm {root,dshSessionId} → 绑定/切�� PM 会话（客户端 startSession 后登记）
- 门禁动作（approve）：冻结该 gate 相关文档、导出到 docs/、stage 推进（stage/change + gate/approve 事件）、写 approvals 行。
- 所有写路径必须 db.tx 且写事件；错误 → {error:{code,message}} 状态码 4xx/5xx。
- 变更推送：任意 db 写后调 bus.emit(root, revision)（EventEmitter 内存广播），SSE handler 订阅。

## 6. host/context.js（T4）— 2k 上下文编译

compileContext(db,{roleKind:'pm'|'task',sessionId,role,sliceId,step,lastSliceId}) → {text, used, parts:{l0,l1,l2}, degraded:boolean}
- L0 ≤400：项目名/阶段/门禁/当前切片/待决策数/活跃任务会话数（每步）
- L1 ≤300：角色卡（PM/产品/UX/架构/码农/测试/发布/复盘）读写边界+开工收工清单（会话启动/切切片注入）
- L2 ≤900：当前切片 title/status/owner/handoff 摘要 + 本任务 acceptance + 相关文档标题与 1 行摘要 + 最近 3 条事件
- 余量 400 留给工具结果；总注入硬上限 2000（estimateTokens），超限先裁 L2 再裁 L1，l0 最后；degraded=true 时注入一行 "上下文已降级，使用 project_recall/doc_get 按需查询"。
- 角色卡内容在 host/roles.js（T4 拥有，静态）。

## 7. host/tools/**（T4）— 工具清单（名字固定，参数为纯 JSON Schema）

所有工具 execute 里通过 exec.agent 解析身份：resolveActor(db, exec.agent) → {kind:'pm'|'task'|'subagent'|'unknown', session, sliceId, role, name}
未知会话调用项目工具 → 错误 NOT_PROJECT_SESSION（除非 project_status 只读上下文允许）。
工具（model 可见名）：
- project_status（任何人）：当前项目/阶段/切片/待决策/活跃任务会话（读）
- project_init / project_switch_slice？（PM 专用，谨慎；用 project_*
- project_brief({sliceId?})：L2 简报
- project_recall({query,hint?,limit?})：≤500 token 片段（doc 章节/决策/事件）
- doc_list / doc_get({id|logicalKey, version?}) / doc_write({docId|logicalKey,type,title,sliceId,content,mode:'new_version'|'create'}) / doc_freeze({docId}) / doc_export({docId})
- task_create({sliceId,title,acceptance}) / task_update({id,status}) / task_list({sliceId?})
- slice_create({key,title,type,parentId?}) / slice_list / slice_update({id,status,ownerRole?})
- session_spawn_task({role,sliceKey,action,prompt,provider?,model?,reasoningEffort?,taskId?}) —— PM 专用；命名=角色-切片-动作；写 sessions 行+租约+事件；校验重复；返回 {session,dshSessionId}
- session_send_task({name|sessionId,message}) —— PM 专用；ctx.subagents.sendMessage
- session_task_report({message,handoff?}) —— 任务会话专用；写 handoff 文档/事件，然后向 PM 发消息
- session_finish_task({status:'done'|'failed',handoff,evidenceIds?,files?}) —— 任务会话收工：校验（有 handoff、证据>=1、片外零改动声明），结束会话、释放租约、通知 PM
- decision_create({title,question,options,recommended,consequences,irreversible,sliceId?,stage?,gate?})
- decision_resolve —— 不提供！人只能在面板/PM 对话中拍板（agent 不得代批）
- evidence_add({kind,uri?,command?,resultSummary,contentHash?,sliceId?,taskId?})
- artifact_add({kind,path,contentHash?,bytes?,metadata?,sliceId?})
- gate_submit({stage?,gate,docIds,evidenceIds,summary}) — PM：生成 approvals pending + 决策卡（kind=gate）
- export_project({kind:'docs'|'snapshot'}) / import_inbox({path,docId?,type?,title?})
- 权限：session_spawn_task/slice_create/task_create/gate_submit/export_project 仅 PM；doc_write/evidence_add/session_finish_task 仅 task（PM 可 doc_write? 否）；project_recall/doc_get/status 双端可用。
- 工具可见性用 ctx.tools.register(def,{when}) 过滤：when 根据 exec 之外的 {agent} 解析 actor；非项目会话整组隐藏。

## 8. host/prompts.js + session-hooks.js（T4）

- prompts：ctx.systemPrompt.context({name:'workbench:l0', order: 略, required:false, text:(c)=> actor 判定后返回 L0}) 与 'workbench:l1l2'（由 session-hooks 维护的 per-session 状态决定是否注入）。
- session-hooks：
  - ctx.on('session/created', s)：若 header.agentPreset==='project-office' 且 cwd 可解析项目根（findProjectRoot 或 workspaceRegistry）：确保项目初始化+登记 PM 会话行（kind=pm）；若 header.agentPreset==='project-task'：按 dshSessionId 找到预登记 task 行绑定 model/provider。
  - ctx.on('agent/pre-step', ...) 或 session 事件：更新 per-session {step,lastSliceId}，决定 L1/L2 注入。
  - ctx.on('session/event', (session, event))：记录 model/selection → 更新 sessions.model；turn/end 不写库（避免噪音）。
  - ctx.on('session/disposed', s)：把 active 任务行标记 interrupted（事件 session/end），不删数据。
- 会话恢复：插件 apply 时对 DB 中 active 但 DSH 无 live agent 的会话标 interrupted（附 event）；PM 会话保留 active（重启后用户打开继续）。

## 9. cordis.patch.yml（T4）— 必须包含

- insert 本插件行 id: project-workbench, name: '@local/dsh-project-workbench'
- override subagent 行：config { maxActiveSubagents: 8, maxDepth: 2 }（保证任务会话能拉子 agent；字段以运行版 schema 为准，先 dsh --dump-config-schema 校验）
- insert preset-project-office（@deepseek-ai/dsh-agent-preset, id project-office）：PM 工具集（读文件、skill、present、ask_user、todo、project 工具全局可见性由 when 管；不含写文件/代码工具；不含 subagent 工具）
- insert preset-project-task（id project-task）：完整执行集（fs 读写、bash/pwsh、jobs、skill、todo、web、present、subagent（maxDepth 继承 2））；不含 ask_user_question
- 两个 preset 都挂：persona/agent-instructions?/time-context/compaction group/delegation group（task）/skills
- 不挂 native team 工具（PM 用工作台 session_spawn_task；避免绕过命名/切片校验）

## 10. client.js（T3）— 必须交付

- sidebar.panellist 入口「项目」+ main keyed 面板 key='project-workbench'（ctx.layout.selectPanel）
- 面板信息架构：项目切换（多 workspace）→ 头部（项目名/阶段/周期/健康/进入 PM 对话/初始化）→ 左树（阶段→切片→任务/会话/文档/决策/证据）→ 右侧详情 tabs（树/会话/文档/决策/时间线）
- 树节点状态色（进行中/待验收/完成/阻塞/待决策）、版本号、角色；点击节点右侧详情；文档双击预览（DB 内容）；会话行显示角色/模型/状态/产物链接（Team 只读转录暂缓）
- 决策收件箱：pending 决策卡（问题/选项/推荐/不返工后果/不可逆警示）→ 批准/驳回（不可逆二次确认）→ POST /decision → 刷新
- 时间线：事件流（谁/切片/动作/对象/时间）+ 过滤（阶段/角色/kind）
- PM 会话页头徽章：conversation.session.header.utilities → 阶段/当前切片/待决策数/回项目按钮
- PM 输入框状态条：conversation.composer.dock → 今日摘要（活跃切片/待决策/最近事件 1 行）
- 所有数据来自 /project-workbench/api（fetch，credentials same-origin）；事件用 EventSource('/project-workbench/api/events?root=...')，收到 change 后刷新 snapshot；不轮询
- 样式：只用 var(--dsw-*) token；类名前缀 wb-；<style> 注入 document.head（官方插件同款）；i18n：ctx.locale.register('workbench',{zh,en}) + t
- 空项目：显示「初始化项目」；PM 会话不存在：显示「进入 PM 对话」按钮（startSession workspaceId{agentPreset:'project-office'} 后 POST /pm 登记 dshSessionId）

## 11. 验收（T5 负责）

1) 域模型单测（node --test）：文档版本只增/冻结拒绝/DOC_FROZEN、事件 seq 无空洞、租约抢占拒绝、命名唯一。
2) 14 步业务预演脚本：直接调用 store/tools 层模拟 用户→PM→产品/UX/架构/码农/测试→门禁→导出→时间线；断言三问可答。
3) HTTP 负向测试：无 cookie 访问 /project-workbench/api/* → 401/403；越权 POST。
4) 隔离实例：DSH_HOME=workspace/.devhome，dsh plugin --profile web add workbench；启动 dsh web --port 52999；curl 带 cookie 校验 snapshot/SSE；用户浏览器目测面板。
5) 2k 预算断言：构造大切片注入内容，estimateTokens<=2000，触发降级标记。
6) 恢复：备份 project.db → 重建 → 导出可重生成；重启实例后 snapshot 一致。
