# 交付审计：设计初衷 vs 已实现（2026-11-21）

> 目的：回答「插件做到什么程度了，是不是一个合格的项目 PM」。
> 方法：把设计提案、架构施工图、设计逻辑里的每一条支柱，逐条对到**代码**与**今天实跑的测试**上。
> 本文件只记录可复核的事实；判断与结论写在每节的「判断」里，缺口写进 [BACKLOG](BACKLOG.zh.md)。

---

## 0. 一句话结论

> **2026-11-21 第二轮更新**：第一版审计（下方 §1–§7）的结论是「治理内核合格，PM 没合格」，
> 三条核心武器全缺。第二轮已把 **B1–B7 全部落地为 schema v5**，结论随之改变 ——
> 详见文末 **§8 v5 落地与结论重估**。下方 §1–§7 保留为第一版快照，不追改（审计要能看出变化过程）。

**（第一版，2026-11-21 上午）治理内核合格，项目经理没合格。**

它是一个很硬的「项目流程执行器 + 审计账本」：权威源搬得出去、非法状态转移真的能拒、门禁判据真的来自机器、
人批准是唯一出口 —— 这几条设计初衷全部兑现。

但它还不是设计里那个 PM，因为 PM 的三件核心武器**一件都没有**：进度度量（Verified Done）、
独立验收闭环、周期与范围控制。现状能管「状态怎么流」，不能管「进度到哪了、该砍什么」。

---

## 1. 今天实跑的测试（命令逐条可复跑）

```bash
# 必须指到工作区内（真实 ~/.dsh 对沙箱是 EPERM，这本身反证单写成立），且必须写 Windows 路径：
# MSYS 的 $(pwd) 给 /c/Users/...，node 会拼成 C:\c\Users\... → 整批 EPERM。
export DSH_HOME='C:/Users/you/repo/.artifacts/dshhome'
```

全部在 **commit `99926f2`（origin/main HEAD）** 上复跑，工作区 `git status` 干净。

| # | 命令 | 结果 | 备注 |
|---|---|---|---|
| 1 | `node workbench/scripts/check-syntax.mjs` | 53 文件 / 0 语法 / 0 import | PASS |
| 2 | `node --test --test-isolation=none workbench/tests/unit/` | **99：98 pass / 0 fail / 1 skip** | skip = 真实 git diff（`spawn` EPERM） |
| 3 | `node workbench/tests/e2e/negative.test.mjs` | 10 / 0 | 401、重复会话、frozen、租约、seq 连续 |
| 4 | `node workbench/tests/e2e/ui-client.test.mjs` | 7 / 0 | 11 槽位注册齐全 |
| 5 | `node workbench/tests/e2e/replay-14-steps.mjs --strict` | 17 / 0 | 14 步业务预演 + 重启恢复 |
| 6 | `node workbench/tests/e2e/dev-instance.test.mjs` | 8 / 0 | 安装校验 / 拒绝 CLI 装 desktop |
| 7 | `node workbench/tests/probes/gate-real-checkers.mjs` | 3 / 0 | 真实 checker 红/绿/故障三态 |
| 8 | `node workbench/tests/probes/governance-e2e.mjs` | 27 / 0 | 真实 lumio 副本的完整治理闭环 |
| 9 | `cd 3d-tree && npm test` | 91 / 0 | 31+23+9+15+13 |

**合计：263 项断言，262 pass / 1 skip / 0 fail。**

### 1.1 运行态证据（非测试）

| 检查 | 结果 |
|---|---|
| 正在运行的 GUI `127.0.0.1:56295` 上的插件路由 | `/project-workbench/api/*` → **401**（鉴权在前）；未知路由 → **404**。说明 Host 面板路由**真的挂在当前实例上**，不是只在测试里存在 |
| `dev-install.mjs check --profile desktop` | profile 依赖 `link:...\workbench`，bundle 清单在位 → 用户态安装通 |
| 沙箱写真实 `~/.dsh` | `EPERM`（这本身反证「权威源 agent 碰不到」成立） |
| 测试是否会污染真实 `~/.dsh` | 指到工作区内跑完 99 例后，真实 store 目录数量 17 → 17，**不污染** |

### 1.2 未复跑的（如实标注，不冒充今天的结果）

