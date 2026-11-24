# 回执：lumio 真库问题报告（2026-11-24）核实与修复（v6.3 → v6.4）

> 回执对象：报告《DSH 项目工作台插件问题报告（2026-11-24）》
> （lumio-checkpoints/workbench-plugin-issues-20261124.md，针对 commit b773eec）。
> 本文分两部分：逐条核实结论（含与报告不一致处）与已落地的修复。
> 每条结论都带可复算的判据；无法复算的一律标注「未独立验证」，与报告同一标准。

---

## 0. 一句话结论

报告质量很高：8 条里 6 条的根因定位与行号准确，P0-1/P0-2/P0-3 全部成立，P1-1/P1-2/P2-2 也成立。
其中 P0-3（验收会话永久 active）是我们最该挨的一条 —— 它让「复验」在真实项目里彻底不可用，
而三条结束路径（工具面、session/disposed、重启对账）没有一条覆盖 kind='qa'，
是同一个假设写错三次。

**8 条已全部处理**：P0 三条 + P1 两条 + P2-2 已修；P2-1/P2-3 是文档化/报告自纠项，无需改码。

同时有 1 条与实测不符（P2-3 的表述，报告自己已修正，我们确认修正正确），
以及 2 处需要更正的事实（见 §2）—— 它们不影响结论，但会让后续排查走偏。

> 更正：本回执第一版把 P1-1/P1-2/P2-2 列为「未修」，理由是「要动表结构/要迁移」。
> 该理由不成立（`context_json` 本就是自由 JSON，inbox 目录可由 `db.file` 算出），已在 v6.4 补齐，见 §5。

---

## 1. 逐条核实

| 条目 | 报告结论 | 我们的核实 | 处置 |
| --- | --- | --- | --- |
| P0-1 `failed` 被作用域校验拦下 | 成立，根因在 `task-tools.js:305-306/373-382/404` | 成立，行号准确。`status` 解析后未分流；校验在 `endSession` 之前 `throw` | 已修（§4.1） |
| P0-2 `acceptedOutOfScope` 死参数 + 误导文案 | 成立，`scope.js:280-284` 文案判据用 `accepted`；`scopePolicy` 无写入方 | 成立。全仓 grep `scopePolicy` 7 处全部是读/传，`createProjectJson` 不产出该键 | 已修（§4.2） |
| P0-3 QA 会话永不结束 | 成立，三条路径只认 `task` | 成立。`session-hooks.js:158`、`orchestration.js:591` 均为 `kind:'task'`；QA 工具面无收工工具 | 已修（§4.3） |
| P1-1 比较整个脏树，不区分归属 | 成立（源码 + 隔离复现） | 成立。`scope.js:158` 用 `--untracked-files=all`；`classifyChanges` 不接 author/session | 已修（§5.1） |
| P1-2 worktree 对校验无效 | 成立（三段链） | 成立。`findProjectRoot` 向上找到主树根写死 | 已修（§5.1：判定改在会话 cwd 里做） |
| P2-1 `slice_verify` 要求 review/done | 报告自行下调为 P2：PM 有合法绕行 | 同意。`slice_update` actors 含 pm，`updateSliceStatus` 只拦 `verified` | 不改码（报告建议 2：写进 PM 角色卡，已在 v6.3 一并完成） |
| P2-2 `import_inbox` 仅 PM + 两套 inbox | 成立 | 成立。`registry.js:233` = `storeRoot/inbox`；`import.js:21` = `<root>/.project/inbox` | 已修（§5.2） |
| P2-3 收工后仍 active / 占租约 | 报告自行下调并重新定义 | 同意报告的修正：成功路径不复现；残留的是 P0-1/P0-3 的表现 | 随 P0-1/P0-3 一并消解 |

---

## 2. 需要更正 / 补充的事实（不影响结论）

### 2.1 「scopePolicy 不可达」是对的，但要精确到「连默认值都不产出」

报告写 `project-defaults.js:68-82` 的 `createProjectJson()` 不产出 `scopePolicy` —— 准确。
补一条报告没写但同样关键的事实：`scope.js` 的 `scopePolicyOf` 把 `undefined` 静默归到 `strict`，
而 `strict` 恰恰是「越界一律拒绝」。两条叠加的效果不是「策略没配」，
而是「策略永远等于最严的那一档，而且没有任何地方能告诉你这件事」。
这也是为什么 PM 反复调参却越调越糟 —— 它不是想错了，是没有可调的东西。

### 2.2 QA 工具面没有 session_task_report，成因值得记一笔

session_task_report 的 actors 是 `['task']`，而 QA 的 `kind === 'qa'`（`orchestration.js:119`）。
也就是说 QA 不是「被刻意挡在 report 之外」，而是它根本不在 task 这个分类里，
于是 task 的所有出口它都自动没有。

