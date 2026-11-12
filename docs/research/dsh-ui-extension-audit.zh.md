# DSH Client UI 扩展能力审计（工作台：项目/PM/team + 树状驾驶舱 + 可选 3D）

> 审计对象：DSH 源码 checkout `C:/Users/oldap/Documents/deepseek-harness-a/deepseek-harness`（**0.2.1-rc.2**，commit `687f282e86`，2026-10-17）；本机运行版约 **0.2.2-rc.1**（差异单列）。
> 方法：只读源码 + 官方子系统文档 + 官方 Agent skill 规则；已用 `rg` 定位符号与行号。未在运行实例上做 PoC 的项标 **[待验证]**。
> 标注：**[源码]** = 直接读到实现/声明；**[文档]** = 官方 README/子系文档；**[推断]** = 基于上述证据的判断；**[待验证]** = 需运行实例 `cordis_inspect_query` 或 PoC 确认。
> 边界：不改 DSH 本体、不做 iframe 嵌入、不 import Harness Client 包；本文只回答「第三方 bundle 能做什么」。

---

## 0. 结论速览

| # | 问题 | 结论 | 证据强度 |
|---|---|---|---|
| 1 | 能否加 `sidebar.panellist` + `main` 面板？ | **能**。侧栏入口（list, root）+ 全局面板（keyed, root）+ `ctx.layout.selectPanel(id)`，已有两个一等插件按此实现 | [源码] |
| 2 | 能否读 agentTeam roster / 任务板做只读 team 视图？ | **能拿数据，但读法分两档**：会话作用域内用 `useProjection('agentTeam')` 最稳；根作用域页面需自行注入 `sessions` 读 Session 投影 **[待验证]** | [源码]+[待验证] |
| 3 | 能否阻止/隐藏原始会话或只读？ | **原生没有「用户只读会话」机制**；原生会话树不能过滤/隐藏，只能整体替换 `sidebar`（不建议）。只读 team 视图要在自有面板自绘 | [源码]（未找到）+[推断] |
| 4 | canvas/WebGL/three.js 可行吗？ | **技术上可行**：client 是预打包 CJS bundle，可内置 npm 依赖；仓库内有 canvas 先例（PDF 预览），无 WebGL/three 先例；无 iframe。3D 建议做成可选/延迟渲染 + 2D/CSS3D 降级 | [源码]+[待验证] |
| 5 | 槽位怎么映射？ | 驾驶舱 = `main` 面板 + `sidebar.panellist` 入口；会话内 = `conversation.session.header.utilities` + `conversation.composer.dock` + `tool.call.toolview`；设置 = `settings.section`；见 §7 | [源码] |

---

## 1. 能力总表（第三方 bundle 视角）

