# lumio 的 Git / CI 治理复盘（只看 `C:\Users\oldap\Documents\lumio`）

> 2026-11-11 · 只分析第三代 `lumio`（前两代 `lumio-gui`/`lumio-agent` 是已废弃尝试，不作为结论依据）。
> 数据来自该仓库 git 历史与文档（main @ `b990243`，111 commits，2026-10-29 ~ 2026-11-10）；命令见文末附录，可复现。
> 关联：[工作台设计 §12.2](project-workbench-design.zh.md)；记忆机制初版已归档（[docs/archive/memory-design-v1/](archive/memory-design-v1/)），分层分片调研见 [research/layered-sharded-memory-research.zh.md](research/layered-sharded-memory-research.zh.md)。

---

## 0. 一页结论

**现象**：产品已经推到 PRD 阶段，但 git / CI 管理混乱——重复收尾、重复 PR、分支收不回来、
收尾工具自己成为最大变更源，治理文档与计数互相矛盾。

**数据**：

| 指标 | 数值 |
|---|---|
| 总提交 / 主分支 first-parent | 111 / 80 |
| 交付 PR（!2~!10） | 9 个，全部集中在 2026-11-08~09 两天 |
| `ci(ai): finish` 提交 | 23 |
| 同一工作项被「收尾」次数 | 8、8、5、4、3、2…（WI-20261109-003 / WI-20261108-005 各 8 次） |
| 同标题 PR 连发 | PR !4/!5/!6 同一标题、4 分钟内合并；!7/!8 同标题、2 分钟内合并 |
| 残留交付分支 | 7 条 `codex/wi-*-finish`；其中 1 条（WI-20261109-004）**有未合入提交** |
| 提交类型构成 | docs 51（46%）、ci 23（21%）、fix 11（10%，多数是 CI/工具修复）、feat 6（5%） |
| 目录触达 | docs 92 次、tools 39 次、.workflow 17 次；**产品目录（apps/backend/packages/infra）仅 8 次** |
| 治理资产 | 40 个决策、51 个工作项、53 份证据、15 个工程工具；docs 6.5 MB vs tools 468 KB |
| 工作项状态 | 12+ 个「实现完成（未验收）」；仅 2 个「已完成」 |
| 版本标识 | 无 semver，仅 1 个 tag `ci-green-20261105` |

**根因（一句话）**：**流程被实现成「一堆脚本 + 一堆文档 + 人肉约定」，而不是一个有唯一权威、能拒绝非法状态转移的状态机**。
于是每次事故都靠「再加一个工具/再加一份决策」修复；工具与文档本身成为最大变更源，而真正的产品代码只占 7%。

---

## 1. 事故链（带证据）

| 时间 | 事件 | 证据 |
|---|---|---|
| 10-29 ~ 11-05 | 设计/治理先行：目录树、决策、工作项、证据、工程门禁、仪表盘、verify、pre-push | git log；`.workflow/`、`tools/engineering/` |
| 11-04 | 分支保护对管理员无效（push/--force 实测成功）→ 远端不能当闸门 | `DEC-20261104-001` |
| 11-04~05 | CI 连修 5 次：Gitee 检出深度不可配、Node 版本只收完整号、浅克隆不能认证、spec 依赖仓库外目录导致构建 #11–#15 连续失败 | `fix(ci)` 提交；`.workflow/README.md` |
| 11-05 | 统一验证入口 + pre-push 本地闸门；CI 只跑 `gate` 档 | `DEC-20261105-001`、`.githooks/pre-push` |
| 11-08 | 上 `ai-finish` + 自动 PR；同时**两代收尾工具并存**（旧 328 行无 `--pr`、新 436 行有 `--pr`） | `DEC-20261109-001` 背景 |
| 11-08~09 | 旧入口只 commit+push 不建 PR → **同一主题重复收尾 8 次、8 个同标题提交、多条平行分支、分支收不回** | `DEC-20261109-001`、`WI-20261109-001` |
| 11-09 | 三处文档仍在教旧的 `--commit --push` 两步 → 新会话照着做，重复分叉 | `WI-20261109-001` 事实清单 §1 |
| 11-09 | `ai-finish` 三处静默降级：续跑沿用旧档位（`RESUME_TIER_MISMATCH`）、续跑跳过证据发布（PR head **0 个 check-run**）、主工作树混入他人 **188 个文件**（`WORKTREE_NOT_ISOLATED`） | `DEC-20261109-005`、`WI-20261109-007` |
| 11-09 | 预演档 `neutral` + 真实档 `success` 同 head 并存，旧规则「每条都 success」→ **check-run 死锁，连续阻塞 PR #7/#8/#9，跨两个独立会话** | `DEC-20261110-001` 背景 |
| 11-09 | 一天内新增 5 个工具：`trunk-health`、`ci-rehearsal`、`check-runs`、`merge-pr`、`delivery-branch`；两代工具才收敛 | `DEC-20261109-001`、工具提交 |
| 11-09 | 主干收束：快进 + 删除 6 个本地分支/2 个远端分支；仍留 7 条 `codex/` 分支与 1 条未合入分支 | `WI-20261109-001` 交接 |
| 11-10 | 按档位归组、失败优先的合并判定修死锁 | `DEC-20261110-001` |

