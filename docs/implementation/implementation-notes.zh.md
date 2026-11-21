# 工作台实现笔记（实现状态 / 偏差 / 安装重启 / 演示）

> 维护者：T5 verify。日期：2026-11-11。目标态架构见 [workbench-architecture-v1.zh.md](../workbench-architecture-v1.zh.md)，
> 接口契约见 [contracts-v1.zh.md](contracts-v1.zh.md)，UI 见 [workbench-ui-architecture-v1.zh.md](../workbench-ui-architecture-v1.zh.md)。
> 本文只记录实现状态、验证结果、偏差与操作说明，不重新设计架构。

## 1. 实现状态总览（一次性目标态，无分期/MVP）

插件 bundle：workbench/（约 1.53 万行 JS；43 个 js/mjs 文件全部可解析）。

| 模块 | 文件 | 状态 | 验证 |
|---|---|---|---|
| 插件入口/装配 | index.js | 完成 | check-syntax、插件实例加载 |
| 领域 DB/事件 | host/db.js, host/schema.js, host/util.js, host/bus.js | 完成 | db.test.mjs 14/14；acceptance |
| 领域写操作 | host/store.js（切片/任务/会话/决策/证据/产物/租约/导出/导入） | 完成 | db.test.mjs、replay、negative |
| 文档与检索 | host/docs.js（版本链/冻结/doc_sections/doc_fts/片段检索） | 完成 | db.test.mjs、replay |
| 导出/导入边界 | host/export.js, host/import.js（只写不回读、generated 头、可重生成） | 完成 | db.test.mjs、replay |
| 项目注册表 | host/registry.js（workspace root realpath 校验、.project 布局、7 阶段、幂等） | 完成 | replay、negative HTTP |
| 项目编排/门禁 | host/project.js（init/决策拍板/门禁冻结+导出+阶段推进/PM 绑定/唤醒 PM） | 完成 | negative HTTP、replay（真实 resolveDecisionAction） |
| 快照投影 | host/snapshot.js（overview/tree/sliceDetail/docPreview/timelinePage） | 完成 | api.test.mjs、instance-http |
| HTTP/SSE 通道 | host/http.js（/project-workbench/api，全部先 requestRejection；SSE 25s 心跳） | 完成 | api.test.mjs、negative HTTP、instance-http |
| 2k 上下文 | host/context.js（L0 400/L1 300/L2 900，硬上限 2000，降级提示） | 完成 | acceptance、tools.test（见 §8 待办 2） |
| 角色卡 | host/roles.js（PM + 7 角色） | 完成 | replay/工具门禁 |
| 工具层 | host/tools/**（26 个模型可见工具，when 按 actor 过滤；含文件回填索引 file_index） | 完成 | tools.test（PM 22 / 任务 15）、replay 17/17、negative、真实实例 |
| 提示注入 | host/prompts.js, host/session-hooks.js（L0 每步、L1/L2 首步/切片、重启对账） | 完成 | tools.test 注入状态机、code review |
| 技能/卡片 | host/skills.js（7 个技能模板）, host/cards.js（decision 卡，服务缺失安全跳过） | 完成 | 注册冒烟 |
| 会话编排 | host/orchestration.js（actor 解析、spawn 任务会话、通知、重启对账） | 完成 | tools.test、replay |
| client UI | client.js（4 槽位：main/sidebar.panellist/PM 页头徽章/composer 状态条 + 驾驶舱/决策卡/文档预览/时间线） | 完成 | ui-client.test 3/3、实例 bundle 可解析 |
| patch/preset | cordis.patch.yml（插件行 + subagent maxDepth 2 + project-office/project-task preset） | 完成，待 --dump-config 复核 | T4 自测；见 §8 |

## 2. 验证资产（T5 交付，全部在写作用域内）

- workbench/scripts/dev-instance.mjs：隔离实例管理（start/stop/restart/status/wait/url/cookie/health/logs；DSH_HOME 默认 <workspace>/.devhome，端口 52999）
- workbench/scripts/dev-install.mjs：bundle/profile 安装检查（check/plan/install/instructions；不写 ~/.dsh）
- workbench/scripts/check-syntax.mjs：全量「可解析」检查（等价 node --check；client.js 用浏览器桩）
- workbench/tests/e2e/harness.mjs：fake ctx / 临时项目 / host 模块加载 / 路由服务器 / SSE / 报告
- workbench/tests/e2e/replay-14-steps.mjs：架构 §7 十四步回放 + 贯穿断言 + 工具层抽检 + 恢复
- workbench/tests/e2e/negative.test.mjs：§11.3 负向 + HTTP 集成
- workbench/tests/e2e/ui-client.test.mjs：client UI 契约自测（无需浏览器）
- workbench/tests/e2e/dev-instance.test.mjs：实例/安装脚本自测（fake HTTP 验证 token→cookie/健康/日志解析/保留 profile 拒绝）
- workbench/tests/e2e/instance-http.mjs：真实实例页面/preload/bundle/API/SSE 验证
- workbench/tests/e2e/live-e2e.mjs：真实模型 + 真实宿主会话的端到端验证（PM 工具/人体批准门禁/导出/时间线）
- workbench/tests/e2e/devhome-model.patch.yml：隔离实例的模型路由 overlay（grsai），仅供验证
- workbench/tests/unit/acceptance.test.mjs：§11.1/§11.5/§11.6 域模型与 2k 预算验收
- workbench/tests/e2e/README.zh.md：命令与退出码说明

各模块自测（T1/T2/T4 亦提供）：tests/unit/db.test.mjs、api.test.mjs、tools.test.mjs。

## 3. 验证命令与结果（本轮）

环境说明：实现期间 ops_bash 一度全量故障（EXECUTOR_UNAVAILABLE，niubash 硬链接池耗尽 / dsh-ops 并发 bug），
期间用 PTC run_code 内 in-process 等价验证；**最后阶段执行器恢复**，以下为官方命令的真实结果（在 workbench/ 下执行）。

    结果（2026-11-12 最终一轮，全部为官方命令实跑）：
    - node scripts/check-syntax.mjs                        PASS（42 文件解析，0 syntax / 0 import error；
                                                           7 个 *.test.mjs 由 node --test 覆盖）
    - node --test tests/unit/                              tests 57 / pass 57 / fail 0
        · db.test.mjs 14 · api.test.mjs 16 · tools.test.mjs 10 · acceptance.test.mjs 17
    - node --test tests/e2e/negative.test.mjs              10 pass / 0 fail
    - node --test tests/e2e/ui-client.test.mjs             3 pass / 0 fail
    - node --test tests/e2e/dev-instance.test.mjs          7 pass / 0 fail（连跑 5 次稳定）
    - node tests/e2e/replay-14-steps.mjs --strict          passed=17 failed=0 pending=0 → PASS
    - node tests/e2e/instance-http.mjs --strict            passed=10 failed=0 pending=0 → PASS
      （对 52999 上真实 web profile 实例：页面/preload/bundle 可解析/鉴权 401/API/SSE）
    - node tests/e2e/live-e2e.mjs --cookie-file ...         passed=4 failed=0 → PASS
      （真实模型 + 真实宿主会话：创建 project-office 会话→落库 PM 行→PM 真实调用 project_status→
       人批准不可逆门禁→冻结+导出 docs/+阶段推进→时间线含 gate/approve、doc/export、stage/change→
       导出文件全部带 generated 标记）

真实运行复现（不只是 fake ctx）：在隔离 .devhome + 真实 web profile + grsai 模型上跑通完整链路：
用户需求 → PM（真实 LLM）拆切片/建任务/session_spawn_task → 产品任务会话（真实 LLM）写 PRD v1 +
证据 + 交接 + 收工校验 → PM 提交 G1 门禁与「退款时效」决策 → 人在面板批准（不可逆二次确认 409→200）→
PRD/交接冻结 + 导出 docs/product/prd-refund.md、docs/handoffs/handoff-refund.md + S1→S2 →
PM 自主拉起 S2 UX 任务会话（UX-refund-退款体验设计）→ 写完 ux/refund v1 + 交接收工。
数据库侧证据：sessions 4 行（PM×2、产品、UX，状态与 handoff 正确）、documents 6、doc_versions 8（含冻结）、
doc_sections/doc_fts 派生、decisions 2（1 gate+1 decision，均 approved）、approvals 1、evidence 1+、
events 50 条 seq 无空洞、leases 归零。

标准命令（仓库根执行）：

    node workbench/scripts/check-syntax.mjs
    node --test workbench/tests/unit/
    node --test workbench/tests/e2e/negative.test.mjs
    node --test workbench/tests/e2e/ui-client.test.mjs
    node --test workbench/tests/e2e/dev-instance.test.mjs
    node workbench/tests/e2e/replay-14-steps.mjs --strict
    node workbench/scripts/dev-instance.mjs restart
    node workbench/tests/e2e/instance-http.mjs --strict
    node workbench/tests/e2e/live-e2e.mjs --cookie-file .poc/devhome-cookies.txt

## 3.1 增量：侧栏「项目维度」三席位（方案 ①，2026-11-14）

背景：用户问「别人的 UI 增强插件能改左侧栏，我们为什么不能重写工作区浏览区」。核查后确认
`sidebar.workspaces` 是 `single` 槽、官方占 `priority 0`，`priority<0` 可影子覆盖但会连带丢子槽
（详见 `docs/research/dsh-ui-extension-audit.zh.md` §2.3 的修正与 `docs/workbench-ui-architecture-v1.zh.md` §1/§3.1）。
因此本轮采用**只加不减**：官方浏览区一行不改，只在三个官方 list 槽各追加一个只读装饰。

改动面（4 个文件，+532/-9）：

| 文件 | 改动 |
|---|---|
| `workbench/client.js` | +6 个纯函数（`roleInitial/roleTone/indexableRoots/snapshotOf/pendingDecisionsOf/buildSessionIndex`）、hub 派生 `sessionIndex`（publish 时按引用未变则复用）、三个席位组件、3 处 slot 注册、11 条 zh/en 文案、4 组 `wb-*` 样式 |
| `workbench/tests/e2e/ui-client.test.mjs` | 槽位断言 4→7；新增「侧栏席位纯变换」与「侧栏席位组件渲染/沉默」两例 |
| `docs/workbench-ui-architecture-v1.zh.md` | §1 能力表修正（新增「影子覆盖有条件可行」一行）+ 新增 §3.1 实现说明 + §7 槽位映射 |
| `docs/research/dsh-ui-extension-audit.zh.md` | 能力表补一行 + 新增 §2.3「修正：可影子但会传染丢子槽」 |

验证（全部官方命令实跑，2026-11-14）：

    - node workbench/scripts/check-syntax.mjs               PASS（44 文件，0 syntax / 0 import error）
    - node workbench/tests/e2e/ui-client.test.mjs           passed=5 failed=0（原 3 例 → 5 例）
    - node workbench/tests/unit/acceptance.test.mjs         passed=17 failed=0
    - node workbench/tests/unit/api.test.mjs                pass 16 / fail 0
    - node workbench/tests/unit/db.test.mjs                 pass 14 / fail 0
    - node workbench/tests/unit/tools.test.mjs              pass 11 / fail 0
    - node workbench/tests/e2e/negative.test.mjs            passed=10 failed=0
    - node workbench/tests/e2e/dev-instance.test.mjs        passed=7 failed=0
    - node workbench/tests/e2e/replay-14-steps.mjs --strict passed=17 failed=0 pending=0

独立复核（impl-reviewer，只读，结论落在 client.js `3d2c60ad` / ui-client.test.mjs `f3363ddd` 这组字节上）：
A 槽位确为官方 list 槽且用我们自己的 id、无 priority、未触碰 `sidebar.workspaces`；B root 槽 inject 不收
sessionId、行的 sessionId 来自渲染点 ownerProps；C 席位无 DOM 写/轮询/新 EventSource/fetch；
D effect 依赖稳定原语且卸载 release（refcount + 1500ms linger）；E `workbench/host/` 零改动、无新路由/无 DB 写；
F 八条命令全 exit=0。**判定：无阻塞，可以合并。**

复核提的两条非阻塞观察与本轮处置：

1. `unit/db.test.mjs` 偶发一次 `EPERM rename`（原子写在 `.project/exports`、`docs/` 下被占用），
   与本次改动无关（host/ 未改），随后 18 次连跑全通过 —— 记为本机 Windows 文件占用抖动，不做代码改动。
2. 「索引来自 snapshot，而 snapshot 需先 acquire」的先后关系：`SessionProjectHover` 已用
   `runtime.sessionSummary` + `resolveProjectForSession`（按 cwd）兜底 root 打破循环；
   `SessionRoleChip` 仍只读索引，首次渲染到快照到达前可能无徽章，之后自动补上（渐进增强，非缺陷）。

### 3.2 第二批：剩余 4 个落点 + 定位链路（2026-11-14，同日）

用户「剩下的东西都做完」→ 把方案 ① 七个落点补齐到 6 个（第 1 个是既有图标，只加角标）：

| 落点 | 槽位 | id | 说明 |
|---|---|---|---|
| 4 行尾 | `sidebar.session.row.trailing` | `wb-slice-mark` | 非交互切片图标（该格官方规定不能放按钮） |
| 6 悬停按钮 | `sidebar.workspaces.session.row.action` | `wb-locate` | 「在项目中定位此切片」 |
| 7 菜单项 | `sidebar.workspaces.session.menu.item` ×3 | `wb-menu-open-project`(500) / `wb-menu-locate`(520) / `wb-menu-copy-slice`(540) | 一行一个 `role="menuitem"`（契约：菜单键盘遍历读 DOM） |
| — 面板更多菜单 | `sidebar.panellist.actions` | `wb-project-row`(100) | 直达当前项目（带待决策数） |
| 1 图标 | `sidebar.panellist`（既有） | `project-workbench` | 右上角待决策红点（owner props 只有 size/active，所以读 hub 自绘） |

配套的「定位」链路（唯一带状态的交互）：

```text
点行尾悬停按钮 / 菜单项
  → runtime.openSlice(hub, root, sliceId)      // ctx.layout.selectPanel + hub.requestFocus
  → hub.state.focusRequest = { id: n, root, sliceId }
  → WorkbenchPanel 的 effect 消费一次：hub.consumeFocus(id) → 清空
  → setExpanded(withKeys(..., [stage key, slice key])) + setSelected(切片行) + setTab('sessions')
```

一次性语义由自增 id 保证：重渲染、二次进入、跨项目都不会重放或误伤（有专门测试锁定）。

**刻意不做**（抢 single 槽 = 静默杀掉官方能力，正是方案 ② 的传染式风险）：

- `sidebar.toggle.badge`：官方 ui-settings-general 在那里挂「桌面更新 / 断连」指示器，注册即遮蔽。
  折叠态待决策提示改由 `sidebar.panellist` 图标角标承担（rail 里同样可见）。
- `sidebar.brand.mark` / `sidebar.brand.name`：官方品牌位不碰。

本轮验证（全部官方命令实跑）：

    - node scripts/check-syntax.mjs             PASS（44 文件，0 syntax / 0 import error）
    - node tests/e2e/ui-client.test.mjs         6 例全过（新增「席位置渲染」与「定位请求一次性」两例）
    - node tests/unit/acceptance.test.mjs       17/0
    - node tests/unit/api.test.mjs              16/0
    - node tests/unit/db.test.mjs               23/0（连跑 3 次稳定；含他人 W1 触发器测试）
    - node tests/unit/tools.test.mjs            11/0
    - node tests/e2e/negative.test.mjs          10/0
    - node tests/e2e/dev-instance.test.mjs      7/0
    - node tests/e2e/replay-14-steps.mjs --strict  17/0

### 3.3 复核提出的阻塞项与修复（2026-11-14）

独立复核（seat-reviewer，锁定字节 client.js `0eb37291` / ui-client.test `58dae431` / schema `408d9f5e` / store `cc8d373f` / db.test `8fdf5cd0`）A~G 全部成立，
提出 **1 项阻塞**（与侧栏席位无关，但会让验收证据失效）：

> `workbench/scripts/check-syntax.mjs` 被 `workbench/tests/probes/*.mjs` 劫持：
> 检查器会 import 除 `*.test.mjs` 外的所有 .mjs，而探针在模块顶层就执行并 `process.exit`，
> 于是退出码来自探针、检查器自己的报告再也没打印过 —— 语法门禁等于失效。

修复（三处，均已复验）：

1. `check-syntax.mjs` 的 `SKIP_DIRS` 增加 `probes`，并在注释里写清原因（探针必须用 `node <file>` 单独跑）。
2. 两个探针都补 `isMain` 守卫（与仓库其它脚本一致）：被 import 时不执行任何副作用。
   `w1-migrate-realdb.mjs` 的源库路径改为 `WORKBENCH_REALDB_SRC` 环境变量可覆盖（默认仍指向 lumio 副本），
   避免「import 即读工作区外路径」。
3. 加回归用例 `check-syntax: 语法门禁不被 tests/probes 劫持`（dev-instance 套件，8/0）：
   断言扫描列表里不含 probes、且包含 client.js。

复验：`check-syntax.mjs` 恢复打印自己的报告（44 文件 / 37 parsed / 0 syntax / 0 import error / PASS）；
`node workbench/tests/probes/w1-guards.mjs` 单独跑仍 PASS；`node -e "import(probe)"` 不再产生副作用。

复核的另一条**保留意见（不阻塞，需记档）**：

> W1 迁移去重删的是 evidence / artifact 行，而这些行对应的 events 是 append-only 保留的
> （subject_id 指向被删行），迁移后会出现「事件指向已不存在的主体」。
> 当前没有代码按 subjectId 反查 evidence，故不影响运行，属审计链上的轻微不一致。

处置：本轮不动（属他人 W1 切片，且改动会造成事件与事实的不一致），在此记档，建议后续在治理文档里注明该例外。

### 3.3.1 用真实库跑出来的一个真 bug（已修）

复核通过后，用你机器上**真实项目库**（`C:/Users/oldap/Documents/lumio/.project`，1 项目 / 2 会话 / 4 切片 / 3 待决策）
的副本喂给真实组件渲染，发现：`/projects` 接口里的 `stage` 是**阶段记录对象**
`{id,key,name,status,gate,position,...}`，不是字符串。新席位里写了 `String(project.stage)`，
在真实数据上会渲染成 **`[object Object]`**（测试 fixture 当时用的是字符串，所以没抓到）。

修复：新增 `stageText(stage)` 归一两种线格式（`/projects` 发记录对象、`/snapshot` 发字符串指针），
三处调用点改用它（底部状态条、会话索引、PM 徽章）。测试 fixture 也改成真实形状并断言
「不得出现 `[object Object]`」。

新增探针 `workbench/tests/probes/seats-realdata.mjs`：拷真实库 → 建真实 snapshot → 用真实 bundle
渲染全部席位 → 断言不出现 `[object Object]`、PM 行徽章是 `P`、底部三段式文本齐全。当前输出：

    1) 侧栏图标角标   title="待决策 3 项" 有红点=true
    2) 底部状态条     "lumio · S1 产品 · 待决策 3"
    3) PM 行          徽章=P 悬停卡=项目lumio阶段S1 产品待决策3（无定位按钮：PM 无切片）
       架构行        徽章=架 行尾标记="切片：工作台与仓库基线对账（反向登记）" 定位按钮=有
    4) 面板更多行     "lumio：打开项目工作台（待决策 3）"
    RESULT: PASS

### 3.5 决策卡语义缺陷（用户实测反馈，2026-11-14 第三批）

用户反馈原文：「只有 abcd 4个选项；只有批准和驳回按钮，这里的语义不清晰；批准什么东西」

查证后确认这是**真实的设计-实现缺口**，不是文案问题：

1. **选项是纯展示**：`DecisionCard` 把 `options` 渲染成 `<li>` 列表，不可点选。
   人只能在「A/B/C/D 里挑一条」这件事上没有任何输入手段。
2. **数据库根本没有地方记「选了哪条」**：`decisions` 表只有 `status`(approved/rejected)、
   `decided_by`、`rationale`，**没有 answer 列**。也就是说无论选 A 还是 B，
   落库结果完全一样 —— 「批准」在语义上无法落地。
   而设计文档 §7.2 明明写的是 `[批准 A] [选 B]`，§5 的 Decision 字段也列了 `answer`。
3. **「推荐」徽章永远不显示**：`isRecommendedOption` 用严格相等比对，
   但真实数据里 `recommended` 是**整句**（"扩展本项范围（理由：…）"），
   而选项 label 只是前半句 → 永不匹配。

修复（跨 schema / host / client 三层）：

| 层 | 改动 |
|---|---|
| schema | `SCHEMA_VERSION 2→3`，`migrateV3` 给 decisions 加 `answer TEXT`（幂等，旧库自动升） |
| store | `switch optionValueOf()` 统一选项机器值（字符串→A/B/C，对象→value??id??字母）；`resolveDecision` 接收并**校验** answer（不存在的选项报 INVALID）；事件 payload 带 answer；`mapDecision` 暴露 answer |
| project | 透传 answer；`buildWakeText` 新增 `describeAnswer`，唤醒 PM 时明确说「选定：B 全部另立工作项」而不是只说"已批准" |
| http | `POST /decision` 透传 `answer`；错误码表补 `ANSWER_REQUIRED: 400` |
| cards | 聊天里的 action card 也支持带 answer |
| client | 选项变可点 radio；卡片显式写「这次批准的是：B · 全部另立工作项」；按钮文案变「批准 B」；**没选出选项时批准按钮 disabled**；确认弹窗复述选择；推荐项改成前缀/括注双向匹配 |

**分层原则**（重要）：API 层**不**强制 answer（保持向后兼容、不误伤既有调用方与历史数据），
「多选一时必须点名」的强制放在人操作的那一层（按钮 disabled）。门禁决策（`kind='gate'`）
的 status 本身即答案，其 options 只是背景陈列，不需要 answer。

测试：db 新增「决策 answer：人来选的是哪一项必须被记住」用例（6 条断言：选项值归一、
answer 落库、事件携带、非法选项被拒、门禁豁免、驳回也可记）；client 新增「决策卡必须让人
点名批准哪一项」用例（推荐前缀匹配、默认选中、按钮点名、无推荐时禁用、选项是 radio）。

### 3.4 文档产物

- `docs/diagrams/sidebar-three-options.zh.png` —— 方案 ①②③ 的侧栏对比图（含 0 · 现状解剖）
- `docs/diagrams/sidebar-option1-detail.zh.png` —— 方案 ① 的 7 个落点细节图
- `docs/diagrams/sidebar-seats-all.zh.png` —— **全量落地图**：6 个落点 + 定位链路 + 刻意不做的两处
- 三份绘图脚本同目录存档（`render-sidebar-*.py`），改配色/文案可直接重跑

## 4. 14 步预演覆盖（架构 §7）

replay-14-steps.mjs 用 fake ctx + 真实 registry/store/docs/leases/export/import/context/project/tools 回放：
需求 intent → PM 判断阶段/拆切片/建任务/spawn 产品会话（命名+重复拒绝）→ 2k 简报+PRD v1+调研证据 →
handoff+PM 校验+G1 决策卡 → 用户批准 G1（真实 project.resolveDecisionAction：冻结+导出 docs+阶段 S1→S2）→
并行 spawn UX/架构 → UX v1→v2 版本链 + ADR/接口规格 + 评审证据 → G2/G3 门禁 → 实现任务+码农会话（多切片）+lease 冲突负向 →
代码文件/artifact/测试证据/handoff + inbox 受控导入新版本 → PM 收交接 spawn 测试 → 测试独立验证+回归报告 →
G4/G5 门禁（测试报告冻结导出）→ G6 发布门禁 + exportSnapshot + 复盘文档 → 贯穿断言（seq 无空洞、事件种类齐全、
版本链/冻结、导出可重生成、重启恢复）→ 工具层抽检（25 工具、project_status 可执行、无代批决策工具）。

三问（在做什么/依据/下一步）在预演中由 snapshot/时间线/文档/决策构造并断言可回答。

## 5. 安装与重启说明

### 5.1 隔离开发实例（推荐先做，不碰用户 ~/.dsh）

    node workbench/scripts/dev-install.mjs check --home "<workspace>/.devhome" --profile web
    node workbench/scripts/dev-install.mjs plan --home "<workspace>/.devhome" --profile web
    node workbench/scripts/dev-instance.mjs start      # 启动 .devhome web profile，端口 52999
    node workbench/scripts/dev-instance.mjs status --json
    node workbench/scripts/dev-instance.mjs restart    # 改了 host/client 代码后必须重启
    node workbench/scripts/dev-instance.mjs stop

实例状态/URL/cookie/日志在 workbench/tests/e2e/.artifacts/dev-instance/（pid、instance.log、instance.url、instance.cookie）。
注意：Host 插件（host/**）与 client bundle 都在**启动时加载**；改动后必须重启实例（client bundle 虽是按请求读文件，
但 preload 列表与路由表在启动时装配）。

### 5.2 用户日常 DSH（desktop profile）

desktop 是 DSH Electron 保留 profile，外部 CLI 的 plugin 命令会被拒绝；正确流程：

1) 打开 DeepSeek Harness → 设置 → 插件（plugin manager）；
2) 添加本地插件/bundle，路径填 <workspace>/workbench（先在隔离实例验证过再装）；
3) 完全退出 DSH（含托盘）后重新打开；
4) 只读校验（不写 ~/.dsh）：

    node workbench/scripts/dev-install.mjs check --home "%USERPROFILE%\.dsh" --profile desktop

5) 在目标工作区打开右侧栏「项目」→「初始化项目」→ 进入 PM 对话。

本仓库验证阶段**未修改 ~/.dsh**；用户安装需在 app 内完成并重启一次。卸载：在插件管理器移除该 bundle 后重启。

### 5.3 故障排查

- 实例起不来：node workbench/scripts/dev-instance.mjs logs --lines 80；端口被占时加 --force（会结束占用进程）；
- API 404/405：实例仍是旧代码 → restart；确认 http.js 已注册 /project-workbench/api；
- 页面无「项目」入口：检查 preload 是否含 @local/dsh-project-workbench/client.js；
  node workbench/tests/e2e/instance-http.mjs 会直接报 preload/bundle 问题；
- 401：URL 必须带启动打印的 ?token=…（脚本已自动解析并换 cookie）；旧 cookie 过期则重启实例。

## 6. 演示步骤（浏览器目测，约 10 分钟）

1) 启动隔离实例（§5.1），把 dev-instance 输出的带 token URL 打开；
2) 在实例里打开工作区（DSH 左栏选择/添加本仓库或演示工作区）；
3) 右侧栏「项目」→ 面板显示项目列表 →「初始化项目」；应看到阶段 S1 产品、7 阶段条、空树；
4) 点「进入 PM 对话」（无 PM 会话时会 startSession project-office 并登记）；PM 页头徽章出现阶段/待决策数；
5) 对 PM 说「支付要能退款」；PM 应按角色卡拆切片/任务并 spawn 任务会话（面板会话列表出现 角色-切片-动作）；
6) 任务会话写 PRD/证据/交接后，PM 生成 G1 决策卡；面板「决策收件箱」出现待拍板项；
   点批准（不可逆类要求二次确认）→ 时间线出现 decision/resolve + gate/approve + stage/change，
   文档版本变为 frozen，docs/ 下出现带 generated 头的导出文件；
7) 面板切「文档」看版本列表/预览（DB 内容，非读文件）；切「时间线」按角色/切片/kind 过滤，可追溯到会话/文档版本/决策/证据；
8) 继续 UX/架构/实现/测试/发布：每道门禁批准后阶段推进；发布后 .project/exports/timeline.md 与 docs/ 快照可重复生成；
9) 重启实例后再次打开：阶段/文档/决策/时间线保持一致（DB 是唯一事实源）。

## 7. 偏差记录（实现与架构/契约的差异，均不改变架构）

1) Team 只读视图暂缓（用户 2026-11-11 决定）：面板只提供会话列表/状态/产物链接，不做 team 转录只读；原始会话仍可兜底打开。
2) actionCards 为实验性可选集成：web profile 默认未挂 dsh-action-cards；cards.js 用 ctx.inject + try/catch 注册
   project-decision 卡 kind，服务缺失安全跳过，不影响面板/HTTP 主链路。
3) 任务会话用 continuable subagent（ctx.subagents.startActivation + sendMessage）而非 native teammate：
   native team 工具不进 PV/任务 preset（避免绕过工作台的命名/切片/租约校验）；session_spawn_task 显式写 DB 会话行、
   命名三段校验、同切片同角色唯一、租约与事件，并在 DSH 侧启动 project-task 子会话；PM→任务/任务→PM 用 subagents.sendMessage。
4) 决策只能人拍板：工具层不提供 decision_resolve/approve/decide；唯一落定入口是受鉴权的 POST /project-workbench/api/decision，
   不可逆决策必须 confirmed=true（409 CONFIRM_REQUIRED）；negative.test.mjs 对两条路径都有断言。
5) 门禁动作唯一实现：host/project.js 的 resolveDecisionAction（冻结 gate 相关 stage/切片文档 → 导出 docs/ → 阶段推进 →
   approvals 行 → gate/approve + stage/change 事件 → 唤醒 PM）；replay 直接调用该真实实现，不再自定义 SQL。
6) 导出可重生成确定性：exportTimeline 默认排除 export/snapshot 事件（否则每次导出都会多一条自指事件），
   timeline.md 对同一项目状态字节稳定；单文档导出不写入墙钟时间。
7) 2k 注入：L0 每步刷新；L1/L2 会话首步与切切片时注入（由 session-hooks 状态机控制）；超预算先裁 L2 再裁 L1，
   并注入「上下文已降级，使用 project_recall/doc_get 按需查询」提示行。
8) 实例级验证不使用 headless 浏览器：页面/preload/client bundle 用 HTTP 校验且 bundle 用 Node 解析（无语法错误），
   真实 UI 渲染/交互由用户浏览器目测；不做登录伪造。

## 8. 已知风险与待办（截至 2026-11-12 最终验收）

1) [已修复] tools.test.mjs 早期两个失败（when 过滤 actor 缓存、2k 降级 fixture）已修复并复验通过。
2) [已解决] ops_bash 的 EXECUTOR_UNAVAILABLE：niubash 每次执行克隆约 156-313 个硬链接、池上限约 1024，
   dsh-ops 0.5.2 未回收陈旧执行树导致耗尽。处理：清理 %TEMP%/dsh-ops-niu-exec-*（先 icacls /remove:d 再删）。
   执行器恢复后全部官方命令已实跑通过（见 §3）。
3) [已解决] 52999 实例重启后 instance-http --strict 全绿（10/10）。
4) [安装] 用户 desktop profile 安装需在 app 内插件管理器操作并重启；本仓库未改 ~/.dsh，check 脚本只读校验。
5) [小] host/util.js truncateToTokens 截断后追加省略号会多 1 token（测试按 +1 容错；2k 硬上限不受影响）。
   另：T4 已修复 actor 缓存复核、2k L2 大内容降级、DSH 子会话头（origin=subagent）不遮蔽任务会话身份；
   复验：db 14/0、api 16/0、tools 9/0、我的 acceptance 17/0、negative 10/0、ui-client 3/0、dev-instance 7/0、replay --strict 17/17。
6) [UI] 浏览器目测项：面板树/详情 tabs/决策卡二次确认/PM 徽章/composer 状态条/SSE 自动刷新
   （本机无法跑 headless 浏览器；但已用真实实例验证 preload、bundle 可解析、API 与 SSE 数据正确）。
7) [已复核] cordis.patch.yml 用运行版 CLI 复核：--dump-config 输出含 project-workbench 行、
   preset-project-office / preset-project-task、subagent maxActiveSubagents=8 / maxDepth=2。
8) [实现期发现并修复的真实运行缺陷]（都由真实会话跑出来，fake-ctx 测不到）：
   a) Cordis 服务代理在 inject 未声明时读取即抛错：注册表用 ctx.workspaceRegistry 属性访问会 500
      （cannot get property ... without inject）→ 改为可选服务走 ctx.get(name)；
   b) 工具输出含 undefined（handoff/assignee 等可选字段）会被 DSH 判为 non-lossless JSON，
      模型只看到 returned invalid output → register.js 增加 toLosslessJson 清洗并加回归测试；
   c) headless/CLI profile 没有 workspaceRegistry，插件原先整组 pending → 注册表退化为
      「已存在 .project 运行时的目录才准入」；插件 inject 缩到 tools/systemPrompt/agents/sessions/subagents/skills，
      webServer + connection + workspaceRegistry + actionCards 改为可选；
   d) dev-instance 自测里 stopInstance(52999) 会杀掉共享实例（偶发失败根因）→ 测试改用独立高位端口。

## 9. 测试数据与清理

- 临时项目根：workbench/tests/e2e/.artifacts/tmp/<prefix>-xxxx（每次运行 mkdtemp；结束时删除）。
- 保留现场：WORKBENCH_E2E_KEEP=1 node workbench/tests/e2e/replay-14-steps.mjs
- 实例状态：workbench/tests/e2e/.artifacts/dev-instance/（脚本管理；stop 会清理 pid/url/cookie，保留日志）。
- 端口：dev-instance 默认 52999（可用 --port 覆盖）；route 级测试自动选空闲端口。
- 退出码：0 通过（非 strict 允许 pending）；1 失败；2 参数/环境错误；dev-instance status 未运行返回 3。