| 套件 | 为什么跑不了（实测原因） | 末次结果 |
|---|---|---|
| `e2e/instance-http.mjs --strict` | 需要已启动的 `dsh web` 实例；本沙箱 `child_process.spawn` 返回 **EPERM**（`status null err EPERM`），`dev-instance.mjs` 的 detached 启动起不来 | 10/0（2026-11-19） |
| `e2e/live-e2e.mjs` | 同上，且需要真实模型路由 | 4/4（2026-11-19） |
| `e2e/live-inprocess-instance.mjs` | 要 `import` `app.asar` 里的 `profile-boot` → 纯 node 下 **ERR_MODULE_NOT_FOUND**（已复现）。这是它的固有属性，不是缺陷 | 15/0（2026-11-14） |
| `e2e/live-governance-http.mjs` | 同上 | 13/0（2026-11-14） |
| `probes/seats-realdata.mjs` | 依赖 `C:/Users/oldap/Documents/lumio/.project` 的真实库副本；且**该探针本身有一条断言已过期**（见 §5） | FAIL（1 条） |

---

## 2. 设计支柱逐条对照

| # | 设计支柱 | 出处 | 完成度 | 判断依据 |
|---|---|---|---|---|
| A | 权威源外移 + 数据模型 + 版本链 + append-only 事件 | 决策 1、架构 §8.3 | **95%** | 24 表（23 + 1 FTS5）、11 触发器；store 在 `$DSH_HOME/storages/`，测试进程写 `~/.dsh` 实测 EPERM |
| B | 能拒绝的状态机 + 双点门禁 + 事务补偿 | 决策 2/3、ADR-0001/0002 | **90%** | 四段式 preflight→commit→apply→settle + outbox 重放；判据红/绿/故障/无判据四态 |
| C1 | 租约 + 栅栏令牌 + 真实 diff | 决策 6、ADR-0003 | **85%** | `LEASE_FENCED`、三档作用域判定实测；非 git 只能 `verifiable=false`（设计如此） |
| C2 | 阶段写路径硬控制（S1 禁写 `src/**`） | §12.1.3 四层拦截 | **0%** | `allowedPaths`/`forbiddenPaths`/`stagePolicy`/`stage_override` 在 host 里 grep **全部 0 命中** |
| D | 会话编排（PM/任务、命名、角色、2k 预算、失败状态） | §4.1、决策 7 | **85%** | 27 工具；可见性 PM 23 / 任务 15 / 普通与子 agent 0；失败带 `failure_code`；整段简报 2000 硬顶 |
| E | 人类接口（决策卡、不可逆、身份可追责） | 决策 5 | **75%** | 工具层无代批入口；`irreversible` 必须 `confirmed`；但 `deadline` 只有 schema 列，工具无参数、UI 不展示 |
| F | 驾驶舱 | §7.2 七视图 | **70%** | 5 个 tab（概览/会话/文档/决策/时间线）+ 11 席位；看板/路线图/依赖图/燃起图/指标页/Team 只读**全缺** |
| G | 度量体系 + PM 控制回路 | §6.2/§6.3/§6.4 | **10%** | `milestone`/`risk`/`issue`/`assumption`/`cycle`/`appetite` 在 host 与 client 里 **0 命中** |
| H | 专家团（7 角色 + 7 技能 + preset） | §4.2 | **70%** | 角色卡/技能模板齐；但**没有独立验收 preset**，也**没有 builder≠verifier 校验** |
| I | 交付链（commit/push/PR/CI→证据） | §10.2 Phase 3 | **0%** | 设计写明是后续阶段，不算欠账 |

### 2.1 兑现得最漂亮的四条

1. **「约束要么在 DB，要么在领域函数；提示词里的话不算约束」** —— 11 个 DB 触发器，`probes/w1-guards`
   实测 8 项反证全拦、4 项合法写全放行。
2. **「判据必须来自机器」且 fail-closed** —— 判据说不过拒、跑不起来也拒、没判据就如实标 `skipped`。
   `governance-e2e` 里「真实 checker 红 → 补记忆后真绿 → 才放行」这条链完整（27 断言）。
3. **「文件系统不参与事务」被正面解决** —— `export_outbox` 对账 + 事务外落盘 + 可重放；
   并明确「绝不因导出失败回滚阶段推进」。
4. **失败路径单独测** —— `failure.test.mjs` 16 例专测「不该发生的时候会不会留烂摊子」。

### 2.2 缺口最大的一块：没有「进度」

- `health` 只有三档推导（有阻塞→blocked，有待决策→attention，否则 on_track），没有「% 完成」。
- 设计 §6.2 列了 13 个指标，代码里**一个都没有**。
- **状态枚举里没有 `verified`**（`slices`: open/in_progress/review/blocked/done…），
  所以「Verified Done 是唯一进度口径」**在数据模型里没有落点**。
- `evidence.verified_by` 列存在，但 host 代码**从未写入它**（只有 schema 与一行读取映射）→ 字段是死的。
- 没有 QA preset，测试角色与实现角色都是 `project-task` → **「建造者不验收」只靠角色文案，没有机制**。

---

## 3. 设计里有、代码里没有（落点级证据）

