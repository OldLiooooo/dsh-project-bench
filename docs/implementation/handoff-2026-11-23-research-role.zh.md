# 交接：调研角色（v6）—— 把「调查」从 PM 手里收走

> 2026-11-23。触发：用户指出「活儿全是前台干的」，并追问
> 「PM 会自己去做调查吗？调查该交给谁？」。
> 本文记录根因、改法、实测证据与遗留。

---

## 1. 一句话结论

**PM 自己调查不是模型偷懒，是机制里没有「调研」这个可派工单位。**

设计原文把调研写成任务会话的子 agent 临时工（架构 §6.1「子 agent｜临时调研/起草/评审」），
但三处都没接上，于是 PM 只剩一个合法动作 —— 自己读：

| 缺什么 | 后果 | 证据 |
|---|---|---|
| `ROLE_WORDS` 里没有「调研」 | PM 派单直接 `INVALID` | `project-defaults.js:15`（改前） |
| PM preset 不挂 `delegation` | PM 不能自己拉子 agent | `cordis.patch.yml` §3 |
| 任务角色卡没有「派临时工」这一步 | 任务会话也不派 | `roles.js` 各角色 start/finish |
| **PM preset 却给了 `tool-fs(read)` + `tool-fs-search`** | 自己读成了唯一出路 | `cordis.patch.yml` §3（改前） |

实测（lumio 真项目，PM 会话 187 次工具调用）：

| 指标 | 数值 |
|---|---|
| `read`+`glob`+`grep` | **86 次（46%）** |
| `session_spawn_task` / `session_spawn_qa` | 19 / 1 |
| 任务会话拉子 agent | **0 次**（9 个任务会话） |
| PM 写给任务的 brief 长度 | 最短 30 字，**最长 3367 字**（≈900+ token，吃掉任务会话半份预算） |

---

## 2. 改法（全部落在工具面，不靠提示词）

| # | 改动 | 文件 |
|---|---|---|
| 1 | 新增第 8 个任务角色「调研」 | `host/project-defaults.js`（`ROLE_WORDS`/`READONLY_ROLES`）、`host/roles.js`（`ROLE_FILES`+`FALLBACK_CARDS`）、`roles/research.md`（新） |
| 2 | 新增 `project-research` preset：只读 fs、能 glob/grep、能跑命令与 web、**无 write/edit/applyPatch** | `cordis.patch.yml` §6 |
| 3 | 按角色选 preset：`presetForRole(role)` → 调研走 `project-research` | `host/orchestration.js` |
| 4 | **调研不占租约**（`isReadonlyRole` 跳过 `acquireLease`） | `host/orchestration.js` |
| 5 | 调研不能用 `session_finish_task`（会推进切片）→ `PERMISSION_DENIED` | `host/tools/task-tools.js` |
| 6 | 调研的 `session_task_report` = 收工（`endSession`），切片状态不动 | `host/tools/task-tools.js` |
| 7 | 调研报告豁免阶段交付类型校验（S1 只允许 prd，但调研任何阶段都写 report） | `host/tools/task-tools.js` |
| 8 | **PM preset 删除 `tool-fs` 与 `tool-fs-search`**：没有 read/glob/grep | `cordis.patch.yml` §3 |
| 9 | PM persona + 角色卡加「不亲自调查，要查就派 role=调研」 | `cordis.patch.yml`、`roles/pm.md`、`FALLBACK_CARDS` |
| 10 | `SESSION_ROLES` 改为从 `ROLE_WORDS` 派生（原来两处各写一份） | `host/store.js` |

### 为什么「调研不占租约」是关键一条

租约的语义是「同一切片同时只有一个**写者**」，不是「同一切片同时只有一个会话」。
让只读的调研持租，会把同切片正在实现的码农挡在门外 —— 那是拿写锁当排队号用。

代价与补救：调研没有写作用域，所以它在 `doc_write`/`evidence_add` 上跳过 `assertWriteScope`
（否则会被别人的租约误伤），但它**写不进产品文件**（preset 层没有 write/edit）。

---

## 3. 怎么验证

```bash
# 全部单测（137 例）
DSH_HOME='C:/Users/oldap/Documents/dsh-porject-bench/.devhome' \
  node --test --test-isolation=none workbench/tests/unit/

node workbench/scripts/check-syntax.mjs        # 47 文件 0 错
node workbench/scripts/check-role-cards.mjs    # 10 张卡文件↔兜底一致
node workbench/scripts/check-doc-counts.mjs    # 9 条规范句

# 端到端
DSH_HOME=... node workbench/tests/e2e/replay-14-steps.mjs --strict   # 17/17
DSH_HOME=... node --test workbench/tests/e2e/negative.test.mjs       # 10/10
```

