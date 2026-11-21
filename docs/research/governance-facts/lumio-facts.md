# lumio 交付治理机制 · 事实清单

- 对象：`C:/Users/oldap/Documents/lumio`，HEAD `b990243`（main，最后一次提交 2026-11-10）。取证时工作区已非干净：`M README.md`、`M docs/README.md`、`?? .project/`、`?? docs/work-items/WI-20261112-001-*`、`?? docs/evidence/EV-20261112-001-*`。
- 限制：本沙箱禁止下游 spawn git（`spawnSync git EPERM`），凡"工具内再调 git"的分支（ai-finish 变更枚举、`gate.mjs --staged`、verify 的 code 档）未能端到端执行；纯 Node 判定与不依赖 git 子进程的分支均已实测。下文标「实测」= 本条有退出码/输出；「读码」= 仅静态证据。

## 1 权威源与实体

| 实体 | 唯一承载 | 写入者 | 读取者 |
|---|---|---|---|
| 工作项 WI | `docs/work-items/WI-*.md`（49 个 + 2 个 `bootstrap-*`） | 人/AI 直接写 markdown | checker.mjs、closeout.mjs、ai-finish.mjs |
| 决策 DEC | `docs/decisions/DEC-*.md`（39 个） | 人 | checker 仅验 ID 唯一+链接（checker.mjs:320-327,337-353） |
| 证据 EV | `docs/evidence/EV-*.md`（32 个） | 人 | closeout.mjs:35-46 仅验被引用文件存在 |
| 分支 | git refs；前缀唯一来源 `delivery-branch.mjs:16`（默认 `codex/`，env `LUMIO_DELIVERY_PREFIX`） | ai-finish.mjs:243 | merge-pr.mjs:182、trunk-health.mjs:186 |
| PR | 远端 Gitee（create-pr.mjs:133） | create-pr.mjs | merge-pr.mjs:262-280 |
| check-run | 远端 Gitee，本地零持久化 | check-runs.mjs:122-159 | merge-pr.mjs:282-290 |
| 收尾状态机 | `.tmp/ai-finish/<WI>/state.json`（每 WI 一份，git 忽略） | ai-finish.mjs:287-289 | ai-finish.mjs:363-405 |
| 交接 | 双处：模块 `README.md` 的 `## 当前交接` 六字段（checker.mjs:6,307-318）+ `docs/memory/project-context.md`（policy.json:261-263） | 人 | checker.mjs、closeout.mjs:60-74 |
| 计数 | `docs/specs/index.json`（62 模块/215 文件条目） | tools/design 生成器 | closeout.mjs:79-100 判 COUNT_STALE |
| 认领 | `.tmp/coordination/claims.json`（16 KB 级 JSON，git 忽略 .gitignore:1） | 仅 coordinate.mjs:132-138,222 | coordinate.mjs、integrity.mjs:199-213 |

- 无数据库、无服务端状态：权威 = 工作树 markdown + git refs + 一次性 `.tmp` JSON + 远端 Gitee 对象。工作项状态只是文件里一行文本，不是机读字段。
- 两级结构性权威：文件内容（human-writable）> 工具派生的 `state.json`/`claims.json`/`check-run`（可由工具重算，但 claims/state 不重建）。

## 2 硬约束（会拒绝的状态转移，附退出码）

全部为`exit 1`（verify.mjs 用法错误为 exit 2，verify.mjs:251）；错误以 JSON `{"ok":false,"code":…}` 或 `[CODE] path: msg` 打印。

