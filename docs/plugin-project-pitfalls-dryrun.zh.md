# 在 DSH 上用插件做一个完整项目：坑位预演（dry-run）

> 日期：2026-11-14 · 依据：本仓库 `workbench/` 插件 v1 实际交付过程 + 本机运行版平台源码实测 + 独立审查与 Git/CI 事后复盘。
> 这不是"通用建议"，是**这个插件真的踩过、且证据可复现**的清单。每条都给出：现象 → 根因 → 证据 → 提前预防。

---

## 0. 一句话结论

坑分三类，**杀伤力递减、发生率递增**：

| 层 | 坑 | 后果 | 何时才发现 |
|---|---|---|---|
| A 架构 | **权威源放在 agent 可写的地方** | 所有业务约束形同虚设 | 上线后被人/agent 绕过 |
| B 状态机 | **阶段门禁 / 租约 / 交付 / 导出各自为政** | 一致性错乱但功能"看起来正常" | 真实数据 + 真实顺序 |
| C 验收 | **测试全绿 ≠ 正确** | 假绿，带着缺陷发版 | 用户第一次用就撞上 |

**最贵的一课**：README 写「v1 feature-complete、全部测试通过」的同一天，独立审查结论是
「当前实现存在可触发的业务一致性缺陷，**不能判定业务逻辑正确**」（[business-logic-review.zh.md](implementation/business-logic-review.zh.md)）。
两句话都对——因为测试测的是"我以为的行为"。

---

## 1. 预演时间轴：坑出现在哪一步

### P0 立项 / 设计（1–2 天）—— 债在这里就欠下了

| # | 坑 | 现象 | 预防 |
|---|---|---|---|
| 0.1 | **权威源选址** | `.project/project.db` 放在工作区内 → 任务会话 preset 带 `bash`+`pwsh`+`fs write`（[cordis.patch.yml](../workbench/cordis.patch.yml)），一条 `node -e` 就能直连改写 | 开工前先决定：DB 放 `~/.dsh/storages/`（实测 agent 为 EPERM）还是放工作区（接受"约束靠自觉"） |
| 0.2 | **约束强度写错** | 设计写"events append-only""一个事实一行"，实现只有 6 条应用层写前校验，DB 层 `CREATE TRIGGER`=0、`CHECK(`=0 | 设计里每条约束都标注**落在哪一层**（DB 约束 / 领域函数 / 提示词），不能只写"应当" |
| 0.3 | **状态机没画完** | 阶段、门禁、租约、文档冻结、导出各有各的规则，没人定义"哪些转移非法" | 先写一张"状态 × 允许动作 × 拒绝码"表，再写代码 |
| 0.4 | **人身份没建模** | `decidedBy` 固定字符串 `'user'`，"人" = 过了 cookie/origin 围栏的请求 | 只要有多用户/共享实例的可能，现在就把 approver 身份存下来 |
| 0.5 | **设计文档比实现大 10 倍** | `project-workbench-design.zh.md` 129 KB / 1929 行，实现用的是它的一部分 | 设计只保留"会被实现和验收的部分"，其余进 archive（本仓库最后确实归档了一批） |

### P1 骨架 / 安装（半天）—— 最容易卡死不动

| # | 坑 | 现象 | 预防 |
|---|---|---|---|
| 1.1 | **link 安装骗过 `files`** | 本地目录链接安装不过滤 `files`，漏文件也照跑；`pnpm pack` 出的 tarball 才暴露 | 每次发包前 `npm pack --dry-run` 对清单；用 tarball 在干净 profile 装一遍 |
| 1.2 | **改代码不生效** | Host 代码与 preload 列表在**启动时装配**，改完必须重启；以为是 bug | 固定一条 `dev-instance.mjs restart` 的肌肉记忆 |
| 1.3 | **patch 行覆盖 = 整体替换 config** | 只改一个键，其它键全丢（不深合并） | 覆盖别人的行（如 `subagent`）时把全部键重述一遍 |
| 1.4 | **`engines.dsh` 与实机不一致** | 设计期参照 0.2.1 源码、运行版是 0.2.2-rc.x，API 有出入 | 以**运行中安装**为准，不以仓库源码为准 |
| 1.5 | **desktop 是保留 profile** | 外部 CLI `dsh plugin --profile desktop` 直接被拒 | 装机路径只有两条：app 内插件管理器 / 独立 `DSH_HOME` 实例 |
| 1.6 | **执行器本身会挂** | 实现期 `ops_bash` 全量 `EXECUTOR_UNAVAILABLE`（niubash 硬链接池耗尽），本轮会话也复现了一次 | 预留 in-process（PTC）验证路径；别把"跑测试"当唯一验证手段 |