| 能力 | 可行 | 依赖/入口 | 关键约束 | 证据 |
|---|---|---|---|---|
| 新增全局面板 | ✅ | `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key: PANEL_ID, ... }, Page))` | `main` 是 keyed/root；key 即 panelId；跳转 `ctx.layout.selectPanel(PANEL_ID)` | ui-layout/src/client/index.ts:73,183；ui-plugin-manager/src/client/index.ts:111-139,137 |
| 侧栏入口 | ✅ | `ctx.slots.inject('sidebar.panellist', () => register({ name:'sidebar.panellist', id, order, label, locale }, Icon))` | list/root；图标由侧栏渲染，点击逻辑自管（通常 selectPanel） | ui-sidebar/src/client/index.ts:83；SidebarRoot.tsx:56,71；ui-plugin-manager/src/client/index.ts:144-151 |
| 打开/新建会话（PM） | ✅ | `ctx.uiWorkspace.openSession(target)`；`startSession(workspaceId?, {agentPreset})`；`openWorkspace(id, beforeOpen?, {agentPreset})` | `target` 支持 SessionId 与 addressed-subagent；打开后 `selectPanel(null)` 回对话 | ui-workspace/src/client/navigation.ts:44,66-76,88,276,320 |
| 读团队 roster/任务板 | ⚠️ 有通道 | Lead Session 的 `agentTeam` projection（members/tasks/failure） | 数据是会话投影；根作用域读取方式 **[待验证]** | docs/subsystems/agent-team.md#web-projection；experimental/agent-team/src/projection.ts:105,111,250,270 |
| 读子会话消息（只读） | ⚠️ 有通道 | Client `ctx.sessions` → Session 的 event window / projections | 不能 import 官方 Chat 组件，只能自绘简化投影；API 公开度 **[待验证]** | docs/subsystems/web-client.md:42-46；session.ts:157,164 |
| 原生会话列表过滤/隐藏 | ❌ | 无过滤 slot；仅 `sidebar.workspaces.session.menu.item` / `.row.action` 可加动作 | 要「只显示 PM」只能替换 `sidebar`（single）或另做导航面 | ui-workspace/src/client/index.ts:294,317-325；ui-layout/src/client/index.ts:68 |
| 会话只读（禁止输入） | ❌（未发现） | 无 per-session read-only 策略；access 是 owner/非 owner Peer 的权限模型 | 需自绘只读投影，或改 DSH 本体 | ui-session/src/client/index.ts:171-183；web-client.md:60 |
| 会话内徽章/常驻条 | ✅ | `conversation.session.header.utilities`（list/session）；`conversation.composer.dock`（list/session） | 宿主已有同 id 项可被同 id 替换（priority 决定） | ui-conversation/src/client/apply.ts:434,460；docs/subsystems/slots.md:62 |
| 自定义工具卡 | ✅ | `tool.call.toolview`（keyed，按工具名） | 仅影响该工具的展示，不改工具语义 | ui-skill/src/client/index.ts:89-90；slots.md 层级图 |
| 自定义 Chat 行 | ⚠️ 较重 | `conversation.chat.node`（keyed，`ChatNodeKind`） | 需注册 ConversationNodeDefinition；[推断] 适配成本高 | ui-chat/src/client/apply.ts:218；docs/subsystems/conversation.md |
| 右侧栏 tab | ✅（[待验证] API 细节） | `ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab`（keyed） | 会话内驾驶舱形态 | ui-sidebar-right/README.md |
| WebGL/canvas | ⚠️ | React 组件内 canvas；依赖打进 client bundle | 无 iframe；主题只读 token；降级自备 | ui-sidebar-documentpreview/src/client/pdf/text.ts:1；practices.md:33 |

---

## 2. Q1 导航：侧栏入口、页面、工作区→项目→PM

### 2.1 已验证的两个落地范式

- **全局面板 + 侧栏入口**：`ui-plugin-manager` 在 `main` 注册 keyed 面板（`{ name:'main', key: PANEL_ID, children:{...} }`），并在 `sidebar.panellist` 注册 `{ id, order, label, locale }` 入口；内部用 `ctx.layout.selectPanel(PANEL_ID)` 跳转。[源码] `packages/client/ui-plugin-manager/src/client/index.ts:111-139,144-151`
- **同一模式的第二个先例**：`ui-schedule` 同样注册 `main` keyed 面板 + `sidebar.panellist` 入口。[源码] `packages/client/ui-schedule/src/client/index.ts:168-182`
- **面板合法性由 layout 校验**：`LayoutController.selectPanel` 在 `hasMainPanel(id)` 为假时抛错；`conversation` 是保留 key，`null` 表示回到当前会话。[源码] `packages/client/ui-layout/src/client/service.ts:36,72-78`；[文档] `packages/client/ui-layout/README.md`

### 2.2 「工作区 → 项目 → PM」能怎么表达