- **认领冲突**（实测）：重叠 scope → `SCOPE_CONFLICT`（coordinate.mjs:185,215）。含"自动生成的工作项文件也需未被认领的范围"（:215）。
- **负责人形状**（实测）：`OWNER_INVALID`（coordinate.mjs:34-48）——8–128 字符、占位词前缀拒绝、必须含 ≥4 位连续数字；`current` 与 `dsh-session` 均被拒。
- **认领归属/重复释放**（实测）：`OWNER_MISMATCH`(:244)、`CLAIM_RELEASED`(:245)、`CLAIM_MISSING`(:243)。
- **锁竞争**：`LOCK_BUSY`（coordinate.mjs:150），5000 ms 后拒绝，且明确要求人工处置、不自动删锁。
- **未就绪即收尾**（实测）：状态不含"实现完成|已完成" → `WORK_ITEM_NOT_READY`（ai-finish.mjs:227）。
- **无范围字段**（实测）：`WORK_ITEM_SCOPE_MISSING`（ai-finish.mjs:43,45）——工作项缺 `- 允许修改范围：` 或其内无反引号路径即拒绝。
- **参数级硬拒绝**（实测）：`PR_MAIN_CONFLICT`(:163)、`TIER_INVALID`(:167)、`DELIVERY_PREFIX_INVALID`(:171-174 / delivery-branch.mjs:48)、`ARGUMENT_INVALID` max-attempts>3(:156)。
- **范围/隔离**（读码）：`SCOPE_OUTSIDE`(ai-finish.mjs:59,96)、`WORKTREE_NOT_ISOLATED`(:99)、`BRANCH_EXISTS`(:242)、`BRANCH_MISMATCH`(:246)、`NO_CHANGES`(:423)、`NOTHING_STAGED`(:477)。判定先后：先隔离后越界（:414-417）。
- **续跑降级**（读码）：`RESUME_TIER_MISMATCH`（ai-finish.mjs:322-333）——存档档位与本次 `--tier` 不符即拒绝续跑。
- **合并前提**（读码，纯函数且有 14 项反例测试）：`NO_CHECK_RUNS`/`CHECK_NOT_GREEN`/`HEAD_NOT_DELIVERY`/`BASE_NOT_MAIN`/`NOT_VERIFIED_UNREADABLE`（merge-pr.mjs:181-219）→ 汇总为 `PRECONDITION_FAILED`(:349)；`MERGE_FAILED`(:370)、`MERGE_UNCONFIRMED`(:383，读回 state≠merged 即失败)。
- **提交时**：pre-commit → `gate.mjs --staged`（.githooks/pre-commit:9），非 0 即阻断；其中 `HOOK_NOT_EXECUTABLE`/`HOOK_UNTRACKED`（integrity.mjs:63,70，索引模式必须 100755）、`HANDOFF_STALE`(:175,190)、`WI_STATUS_STALE`(:209)、`RECOVERY_PATH_MISSING`(:233)、`HISTORY_TRUNCATED`(:106)。
- **推送时**：pre-push → `verify.mjs --tier=code`（.githooks/pre-push:25）；缺工具是 `MISSING_TOOL` 失败关闭，只有 `--allow-missing`（或 env `LUMIO_VERIFY_ALLOW_MISSING=1`）才降级为 `NOT_VERIFIED`（verify.mjs:140-154）。
- **目录/清单不变量**（实测 `checker exit=1`）：`DIR_UNREGISTERED`、`FILE_REQUIRED`、`README_FIELD`、`IMPLEMENTED_WITHOUT_TESTS` 等（checker.mjs:193-305）。
- **收尾对账**（实测 `exit=1`）：`EV_MISSING`（closeout.mjs:43，测试夹具复现）、`MEMORY_BEHIND`（:69，真仓库当前即红于 WI-20261112-001）、`COUNT_STALE`(:93)。
- 「NOT VERIFIED 不得冒充 PASS」是硬编码的：`status==='PASS' && markers.length` 时强制降级（verify.mjs:154）；`ai-finish` 遇 NOT_VERIFIED 直接返回 `state=NOT_VERIFIED` 不提交（ai-finish.mjs:453-457）。

## 3 软约定 / 事后审计