**其它被记录的真实缺陷**：`coordinate.mjs` 目录级认领 → 宽认领期间任何第二会话无法登记工作（含紧急修复）；
两份 `DEC-20261108-001` 撞号（checker 报 `ID_DUPLICATE`）；记忆计数 62/215 vs 规格 261（`COUNT_STALE`）；
S0-S5 退役被误读成「首切片合同失效」→ 再发决策澄清；仪表盘空白页只因少一个右括号，而此前只验服务端 HTTP 200/grep；
提交时间戳混用 `+0000` 与 `+08:00`，事后时间线难复原。

---

## 2. 根因分析（5 层）

### R1 流程不是状态机，而是「脚本 + 文档 + 约定」的集合

- work item 状态、分支、PR、check-run、证据、记忆分别存在 5 类载体里，靠人和 AI 会话「记得同步」。
- 同步失败的症状就是：计数 stale、ID 撞号、记忆落后、旧协议文本仍在教旧用法、仪表盘假绿。
- 后来加的 `closeout` 对账（EV_MISSING/MEMORY_BEHIND/COUNT_STALE…）方向正确，但它是**事后审计**，不是写入时的状态约束。

### R2 交付链切换没有「清扫」（migration without cleanup）

- `--commit --push` → `--pr` 是破坏性流程迁移：旧工具、旧文档、旧分支、旧状态文件必须同时清理。
- 实际只改了新工具，旧文档继续教旧用法，旧分支继续堆积 → 新会话复现旧错误。
- **流程迁移必须带清扫清单 + 门槛**，否则迁移本身变成新的分叉源。

### R3 认领/交付粒度错误，且没有并发约束

- `coordinate.mjs` 用目录级认领 → 一个宽认领锁死全仓（第二会话连登记都做不了）。
- 没有「同一工作项只允许一个开放分支/PR」的硬检查 → 同一 WI 被 8 次收尾、3 个 PR 连发。
- AI 多会话共享主工作树，没有强制 worktree 隔离 → 别人的脏文件被静默混入（188 文件）。
- 编号靠人记/文件锁，撞号只能靠 checker 事后抓。

### R4 远端不可信 + 本地闸门可绕过 → 安全实际押在「人记得合并」

- 分支保护对管理员无效（实测 push/--force 成功）；远端 CI 只是探测器，不阻止推送。
- CI runner 只能跑 `gate` 档（纯 Node），`code/full` 档依赖 pnpm/uv 不在镜像；Gitee 检出深度不可配（永远 depth=1）。
- check-run 端点拼写错误导致「API 不支持」误判；合并需要人工勾选 review+test 两个复选框（`PUT merge` 否则 405）。
- pre-push 是唯一真实闸门，但可被 `--no-verify` 绕过（需登记理由）。
- 结论：当远端无法做硬闸门时，**不要假装它是门**；必须把「不可信声明」和「人类批准」分开建模。

### R5 治理反噬：事故 → 加工具/加决策 → 工具自身成为最大变更源

- 11-09 一天新增 5 个工具；40 个决策 / 51 个工作项 / 53 份证据服务 8 个产品提交。
- 每次事故都增加一层机制，机制之间互相耦合（pre-push 跑 closeout → 并行会话的收尾会拦住别人的推送）。
- 度量缺失：**没有人度量「流程成本」**（docs/tooling 提交占比、重复收尾次数、分支滞留、假绿次数）。
- 流程的收益是「防事故」，成本是「人/AI 的时间与注意力」；没有度量就无法止损。

---

## 3. 新结论（给 DSH 项目工作台插件）

> 这是「重新得出的结论」：不是「用 git 要用对命令」，而是「**git/CI 必须由工作台的项目服务托管成状态机**」。

### C1 Git/CI 是项目服务的一个状态机，不是脚本文档集合

项目服务必须持有这些实体的唯一权威记录，并让它们**外键关联**：
`WorkItem → Claim → Branch → DeliveryAttempt → PR → CheckRun → Evidence → Memory/Handoff → Gate`。
任何一步的状态变化都是一个事务事件；`main` 被视为只读投影，只能由「交付状态机」推进。

### C2 交付链的唯一性与幂等