| 层次 | 原生对应 | 插件做法 | 结论 |
|---|---|---|---|
| 工作区 | Workspace（目录） | `ctx.workspaces` 列表可读；切换/连接用 `ctx.uiWorkspace.openWorkspace(workspaceId)`（会连接并打开其会话） | ✅ 读+跳转 [源码] navigation.ts:66-76 |
| 项目 | **原生无此概念** | 项目是插件域数据（storageDomain / 生成物）；在自有面板里画项目列表 | ✅ 自定义模型 |
| PM | 一个 Lead Session（PM 会话） | 点项目 → `openSession(leadSessionId)`（或 `startSession(workspaceId,{agentPreset})` 新建），再 `selectPanel(null)` 回对话 | ✅ [源码] navigation.ts:44,88,276 |
| 「只有 PM 对话」 | 原生侧栏显示该工作区所有会话 | 原生列表**无过滤 slot**；只能 (a) 自有面板做导航面、(b) 整体替换 sidebar、(c) 折叠侧栏（`ctx.layout.toggleSidebar()`）后以自有页面为主 | ⚠️/❌ 见 §4 |

- **能做的**：新增面板、入口、跳会话、按 id 打开（含 addressed-subagent 目标）、切换工作区、读工作区/会话列表。
- **不能做（不建议做）的**：给原生会话树加过滤谓词/隐藏规则；替换工作区切换器组件的内部行为。**整体替换 `sidebar`（single）在 slot 机制上理论可行（priority 覆盖），但需重写工作区/会话/归档/搜索全部语义，属于高风险不可取** [推断][待验证]。
- **导航语义**：`openSession` 文档注释为「选中会话并显示 Conversation，作为一个 UI 导航动作」；`openWorkspace` 会在必要时**创建/复用**会话，语义比「切换工作区」更重，接 PM 卡片前需在运行版验证。[源码] navigation.ts:37-76

---

## 3. Q2 PM/team：roster、任务板、只读消息投影

### 3.1 数据层：团队状态已有「客户端可见投影」

- **权威形态**：Lead Session 发布 `SessionProjectionMap.agentTeam`，含 `members[]`（id/name/role/phase/error）、`tasks[]`（id/revision/subject/status/ownerName/blockedBy/ready/writeScopes…）、可选 `failure`。这是「durable Team state published to browser clients through the Lead Session's `agentTeam` projection」。[文档] `docs/subsystems/agent-team.md#web-projection`
- **事件是 log-only**：roster/task 变更写 `team/member`、`team/task` 到 Lead Session 日志；它们「从不进入会话表面」，不污染模型历史。团队状态不是独立数据库，跨会话/重启会重建。[文档] `packages/experimental/agent-team/README.md:144`；`packages/core/session/src/known-event-types.ts:66,69`
- **实现位置**：投影 schema 与 apply 在 `packages/experimental/agent-team/src/projection.ts:105,111,250,270`（**experimental 包**，升级风险高）。

### 3.2 Client 侧怎么读（两档）

| 场景 | 可行读法 | 证据 | 状态 |
|---|---|---|---|
| 会话作用域（会话内 tab/卡片/徽章） | `useProjection('agentTeam')`，由 `ui-session` 绑定当前 Session 投影 | ui-session/src/client/index.ts:171-183,268-277 | ✅ [源码] |
| 根作用域（自有驾驶舱页面） | 注入 `ctx.sessions`（ClientSessions）→ 取 Session → `session.projections.faceOf('agentTeam')` 订阅 | web-client.md:42-46；session.ts:157,164；manager.ts:630 | ⚠️ [待验证：第三方插件注入面/公开度] |
| 子会话（teammate）消息 | Client Session 模型有「连续事件窗口」与 direct-subagent 地址 | web-client.md:42-46；transport.ts:136；manager.ts:137,160-175 | ⚠️ [待验证：事件窗口是否对插件开放] |

### 3.3 只读 team 视图的现实边界

- **可以**：读 roster + 任务板 + 每个 teammate 的 SessionId/状态，在自有面板渲染树/列表/任务卡；点 teammate 用 `openSession(sessionId | addressed-subagent)` 打开原生会话。
- **不可以/受限**：① 不能 import 官方 Chat 渲染组件（禁止 require Harness Client 包；官方 skill 规则）；② 自带页面要渲染「消息投影」只能自绘简化版（角色/文本/工具调用摘要），保真度低于原生 Chat；③ 原生「只读打开」不存在（见 §4）。
- **[待验证]** teammate 会话是否可直接 `openSession(SessionId)`（team 成员是 Lead 的直接子会话，sidebar 默认隐藏 subagent-origin 会话，但 Navigation 支持 subagent 地址）。设计文档 §2.7 称「可被人类从 roster 导航进去」，需运行版确认。