- **状态序列** `待认领→已认领→实施中→待验证→已完成` 只写在 docs/engineering/multi-agent-collaboration.md:15；全仓 grep 无任何代码校验状态转移顺序（仅有"是否含实现完成"一次布尔判断，ai-finish.mjs:227）。
- **认领不是收尾前置**：ai-finish.mjs / checker.mjs / gate.mjs 均不读 claims.json（grep 为空），只有 integrity.mjs:199-213 事后读，且只判"已释放但文件仍写已认领"。work-item 的负责人取自文件 `- 负责人：` 行（ai-finish.mjs:228），与 claims 的 owner 无交叉校验。49 个工作项中 38 个从未有认领记录（11 条 claim 对 49 个 WI 文件）。
- **事后审计**（不阻断写入，只在提交/收尾/开工时报告）：closeout（EV/记忆/计数）、checker（目录/清单/链接）、integrity（钩子/handoff 新鲜度/回滚物）、trunk-health（分叉/残留分支/worktree/文档失效引用，tools/engineering/README.md:13 明示"不阻断提交"）。
- **交接新鲜度**只靠提交时间比较（integrity.mjs:20-25,180-194），CI 浅克隆下恒为 `[NOT VERIFIED]`（.workflow/README.md:114-120）。真实执行点是本地 pre-commit，钩子不随克隆继承（core.hooksPath 为本地配置，.gitconfig 实测 `core.hookspath=.githooks` 但新克隆需手配）。
- **`--no-verify`** 是被承认的逃生口："使用即需登记理由与事后复核项"（.githooks/README.md:24、development-rules.md:99）——纯文档约定，无工具检测。
- **合并权**：AGENTS.md:59 与 .workflow/README.md:17,151 仍写"CI 通过后仍由负责人合并""合并由人手动做"，但 merge-pr.mjs 已实现 AI 受控自动合并（DEC-20261109-003）；文档未同步，属现存口径冲突。
- **合并路径无钩子**：`.githooks/` 只有 pre-commit、pre-push（`pre-merge-commit` 缺失，WI-20261105-002:81 实测 `git merge` 不触发 pre-commit）。因此手工合并 = 零门禁，靠合并后人工重跑。
- **业务检查被显式延期**：policy.json:270-291 的 4 条 deferredChecks（合同边界、写/异步标识、权限计费迁移恢复、远端 CI 与分支保护）由 checker 打印 `DEFERRED` 而非校验；`gate` 收尾语同样声明"只证明治理约束，不证明业务行为"（gate.mjs:42）。

## 4 入口与绕过面

- 文档宣称唯一链：工作项登记 → 范围检查 → verify → `ai-finish --pr` → 分支 CI → PR 评审（AGENTS.md:57；.workflow/README.md:37-46；DEC-20261109-001 决定采用"单一标准入口 + 显式例外"）。
- 代码事实：`ai-finish` 是唯一做"范围校验 + 验证 + 提交 + 推送 + 建 PR + 回写 check-run"的入口（ai-finish.mjs:407-518）；`--commit`/`--push` 保留为显式例外（:161-166，与 `--pr` 互斥于 `--allow-main`）。包的入口只有 `pnpm ai:finish`（package.json），`merge-pr` **无** pnpm 脚本，只能 `node tools/engineering/merge-pr.mjs` 直调。
- 绕过面（全部真实存在）：
  1. 手工 `git commit`/`git push`：只受 pre-commit/pre-push 约束，两者均可 `--no-verify`；pre-push 校的是工作树而非被推提交（.githooks/README.md:31）。
  2. 直推/强推 main：分支保护对管理员无效，实测可推（.workflow/README.md:140-151、DEC-20261104-001）。
  3. 手工合并 PR：合并路径无钩子（见 §3）。
  4. 旧入口已删：`scripts/check-docs.ps1` 已移除、`scripts` 已从 policy directories 撤下（tools/engineering/README.md:55），但历史文件中仍留有引用（仅文档残留，非活入口）。
  5. **Windows 上 5 个 CLI 实际不可用**（实测）：`merge-pr`、`create-pr`、`check-runs`、`ci-rehearsal`、`trunk-health` 用 `process.argv[1].endsWith('/x.mjs')` 做入口判断（merge-pr.mjs:474、create-pr.mjs:164、check-runs.mjs:218、ci-rehearsal.mjs:203、trunk-health.mjs:294），Windows 下 argv[1] 是反斜杠路径 → 条件恒假，五者带任意参数均 **exit 0 且无任何输出**（`--help`、无参、`--dry-run --json` 全部空跑）。用 `path.resolve` 比较的 ai-finish/checker/gate/verify/coordinate 正常（ai-finish 实测 exit 1 报 TIER_INVALID）。即：合并门禁在 Windows 上无法通过 CLI 触发。