### P2 核心域（最长，坑最密）—— 一致性都在这里翻车

| # | 坑 | 现象（均有复现） | 预防 |
|---|---|---|---|
| 2.1 | **门禁不校验"当前阶段"** | S1 active 时提交并批准 S4 门禁 → S4 done、S5 active，S1 仍 active（两个 active） | 提交与批准两端都校验：阶段存在 + gate 匹配 + 状态 + 是否过期 |
| 2.2 | **批准集合 ≠ 提交集合** | 提交 S1 文档 A 被接受，批准时按 stage 查找冻结了文档 B，A 未冻结 | 批准时冻结**提交时那一组**，并回显实际集合 |
| 2.3 | **批准不绑定版本** | 提交 v1 后追加 v2，原审批直接冻结 v2 | 存 docId + version + hash 快照；内容变了要求重新提交 |
| 2.4 | **租约过期仍能收工** | 租约被 B 接管后，A 的 `session_finish_task` 仍返回 `finished=true`，任务变 done、切片变 review，B 还持租 | 收工路径先校验租约，且状态变更走同一事务 |
| 2.5 | **失败收工返回错的状态** | `status=failed` 后 DB 是 `blocked`，返回值却是 `review` | 返回值一律来自**更新后的实际记录**，不要常量 |
| 2.6 | **派活失败留下幽灵任务** | `startActivation` 抛错 → 会话结束、租约释放，但 task 仍 `in_progress` 且指向 failed 会话 | 补偿事务：失败即回滚任务状态与负责人，或原子标记 |
| 2.7 | **导出路径撞车** | 逻辑键 `prd/a-b` 与 `prd/a/b` 都映射 `docs/product/prd-a-b.md`，后者覆盖前者，两次都"成功" | 用稳定唯一 ID/哈希后缀，或导出前做路径冲突检测 |
| 2.8 | **"唯一写者"只靠自觉** | 应用层 6 条校验可拒；DB 层 0 条防线；`node:fs` 直连完全绕过 | 要么把 DB 搬出可写区，要么补触发器/唯一索引，要么如实写成"非强制约束" |
| 2.9 | **上下文预算只管注入** | 2k 硬上限只约束注入文本，工具结果不受限（`doc_get` ≤1500 token 等另设） | 预算要覆盖"注入 + 工具返回 + 卡片"三处 |

### P3 UI / 扩展点（坑最"静默"）

| # | 坑 | 现象 | 预防 |
|---|---|---|---|
| 3.1 | **抢 single 槽 = 静默杀掉官方能力** | `sidebar.workspaces` 被影子覆盖后，目录选择器、行尾归档/置顶、行装饰**全部消失**；子槽重述直接 `slot ... is already declared` | 只加不减：在官方 **list 槽**追加自己的 id，不设 priority；测试里断言"single 槽 0 注册" |
| 3.2 | **槽作用域搞错** | root 作用域槽的 inject 不接收 `sessionId`，要从渲染点 ownerProps 取 | 按槽的 owner 作用域传参，别在 inject 里瞎找 |
| 3.3 | **数据通道自造第二套** | 席位里 fetch/轮询会带来刷新竞态与重复请求 | 数据只在 `hub.publish` 里用纯函数派生，席位只读 |
| 3.4 | **SSE 去抖丢更新** | 旧快照请求未完成时来新 revision，去抖复用旧 Promise，**revision=2 已收到却只显示 revision=1，且没有补拉** | 记 `dirty/targetRevision`，旧请求结束后补拉一次 |
| 3.5 | **线格式两套** | `/projects` 发阶段**对象**、`/snapshot` 发字符串 → 真实数据渲染成 `[object Object]`；fixture 用字符串所以测试没抓到 | 同一字段全链路一个形状；fixture 用**真实库快照** |
| 3.6 | **UI 只测注册不测交互** | `ui-client.test.mjs` 只验槽位注册与纯函数，"6 例全过"不含任何浏览器行为 | 明写"像素/交互需人眼验收"，或补 headless 浏览器 |
| 3.7 | **demo 里的语义缺口** | 决策卡选项是纯展示、DB 根本没有 `answer` 列、"推荐"徽章永不匹配 → 用户问"批准的是哪个？" | 设计文档里的字段（`answer`）必须同时出现在 schema、API、UI 三处 |