---

## 4. Q3 只读与隐藏：能做什么、不能做什么

| 诉求 | 原生支持 | 插件可行替代 | 证据/风险 |
|---|---|---|---|
| 用户点开 team 会话不许输入 | **未发现** per-session read-only；composer 的 `readOnly` 只是编辑器内部状态 | 不给入口；或自绘只读投影；或改 DSH 本体 | ComposerContentEditable.tsx:17；全仓 `readOnly` 检索无会话策略 |
| 隐藏原生会话列表/工作区切换器 | 无过滤 slot；`sidebar` 是 single | 替换 `sidebar`（重写全部导航，不推荐）；或折叠侧栏 + 自有导航面 | ui-layout/src/client/index.ts:68,182；slots.md:54-62 |
| 隐藏 teammate 会话 | ✅ 默认隐藏：subagent-origin Sessions 不进列表 | 无需操作 | ui-workspace/README.md（"subagent-origin Sessions remain hidden"） |
| 归档/关闭会话 | ✅ `archiveSession` / `unarchiveSession` | 可作为「收起旧会话」的正规手段 | navigation.ts:78-88 |
| 禁止从共享链接/外部入口访问 | 无会话级 ACL 概念 | 属 DSH 本体能力 | [推断] |

**结论**：需求里的「team 会话对用户只读」在第三方插件层**不能靠原生能力实现**；可落地的是「只读视图 + 不提供原生入口」，并接受用户仍可能通过原生路径打开可写会话（[待验证] 是否可达）。若要硬保证，必须改 DSH 本体或贡献只读会话能力。

---

## 5. Q4 树状驾驶舱：自绘、主题、locale、数据流

- **自绘**：`main` 面板是普通 React 组件，可画任意树（项目→阶段→切片→任务/会话/文档/事件）；面板由 AppFrame 中央区承载，尺寸随布局（左栏 264–420px，右栏可占 45%→70%），树要按容器宽度自适应。[文档] ui-layout/README.md
- **主题**：只用语义 token（`--dsw-alias-*` 等 `--dsw-*`），禁止字面色；CSS Modules，不用组件库/Tailwind。[文档] `packages/client/AGENTS.md:117`；`docs/web-styling.md`
- **locale**：注册时声明 `locale: NS`，组件拿 `t`；文案全部走 Client locale 服务。[文档] slots.md:64-80；plugin guide §3.3
- **数据通道（三条，按推荐度）**：

| 通道 | 适用 | 约束 | 状态 |
|---|---|---|---|
| ① Session projection `wire.view` | 会话派生数据（agentTeam、status、project 汇总） | Host 注册投影单元，Client 拿已算好值；仅会话派生 | ✅ 最稳（agentTeam 即此形态） |
| ② Typert Remote（自定义 namespace） | 插件自有域数据（项目/决策/指标） | 需 DSH 根构建的 Typert 严格生成（`typert.host.js` / `typert.remote-client.js`），且由 `api/remotes` 显式选择挂载 | ⚠️ 第三方独立 bundle **不能自助**（[待验证] 是否可内置预生成产物） |
| ③ 自定义 `webServer` 路由 | 自有 JSON/SSE | `ctx.webServer.register({kind,path,handler})`；但 **Desktop 以 file:// 加载页面、fetch 走 IPC bridge**，自定义路由可达性未知 | ⚠️ 高风险 [待验证] |

- **增量刷新**：projection 本身按 `seq` 增量发布（wire.view + Object.is 抑制）；自有通道若用 Remote stream 或 SSE 需自建版本/摘要；**不要轮询**。
- **3D 之前先把 2D 树跑通**：树的展开状态属于 UI 状态（声明 store），不要塞进项目权威数据。

---

## 6. Q5 3D：WebGL/Canvas/three.js 的可行性与推荐路径