这条设计在 v5 引入 `kind='qa'` 时是对的（验收不该推进切片），
但当时没有同步回答「谁负责结束一个 qa 行」—— 这正是 P0-3 的成因。
教训已写进代码注释：新增一种 session kind，必须同时回答「它怎么离场」。

---

## 3. 我们未能复核的部分（如实列出）

| 条目 | 报告说法 | 我们这边 | 原因 |
| --- | --- | --- | --- |
| P1-1 「实际触发 7 次误报」 | 未独立验证，拒绝路径无留痕 | 同意，且这是我们自己的洞 | 已补 `scope/reject` 事件（§4.1），此后同类误报可复核 |
| P0-3 `team_task_*` 是否在 QA 工具面 | 报告判定不在本插件内 | 同意。本仓 grep `team_task` 命中 0 | 该工具来自 DSH agent-team 层，不在本插件边界内 |
| P2-2 `import_inbox` 在 PM 会话的实际可用性 | 未验证（未实际调用） | 同样未在本次验证中调用 | 与报告一致：不应对真实项目写入 |

---

## 4. 已落地的修复（v6.3）

设计原则：不放宽「片外零改动」这条校验，改的是「它什么时候该拦、拦了之后留下什么」。

### 4.1 P0-1：失败收工不再被片外存量堵死，且拒绝路径必留痕、必离场

三处改动，缺一不可：

1. 判定层（`host/scope.js`）：新增 `blockOutOfScope`（默认 true）。
   `status=failed` 时传 false —— 片外改动只报告不拦截。`crossScope` 不在此放宽范围内。
2. 离场层（`host/tools/task-tools.js` 新增 `rejectFinish`）：被拒时先写 `scope/reject` 事件，
   再 `endSession(failed)` + `releaseLease`，然后才 `throw`。
   错误回执带 `sessionEnded: true`，调用方知道会话已经离场。
3. 留痕层：成功路径也写 `scope/finish` 事件（原先成功路径零事件，
   「这次到底校验了什么」根本无从查起）。

> 为什么 `crossScope` 仍然拦：那是改到了别人已声明的地盘，与本次成败无关。
> 但也给了显式接受通道（`acceptCrossScope` + 非 strict 策略 + 必须给理由），
> 否则「同事没提交的存量」会把所有人的失败一起锁死。

### 4.2 P0-2：文案按策略判定 + scopePolicy 真写入口

1. 文案判据从 `accepted` 改成 `policy`（`scope.js`）：strict 下提示「先 scope_policy 切到 declare」，
   declare 下提示「还缺 `outOfScopeReason`」，不再出现「declare 策略下仍不允许越界」这种自指文案。
2. `createProjectJson()` 现在显式产出 `scopePolicy: 'strict'`（默认可读、可改）。
3. 新增 `registry.updateProjectJson()`（读 → 浅合并 → 原子写）。
4. 新增 PM 工具 `scope_policy`（get / set）。set 必须给理由，并落 `project/config` 事件。

> 采取的是报告建议里的「给写入口」而不是「删掉参数」：`acceptedOutOfScope` 表达的是
> 「由人显式接受越界」，这是真需求；不可达是接线问题，不是设计错误。

### 4.3 P0-3：验收会话有自己的离场出口

1. 新增工具 `session_finish_qa`（actors: `['qa']`）：只结束自己，
   不改切片状态、不写文档、不碰租约；`verdict='rejected'` 时以 failed 离场并落 `QA_REJECTED`。
2. 兜底放宽（报告建议三）：`session-hooks` 的 `session/disposed` 与
   `orchestration.reconcileStaleSessions` 都从 `kind === 'task'` 放宽为 `('task','qa')`。
3. 把「必须离场」写进三处：工具描述、`session_spawn_qa` 开场交代、QA 角色卡与 `skills/testing-acceptance.md`。

> 刻意没有按报告建议 2 让 `slice_verify` 自动 `endSession(qa)`：
> 「验完」与「离场」是两件事 —— 验收不通过（不签字）时同样要离场。
> 把离场绑在签字上，等于让「不通过的验收」又变成死锁，只是触发条件换了一个。

---

## 5. 上一版回执里「未修」的三条，已补修（v6.4）

这三条我第一版判成「不该在本轮修」，理由写的是「要动 `sessions` 表结构 / 要迁移 imports」。
**理由是错的**，复核后逐条推翻：

