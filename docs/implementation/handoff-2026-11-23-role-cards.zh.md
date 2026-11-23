# 角色卡外置 + 与 fullstack-forge-team 的职责对比（2026-11-23）

> 触发：用户要求「对比一下我们的角色职责范围」并「抄一下角色卡外置」。
> 本文件两件事：① 两组角色卡的职责对比与差距判断；② 外置改造的落点与证据。

---

## 1. 对比：我们的角色卡 vs 专家团的角色卡

对比对象：`workbench/roles/*.md`（本次外置后的 9 张）与
`~/.workbuddy/plugins/marketplaces/experts/plugins/fullstack-forge-team/agents/*.md`（8 份，78–275 行）。

### 1.1 结构差异（这是核心区别）

| 维度 | 我们（workbench） | 专家团（fullstack-forge） |
|---|---|---|
| 卡的组织 | 9 张，一角色一文件 | 8 份，一角色一文件 |
| 主线 | **边界**：读什么 / 写什么 / 能开工什么 / 收工条件 / 红线 | **范围**：5–6 条编号「职责维度」 |
| 是否枚举工作内容 | 只有一行 `职责`（本次新增） | 逐条枚举，如 qa-tester 六条：测试策略/功能/多端兼容/非功能/自动化回归/回访清单 |
| 必读知识 | `reads` 一行（指向简报/文档） | 显式路径 `references/xxx.md`，偏离即退回 |
| 产出契约 | `doc_write(type=...)` + `session_finish_task` | 最后一行方括号标记 `[测试保障方案]`，缺失即退回重做 |
| 错误预防 | 一行 `红线` | 编号表（成员 3 条 D1–D3，团长 12 条 FF01–FF12）：现象→后果→正确做法 |
| 自检 | 收工硬校验（工具层执行） | 文末勾选清单（提示词自觉） |
| 上下游 | `session_task_report` / 完整原文传递 | 「上下游协作接口」段落文字约定 |

**结论一句话**：我们的卡是「**权限与完成条件卡**」，他们的是「**工作范围卡**」。
两者不冲突，但**我们缺了「这个角色到底要覆盖哪些维度」这一层**——
这正是用户说的「职责范围写得比较清晰」。

### 1.2 角色集合差异

| 职责域 | 我们 | 专家团 | 判断 |
|---|---|---|---|
| 主理/编排 | `PM`（项目办公室） | `forge-lead` | 对齐；我们的 PM 不写文档/代码，他们的团长会写整合报告 |
| 需求与平台选型 | 并入 `产品` | `product-scout`（独立） | 他们的选型是独立产出；我们只在切片里做 |
| 产品定义 | `产品` | `product-manager` | 对齐 |
| 体验设计 | `UX` | **无** | 我们更细；他们把交互塞进 PRD |
| 架构 | `架构` | 并入 `fullstack-engineer` | 我们把架构与实现**拆成两级**（ADR 先冻结，再写码） |
| 实现 | `码农` | `fullstack-engineer` | 同上，他们合并 |
| 测试 | `测试` | `qa-tester` | 对齐 |
| 独立验收 | `QA`（独立 preset + 只读工具面） | **无**（测试角色自认完成即算过） | **我们更强**：建造者不验收是工具层硬边界 |
| 发布 | `发布` | `release-manager` | 对齐 |
| 运维/SRE | **无** | `ops-sre` | 我们的缺口 |
| 增长运营 | **无** | `growth-operator` | 我们的缺口 |
| 复盘 | `复盘` | 无（团长自己写复盘卡） | 我们有独立角色 + `period_roll` |

缺口判断：`运维`、`增长` 两个角色词不在 `ROLE_WORDS` 里。
**不建议现在加**——加角色词要动 DB 命名校验、preset 说明、面板角色滤镜、9 个技能的「使用方」表，
而这两个角色在「交付到上线」之后才登场，当前 MVP 的切片还停在交付前。
已记入 §4 遗留。

### 1.3 我们比他们强的地方（别抄丢了）

| 能力 | 我们的实现 | 他们的实现 |
|---|---|---|
| 建造者不验收 | 独立 `project-qa` preset，工具面只有 9 个，不占租约 | 提示词里一句话 |
| 写作用域 | `assertWriteScope` + 切片租约 | 无 |
| 产出校验 | `session_finish_task` 硬校验（交接非空 + 证据 ≥1 + 片外零改动） | 方括号标记，团长人肉核对 |
| 进度口径 | 只认 `verified`，`done` 单列 | 无状态机 |
| 上下文预算 | 2k 硬上限，分层裁剪并标注降级 | 无 |