## 5 并发与认领

- 粒度 = **路径**（文件或目录，`normalizeScope` coordinate.mjs:86-102），重叠判定为大小写不敏感的等值或前缀包含（`overlap` :112-117）；拒绝绝对路径、`..`、`.git`、Windows 保留名、符号链接与硬链接别名（:50-58,71-84,93-100）。
- 锁 = **单一全局**：`.tmp/coordination/state.lock`，`open(...,'wx')` 互斥创建，写 owner/operation_id/pid/时间，finally 只在本次持有时删除（coordinate.mjs:140-164）；超时 5000 ms 报 `LOCK_BUSY` 并要求人工恢复（:150）。即所有认领串行化在一个工作区。
- 编号 = 扫描 `docs/work-items` + `.tmp/coordination/ids/<WI>.lock` 预留文件 + 历史 claims 取最大 +1，`wx` 抢号（:188-208）；已预留编号不复用（实测连续两次 start 得到 001、002 逻辑）。
- worktree 隔离：**不在 coordinate.mjs**，而在 ai-finish（`inspectWorktree` 比较 `--git-dir` 与 `--git-common-dir`，ai-finish.mjs:71-75；主工作树 + 范围外改动 → `WORKTREE_NOT_ISOLATED` :89-106，并在报错里给出 `git worktree add` 命令）。且该检查只在"有改动"时触发（:416）。默认路径模板即要求独立 worktree（README.md:21）。
- 「一个工作项一条链」**无硬检查**：不存在"WI 必须被认领才能 ai-finish"的校验；认领与收尾是两条独立路径，仅通过文件里的 owner 字符串软连接。实测 11 条 claim 中 10 条已释放，1 条 active（WI-20261112-001 / arch-baseline-reconcile-20261112），覆盖 4 个文件级 scope。
- 跨机/跨 checkout 不同步（tools/engineering/README.md:43、multi-agent-collaboration.md:40-42），自述"不能阻止绕过工具的直接写入"。

## 6 与 .project 的关系（双权威判断）

- `.project/` 是 DSH 工作台运行时：`project.json`（2137 B，含 stageTemplate S1–S7/G1–G7、exportMap、budget、roles）+ SQLite `project.db`（4096 B 主库，`project.db-wal` 2.5 MB）+ `exports/`、`inbox/`、`packages/`（三者当前为空）。`.project/.gitignore` 自行忽略 db/exports/inbox/packages，注释称"project.json 入 git"，但 `git ls-files .project` = **0**，`git status` 显示 `?? .project/` —— 实际全部未跟踪。
- 仓库侧完全不知道它：`tools/engineering/policy.json` 无 `.project` 条目（既不在 directories 也不在 ignoredDirectories），全仓 `grep 'project.db|\.project/'` 在 tools/apps/backend/packages/infra/docs/engineering/.workflow 下**零命中**；因此 checker 恒报 5 条 `DIR_UNREGISTERED` 并 `exit 1`（实测：`663 files, 113 directories, 5 issues`），把仓库门禁钉在红态。
- 两套实体**不重叠且无映射代码**：仓库侧 WI/DEC/EV 文件（49/39/32）↔ DB 侧 slices(4)/tasks(5)/decisions(3)/evidence(3)/documents(2)。DB 状态词表是英文小写（slice: open/review；task: pending/blocked；decision: pending；document: draft/review），仓库状态是中文自由文本（"实现完成（未验收）"等），二者无枚举映射，也无同步脚本（tools 内无 sqlite 依赖）。
- 但**主体重叠**：DB 的 `slice-7937fb41`（key `baseline-reconcile`，status review）与仓库未提交的 WI-20261112-001 是同一件事；DB 的 3 条 evidence 逐字引用仓库命令输出（`node tools/design/validate-spec.mjs` 等）、artifacts 表列出 `docs/evidence/EV-20261112-001-readme-status-align.md` 与 `docs/work-items/WI-20261112-001-*.md`；`sessions.dsh_session_id=443e679a-…` 与 claims.json 的 active owner 对应同一会话。即同一批工作被写了两遍，各自完整。
- **双权威判断：成立（分域并存）**。交付闸门（verify/gate/CI/PR）只认仓库文件与 git —— DB 对门禁零影响；而工作阶段（S1–S7/G1–G7）、切片状态、待裁定决策、交接文档版本、lease（1800 s TTL）只存在于 DB，仓库门禁**完全看不见**，也无法校验。同一"工作项/决策/证据/交接"四类实体在两个权威里各有一份，没有一个引用另一个（无 link 行、无 hash 交叉校验：DB 的 `content_hash` 列全为 NULL，artifacts.bytes 亦为 NULL）。
- DB 自身的记录也把该冲突列为未决：`decisions` 3 行 status 全 pending，其一即「.project 工作台存储的 policy 归属」，选项含"加 ignoredDirectories / 登记为已登记目录 / 保持现状恒红"；另一行为「治理冲突：文档类工作项收尾必须同时改项目记忆」，指 `MEMORY_BEHIND` 与 ai-finish「实现完成」门槛叠加导致文档类工作项必然红。当前 `approvals` = 0 行、`exports` = 0 行、`links` = 0 行。
- exportMap 有 6/8 目标目录在仓库不存在（`docs/ux`、`docs/design`、`docs/spec`、`docs/reports`、`docs/handoffs`、`docs/retro` 全 MISSING；仅 `docs/product`、`docs/architecture` 存在）—— 说明映射层尚未落地。