实测结果（2026-11-23）：

| 检查 | 结果 |
|---|---|
| 单元测试 | **137 例：136 pass / 0 fail / 1 skip** |
| 语法 | PASS（47 文件） |
| 角色卡一致性 | PASS（10 张） |
| 文档计数 | PASS（9 条） |
| 14 步预演 | **17/17 PASS** |
| 负向测试 | 10/10 PASS |
| 安装检查 | 全 ok（含 `roles/research.md`） |

### 新增的守门测试

| 测试 | 锁住什么 |
|---|---|
| `tests/unit/presets.test.mjs`（新，5 例） | **PM preset 不得挂 tool-fs / tool-fs-search / bash / pwsh**；调研 preset 的 write/edit/applyPatch 必须显式 false；qa 与 research 是两个独立 preset |
| `tools.test.mjs` v6 四例 | 调研用 `project-research` 且**不占租约**；码农**仍占**租约；调研不能 `session_finish_task` 推进切片；report 即收工且切片状态不变 |
| `check-doc-counts.mjs` 新规范句 | 「PM 可见 27，任务可见 15，验收（qa）可见 9」——这行曾同时漂三个数 |

**漂移检测本身也验过**：把 `PM 可见 27` 改回 26，脚本 FAIL 且红在正确那一行；改回后 PASS。

---

## 4. 与并发会话的冲突（重要）

本次施工期间，**另一个会话**（角色卡外置改造）也在改 `roles.js`。
两个改动已经合流，结果自洽（角色卡外置为 `workbench/roles/*.md` + `FALLBACK_CARDS` 兜底，
调研卡按同一结构加入，由 `check-role-cards.mjs` 守 10 张一致）。

但请注意：**该会话的交接文档 `handoff-2026-11-23-role-cards.zh.md` 里的数字已过期**
（它写「9 张卡 / 127 pass」）。以本文的 10 张 / 136 pass 为准。
如果两个会话要各自提交，建议先 rebase 到同一 HEAD 再跑一遍上面 5 条命令。

---

## 5. 遗留与风险（不掩饰）

| # | 事项 | 说明 |
|---|---|---|
| R1 | **PM 现在看不到工作区文件** | 这是刻意的代价。好处是「调查必须派单」成立；坏处是「这仓库长什么样」这类问题要绕一跳，且有额外延迟。替代：`project_status/brief/recall/doc_get/timeline` 仍能回答项目内的事 |
| R2 | **「什么时候该派调研」仍是判断题** | 没有硬判据（不像「建造者不验收」有 `SELF_VERIFICATION_DENIED`）。若要机制化，可做：收工时若本切片有 `artifact_add(code-file)` 却无调研证据则告警——但会误伤「小改动顺手看完」的情况，暂不做 |
| R3 | 调研会话仍可跑 `bash/pwsh` | 能跑命令是调查的必要能力（复现/统计/git 历史），但也意味着它理论上能改文件。**preset 层挡不住 shell**；真正兜底是「不占租约 + 收工不推进切片 + 产物里没有代码」 |
| R4 | 任务会话仍未在角色卡里显式要求「派子 agent」 | 设计 §6.1 的第三层（任务会话 → 子 agent）依然靠模型自觉。本轮只把「调研」提升为可派角色，没有强制任务会话必须派临时工 |
| R5 | `workbench/host/roles.js` 的注释说「8 个角色」，实际已是 10 张卡（含 PM/QA） | 文案级不一致，不影响行为 |

---

## 6. 下一步建议

1. **真机复验**：在 lumio 真项目里让 PM 处理一个需要查代码的需求，确认它走的是 `session_spawn_task(role=调研)` 而不是「我猜」。
   观察点：调研会话的 `agentPreset=project-research`、切片租约表为空、切片状态不变。
2. **R2 的判据**：如果要机制化「该调研却没调研」，建议做成**告警而不是拒绝**（先在周报/时间线里标出来，观察一周再决定要不要拒）。
3. **把本轮提交**：目前改动都在工作区未提交，且与并发会话的改动混在一起，建议由人来决定提交粒度。