所以抄的是**卡的内容组织**，不是**卡的作用方式**——他们的卡是唯一约束，我们的卡只是提示。

---

## 2. 本次改造：角色卡外置

### 2.1 落点

| 文件 | 变化 |
|---|---|
| `workbench/roles/*.md`（新增 9 个 + README） | 一角色一卡；frontmatter `word/title/stage`，正文六节 `职责/读/写/开工/收工/红线` |
| `workbench/host/roles.js` | 从「写死 9 个对象」改为「启动时读 roles/ + 解析 + 兜底」；新增 `parseRoleCard/loadRoleCards/ROLE_CARD_SOURCES/ROLE_CARD_ERRORS`；导出 `FALLBACK_CARDS` |
| `workbench/scripts/check-role-cards.mjs`（新增） | 文件卡与内置兜底卡逐字段比对，漂移 exit=1 |
| `workbench/package.json` | `files` 加 `roles/**`（否则发布包里没有卡） |
| `workbench/scripts/dev-install.mjs` | `REQUIRED_BUNDLE_FILES` 加 `roles/pm.md` 等 3 个探针文件 |
| `workbench/tests/unit/tools.test.mjs` | +3 例：来源必须是 file / 缺文件必须兜底且不空串 / parseRoleCard 解析与坏输入 |
| 契约 §6、设计 §3.4、README | 同步「角色卡外置」与预算说明 |

### 2.2 三条设计取舍

1. **外置的只是文案，不是权限**。
   权限仍在 `actors`/`when` 过滤、`scope.js` 写作用域、租约、`verifySlice` 三道闸。
   把 `coder.md` 的红线删掉，码农照样被租约拦住——这正是设计 §8「提示词不算约束」的落地。
2. **兜底不是第二事实源**。
   `FALLBACK_CARDS` 只在读文件失败时用，且由脚本守一致性。
   宁可注入旧文案，也**绝不注入空串**——v5 的 qa 空角色卡事故就是这么来的。
3. **新增 `职责` 节，但只给一行**。
   L1 单层预算 300 tokens，实测已到 254（测试卡），再加维度清单会顶破预算并让每步注入判降级。
   所以：`职责` 一行给范围，**维度细节仍放技能**（`prd-writing`/`adr-writing`/…，按需加载不占预算）。

### 2.3 实测长度（token）

| PM | QA | 产品 | UX | 架构 | 码农 | 测试 | 发布 | 复盘 |
|---|---|---|---|---|---|---|---|---|
| 239 | 246 | 208 | 172 | 198 | 207 | 254 | 194 | 173 |

全部 ≤300；`compileContext` 对 pm/task/qa 三种角色的 `degraded` 仍为 false（有用例锁住）。

---

## 3. 怎么验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 单测 | `DSH_HOME=<workspace> node --test --test-isolation=none workbench/tests/unit/` | **128：127 pass / 0 fail / 1 skip** |
| 语法门禁 | `node workbench/scripts/check-syntax.mjs` | PASS（47 文件，0 错） |
| 文档计数 | `node workbench/scripts/check-doc-counts.mjs` | PASS（8 条规范句） |
| 角色卡一致性 | `node workbench/scripts/check-role-cards.mjs` | PASS（9 张全一致） |
| 漂移检测本身 | 改 `coder.md` 一个词再跑 | FAIL（1 处，红在正确的字段上） |
| 安装检查 | `node workbench/scripts/dev-install.mjs check --home .devhome --profile web` | 全 ok |
| dev-install e2e | `node --test tests/e2e/dev-instance.test.mjs` | 8/8 pass |

> `DSH_HOME` 必须显式指到工作区内：默认 `~/.dsh` 在会话沙箱里 `mkdir` 会 EPERM，
> 那是沙箱行为不是插件行为。

---

## 4. 遗留与下一步

| # | 事项 | 说明 |
|---|---|---|
| R1 | `运维`/`增长` 角色词 | 需动 `ROLE_WORDS` + DB 命名校验 + 面板角色滤镜 + 技能使用方表；跨切片，建议走决策卡 |
| R2 | 每角色的「职责维度」清单 | 现由 skills 承担；若要进卡，需先给 L1 加预算（会挤压 L2 的 900）或拆 L1 为「核心卡 + 按需展开」 |
| R3 | 错误预防编号表 | 他们的 D1–D3/FF01–FF12 很有价值；我们的对应物散在 `docs/implementation/adr-*.md` 与技能里，可考虑收敛成每角色 3 条进技能 |
| R4 | 产出标记 | 他们的方括号标记是「团长人肉校验」的替代品；我们已有 `session_finish_task` 硬校验，**不需要抄** |
