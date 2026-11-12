# 工作台 UI 架构 v1：工作区→项目→PM / team 只读 / 树状驾驶舱 / 3D

> 2026-11-11 · 目标态设计（不实现）。
> 用户要求：改 DSH UI——工作区 → 项目 → PM（只有和 PM 的对话）；team（PM 拉起的会话，对用户只读）；
> 驾驶舱做成树状；有条件做 3D。
> 依据：DSH Client 源码（0.2.1-rc.2）+ 本机 profile（0.2.2-rc.1）实测；平台 PoC 见
> [research/poc-platform-capabilities.zh.md](research/poc-platform-capabilities.zh.md)（SQLite/插件/Web bundle 已通，渲染待目测）。
> 能力审计见
> [docs/research/dsh-ui-extension-audit.zh.md](research/dsh-ui-extension-audit.zh.md)（235 行，含行号与 PoC 风险）。

---

## 0. 一句话

**不改 DSH 外壳，用插件加一层「项目面板」把工作区→项目→PM 的层级装进去**：项目面板是主入口，PM 会话是唯一对话，
team 在项目面板里只读呈现，树状驾驶舱是项目面板的主视图，3D 是树视图的可选渲染层（可降级 2D）。

---

## 1. DSH UI 能力与边界（当前确认/待确认）

| 能力 | 结论 | 依据/说明 |
|---|---|---|
| 加一个主页面 | ✅ 可以 | 插件注册 main slot（ui-schedule / ui-plugin-manager 同款模式） |
| 加侧栏入口 | ✅ 可以 | sidebar.panellist（图标 + 标题 + 排序） |
| 会话页头徽章/按钮 | ✅ 可以 | conversation.session.header.utilities / .actions |
| 输入框常驻条 | ✅ 可以 | conversation.composer.dock |
| 决策卡/动作卡 | ✅ 0.2.2 运行版可用 | actionCards 在 0.2.1 源码中 0 命中；实现前用运行版核对，勿依赖旧源码 |
| 读 team roster/任务板 | ✅ 可以 | Client 读取 Lead 会话的 agentTeam 投影（实验包已有先例） |
| 打开/新建会话 | ✅ 可以 | ctx.uiWorkspace.openSession / startSession（可指定 preset） |
| 替换或隐藏核心会话列表 | ❌ 基本不行 | sidebar.workspaces 由 ui-workspace 独占；无过滤 slot；只能自建导航面（或整体替换 sidebar，语义重写，不推荐） |
| 会话级只读 | ⚠️ 原生无；自绘侧栏视图可以 | 原生没有 per-session 只读；但可以**不打开原生会话**，在我们的侧栏 tab / 项目面板里自绘只读视图（官方 Chat 组件不可 import） |
| Canvas / WebGL / three.js | ⚠️ 可行但需评估 | 插件页面是普通 Web 页面（禁 iframe），可自绘 canvas；三方依赖要打进 client bundle，体积/性能需评估 |
| 替换 app root / iframe / 字面色 | ❌ 禁止 | 平台硬约束；只用主题 token、locale、slot |

**由此得到的最大设计约束**：不能把 DSH 改造成"只有项目和 PM"，但可以做到：
**默认入口 = 项目面板；项目面板里只有 PM 对话入口；team 只在面板内只读呈现；原始会话列表仍存在（用户可打开的兜底视图）。**
这不是妥协，而是把「项目」变成用户真正的工作面，DSH 原生会话列表退化成调试/兜底入口。

---

## 2. 信息架构

```text
DSH 工作区（原生）
└─ 项目面板（插件 main；sidebar 图标「项目」）        ← 用户的主入口
   ├─ 项目头：项目名 / 阶段 / 周期 / 健康 / [进入 PM 对话]
   ├─ 左侧导航（树）
   │  └─ 项目
   │     ├─ 阶段 S1..S7（门禁状态）
   │     │  └─ 切片（工作项/模块）
   │     │     ├─ 任务
   │     │     ├─ 会话（team）
   │     │     ├─ 文档（版本）
   │     │     ├─ 决策
   │     │     └─ 证据
   │     └─ 时间线（最近事件）
   └─ 右侧详情：选中节点的详情/文档预览/时间线/操作
      tabs：树状驾驶舱 | Team | 文档 | 决策 | 时间线 | 设置
```

**入口规则**：
- 打开项目面板 = 看到项目树 + 「进入 PM 对话」按钮；PM 会话若存在则打开，不存在则按 project-office preset 新建。
- 项目面板里"新建会话"只创建 PM 会话；任务会话由 PM 内部拉起，用户不直接建。
- 用户从 DSH 侧栏也能看到原始会话，但产品文案与默认路径都指向项目面板；team 会话行标「只读」。

---

## 3. PM 会话形态（唯一对话）

- 会话名：项目名 + PM（如「支付项目 · PM」）；固定为项目当前 PM 会话，可被新 PM 会话替换（继承 handoff）。
- 页头 utilities：阶段徽章 / 当前切片 / 待决策数 / 「回到项目」按钮。
- 输入框 dock：项目今日摘要（进行中切片数、待决策、最近事件 1 行）。
- 聊天卡：
  - 开工卡：项目/阶段/切片/下一步（PM 拉起任务会话时显示）；
  - 决策卡：问题/选项/推荐/不返工后果（actionCards）；
  - 收工回执：本切片产物/证据/下一切片。
