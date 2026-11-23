# 角色卡（workbench/roles）

10 张角色卡，**一角色一个 Markdown 文件**。插件加载时由 `host/roles.js` 读进来，
拼成 L1 注入（会话首步 / 切切片时）与任务会话开场里的「角色卡」段。

| 文件 | 角色词 | 角色 | 主阶段 |
|---|---|---|---|
| `pm.md` | `PM` | 项目办公室 | 全阶段 |
| `qa.md` | `QA` | 独立验收者 | 全阶段（验收点） |
| `product.md` | `产品` | 产品经理 | S1 产品 |
| `ux.md` | `UX` | 体验设计 | S2 UX |
| `architecture.md` | `架构` | 架构师 | S3 架构 |
| `coder.md` | `码农` | 实现工程师 | S4 实现 |
| `test.md` | `测试` | 测试工程师 | S5 测试 |
| `release.md` | `发布` | 发布工程师 | S6 发布 |
| `retro.md` | `复盘` | 复盘者 | S7 复盘 |
| `research.md` | `调研` | 调研员（只读） | 全阶段（按需） |

## 文件格式

```markdown
---
word: 码农            # 角色词，必须与文件名对应的词一致（会话命名校验靠它）
title: 实现工程师      # 显示名
stage: S4 实现         # 主阶段（仅用于展示，不参与阶段机判定）
---

## 职责
这个角色负责什么、明确不负责什么

## 读
开工前该读什么

## 写
允许写什么、不允许写什么

## 开工
- 逐条清单

## 收工
- 逐条清单

## 红线
一句话红线
```

六节之外的内容会被忽略（可以在文件末尾写备注，不会进注入）。

## 外置的边界（重要）

外置的只是**文案**。权限与边界仍然由代码执行：

| 约束 | 执行位置 |
|---|---|
| 谁能调哪个工具 | `host/tools/*.js` 的 `actors` + `register.js` 的 `when` 过滤 |
| 谁能写哪些文件 | `host/scope.js` 的 `assertWriteScope` + 切片租约 |
| 建造者不验收 | `store.verifySlice` 的三道闸 + `kind='qa'` 独立会话 |
| PM 不亲自调查 | **PM preset 不挂 `tool-fs` / `tool-fs-search`**（没有 read/glob/grep）+ `tests/unit/presets.test.mjs` 守门 |
| 调研只读 | `project-research` preset 的 write/edit/applyPatch 全 false + 调研角色不占租约 + 不能用 `session_finish_task` |
| 任务会话名合法 | `host/roles.js` 的 `taskSessionName/validateTaskName` + `store.createSession` |

所以**改角色卡不会放宽任何权限**：把「只改本切片文件」从 `coder.md` 里删掉，
码农照样会被租约和写作用域拦住。反过来也成立——往卡里写「你可以改任意文件」也没用。

## 内置兜底卡

`host/roles.js` 里有一份 `FALLBACK_CARDS`，与这 9 个文件同构。只在读文件失败时使用：

- 文件缺失 / frontmatter 坏了 → 该角色走兜底，并把错误记进 `ROLE_CARD_ERRORS`；
- **绝不注入空串**——v5 踩过这个坑：qa 会话没有角色卡，会话开场不知道自己来干什么。

两份内容必须一致，由 `node workbench/scripts/check-role-cards.mjs` 校验（漂移即 exit=1）。
改了这里的任何一张卡，记得同步 `FALLBACK_CARDS`，然后跑一遍：

```bash
node workbench/scripts/check-role-cards.mjs
```

## 长度预算

L1 单层上限 300 tokens（`host/context.js` 的 `budget.l1`），超了会把每步注入都判成降级。
当前实测：PM 277 / QA 246 / 产品 208 / UX 172 / 架构 198 / 码农 207 / 测试 254 / 发布 194 / 复盘 173 / 调研 278。
改卡后跑 `node --test --test-isolation=none tests/unit/`，里面有锁「pm/task/qa 三种角色都不降级」的用例。
