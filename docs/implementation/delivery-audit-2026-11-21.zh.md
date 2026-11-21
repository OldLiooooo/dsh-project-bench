# 交付审计：设计初衷 vs 已实现（2026-11-21）

> 目的：回答「插件做到什么程度了，是不是一个合格的项目 PM」。
> 方法：把设计提案、架构施工图、设计逻辑里的每一条支柱，逐条对到**代码**与**今天实跑的测试**上。
> 本文件只记录可复核的事实；判断与结论写在每节的「判断」里，缺口写进 [BACKLOG](BACKLOG.zh.md)。

---

## 0. 一句话结论

**治理内核合格，项目经理没合格。**

它是一个很硬的「项目流程执行器 + 审计账本」：权威源搬得出去、非法状态转移真的能拒、门禁判据真的来自机器、
人批准是唯一出口 —— 这几条设计初衷全部兑现。

但它还不是设计里那个 PM，因为 PM 的三件核心武器**一件都没有**：进度度量（Verified Done）、
独立验收闭环、周期与范围控制。现状能管「状态怎么流」，不能管「进度到哪了、该砍什么」。

---

## 1. 今天实跑的测试（命令逐条可复跑）

```bash
export DSH_HOME='<workspace>/.artifacts/dshhome-audit'   # 必须指到工作区内，否则写 ~/.dsh 会被沙箱拒绝
```

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