- 用户与 PM 的对话是唯一输入通道；所有指令、纠错、验收都通过 PM 转成任务/决策/事件。

---

## 4. Team 视图（只读）

> **实现状态（2026-11-11）**：team 只读视图**暂缓**。设计保留（PM 会话右侧栏 tab + 项目面板 Team tab），
> 实现阶段先不做；团队会话暂按原生会话可读处理，之后再解决只读问题。
>
> **形态选择（逐步收敛）**：

1. **PM 会话右侧栏 tab「Team · 只读」（推荐主入口）**：在 PM 会话内注册 sidebar.right.pane.tab（ui-schedule 同款机制），列表 + 只读详情都在侧栏里，用户看 team 不离开 PM。
2. **项目面板 Team tab**：全局视角，与右侧栏共用同一只读组件。
3. 原生会话：保留兜底，但产品上不提供入口（或藏在「高级」里并提示回 PM）。

数据来源两条路（实现时二选一，推荐 B）：

- **A. Client 投影**：agentTeam 投影（roster/tasks）+ 会话作用域 projection（需要确认消息投影 key）；不改 Host。
- **B. Host 只读转录服务**：插件 Host 侧订阅会话事件（ctx.on('session/event')）或读会话日志，按页提供给侧栏；完全受控、可脱敏、可分页，**只读由架构保证**（客户端没有写接口）。

只读保证：侧栏视图里**没有输入框、没有发送按钮**；所有操作只有「查看/复制/让 PM 处理」。「让 PM 处理」= 切回 PM 会话并把上下文摘要发回 PM（或生成一张待 PM 处理的卡）。
残余口子：原生会话页仍可输入（平台限制）；我们只能不提供入口 + 文案提示。要绝对只读，只能是「team 会话不作为 DSH 可交互会话存在」——但这与 PM 拉起会话、任务会话拉子 agent 的流程冲突，不建议。


| 区域 | 内容 | 数据源 |
|---|---|---|
| roster | 名称（角色-切片-动作）/ 角色 / 切片 / provider/model / 状态 / 当前任务 | DB sessions + agentTeam 投影 |
| 任务板 | PM 分给各会话的任务、依赖、状态 | agentTeam 投影 / DB tasks |
| 只读对话预览 | 选中会话的消息投影（只读渲染） | session projection（不打开原会话） |
| 操作 | 「查看原始会话（只读）」/「请 PM 处理」 | 打开原会话（带警告）/ 回到 PM |

规则：
- 只读预览里**不提供输入框**；用户要干预 → 回 PM 说，由 PM 转成消息/决策。
- **实现细节**：只读预览只能自绘（不能 import 官方 Chat 组件）；roster/task 用会话作用域的 agentTeam 投影最稳；
  项目面板是根作用域，读 Lead 的投影需要注入 `ctx.sessions` 读 `Session.projections.faceOf`——**需 PoC 验证**。
- 「查看原始会话」打开 DSH 原生会话页（可输入），页头显示提示「原始视图；请在 PM 中指挥」；平台层面无法禁输入（见 §1）。
- team 会话的产物（文档/证据/交接）点击后跳到项目面板对应节点，不直接改。

---

## 5. 树状驾驶舱（默认视图）

### 5.1 节点模型

```text
Project
├── Stage（S0..S7，状态/门禁）
│   └── Slice（工作项/模块，owner/状态）
│       ├── Task（状态/负责人）
│       ├── Session（角色/模型/状态）
│       ├── Document（类型/版本/状态）
│       ├── Decision（状态/待拍板）
│       └── Evidence（类型/结果）
└── Timeline（最近事件，独立时间轴视图）
```

节点徽章：状态色（进行中/待验收/完成/阻塞/待决策）、角色、门禁、版本号、时间。
树默认展开到「阶段 → 切片」，任务/会话/文档按需展开；节点数大时虚拟滚动 + 折叠。

### 5.2 交互

- 单击节点：右侧详情（状态/字段/最近事件/关联对象/可执行动作）。
- 双击文档：文档预览（DB 渲染，不打开文件）；版本切换/diff。
- 双击会话：Team 只读预览。
- 双击决策：决策卡（若待拍板，显示"去 PM 拍板"）。
- 右键/更多：复制 ID、在 PM 中讨论（切换 PM 并带入上下文）、查看时间线。
- 顶部：搜索（文档/任务/会话）、过滤（阶段/角色/状态/时间）、刷新状态（事件驱动自动更新）。
- 状态：加载中/空项目/降级（记忆不可用）/错误；均给明确文案。

### 5.3 数据流

- Host 服务提供 snapshot + 增量事件（project/changed），客户端 store 维护树与详情；不轮询。
- 大量数据分页/懒加载（切片下的文档/事件）。
- 与 DB 一致：树节点来自 DB 查询，不维护第二份状态。

---