| 设计条目 | 出处 | grep 结果 |
|---|---|---|
| 阶段写路径硬控制 | §12.1.3 | `allowedPaths` / `forbiddenPaths` / `stagePolicy` / `stage_override` → 0 命中 |
| 风险/问题/决策/假设四本账 | §6.4 | `risk` / `issue` / `assumption` 建表 0 命中；`links` 表建了但**从未写入**（`INTO links` 0 命中） |
| 周期 / appetite / circuit breaker | §5.4 | `cycle` / `appetite` / `milestone` → 0 命中 |
| 看板 / 路线图 / 依赖图 / 燃起图 / 指标页 | §7.2 ②③④⑤⑥ | client 只有 5 个 tab；`dependsOn` 0 命中 |
| 自动日报/周报 | §7.5、架构 §10「定时」 | host 里 `schedule` / `cron` → 0 命中 |
| 独立验收（QA preset + 只读） | §10.5 决策 4 | presets 只有 `project-office` / `project-task` |
| 决策 deadline + 超时策略 | §6.3 | `deadline` 仅 schema 列与读取映射；`decision_create` 参数里没有，client 不展示 |

---

## 4. 「配置写了但没人读」这一类（本次新增记录）

| 项 | 现状 | 后果 |
|---|---|---|
| `period` | `snapshot.js:122` 读 `db.getMeta('period')`；全仓库 **无 `setMeta('period')`** | 周期永远是「当前月」，设计 §5.4 的周期无数据落点 |
| `deliverableTypes` | 内置 S1–S7 与 `LUMIO_STAGE_TEMPLATE` 都声明了；仅 `normalizeStageTemplate` 校验，**门禁与写路径从不读** | 「S1 只能产 prd」目前只是文案 |
| `evidence.verified_by` | 列在，读取映射在，**写入点 0** | 「谁验收的」不可追溯 |
| `links` 表 | 建表在，**写点 0** | 证据↔文档↔决策的图关系只能靠 payload 里的自由字段 |

> 这一类值得单独记：它们**不是没写代码**，而是写了一层、另一层没接上。
> 比「完全没做」更危险，因为它看起来是「已实现」。

---

## 5. 本次发现并修掉的缺陷

| # | 缺陷 | 修法 |
|---|---|---|
| 1 | **仓库 HEAD 跑不起来**：`host/checkers.js`、`host/identity.js`、`host/scope.js` 未入库，但 `http.js:6`、`project.js:41`、`tools/index.js:10-11`、`pm-tools.js:8`、`task-tools.js:6` 都在 import | 提交为 `feat(workbench): v4 治理加固运行时` |
| 2 | `git add .` 会收进 1420 条垃圾（`.sandbox/` 17M 副本、`undefined/` native 缓存、`/.project/`） | `.gitignore` 增 3 条，降到 100 条真实文件 |
| 3 | `3d-tree` 的 `server.test.mjs:181` 断言页面含 `renderer.js`，但 `index.html:178` 实际 import `viewer.js` → **长期 90/91 红** | 改为断言 `viewer.js` 并核对 `/viewer.js` 可取；同时把 `package.json` 的 test 脚本从 3 个文件补成 5 个 → **91/91** |
| 4 | 文档 8 处计数漂移（工具/表/触发器/路由/模块/行数/用例数/空 catch） | 逐条改为实测值；`§9 歧义清单` 保留 v1.1 历史并补 v4 现值 |
| 5 | **`probes/seats-realdata.mjs` 长期 FAIL**：`flat(pmChip) !== 'P'` 取的是 `snap.sessions[0]`，但真实 lumio 库里第一条会话是「架构」不是 PM → 断言恒假 | 改为按 `kind === 'pm'` 找 PM 行再断言；找不到 PM 行则单独报「快照里没有 PM 会话行」。**修后 PASS**（同一次运行里 `[object Object]` 0 处，PM 徽章 `P`、其余显示角色首字 —— 席位组件本身是好的，是探针取样假设过期） |
| 6 | **`probes/governance-e2e.mjs` 的 ②c 会误报**：它拿 `process.env.DSH_HOME` 当「真实用户目录」去探 EPERM，而其它套件要求把 DSH_HOME 指到工作区内 —— 工作区对会话沙箱可写，于是把「测试沙箱可写」误报成「单写未成立」 | 改为：DSH_HOME 指向**工作区外**才认作真实目录，否则回落到 `homedir()/.dsh`。修后**设或不设 DSH_HOME 都 27/27**。这正是 handoff-2026-11-20 里那条「不要设 DSH_HOME，否则 ②c 会误报」的根因 —— 靠「记得别设」规避的坑，应该修在代码里 |

### 5.1 仍未修的已知偏差

