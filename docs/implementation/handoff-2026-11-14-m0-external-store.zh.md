# 交接：M0 权威源外移（单写成立）

> 2026-11-14 第四批 · 目标：让「单写」从**自觉**变成**物理事实**。
> 前三批见 [gate-precheck](handoff-2026-11-14-gate-precheck.zh.md) / [governance-e2e](handoff-2026-11-14-governance-e2e.zh.md)。

---

## 1. 为什么这一步是命门

DSH 沙箱只有 allow-list（`workspace-write` = 工作区根 + tmp），**没有 deny-list**。
所以「工作区可写但 `<workspace>/.project` 不可写」这个需求，用沙箱表达不出来。
只要 DB 留在工作区，任务会话的 `bash` / `fs write` / PTC 裸 `node:fs` 就能直连改写——
前面所有门禁、判据、租约都只是**自觉**。

实测（本机）：会话沙箱写 `~/.dsh/storages/` → **EPERM**；写 `<workspace>/.project/` → ALLOWED。

→ 唯一有效动作是**换位置**，不是加规则。

## 2. 做了什么

[registry.js](../workbench/host/registry.js) 新增权威源布局层：

| 模式 | 位置 | 单写 |
|---|---|---|
| `home`（**默认**） | `$DSH_HOME/storages/project-workbench/<workspaceKey>/` | ✅ 成立 |
| `local`（兼容） | `<workspace>/.project/` | ❌ 不成立 |
| 绝对路径 | 指定目录 | 取决于该目录权限 |

切模式：`PROJECT_WORKBENCH_STORE=home|local|<abs path>`；`$DSH_HOME` 缺省 `~/.dsh`。

**布局语义**（关键）：

- 权威数据（`project.db` / `project.json` / `inbox/` / `packages/`）→ **store**（agent 碰不到）
- 导出投影（`docs/` / `exports/` / `timeline.md`）→ **仍在工作区**（给人看、进 git，本来就该在那）
- `<workspaceKey>` = 工作区规范根 realpath 的 sha256 前 16 位（同一根永远同一 key，不泄露路径）

**迁移**（老库自动兼容）：

- `openDb` 发现「store 空 + 工作区 `.project/` 有数据」→ **自动复制**一次（原件保留，随时可回滚）
- 显式入口：`registry.migrateLegacyStore(root, { overwrite, removeLegacy })`
- `registry.migrationStatus(root)` 只读查询

## 3. 顺带修掉的两个真 bug

1. **`open({create:true})` 永远走不到创建分支**：`open` 先用 `rootForWorkspace`（不允许创建）解析，
   未初始化时直接 403。已改为 `create` 时用 `allowCreate` 解析。
2. **回放第 17 步重开用的是硬编码路径**：M0 后 DB 不在 `<root>/.project/` 了，
   已改为走 `registry.projectPaths(root).dbPath`（布局只有一个真相源）。

## 4. 验证

### 治理演练升到 **27 条断言**（[governance-e2e.log](../.artifacts/governance-e2e.log)）

新增三条直接验「单写」：

```text
PASS ②a 权威源已外移到 store（不在工作区内）— store=<workspace>/.artifacts/governance-dshhome/storages/project-workbench/83ef6d36...
PASS ②b 工作区里不再有 project.db（agent 碰不到权威源）— workspace .project 仅剩导出投影
PASS ②c 会话沙箱写不进真实 $DSH_HOME/storages（物理单写前提）— EPERM ✓
```

### 全量回归

| 套件 | 结果 |
|---|---|
| `checkSyntax()` | PASS 47 文件 |
| unit db / api / tools / **acceptance** | 30 / 16 / 25 / **21**（+2 例：外部 store 布局、旧库自动迁移） |
| e2e negative / ui-client / dev-instance | 10 / 7 / 8 |
| replay-14-steps | 17 / 0 pending |
| gate-real-checkers | 3 / 0 |
| governance-e2e | **27 / 0** |

### 测试侧的必要调整（不是放宽，是修正前提）

- `harness.mjs` 把 `DSH_HOME` 钉到 `<workspace>/workbench/tests/e2e/.artifacts/dshhome`：
  **测试进程自己也跑在会话沙箱里**，写真实 `~/.dsh` 会 EPERM——那测的是沙箱，不是插件。
- db.test 两条「project.json 生效 / 不隐式改写」用例显式 pin `local` 模式：
  它们验的是**配置语义**，与权威源位置无关；顺带覆盖了 local 兼容路径。

## 5. 现在三个问题的答案

| 问题 | 答案 |
|---|---|
| 插件能不能跑通？ | **能**（27 条端到端断言，真实 lumio 副本） |
| 判据能不能生效？ | **能**（真实 checker 拦截 + 放行双向验证） |
| 单写成不成立？ | **成立**（权威源在 agent EPERM 的目录；工作区只剩导出投影） |

## 6. 仍未达标（诚实记档）

| 缺口 | 影响 |
|---|---|
| **官方命令仍未跑通** | bash 全程 `EXECUTOR_UNAVAILABLE`，`spawn` 全程 EPERM。全部证据来自 in-process |
| **未在真实 DSH 实例 + 真模型上跑** | `instance-http.mjs` / `live-e2e.mjs` 未执行 |
| **子会话仍是替身** | 真实 `startActivation` 的 preset/model/prompt 注入未在真机验证 |
| **lumio 的 17 种状态词表未映射** | 反向登记（M1）没做：49 WI / 40 DEC 尚未进 DB |

## 7. 下一轮

1. **补跑官方命令**（执行器恢复后第一时间）——这是唯一能推翻以上结论的东西。
2. **真实 DSH 实例 + 真模型**：`dev-instance.mjs start` → `instance-http.mjs --strict` → `live-e2e.mjs`。
3. **M1 反向登记**：把 lumio 的 49 WI / 40 DEC 以 `external_ref + hash` 形式建进 DB（不复制正文）。