- **唯一交付入口**：`deliver`（内部调用 verify/commit/push/PR/check-run/merge policy），不允许手工 `git commit/push` 绕过（钩子 + 服务双重校验）。
- **开工自检**：`start` 前检查该工作项是否已有开放分支/PR/未合入提交；有则拒绝再开（implements「一个 WI 一条链一个 PR」）。
- **收尾幂等**：同一工作项重复收尾必须复用分支/PR，不新建；重复收尾计入告警。
- **合并后清扫**：合并成功自动删交付分支、清 worktree/锁；未合入分支出现在 `trunk health` 里并阻断新工作。
- **worktree 强制隔离**：多会话共享主工作树时拒绝收尾，给出 `git worktree add` 命令。

### C3 状态、证据、记忆同事务 + 收尾对账

- 收尾时同一事务写：work item 状态、证据索引、记忆/交接、outbox；任何一项写失败就整体失败（fail-closed）。
- 收尾对账门（必须机检）：`EV_MISSING`、`MEMORY_BEHIND`、`COUNT_STALE`、`WI_STATUS_STALE`、`RECOVERY_PATH_MISSING`、
  `PROTOCOL_REFERENCE_STALE`（文档仍引用旧入口）。
- 计数、索引、仪表盘、记忆摘要**全部由权威源生成**；文档里出现手写数字即失败。

### C4 CI 能力分级，不把不可信远端当门

| 层级 | 例子 | 角色 |
|---|---|---|
| 远端探测 | Gitee/GitHub CI 结果、check-run | 证据，不是批准 |
| 受控 runner | 能跑 code/full 档的环境 | 证据，可当合并前提（需声明能力） |
| 本地闸门 | pre-push（可绕过但须登记） | 最后防线之一 |
| **人类批准** | 门禁/合并/发布 | **唯一批准来源** |

- check-run **名字 = 档位**（`engineering-gate` / `engineering-gate-code`），组内失败优先、不同名独立判定；
  **预演/降级结论不得作为合并证据**；`neutral` 不算通过；无 check-run 拒绝合并。
- 对外部平台限制（分支保护无效、深度不可配、合并需人工复选框）要**显式建模为已知限制**，不能写进「已保护」的假设里。

### C5 度量过程成本，设止损线

驾驶舱必须显示「流程健康」指标（来自 git/项目服务，不靠手填）：

| 指标 | 止损线（建议） |
|---|---|
| 治理提交占比（docs/tooling/workflow ÷ 总提交） | > 30% 告警，> 40% 强制复盘 |
| 重复收尾次数 / 工作项 | > 1 告警，> 2 阻断 |
| 滞留交付分支数 / 未合入分支 | > 0 告警；未合入提交 → 阻断新工作 |
| 假绿次数（检查通过但事实不符） | > 0 复盘 |
| 产品提交占比 | < 50% 告警（说明流程在反噬） |
| 工作项「未验收」积压 | > 5 告警 |

### C6 流程迁移必须带清扫与门槛（R1–R6）

镜像 → 幂等回填 → 双读逐字段对照 → 按读路径分阶段开关 → R1–R6 就绪门槛 → legacy 默认可回滚 → 删除要 owner 裁决+期限。
迁移完成前，**旧入口/旧文档/旧分支必须删除或重定向**，不能并存。

---

## 4. 对设计文档的具体修订

1. 工作台设计 §12.2 增加「Git/CI 治理 10 条硬规则」（引用本复盘）。
2. 项目服务新增模块：`repo`（branch/worktree/claim）、`deliver`（唯一收尾入口）、`reconcile`（收尾对账）、
   `process_health`（成本与分叉指标）。
3. 驾驶舱新增「流程健康」卡片：治理提交占比、重复收尾、滞留分支、未验收积压、假绿次数。
4. 阶段门禁增加 git 状态检查：开工前 `trunk health`、收尾对账、合并前 check-run 语义检查。
5. 记忆模块：`project.sqlite` + `project-search.sqlite` 两库分离；会话检索复用 DSH `session-query-sqlite`。

---

## 附录：数据命令（可复现）

```sh
cd C:\Users\oldap\Documents\lumio
git rev-list --count HEAD                          # 111
git log --first-parent --oneline | wc -l           # 80
git log --merges --format='%s' | grep -o "![0-9]*" | sort -u   # !2..!10
git log --format='%s' | grep -c "^ci(ai): finish"  # 23
git log --format='%s' | grep -o "WI-[0-9-]*" | sort | uniq -c | sort -rn
git for-each-ref --sort=-committerdate --format='%(refname:short) %(committerdate:short)' refs/remotes
git branch -r --no-merged main                     # 1 条（WI-20261109-004）
git log --diff-filter=A --format='%ad' --date=short --name-only -- tools/engineering
grep -rh "^- 状态：" docs/work-items/*.md | sort | uniq -c
```

**读法**：数字只说明「发生了什么」；根因看 §2；给插件的硬规则看 §3。