### P4 验收 / 发布 / 运维

| # | 坑 | 现象 | 预防 |
|---|---|---|---|
| 4.1 | **探针劫持门禁** | `check-syntax.mjs` import 了 `tests/probes/*.mjs`，探针顶层 `process.exit` → **退出码来自探针，门禁报告再没打印过**，语法门禁 = 失效 | 门禁脚本必须有"自己跑过"的证据（打印统计），且断言扫描清单 |
| 4.2 | **Windows 原子写抖动** | `.project/exports`、`docs/` 下偶发 `EPERM rename`（文件被占用） | 重试 + 抖动与缺陷分开记档，别当业务 bug 追 |
| 4.3 | **治理反噬** | 复盘数据：docs 提交 46%、ci 21%、产品目录仅触达 8 次 | 设止损线：治理提交占比 >30% 告警、>40% 强制复盘 |
| 4.4 | **git 直装跑不起来** | git 安装不跑 build；pnpm ≥10 默认不跑 `prepare`，要用户 `allowBuilds` 授权 | 分发优先 npm / tarball；git 方案必须锁 commit 并提示授权风险 |
| 4.5 | **收工后 agent 仍 idle 存活** | DB 会话已结束、项目工具已隐藏，但 DSH agent 还在 | 平台无自我 dispose API → 写进"已知边界"，别当 bug 修 |

---

## 2. 三条硬约束：不要对抗，只能绕

### A. 沙箱只有 allow-list，没有 deny-list
`.runtime/dsh-sandbox/lib/index.js:239-246`：`workspace-write` 的可写根 = `[workspaceRoot, ...additionalWritableRoots, /tmp, os.tmpdir()]`。
**"工作区可写但 `<workspace>/.project` 不可写"这个需求，用沙箱表达不出来。**

→ 唯一有效动作是**换位置**：把权威源放到 agent 物理碰不到的地方（实测 `~/.dsh/storages/` 为 EPERM），或接受"靠应用层自觉"。

### B. 工具层管不住 in-process 的 `node:fs`
- `tools.guard()` / pre-execute 能拦**工具调用**；
- `tools.restrict()` **不能点名 `run_code`**（`.runtime/dsh-tools/lib/index.js:463` 直接抛错），只能整体禁用；
- 但 `run_code` 里的裸 `fs.writeFileSync` **完全绕过工具层**，连 `tool/call` 事件都不产生；
- 按命令串做 bash 黑名单也能绕过：`P=.pro''ject && echo x > "$P/probe.txt"` 照样 exit 0。

→ 插件本身跑在 Host 进程、用裸 `node:fs`，**不受会话沙箱约束**——这也是"插件可以是唯一写者"的唯一支点。把它写进架构，而不是写进道德约束。

### C. single 槽影子覆盖会传染
`.runtime/dsh-client-ui-renderer/lib/client.js:348-395` 的 `SlotOwnershipError`：组件只能渲染**自己声明过的**子槽。
影子覆盖 `sidebar.workspaces` 后不能重述官方那 5 个子槽（`slot ... is already declared`），于是官方能力静默消失。
整块替换要自建约 6k 行等价物。

→ 结论：**只加不减**。想"只剩项目视图"，靠产品路径引导，不靠删官方入口。

---

## 3. 「假绿」清单：12 种"测试通过但产品是错的"