| 我当时的理由 | 实际情况 |
|---|---|
| 「P1-1 要动 sessions 表加 baseline」 | `sessions.context_json` 本来就是自由 JSON 列，spawn 时已经在写 `fenceEpoch`。加一个 `baselineSnapshot` 键**不需要任何 schema 变更** |
| 「P2-2 牵动 `imports.source_path` 语义与迁移」 | 不用迁移：两个 inbox 目录都认，store 优先、工作区兼容。新导入行的 `source_path` 是 store 相对路径，老行原样保留 |
| 「P1-2 需要同时改 baseline」 | 判定改为在会话自己的 cwd 里做即可；worktree 里 `.git` 是文件，`existsSync` 照样为真（实测） |

### 5.1 P1-1 / P1-2：归因从「工作树有多脏」改成「这次会话动了什么」

新增 `captureWorkspaceSnapshot()` / `diffWorkspaceSnapshots()` / `collectSessionChanges()`：

- spawn 时拍一张快照（`git stash create` 收录已跟踪改动 + 临时 `GIT_INDEX_FILE` 收录未跟踪文件）；
- 收工时再拍一张，两次快照之间的路径才算**本次会话的改动**；
- 判定在 `actor.cwd`（worktree）里做，不再固定读主工作树。

**关键约束是「快照不能有副作用」**：不 `git add` 真索引、不改工作树、临时索引用完即删。
实测（bash 里跑同一套命令，因为本机沙箱禁管道、Node 子进程读不回 git 输出）：

```
baseline 拍在「别人已经留下改动」之后：
  ?? other.txt   M tracked.txt          <- 别人的存量
会话做自己的活：ours.txt + tracked2.txt
归因结果 = A ours.txt / M tracked2.txt   <- 别人的两条被正确排除
工作树 git status 原样未变
```

回执里新增 `scope.attribution` 三档：`session`（按会话）/ `workspace`（只能看整树）/
`unavailable`（采集失败）。三者分开写，是因为「没被拦」和「校验过」是两件事。

### 5.2 P2-2：inbox 统一 + 任务会话可导入

- `import.js` 现在认**两个** inbox：store 的（`<storeRoot>/inbox`，registry 建的那个）优先，
  工作区 `.project/inbox` 作为历史兼容 —— 直接切到 store 会让已有项目的文件静默失效。
- `import_inbox` 的 actors 从 `['pm']` 扩到 `['pm','task']`；任务会话限本切片
  （不传 `sliceId` 时默认落到自己的切片，避免导入出无归属孤儿）。
- 越界防护不放宽：仍要求文件落在某个 inbox 目录之下（realpath 包含检查）。

### 5.3 顺带修掉的一个真缺陷

写测试时撞出来的：**unborn HEAD**（`git init` 后还没第一次提交）跑 `git diff --numstat HEAD`
会直接报错，而旧代码让这一个失败把**整个采集**拖成 `unavailable`。
于是新项目永远「无法校验」。现在单独 try，拿不到改动量就退化为「只有路径」。

## 6. 证据（可复算）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 单测 | `node workbench/tests/unit/<each>.test.mjs` | 172 通过 / 0 失败（3 例因沙箱禁管道读不回 git 输出而 skip） |
| 工具数与可见面 | `node workbench/scripts/check-doc-counts.mjs` | PASS：33 个工具（PM 28 / 任务 15 / 验收 10） |
| 角色卡与兜底一致 | `node workbench/scripts/check-role-cards.mjs` | PASS（10 张） |
| 语法与 import | `node workbench/scripts/check-syntax.mjs` | PASS（58 文件，0 错） |
| 注入预算不降级 | 编译 `compileContext` 三种角色 | pm 298 / task 236 / qa 273 token（L1 上限 300），均不降级 |

新增回归用例（`tests/unit/failure.test.mjs` §8，6 例）：

- P0-1 失败收工通过 + 会话结束 + 租约释放 + `scope/finish` 事件；
- P0-1 done 收工仍被拒 + `scope/reject` 留痕 + 会话已离场 + 租约已释放；
- P0-2 strict 下不再出现「declare 策略下」误导文案（declare 下也不出现）；
- P0-2 默认 project.json 带 `scopePolicy`；`scope_policy` 能改且落 `project/config` 事件；
- P0-3 `session_finish_qa` 结束会话、不改切片状态、同切片可再拉复验、任务会话调用被拒；
- P0-3 重启对账连 `qa` 一起收。

---

## 7. 给报告作者的两条反馈

1. 「与 PM 描述的差异」这一栏非常有价值，尤其 P2-3 那条 —— 你们没有顺着 PM 的结论写，
   而是自己复现出「那次拒绝是正确的」。这种纠正比多列十个问题更有用。
2. 「拒绝路径无留痕」你们标成「第 9 个问题」是对的，而且它比 P1-1 更该先修：
   没有留痕时，任何关于「误报率」的讨论都只能是回忆。这条已在 §4.1 补上。