| 项 | 说明 |
|---|---|
| `live-inprocess-instance` / `live-governance-http` 只能在 DSH 进程内跑 | 要 `import` `app.asar` 的 `profile-boot`，纯 node 下 `ERR_MODULE_NOT_FOUND`。固有属性，等价覆盖由 `instance-http` + `live-e2e` 提供（但这两项本次未能复跑，见 §1.2） |

---

## 6. 交付卫生

| 项 | 状态 |
|---|---|
| 提交历史 | 收尾前最后 commit 是 **2026-11-12**，9 天未提交，期间全部 v4 工作悬空 → 已按主题分 7 个 commit 入库 |
| 垃圾目录 | `.sandbox/`(17M) / `undefined/` / `/.project/` 已 ignore |
| 大文件 | 最大入库项：`docs/diagrams/*.png` 1.9M、`3d-tree/web/vendor` 760K；195M 的 e2e 运行产物由既有 `.artifacts/` 规则拦住（`git check-ignore -v` 已验证） |
| 凭据扫描 | `workbench`/`docs`/`README.md`/`3d-tree` 全量 grep `sk-`/`ghp_`/api_key/PRIVATE KEY → 0 命中 |
| `~/.dsh` 残留 | 17 个 store，其中 16 个是 2026-11-21 的测试残留（`name=测试项目`）。沙箱删不动（Permission denied），需人工清理，**保留 `8aad783e7d4011f2`（lumio 真库，86 事件）** |
| `CON` 文件 | Windows 保留设备名，读取会把终端挂死（实测 2 次超时）。已由 `.gitignore:36` 排除且未入库，**不读不删** |

---

## 7. 结论：它现在是个什么样的 PM

**能干（已验证）**
- 接一句需求 → 拆切片/任务 → 拉起「角色-切片-动作」任务会话 → 注入 2k 简报 → 收交接
- 门禁前跑真实判据，红了就拒、不留 pending；提交后仓库变了 → `STALE_PRECHECK`；文档改版 → `STALE_APPROVAL`
- 人批准后：冻结 + 导出 + 推进阶段 + 写时间线 + 唤醒 PM，全在一个可补偿的四段式里
- 同切片并发写被租约 + 栅栏令牌挡住；收工要拿真实 diff 对作用域
- 换阶段模板要人确认，旧阶段 retire 不删，历史事件不断链

**干不了（见 §3 与 [BACKLOG](BACKLOG.zh.md)）**
- 回答「现在进度百分之几、还差多少」
- 回答「这个周期做几件事、超了没有」
- 回答「风险 Top-3 是什么」
- 拒绝「S1 阶段偷偷写 `src/**`」
- 独立验收（第二个会话、只读权限、验收人登记）
- 自动日报/周报

**一句话**：流程的骨架和关节做成了钢的，肌肉（进度、验收、范围控制）还没长。

---

## 8. v5 落地与结论重估（2026-11-21 第二轮）

第一版审计列出的三条「PM 核心武器全缺」，在同一天的第二轮里全部补上了（schema v4 → v5）。

### 8.1 B1–B7 落地对照

| # | 第一版缺口 | v5 做法 | 证据 |
|---|---|---|---|
| B1 | 状态枚举没有 `verified`，「唯一进度口径」在数据模型里没有落点 | `slices` 加 `verified` 状态 + `verified_by/verified_at/verified_session`；唯一写入路径 `store.verifySlice`；`updateSliceStatus` 收 verified 直接拒 | `tools.test` 5 例 |
| B2 | 没有独立验收 preset，「建造者不验收」只靠角色卡一句话 | 第三个 preset `project-qa`；`kind='qa'` 不占租约；工具 actors 收紧到 9 个；`session_spawn_qa` 拉起 | 工具面断言 + 不占租约断言 |
| B3 | `deliverableTypes` 只写不读 | `checkDeliverableType` + `doc_write` 新建时校验 → `STAGE_DELIVERABLE_NOT_ALLOWED` | 3 例（拒 report / 追加不受限 / 未声明不约束） |
| B4 | `deadline` 只有列，工具无参数、UI 不展示 | `decision_create` 加 `deadline`/`defaultOption`；v5 列 `default_option` | deadline 落库 + 非法时间被拒 |
| B5 | `evidence.verified_by` 从未被写入 | `verifySlice` 回填该切片证据的验收人与时间 | 验收前 undefined / 验收后有值 |
| B6 | `period` 元数据从未写入 | `period_roll` 显式推进，写 meta + `period/roll` 事件，并把上一周期验证数定格 | 推进两次 + 概览跟随 |
| B7 | `links` 表从没写入；文档计数会漂 | 验收时连 `evidence → slice (verifies)`；新增 `scripts/check-doc-counts.mjs` | 脚本 8 条规范句全 PASS |

### 8.2 B1 的关键取舍（为什么不「顺手加个状态」）

`done` ≠ `verified`：