## 6. 3D 视图（可选渲染层）

| 维度 | 设计 |
|---|---|
| 触发 | 树视图右上「3D」开关；默认 2D |
| 表现 | 项目为根球，阶段为环/柱，切片为节点，会话为卫星，时间线为外环；颜色=状态/角色；点击节点与右侧详情联动 |
| 技术 | 主面板内 canvas/WebGL（three.js 或轻量自绘）；无 iframe；主题色取 token；i18n 标签 |
| 交互 | 轨道旋转/缩放/点击选中/双击进入详情；自动旋转默认关；键盘 Esc 返回 2D |
| 性能 | 目标 60fps；>500 节点时聚合/裁剪；低端 GPU/远程桌面降级 2D；WebGL 不可用直接隐藏 3D 开关 |
| 依赖 | client 是预打包 CJS bundle，three.js **能**打进包；但无 WebGL/three 先例（只有 canvas PDF 预览先例），且全入口首屏预载 → 大包拖慢启动。**目标形态：2D 树 + CSS3D 开关**；WebGL 仅作延迟加载增强（动态 chunk 是否支持待 PoC） |
| 可访问性 | 3D 不是唯一入口：所有节点在 2D 树/列表可达 |

> 结论：3D 是「树的另一种画法」，不是新数据源、不是新交互模型。
> **目标态采用 2D 树 + CSS3D 可选视图**（零依赖、效果够用、不拖启动）；WebGL/three.js 作为「如果 PoC 证明可接受」的增强项。
> 若你坚持真 3D，必须先 PoC：bundle 体积、启动耗时、远程桌面 GPU、动态 chunk。

---

## 7. 槽位与 API 映射

| UI 元素 | DSH 槽/API | 备注 |
|---|---|---|
| 项目面板页面 | main（插件注册 keyed panel） | 一个项目面板；内部切换项目 |
| 侧栏「项目」入口 | sidebar.panellist | 图标+标题+order |
| 会话列表行装饰 | sidebar.workspaces.session.row.leading/hover（若可用） | 显示角色/切片/只读徽章 |
| PM 页头徽章 | conversation.session.header.utilities | 阶段/待决策/回项目 |
| PM 输入框状态条 | conversation.composer.dock | 项目摘要 |
| 需求/决策/收工卡 | actionCards / toolview | 人身份操作 |
| Team roster | agentTeam 投影（Lead 会话） | 实验 API；需 opt-in bundle |
| 打开 PM/任务会话 | ctx.uiWorkspace.openSession/startSession | PM 用 project-office preset |
| Team 只读 tab | sidebar.right.pane.tab（sidebarRightTabs.register） | 在 PM 会话内打开，列表+只读详情 |
| 时间线 | 插件 Host 事件 → client store | project/changed 事件 |
| 3D canvas | 插件页面内 canvas | 不需要新 slot |

---

## 8. 验收（UI 正确性）

- [ ] 从侧栏「项目」打开面板，看到项目树 + 「进入 PM 对话」。
- [ ] PM 会话是默认对话入口；项目面板内不能新建非 PM 会话。
- [ ] Team 只读视图（PM 右侧栏 tab 或项目面板）可列出 task 会话、看只读转录；无输入框；「请 PM 处理」回到 PM。
- [ ] 树节点与 DB 一致；事件到达后 1 秒内更新；1000 节点可交互。
- [ ] 文档预览来自 DB；版本切换/冻结/导出状态可见；不打开仓库文件。
- [ ] 决策卡可拍板；门禁/不可逆动作人身份确认。
- [ ] 3D 开关可用时与 2D 树选中联动；WebGL 不可用/低性能时自动降级且不报错。
- [ ] 主题 token/locale 全量适配；无 iframe、无 root 替换、无字面色；卸载后不残留。
- [ ] 侧栏原始会话列表仍可用（兜底），team 行有只读标识。

---

## 9. 待审计确认 / 风险

1. **能力审计**：sidebar 行装饰、team 投影、只读预览、WebGL/依赖打包的最终结论（见 docs/research/dsh-ui-extension-audit.zh.md）。
2. **只读不可强制执行**：原始会话仍可输入；只能靠产品引导 + 我们的只读预览。需要在 UI 文案/权限说明里如实写。
3. **3D 依赖体积/性能**：client bundle 预算、远程桌面/虚拟机 GPU；必要时退回 CSS 3D 或纯 2D。
4. **版本差异**：0.2.2-rc.1 与 0.2.1-rc.2 的 slot/实验包差异；实现前用运行中实例核对。
5. **Desktop file:// + IPC 下自定义数据路由/Remote 可达性**：审计指出的首风险，必须先 PoC（面板读 DB、agentTeam 投影、事件推送三件事）。
6. **首屏预载**：client 入口全量预载，驾驶舱/3D 库体积会拖慢启动；CSS3D 优先，3D 库延迟加载。
7. **项目面板 keyed 方式**：一个面板内切项目 vs 每项目一个面板；建议单面板内切换，避免主页面爆炸。

---

> 本文与《目标架构 v1》配套；UI 即项目运行时的可见层，数据仍以 DB 为唯一源。