## 7 可量化事实

- 提交：111 个（2026-10-29 → 2026-11-10），14 个 merge commit，远端 7 条 `codex/*` 交付分支（1 条滞留：`codex/wi-20261109-004-finish` 有 1 个未落地提交；6 条已完全合入 main，属残留）。
- 提交占比（触及即计，可重叠）：`docs/` 92（82.9%）、`tools/` 39（35.1%）、`.workflow/` 17、`AGENTS.md` 7、`.githooks/` 3、业务代码四根 `apps|backend|packages|infra` 仅 8（7.2%）。不含 tools/code 的"文档类"提交 66/111（59.5%）。
- 代码行占比（`git log --numstat` 累计新增 109 488 行）：docs +90 752（82.9%）、tools +7 701（7.0%）、backend +5 655（5.2%）、apps +2 359（2.2%）、infra +635、packages +343、pnpm-lock +1 258。
- 实体数量：WI 49 + bootstrap 2；DEC 39；EV 32；tracked 文件 656（其中 docs 下 md 267、tools 下 mjs 32、四个业务根 303）。
- 规格/登记：`docs/specs/index.json` 62 模块 / 215 文件条目（195 specified、14 implemented、6 pending-prd）；policy 108 目录、95 moduleReadmes、35 requiredFiles、4 deferredChecks；反例测试 14 个文件 2 594 行。
- 未验收积压：49 个工作项里显式含"未验收"14 个、仅"实现完成/已完成"15 个、其余 20 个用其它自由表述；**声明"运行验收完成"的 0 个**（development-rules.md:13-19 的四级状态中最高级从未使用）。
- 认领覆盖：11 条 claim（10 released / 1 active）、21 条事件、10 个不同 owner；49 个 WI 文件中 38 个无认领记录。
- 当前红灯（实测）：`checker exit=1`（5 条 `.project* DIR_UNREGISTERED`）、`gate --closeout exit=1`（`MEMORY_BEHIND`：WI-20261112-001 已写"实现完成"但 `docs/memory/project-context.md` 最新交接停在 WI-20261110-001）、`gate exit=1`（同 checker 5 条）。三项均为既存红，与本次只读分析无关。
- `.project` 库内计数：4 slices（3 open/1 review）、5 tasks（4 pending/1 blocked）、3 decisions（全 pending）、3 evidence、2 documents/3 doc_versions、45 events、2 sessions、7 stages（仅 S1 active）、0 approvals、0 exports、0 links、0 imports、活动 lease 已释放（TTL 1800 s）。