| 状态 | 谁给的 | 含义 |
|---|---|---|
| `done` | 交付方（实现会话） | 「我做完了」——自述 |
| `verified` | 独立验收者 | 「我验过了」——有签名、可追溯 |

**不自动把存量 `done` 升级成 `verified`**：那等于伪造验收记录，而 events 是 append-only、事后无法纠正。
所以迁移只加列不改数据 —— 老项目会显示「已交付未验收 N 项」，这是**如实反映历史**，不是迁移失败。

三道闸缺一条，`verified` 就只是 `done` 的改名：

1. **唯一写入路径**：`updateSliceStatus` 收到 `verified` 直接拒（`INVALID`）；
2. **建造者不验收**：按该切片**最近一次实现会话**比对（不按角色词 —— 角色词是文案，会话 id 是事实）；
3. **DB 兜底**：`guard_verified_requires_signer` + `guard_verified_slice_terminal`。

### 8.3 进度终于有了分母

`projectProgress` 是唯一进度出口（面板与 `project_status` 都读它）：

| 字段 | 含义 |
|---|---|
| `total` | verified + inFlight + blocked + notStarted + doneUnverified |
| `verified` | 分子 |
| `doneUnverified` | **最容易自我欺骗的一档**：交付方说完了、没人验 —— 单列，不算进百分比 |
| `abandoned` | archived/cut（有意不做），**不进分母** |
| `percent` | verified / total |

面板加了进度条 + 四个计数卡（已验收 / 进行中 / 阻塞 / 已交付未验收），
「已交付未验收」单独一行提示 —— 这是最该被看见、也最容易被糊过去的数字。

### 8.4 结论重估

| 设计支柱 | 第一版 | v5 后 | 变化原因 |
|---|---|---|---|
| A 权威源 + 数据模型 | 95% | **95%** | 未动 |
| B 可拒绝状态机 + 门禁 | 90% | **90%** | 未动 |
| C1 租约 + 栅栏 + 作用域 | 85% | **85%** | 未动 |
| C2 阶段写路径硬控制 | 0% | **35%** | 只落了「文档类型」这一层；文件路径层仍靠切片作用域（不是阶段作用域） |
| D 会话编排 | 85% | **90%** | 加了 qa 会话类型与验收 preset |
| E 人类接口 | 75% | **85%** | deadline/defaultOption 落库（面板展示仍简） |
| F 驾驶舱 | 70% | **75%** | 加了进度卡；看板/路线图/燃起图/指标页仍缺 |
| G 度量体系 + 控制回路 | 10% | **40%** | Verified Done + 进度 + 周期三个分母都到位；四本账还缺三本 |
| H 专家团 | 70% | **80%** | 建造者不验收从文案变成机制 |
| I 交付链 | 0% | **0%** | 未动（设计写明是后续阶段） |

**新的一句话结论**：

> 它现在是一个**能回答「到哪了、该验收什么、谁验的」的项目运行时**。
> 仍然不能回答「风险 Top-3 是什么、这个周期该砍什么」—— 因为风险账本与周期熔断还没做（见 BACKLOG N1/N2）。

### 8.5 本轮实跑（全部在 v5 工作树上）

| 套件 | 结果 |
|---|---|
| `check-syntax` | PASS（53 文件 / 0 语法 / 0 import） |
| `check-doc-counts` | PASS（8 条规范句与代码实测一致） |
| `unit` | **111 / 111 pass**（第一版 99，v5 新增 12 例） |
| `negative` | 10 / 0 |
| `ui-client` | 8 / 0（新增 1 例进度纯函数） |
| `replay-14-steps --strict` | 17 / 0 |
| `dev-instance` | 8 / 0 |
| `gate-real-checkers` | 3 / 0 |
| `governance-e2e` | 26 / 0 / **1 skipped** |
| `seats-realdata` | PASS |
| `3d-tree` | 91 / 0 |

### 8.6 一个必须记住的新发现：单写保证依赖沙箱模式

本轮 `governance-e2e` 的 ②c 断言（「会话沙箱写不进真实 `~/.dsh`」）第一次跑出 FAIL，
追查后确认**不是代码回归，而是本会话的文件策略从 `workspace-write` 变成了 `danger-full-access`** ——
agent 进程现在真的能写 `~/.dsh`，而且确实在 `storages/project-workbench/` 下留下了探针目录。

这条很关键：

- **「权威源 agent 碰不到」不是插件的属性，是沙箱策略的属性**。插件只负责把库放在正确的位置。
- 因此 ②c 改成三态：EPERM → PASS；可写且探到真实用户目录 → **SKIP（环境无法验证，不是通过）**；
  可写且探到非用户目录 → FAIL（探针 bug）。把「无法验证」混成 PASS 或 FAIL 都是坏的。
- 探针加了 `finally` 自清理，避免向真实目录塞垃圾。