| 维度 | 结论 | 证据 |
|---|---|---|
| 能否用 canvas/WebGL | **能**：插件页面就是 React DOM，canvas 可挂载；仓库已有 canvas 先例（PDF.js 预览覆盖层） | ui-sidebar-documentpreview/src/client/pdf/text.ts:1 |
| 能否带 three.js | **技术上能**：client 产物是预打包 CJS bundle，npm 依赖打进包内即可；Loader 只要求 `dsh.client` + `exports["./client"]` | docs/subsystems/client-modules.md#the-scan；plugin guide §3.3 |
| 有无先例/限制 | 全仓未发现 WebGL/three 使用；无 client bundle 体积上限（仅图标 ≤256KiB）；未发现 CSP 头；**禁止 iframe** | rg WebGL/three 无命中；package-manifest/src/types.ts:15；practices.md:33 |
| 性能/启动 | 所有 client 入口在首屏渲染前加载（roster 完整才渲染），three.js（数百 KB）会拖慢启动；建议 3D 视图首次进入时才初始化 canvas（[待验证] loader 是否支持动态 chunk） | client/web/README.md:128；web-client.md |
| 主题/locale | 颜色从 CSS 变量读取；文案走 `ctx.locale`；深色模式需重算材质/背景 | AGENTS.md:117；plugin guide §3.3 |
| 降级 | 首选 **2D 树 + CSS 3D 透视**（零依赖）；WebGL 仅作可选增强，失败回退 2D；提供「关闭 3D」开关并记忆 | [推断] |

**推荐**：Phase 1 只做 2D 树（SVG/DOM + 主题 token）；Phase 2 若必须 3D，先 PoC 单面板 three.js bundle 体积与 Desktop 渲染，再决定内置还是 CSS 3D。

---

## 7. Q6 会话内槽位映射（项目徽章/待决策/PM 卡）

| 需求 | 槽位 | 类型/作用域 | 说明 |
|---|---|---|---|
| 项目/阶段徽章 | `conversation.session.header.utilities` | list/session | 与官方预设、任务列表并列；同 id 可替换展示 |
| 「当前项目 · 待决策 N」常驻条 | `conversation.composer.dock` | list/session | 输入框上方；官方统计控件也在用（activity/usage） |
| 决策卡/门禁卡 | `conversation.chat.node` | keyed/session | 需注册 ChatNodeDefinition，重；建议先做卡内链接 |
| 项目工具结果可视化 | `tool.call.toolview` | keyed/按工具名 | 只影响渲染，不改工具行为 |
| 会话内驾驶舱 | `sidebar.right.pane.tab` + `ctx.sidebarRightTabs.register` | keyed | 不占整页；API 细节 [待验证] |
| 模态/通知 | `shell.overlay` | list/root | 官方 toast/dialog 也用它 |
| 底部状态条 | `shell.bottom` | single/root | 全宽，可自控高度 |
| 设置页 | `settings.section` | — | 项目/周期/决策策略配置 |

- 已确认声明：`conversation.session.header.utilities` 在 ui-conversation/src/client/apply.ts:434；`conversation.composer.dock` 在 :460；`tool.call.toolview` 由 ui-skill/src/client/index.ts:89 使用；`conversation.chat.node` 在 ui-chat/src/client/apply.ts:218。[源码]
- **actionCards**：0.2.1-rc.2 源码中 **不存在**；运行版 app.asar 中命中 169 次，说明 0.2.2-rc.1 已有该能力，但**槽位名/语义/兼容性待验证**，Phase 1 不要依赖。[源码+二进制证据]

---

## 8. Q7 边界与坑（第三方 bundle 视角）