| # | 假绿方式 | 这次的真实案例 |
|---|---|---|
| 1 | 测试测的是"我以为的形状" | `stage` 真实是对象，fixture 用字符串 → `[object Object]` 上线级 |
| 2 | 门禁脚本被别的脚本劫持 | `check-syntax` 被 `tests/probes` import 后 `process.exit` 接管退出码 |
| 3 | 只测注册不测渲染 | UI 6 例全过，浏览器里从没跑过 |
| 4 | fake ctx 测不到真实服务行为 | Cordis 服务未声明 inject 时**读属性即抛错**，fake ctx 永远不抛 |
| 5 | 输出非 lossless JSON | 可选字段 `undefined` → DSH 判非 lossless，模型只看到 "returned invalid output" |
| 6 | 只在有 GUI 的 profile 里测 | headless/CLI 没有 `workspaceRegistry`，插件整组 pending |
| 7 | 单测跑在共享端口上 | `stopInstance(52999)` 顺手杀掉共享实例 → 偶发失败 |
| 8 | 复现脚本 exit 0 被当通过 | 业务审查脚本"打印错误行为即成功"，退出码 0 **不代表**业务通过 |
| 9 | 真实模型 vs 假模型 | 真实 LLM 才会把工具调错、把参数写歪；mock 不会 |
| 10 | 真实库 vs 临时库 | 用你机器上的真实项目库跑一遍，才抓出 `[object Object]` |
| 11 | 只测 happy path | 派活失败/租约过期/版本漂移全部只在负向路径暴露 |
| 12 | "文档写了 = 实现了" | 设计写了 `answer` 字段，schema 里根本没有这一列 |

**可操作的对策**：每个"核心域"必须同时有 ①fail-path 负向用例 ②真实库快照 fixture ③真实实例 HTTP ④（有条件时）真实模型 E2E。
少任何一条，就在交接里写明"这条没验"。

---

## 4. 开工前必须拍板的 8 件事（建议做成决策卡）

1. **权威源放哪**：工作区内（agent 可写，约束靠自觉）vs `~/.dsh/storages/`（物理隔离，但要改 registry 与 headless 兼容）。
2. **约束强度做到哪层**：只做应用层校验 / 加 DB 触发器与唯一索引 / 两者都要。
3. **单写者纵深**：只拦工具层（挡 90%）/ 连 DB 触发器 / 连"把 DB 搬出去"。
4. **人的身份**：单一 `'user'` 字符串，还是记录 approver ID（多用户/共享实例必选后者）。
5. **UI 边界**：只加 list 槽装饰（安全）vs 影子覆盖 single 槽（静默丢官方能力）。
6. **测试验收口径**：谁负责"真实实例 + 真实模型 + 真实库"这一层？没有它，全绿不算数。
7. **分发渠道**：npm / tarball / git（git 需 `prepare` + `allowBuilds`，风险自担）。
8. **治理止损线**：治理/文档提交占比、重复收尾次数、未验收积压的上限。

---

## 5. 可直接抄的最小 checklist

**开工**
- [ ] 画状态机：实体 × 状态 × 允许动作 × 拒绝码（含失败补偿路径）
- [ ] 每条设计约束标注落点层级（DB / 领域函数 / 提示词 / 仅文案）
- [ ] 决定权威源位置，并写清"agent 能不能绕过、绕过后谁兜底"

**写代码**
- [ ] 所有写路径走同一领域函数 + 同一事务；返回值来自更新后的记录
- [ ] 可选服务用 `ctx.inject`，硬依赖才放 `inject` 数组；核心服务缺失要能降级而不是整组 pending
- [ ] 工具输出过 lossless 清洗（`undefined`/`Date`/`循环引用`）
- [ ] 覆盖他人 patch 行时重述全部键
- [ ] client 侧：数据只在 publish 时纯函数派生；不 fetch/不轮询；刷新记 `dirty` 补拉
- [ ] 槽位只加 list 槽、不设 priority、不碰 brand/toggle 等 single 槽

**验收**
- [ ] `npm pack --dry-run` 对清单；tarball 在干净 profile 装一遍
- [ ] 负向用例覆盖：越权、重复、冻结、租约、过期审批、失败回滚
- [ ] 真实实例 HTTP/SSE + 真实库快照 + （有条件）真实模型 E2E
- [ ] 门禁脚本自证"我跑过"（打印统计 + 断言扫描清单，防被 import 劫持）
- [ ] 明写"没验的部分"（浏览器像素、多用户身份、跨平台路径）

**交付**
- [ ] `engines.dsh` 对齐**运行中**版本，不是仓库源码版本
- [ ] README 区分"测试通过"与"业务正确"，并链接独立审查结论
- [ ] 已知边界清单（agent 收工后仍 idle、原始会话仍可输入、无 deny-list 等）

---

## 6. 如果只记三句话

1. **把权威源放到 agent 写不到的地方**，否则你写的所有约束都只是提示词。
2. **状态机（含失败补偿）比功能重要**——坑几乎全在"失败/并发/过期"这三类路径上。
3. **"全绿"是自证，不是他证**：至少要有一种验证手段，跑在真实实例、真实库、真实模型上。
