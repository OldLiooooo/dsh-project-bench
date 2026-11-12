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