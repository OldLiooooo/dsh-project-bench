# 工作台插件交付说明（安装 / 演示 / 验收对照）

> 2026-11-12 · 插件：`@local/dsh-project-workbench`（本地 bundle，路径 [workbench/](../workbench/)）。
> 施工图 [workbench-architecture-v1.zh.md](workbench-architecture-v1.zh.md)，实现笔记
> [implementation-notes.zh.md](implementation/implementation-notes.zh.md)，接口契约
> [contracts-v1.zh.md](implementation/contracts-v1.zh.md)。

## 1. 它是什么

工作区里的**项目运行时**：一个 SQLite 项目库（唯一事实源）+ 项目面板/树状驾驶舱 + PM/任务会话编排。

- 用户只和 **PM 会话**（preset `project-office`）说话；PM 用 `session_spawn_task` 拉起
  **任务会话**（preset `project-task`，命名「角色-切片-动作」，角色词表：产品/UX/架构/码农/测试/发布/复盘）。
- 文档、任务、会话、决策、证据、时间线全部在 `.project/project.db`；`docs/` 只是门禁/发布时的导出快照（只写不回读）。
- 每会话注入 ≤2k 上下文（L0 400 / L1 300 / L2 900，硬上限 2000，超限降级并提示按需查询）。
- 门禁与不可逆决策**只能人批准**：面板/HTTP 是唯一落定入口，agent 没有任何代批工具。

## 2. 安装（用户 Desktop）

1. 打开 DeepSeek Harness → 设置 → **插件**（plugin manager）；
2. 选择「添加本地插件 / 安装本地 bundle」，路径填：

   ```
   C:\Users\oldap\Documents\dsh-porject-bench\workbench
   ```

3. **完全退出 DSH**（含托盘）后重新打开（Host 代码与 preload 列表都在启动时装配）；
4. 在目标工作区打开右侧栏「**项目工作台**」→ 点「初始化项目」；
5. 点「进入 PM 对话」开始对话（PM 会话按 `project-office` preset 新建并登记）。

> desktop 是 Electron 保留 profile，外部 CLI 的 `dsh plugin --profile desktop` 会被拒绝；
> 安装必须在 app 内完成。只读自检（不改 `~/.dsh`）：
> `node workbench/scripts/dev-install.mjs check --home "%USERPROFILE%\.dsh" --profile desktop`
>
> 卸载：插件管理器移除该 bundle → 完全退出并重启。项目数据留在工作区的 `.project/`，删除即彻底清理
> （建议先 `node workbench/scripts/dev-install.mjs` 之外自行备份 `project.db`）。

## 3. 先跑隔离实例（不动用户 profile，推荐）

```bash
node workbench/scripts/dev-instance.mjs start        # DSH_HOME=<workspace>/.devhome，端口 52999
node workbench/scripts/dev-instance.mjs status --json
node workbench/scripts/dev-instance.mjs restart      # 改 host/client 代码后必须重启
node workbench/scripts/dev-instance.mjs stop
```

隔离实例默认没有模型路由；验证真实 PM/任务会话时加 overlay（grsai，key 从 credentials refs 读）：

```bash
node workbench/scripts/dev-instance.mjs stop
# 见 workbench/tests/e2e/devhome-model.patch.yml，启动时 --patch 它（脚本 start 支持 --patch）
```

## 4. 演示脚本（约 10 分钟）

1. **面板**：侧栏「项目工作台」→ 项目头显示项目名/阶段徽章/待决策数；左树「S1 产品 → 切片」；
   右侧 tabs：概览 / 会话 / 文档 / 决策 / 时间线。
2. **提需求**：点「进入 PM 对话」，对 PM 说：*「支付要能退款，先出 PRD」*。
   PM 会：拆切片（refund）、建任务、`session_spawn_task` 拉起「产品-refund-PRD」任务会话。
3. **看任务会话干活**：面板「会话」tab 出现行（角色/切片/模型/状态/只读提示）；
   文档 tab 出现 PRD v1（点开是 DB 渲染的预览，可切版本）。
4. **决策/门禁**：PM 提交 G1 门禁后，「决策」tab 出现卡（问题/选项/推荐/不返工后果 + **不可逆**标记）。
   点「批准」→ 要求二次确认 → 通过后：时间线出现 `gate/approve`、`doc/export`、`stage/change`，
   阶段徽章 S1→S2，`docs/product/prd-refund.md` 生成（带 generated 头）。
5. **时间线**：按类型/角色过滤；每条都能追到会话、切片、文档版本、决策、证据。
6. **PM 页头/输入框**：PM 会话里页头有阶段/当前切片/待决策徽章，输入框上方有项目摘要条；
   发一句新需求，侧栏树的待决策/任务状态会自动刷新（SSE 推 revision，不轮询）。