| 约束 | 内容 | 证据 |
|---|---|---|
| 禁止 iframe | 不能把 Host 页面塞进 iframe：拿不到主题 token、明暗切换与 `ctx.locale` | 官方 skill practices.md:33 |
| 禁止替换 app root / 追加 body | 不替换根、不向 `document.body` 追加第二应用 | practices.md:36；ui-plugin.md:13 |
| 禁止读别的插件 DOM/样式 | 不得读其他插件 DOM/样式/组件源码估算位置；选已分配空间的 slot | ui-plugin.md:13 |
| 禁止 import Harness Client 包 | 需要控件自己写（照样式、改前缀、保留无障碍） | plugin guide §3.3；ui-plugin.md |
| 字面色 | 只用 `--dsw-*` token；插画可例外 | AGENTS.md:117；web-styling.md |
| 清理 | 样式/监听/定时器放 `ctx.effect` 并返回 disposer；slot 注册随声明生命周期回收 | slots.md:13-40；ui-plugin.md:13 |
| 版本差异 | checkout 0.2.1-rc.2 vs 运行 0.2.2-rc.1：`actionCards` 等已变；用 `engines.dsh` 声明兼容，并只用两版都有的 slot | 本文 §7；package.json `engines.dsh` |
| 卸载降级 | 面板/入口随插件卸载消失；自有数据需与插件同生命周期（storageDomain 保留），UI 不得依赖残留 | [推断] slots.md 生命周期 |
| 跨 workspace/project | 插件面板是 root 作用域，不绑定当前工作区；切工作区不自动切项目，需自管映射 | [推断] |

---

## 9. 推荐 UI 架构（工作区→项目→PM/team + 树状驾驶舱 + 可选 3D）

```
sidebar.panellist 入口（图标+“工作台”）
  └─ main[key=dsh.workbench]  全局面板（root）
       ├─ 左：工作区 → 项目 → 阶段 树（2D，主题 token；可选 CSS3D/WebGL）
       ├─ 中：项目总览 / 里程碑 / 待决策 / 风险
       └─ 右：team roster + 任务板（读 agentTeam 投影；成员只读消息简化视图）
            └─ 点击 PM 卡片 → ctx.uiWorkspace.openSession(leadSessionId)
                             + ctx.layout.selectPanel(null) → 原生 PM 会话
```

- **数据分层**：项目/工作项/决策等权威状态放 Host 插件（storageDomain）；会话相关（roster/tasks/session 状态）读 session projection；两者在驾驶舱合并渲染（[推断]）。
- **会话内形态**：Lead 会话打开时用 `header.utilities` 徽章 + `composer.dock` 阶段条 + `sidebar.right.pane.tab` 驾驶舱 tab；team 成员会话默认不提供入口，需要时在驾驶舱给「只读投影」。
- **3D**：仅对「项目→阶段」层级做可选的 CSS3D/WebGL 场景，默认关闭；2D 树为唯一权威视图。

### 必须先验证的 5 个风险（按顺序）

1. **Desktop 自定义数据通道可达性**：`webServer` 路由在 Electron file:// + IPC bridge 下是否可达（决定项目域数据怎么到浏览器）。[最高优先级]
2. **根作用域读他会话投影**：`ctx.sessions` + `Session.projections.faceOf('agentTeam')` 对第三方插件是否可用/稳定；否则驾驶舱拿不到 roster。
3. **只读 team 消息投影**：第三方能否订阅 teammate Session 事件窗口；不能则 team 视图降级为任务板+状态。
4. **原生列表不可过滤**：确认「只显示 PM 对话」只能做成自有导航面；若产品要求强制，需评估替换 `sidebar` 的代价或改 DSH。
5. **版本差异**：0.2.2-rc.1 的 `actionCards` / slot 变化；用运行版 inspect 校准，写死兼容范围。

---

## 10. 待验证清单（运行实例上做）

1. `cordis_inspect_query` 查 `Slots.listSubTree`：确认 `sidebar.panellist`、`main`、`conversation.session.header.utilities`、`conversation.composer.dock`、`sidebar.right.pane.tab` 在 0.2.2-rc.1 的声明与 scope。
2. 是否能在 Session 内用 `useProjection('agentTeam')` 读到 0.2.2 的 team 数据（0.2.1 为 experimental 包）。
3. `ctx.sessions` 是否对第三方 client 插件 inject 开放；`Session.projections`/`eventSource` 是否属于公开面。
4. Desktop 下插件自定义 fetch/SSE 路由是否经 IPC bridge 可达。
5. `ctx.uiWorkspace.openSession(teammateSessionId)` 是否可打开 subagent-origin 会话；打开后 composer 可写（预期可写）。
6. `actionCards` 的实际 slot 名与用途（0.2.2）。
7. client bundle 体积/启动影响：3D 依赖打入后的首屏时间。