> 这也解释了为什么第一版审计能写「测试进程写 `~/.dsh` 实测 EPERM」：那次会话确实受限。
> **同一句结论在不同沙箱模式下真假不同**，所以必须连带写明环境。


---

## 9. 闸1 / 闸2：从「能力已实现」到「流程已跑通」（2026-11-21 第三轮）

§8 的结论是「能回答到哪了、该验收什么、谁验的」。但那只是**能力存在**。
本轮补两件事：把能力接进流程（闸1），并在真实仓库上真的跑一遍（闸2）。

### 9.1 闸1：v5 能力接线（这是 §8 留下的真漏洞）

§8 做完后，PM persona 与角色卡里 **0 处**提到 v5，L0 里没有进度，收工回执也不说下一步 ——
于是 PM 会继续用 `slice_update(status=done)` 收尾，而它的 L0 里看不到「已验收 3/12」，**答不出「到哪了」**。
这和之前批评 `period`/`deliverableTypes`「只写不读」是同一个病：加了能力，没接线。

四处接线：

| 接线点 | 内容 |
|---|---|
| L0 注入 | 「进度：已验收 x/y（z%）｜已交付未验收 n｜阻塞 n」，口径与 `projectProgress` 完全一致 |
| 收工回执 `nextStep` | 成功→`spawn_qa`（明确劝阻自验/直改状态）；失败→`resolve_blocker`；无证据→`add_evidence`。同时写进唤醒 PM 的消息 |
| 角色卡 | PM 卡补验收闭环；**新增 QA 卡**（v5 加了 qa 会话却没给角色卡，它的 L1 注入是空串 —— 会话不知道自己来干什么） |
| persona | PM：进度只认 verified；QA：你没有文件写工具、没有 doc_write、没有租约 |

顺带修掉一个被测试抓出来的真问题：角色卡写长后 PM 卡到 420 字符，**超过 L1 的 300 预算**，
导致每步注入都判降级。现在 PM 372 / QA 360，三种角色实测 `used` 274–330（硬上限 2000），全不降级；
并加了专门锁这条的测试（三种角色都必须 `degraded=false`）。

### 9.2 闸2：真实项目全流程（26/26）

`probes/gate2-real-project.mjs` —— 用 **lumio 的真实副本 + lumio 自己的 checker + 真实 git** 跑完整流程。
它与之前所有测试的区别：

- 判据是 lumio 的 `tools/engineering/checker.mjs`，会真的扫描 659 个文件、真的红/真的绿；
- 作用域校验走真实 `git status/diff`（不是声明）；
- 验收用**独立的 qa 会话身份**，不是实现会话自评。

| # | 断言 | 结果 |
|---|---|---|
| 0a/0b | 复制真实仓库（含它的判据）+ 干净 git 基线 | PASS |
| 3a | 初始进度 0% | PASS |
| 4 | 实现会话改真实文件 + 登记证据 | PASS |
| 5 | **真实 git diff** 作用域校验：可判定且域内 | PASS（verifiable=true, in=1, out=0） |
| 6 | 收工后进度**仍 0%**（done/review 不算完成） | PASS |
| 7a | **建造者不验收**（实现会话签字被拒） | PASS（SELF_VERIFICATION_DENIED） |
| 8 | 验收会话能跑真实判据（不 skip、有结论） | PASS（repository=pass / closeout=fail） |
| 9 | 独立验收签字 → verified | PASS |
| 10a/10b | **进度 0% → 100%**，且变化可解释 | PASS |
| 11 | 每个 verified 都能点开到证据 | PASS（证据带 verifiedBy） |
| 12 | L0 显示「已验收 1/1（100%）」 | PASS |
| **13b** | **判据红灯 → 门禁被拒** | PASS（GATE_PRECHECK_FAILED，MEMORY_BEHIND） |
| **13c** | **被拒后不留 pending 审批** | PASS（pending=0） |
| **13d/13e** | **按判据要求修好 → 判据转真绿** | PASS（issues=0） |
| **13f** | 判据绿 → 门禁提交成功 | PASS（approvalId 生成） |
| 14/14b | 重启后进度与 verified 签名完全恢复 | PASS |

**这套流程最有价值的一步是 13b→13f**：它证明门禁真的被机器判据挡住了（不是走过场），
而且拒绝后没有留下一个可以被人误批的 pending 审批。这正是设计里「判据来自机器 + fail-closed」的完整证明。

### 9.3 闸2 顺带确认的两件事

1. **判据在副本里红是真实结果，不是环境故障**：sandbox 的 `.git` 是新建基线、`docs/memory` 与交接对不上，
   lumio 的 checker 据此报 `MEMORY_BEHIND`。这正是它该做的 —— 我们让门禁真的拒了，而不是把判据调绿。