## 5. 验收对照（架构 §11）

| §11 验收项 | 证据 |
|---|---|
| 14 步业务预演可完整回放；三问可答 | `tests/e2e/replay-14-steps.mjs --strict` 17/17；`tests/e2e/live-e2e.mjs` 4/4（真实模型） |
| 时间线可追溯到会话/切片/文档版本/决策/证据 | `replay` 贯穿断言 + `live-e2e` gate 事件断言 + 面板时间线 tab |
| 文档版本/冻结/导出/导入闭环；旧版本可查不可改 | `db.test.mjs`（版本只增 / DOC_FROZEN / 同 hash 幂等 / 导出可重生成 / inbox 导入）+ `acceptance` |
| 2k 装载预算、按需查询、降级 | `acceptance.test.mjs` 2k 断言（大切片降级 + 硬上限 2000）+ `context.js` 裁剪顺序 |
| 单写者/租约/写作用域负向测试 | `db.test.mjs`（LEASE_HELD/过期抢占/续期）+ `negative.test.mjs`（未鉴权 401、重复会话、frozen、lease、seq） |
| PM 拉任务会话、命名/角色/切片/模型可查 | `tools.test.mjs`（spawn 写 sessions 行+租约+activation；when 过滤 PM 23 / 任务 15）+ 真实实例 sessions 表 |
| 决策/门禁人批准；不可逆二次确认 | `negative.test.mjs` 409 CONFIRM_REQUIRED + `live-e2e` 真实 409→200；工具层无代批工具（replay 断言） |
| 恢复：DB 备份/重建、导出可重生成、重启后会话可恢复 | `db.test.mjs`（重开 DB 推导 projectId/root、迁移幂等）+ `replay` 第 17 步 + `acceptance` 导出重生成 |
| 用户只与 PM 交互；任务会话不直接问用户 | `project-task` preset 不含 `ask_user_question`；PM 是唯一 `project-office` 入口（面板只建 PM 会话） |

UI 侧（`workbench-ui-architecture-v1.zh.md` §8）：侧栏入口、项目树+进入 PM、面板内不能新建非 PM 会话、
树节点与 DB 一致（SSE 1 秒内刷新）、文档预览来自 DB、决策卡可拍板、主题 token/无 iframe/无 root 替换
——代码与 `ui-client.test.mjs` 覆盖；**像素级观感需你在浏览器里目测**（本机无法跑 headless 浏览器）。

## 6. 本次未实现 / 已知边界

1. **Team 只读转录视图**：按你的决定暂缓；面板提供会话列表/状态/产物链接，原生会话可兜底打开。
2. **actionCards 决策卡**：实验服务在 web profile 默认未挂载，插件用 `ctx.inject` 安全注册 kind，
   未挂载时自动跳过（面板决策卡不受影响）。要启用需在 profile patch 里加
   `@deepseek-ai/dsh-action-cards` + `@deepseek-ai/dsh-client-ui-action-cards` 两行。
3. **任务会话收工后 DSH agent 仍 idle 存活**（DB 会话已结束、项目工具对其隐藏）；平台无自我 dispose API。
4. **WebGL/3D**：按 UI 架构只做 2D 树（CSS3D 可选层未启用），不引三方 3D 库。
5. `.project/project.db` 不入 git（自动生成 `.project/.gitignore`）；`project.json` 与导出的 `docs/` 入 git。
## 6.1 2026-11-14 变更：权威源外移（M0）

**默认行为变了**：项目库不再放 `<workspace>/.project/`，而是 `$DSH_HOME/storages/project-workbench/<workspaceKey>/`。

| 项 | 之前 | 现在（默认 `home` 模式） |
|---|---|---|
| `project.db` / `project.json` / `inbox/` / `packages/` | 工作区 `.project/` | **store**（agent 沙箱 EPERM，物理单写） |
| `docs/` / `exports/` / `timeline.md` | 工作区 | 工作区（不变；导出投影，进 git） |

- 老库自动兼容：首次打开时若 store 为空而工作区 `.project/` 有数据，会**复制**一次（原件保留，可回滚）。
- 想恢复旧行为：`PROJECT_WORKBENCH_STORE=local`（单写不成立，仅兼容用）。
- 自定义位置：`PROJECT_WORKBENCH_STORE=<绝对路径>`。
- 备份/迁移：直接拷 `$DSH_HOME/storages/project-workbench/` 整个目录。
- 卸载插件不会删数据；要彻底清理，删该 store 目录 + 工作区的 `.project/`。

门禁判据（[checkers.js](../workbench/host/checkers.js)）：`gate_submit` 会跑 `<root>/tools/engineering/checker.mjs`
与 `closeout.mjs`（存在才跑），失败即拒；批准前**复跑一次**，提交后判据变了同样拒（`STALE_PRECHECK`）。