---

## 11. 源码证据索引（相对 checkout）

| 主题 | 路径:行 | 说明 |
|---|---|---|
| 根布局 slot 声明 | `packages/client/ui-layout/src/client/index.ts:68,73,87,94,105,119,182-187` | sidebar single / main keyed / rightbar / shell.* |
| selectPanel 校验 | `packages/client/ui-layout/src/client/service.ts:36,72-78` | 未注册面板抛错 |
| 面板+入口范式 | `packages/client/ui-plugin-manager/src/client/index.ts:111-139,137,144-151` | main keyed + sidebar.panellist + selectPanel |
| 第二先例 | `packages/client/ui-schedule/src/client/index.ts:168-182` | 同上 |
| 侧栏入口声明/渲染 | `packages/client/ui-sidebar/src/client/index.ts:50,62,83`；`SidebarRoot.tsx:56,71` | sidebar.panellist list/root |
| 导航 API | `packages/client/ui-workspace/src/client/navigation.ts:44,66-76,88,276,320` | openSession/openWorkspace/startSession |
| 会话行动作 slot | `packages/client/ui-workspace/src/client/index.ts:294,317-325` | sidebar.workspaces / menu.item / row.action |
| 会话内 slot 声明 | `packages/client/ui-conversation/src/client/apply.ts:434,460` | header.utilities / composer.dock |
| Chat 节点 slot | `packages/client/ui-chat/src/client/apply.ts:218,325,328` | chat.node keyed / composer.dock 官方项 |
| 工具卡先例 | `packages/client/ui-skill/src/client/index.ts:89-90` | tool.call.toolview keyed |
| 投影 API | `packages/client/ui-session/src/client/index.ts:171-183,268-277` | useProjection/keyedHooks |
| Session 投影存储 | `packages/api/session-controller/src/client/sessions/session.ts:157,164`；`manager.ts:630` | faceOf / readonly projections |
| subagent 地址 | `packages/api/session-controller/src/client/transport.ts:136`；`manager.ts:137,160-175` | direct-subagent Session 地址 |
| 团队投影 | `docs/subsystems/agent-team.md#web-projection`；`packages/experimental/agent-team/src/projection.ts:105,111,250,270`；`README.md:144` | members/tasks/failure；log-only |
| Slot 语义 | `docs/subsystems/slots.md:13-40,48-62` | 生命周期/四种基数/priority 替换 |
| Client 模块加载 | `docs/subsystems/client-modules.md#the-scan` | dsh.client + exports ./client 扫描 |
| Typert 生成 | `docs/api-gateway.md:100-133` | 根构建生成；第三方不可自助 |
| webServer 路由 | `packages/host/webserver/src/index.ts:366` | register(route)；Desktop file:// 见 `docs/subsystems/web-server.md` |
| 官方 UI 规则 | `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md:33,36`；`ui-plugin.md:13` | 禁 iframe / 禁 body 追加 / 禁读别家 DOM |
| 样式规则 | `packages/client/AGENTS.md:117`；`docs/web-styling.md` | 禁字面色、token |
| 版本 | `package.json`（0.2.1-rc.2）；`git log -1` 687f282e86 | 与运行 0.2.2-rc.1 差异 |
| actionCards 差异 | 0.2.1 checkout：0 命中；运行版 app.asar：169 命中 | [待验证] 槽位语义 |

> 说明：运行版为打包 app.asar，未能解析出版本号字符串；"0.2.2-rc.1" 来自设计文档与运行环境记录，按 **[待验证]** 处理。所有行号基于 0.2.1-rc.2 checkout，升级后需重取。
