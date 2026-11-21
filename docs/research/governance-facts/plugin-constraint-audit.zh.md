# 插件现有约束实测（回答「本插件做了约束了吗」）

> 2026-11-14 · 只读验证。两条路径分别测：**绕过工具层直连 DB** vs **走应用层函数**。

## 结论一句话

**应用层有约束，数据库层没有约束。** 也就是说：约束只在"从工具/领域函数进"时生效；一旦绕过（任务会话有 bash + fs write），DB **一条都拦不住**。

## A. 数据库层（schema）—— 0 条

| 声称的约束 | DB 实测 |
|---|---|
| events append-only | **允许** DELETE、**允许** 改写 payload、**允许** 插跳号 seq |
| doc_versions 只增 | **允许** DELETE |
| 一个事实一条权威行 | **允许** 重复 artifact（同 path 同 kind）、**允许** 重复 evidence（同 uri） |
| 状态枚举 | **允许** `slice.status = '随便什么'` |

统计：`CREATE TRIGGER` = **0**，`CHECK(` = **0**，唯一索引只有 2 条（都是 sessions 的 active 约束）。

## B. 应用层（store/docs/leases）—— 7 条硬约束，3 处缺口

真实执行结果（`node .artifacts/verify-app-constraints.mjs`）：

```
DENIED   冻结后再写新版本            [DOC_FROZEN]
DENIED   同切片同角色第二个 active 会话 [DUPLICATE_ACTIVE_SESSION]
DENIED   非法会话命名                [INVALID]
DENIED   lease 被他人持有            [LEASE_HELD]
DENIED   decision 重复裁决           [INVALID]
DENIED   不可逆 decision 无 confirmed [INVALID]
ALLOWED  seq 连续                    ← 靠 MAX+1 保证（非约束，是算法）
ALLOWED  slice 状态任意字符串         ← 缺口
ALLOWED  artifact 重复同 path        ← 缺口（实测 2 行）
ALLOWED  evidence 重复同 uri         ← 缺口（实测 2 行）
```

## C. 所以「插件做了约束」的准确表述

- **做了**：应用层 6 条可拒绝的写前校验（冻结/重复会话/命名/租约/重复裁决/不可逆确认）+ 事件与数据同事务。
- **没做**：任何数据库级防线；任何路径级写作用域；任何阶段写策略；任何 CAS `expectedRevision`；任何"一个事实一行"的唯一性。
- **因此**：约束的强度 = "参与者是否自愿走应用层"。而任务会话 preset 带 `bash`+`fs write`（`cordis.patch.yml:108-121`），绕过是可行的。
## D. 复现方式

```bash
# A：绕过应用层直连 DB（副本上跑，不动真实库）
node .artifacts/verify-constraints.cjs

# B：走应用层函数，看哪条会真的拒绝
node .artifacts/verify-app-constraints.mjs
```

两个脚本都在 `.artifacts/`（不入 git），可重建：A 复制 DB 到临时目录后伪造写入；B 用内存/临时库直接调 `store`/`docs`/`leases`。