2. **`spawn git` 在本轮恢复**（文件策略变成 danger-full-access 后），所以「真实 git diff 作用域校验」
   这条此前一直被跳过的路径，本轮第一次真正跑通了（用例 5）。

### 9.4 结论更新

| MVP 验收标准（设计 §10.1） | 闸2 后状态 |
|---|---|
| ① 真实小项目：需求 → 实现 → 独立验收 → 进度自动更新 | **通过**（1 个切片，进度 0%→100%，可解释） |
| ② 人类每周被打断 ≤5 次 | **无法由代码验证**（需要真人使用） |
| ③ 每个 Verified 都能点开到证据 | **通过**（证据链带 verifiedBy） |
| ④ 关掉重开/换会话后完全恢复 | **通过**（revision 前后一致，签名还在） |
| ⑤ 生成的周报可直接贴 GitHub Issue | **未做**（只有 timeline.md，没有周报生成器） |

**所以「阶段性做完」的判定是：闸1 + 闸2 已过，②依赖真人使用、⑤仍未做。**
按设计 §10.1 的原始定义，②③④ 里 ③④ 已过；①本轮刚过；②要真人验证；⑤属于下一个阶段。


---

## 10. MVP 清单收口（2026-11-22 第四轮）

§9 之后，设计 §10.1 的 MVP 清单只剩三项没做。本轮补齐，并跑全量回归。

### 10.1 三项收口

| 项 | 落点 | 关键设计取舍 |
|---|---|---|
| **⑤ 周报可贴 Issue** | `weekly_report` 工具 + `host/report.js`；写盘走 outbox | **不是模型现写**：内容全部从库渲染。输出契约要求**确定性**（同一状态内容一致）—— 所以 `since` 兜底用项目创建时间，不用「近 7 天」（`Date.now()` 每次都变，报告就没法按 hash 判断新旧） |
| **看板视图** | 面板第 2 个 tab，7 列 | **done 与 verified 是两列**。设计 §7.2 原看板把 InReview/Verified/Done 混成两列，而这项目最容易糊过去的一帧恰是「交付方说完了」与「有人验过」的差别 —— 合并等于又把它藏起来 |
| **9 个 SOP 技能** | 新增 `testing-acceptance` / `cycle-retrospective` | 不是凑数：v5 加了 qa 会话与周期，但没人告诉那两个角色该怎么做 |

### 10.2 本轮实跑

| 套件 | 结果 |
|---|---|
| `check-syntax` | PASS（55 文件 / 0 语法 / 0 import） |
| `check-doc-counts` | PASS（8 条规范句；本轮它抓出 5 处漂移，正是因为改了工具数与模块数） |
| `unit` | **120 / 120**（+3 周报测试） |
| `ui-client` | **9 / 9**（+1 看板测试：断言 done 与 verified 落在不同列） |
| `negative` / `replay` / `dev-instance` | 10 / 17 / 8 |
| `gate-real-checkers` | 3 / 0 |
| `governance-e2e` | 26 / 0 / 1 skip |
| **`gate2-real-project`** | **26 / 26** |
| `3d-tree` | 91 / 0 |

### 10.3 MVP 验收标准总账（设计 §10.1）

| # | 标准 | 状态 | 证据 |
|---|---|---|---|
| ① | 真实小项目：需求→实现→独立验收→进度自动更新 | **通过** | gate2 用例 4/5/9/10（真实 git diff + 进度 0%→100%） |
| ② | 人类每周被打断 ≤5 次，且都是决策卡 | **待真人验证** | 代码侧只能保证「决策卡是唯一的人机接口 + 开放问题走 session_task_report」 |
| ③ | 每个 Verified 都能点开到证据 | **通过** | gate2 用例 11（证据带 verifiedBy） |
| ④ | 关掉重开/换会话后完全恢复 | **通过** | gate2 用例 14/14b（revision 一致、签名还在） |
| ⑤ | 生成的周报可直接贴 GitHub Issue | **通过** | 本轮 `weekly_report` + 3 例测试 |

**结论：MVP 清单在代码层面已全部完成。**
唯一未闭环的 ② 不是代码能验的 —— 它需要你实际用一段时间（设计原意也是「用它验收插件自己」）。

### 10.4 一个顺带发现

`check-doc-counts.mjs` 在本轮改了工具数（30→31）与模块数（32→33）后**立刻报出 5 处漂移**，
这就是它存在的意义：这类数字不会让任何测试变红，但会让「诚实」悄悄烂掉。


---

## 11. 投产前加固（2026-11-22 第五轮）

问题：闸1、闸2 通过 ≠ 可以投产。本轮补上投产前必须解决的三件事，并说明哪些做完了、哪些受环境限制。

### 11.1 P0：迁移前自动备份 + 迁移后自检（已完成）

**背景（真实事故）**：v5 上线时，真实 lumio 库（`8aad783e7d4011f2`）在**没有任何备份**的情况下被就地迁移了。
那次恰好成功（我逐项验过：v1–v5 全齐、13 触发器、v5 列全在、86 事件无丢失），但这不是策略 ——
迁移不可逆，而真实项目数据没有第二份。「打开就迁移」等于拿唯一的数据做不可撤销的手术。

**实施**（`host/db.js` + `host/schema.js`）：

| 机制 | 规则 |
|---|---|
| 何时备份 | 只在真要跨版本迁移时（`current < SCHEMA_VERSION`）；日常打开零成本 |
| 备份位置 | 同目录 `_backup/project.db.bak-v{from}-{时间戳}`；保留最近 10 份 |
| WAL 处理 | 备份前 `PRAGMA wal_checkpoint(TRUNCATE)`，否则 —wal 里的数据不在 .db 里 |
| 备份失败 | **不迁移**并抛 `MIGRATION_BACKUP_FAILED` —— 宁可这次打不开，也不能没有退路时动数据 |
| 迁移后自检 | `verifyMigration()`：版本、13 个触发器逐个点名、v4/v5 关键列存在；失败抛 `MIGRATION_VERIFY_FAILED` 并**给出备份路径** |

**为什么要有自检**：迁移跑完没报错 ≠ 结构对。最糟的失败形态是**静默半迁移** ——
库能打开能读写，但某个触发器没建上，于是一条本该被拒的非法写悄悄成功。

**验证**：

| 用例 | 结果 |
|---|---|
| v4 库 → v5 前自动备份，备份文件非空且在 `_backup/` 下 | PASS |
| 迁移后自检通过（13 触发器 + 全部列） | PASS |
| 人为删一个触发器 → `verifyMigration` 必须失败并点名 | PASS |
| 全新库不产生备份（日常零成本） | PASS |
| **真实 lumio 库副本**做 v4→v5：86 事件 / 4 切片迁移前后一致 + 生成备份 | PASS |

### 11.2 立即执行的一件事

在做 P0 之前，先把真实 lumio 库手工备份了一份（不等代码）：
`8aad783e7d4011f2/_backup/project.db.bak-v5-20261122-160007`（581KB）。

### 11.3 P1：真实实例端到端（部分完成）

| 套件 | 结果 | 说明 |
|---|---|---|
| `instance-http --strict` | **10 / 0 PASS** | 真实 `dsh web` 实例：首页/preload/bundle 可解析、鉴权 401、`/projects`、`/snapshot`、SSE、三问可答 |
| `live-e2e`（真实模型） | **3 / 1** | 3 项通过；`PM 调用 project_status` 失败 —— **模型没有返回工具调用**。直连模型端点探测超时，判断为**本机网络/IP 可达性限制**，非插件缺陷 |

**顺带修掉两个真 bug（都在这条路径上从未暴露过）**：

1. `dev-instance.mjs --patch` 的参数顺序错了：`--patch` 是 dsh 的**全局选项**，必须在 profile 名（`web`）之前；
   原来追加在末尾 → `unknown option '--patch'`。这条路自 11-12 起就没跑通过，所以一直没暴露。
2. `devhome-model.patch.yml` 配的是 `grsai` / `GRSAI_API_KEY` / `grsaiapi.com`，
   而本机 `.credentials.yaml` 只有 `A_API_KEY`、provider 实际是 `a`（`sla.ddshub.site`）→ 配置与凭据对不上。已改为真实配置。

### 11.4 P2：面板目测（待你做）

本轮新增了看板 tab（7 列 CSS Grid）与进度条，**没有在浏览器里目测过**（本机无 headless 浏览器）。
需要你确认：7 列横排不塌、进度条在深浅色主题下都可见。

### 11.5 投产判定（更新）

| 项 | 状态 |
|---|---|
| **P0 迁移备份 + 自检** | ✅ **完成**（这是唯一「不做完不该上生产」的） |
| P1 真实实例 HTTP/SSE | ✅ 10/0 |
| P1 真实模型会话 | ⚠️ 受环境限制（模型端点不可达），未闭环 |
| P2 面板目测 | ⏳ 待你确认 |
| 真实 lumio 库 | ✅ 已是 v5 且结构完整；已手工备份 |

**结论**：从「数据安全」角度，现在可以投产（迁移有备份、有自检、有失败即中止）。
但「真实模型会话」这条未闭环 —— 意味着**PM 会话能不能真的带着 v5 能力跑起来，还没有实测证据**。
建议：你先在面板里用真实项目点一次「进入 PM 对话」，让它回答「到哪了」；如果它能说出「已验收 x/y」，说明 v5 接线在真实会话里成立。

