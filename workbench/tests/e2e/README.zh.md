# 工作台验证套件（T5 verify）

本目录是「软件项目工作台」插件的验收测试与实例验证脚本。全部只依赖 `node:` 内置模块；
不要求 GUI / headless 浏览器 / 真模型调用。默认在 `workbench/tests/e2e/.artifacts/` 下建临时项目
（自动清理；`WORKBENCH_E2E_KEEP=1` 时保留以便排查）。

## 文件

| 文件 | 作用 |
|---|---|
| `harness.mjs` | 共享夹具：fake Cordis ctx、临时项目根、host 模块加载、断言、node:http 路由服务器、SSE 读取、报告 |
| `replay-14-steps.mjs` | 架构 §7 的 14 步业务预演（需求→PM→产品/UX/架构/码农/测试→决策→门禁→导出→复盘）+ 贯穿断言 + 工具层抽检 + 恢复 |
| `negative.test.mjs` | 契约 §11.3 负向测试：API 未鉴权 401/403、未鉴权不触注册表、agent 无代批决策工具、重复 active 会话、frozen、租约、seq 无空洞；HTTP 集成（init/snapshot/timeline/SSE、不可逆决策 confirmed、门禁冻结+导出+阶段推进） |
| `ui-client.test.mjs` | Client UI 契约自测：4 个槽位注册、i18n zh/en 字典、__pure 纯变换、组件存在性（不需要浏览器） |
| `instance-http.mjs` | 真实 52999 隔离实例验证：页面/preload/client bundle 可获取且可解析、未鉴权 401/403、/projects、/snapshot、/timeline、SSE |
| `live-inprocess-instance.mjs` | **真实 DSH 实例（进程内启动，不依赖 spawn）**：起真 web profile → 装插件进 profile → 真 token 换 cookie → 页面/preload/鉴权/API/SSE 全链路 15 断言 |
| `live-governance-http.mjs` | **真实实例上的治理闭环**：真实 lumio 副本 → 换阶段模板 → 真实判据红灯 → 治理转绿 → 门禁（真实 tools 服务执行）→ 真实 HTTP 批准 → 阶段推进。13 断言 |
| `../../tests/unit/acceptance.test.mjs` | 契约 §11.1/§11.5 单测：schema/事件 seq/事务回滚、文档版本链/冻结/检索/导出重生成/inbox 导入、租约、决策不可逆、2k 预算与降级 |
| `../scripts/check-syntax.mjs` | 对所有 workbench `*.js|*.mjs` 做「可解析」检查（等价 node --check；bash 不可用时用） |
| `../scripts/dev-instance.mjs` | 隔离 DSH 实例管理：start/stop/restart/status/wait/url/cookie/logs（DSH_HOME=`.devhome`，端口 52999） |
| `../scripts/dev-install.mjs` | 插件安装检查/计划/说明（check/plan/install/instructions；只写隔离 profile，不动 `~/.dsh`） |

## 命令（在仓库根执行）

```bash
# 语法检查（等价 node --check 全量）
node workbench/scripts/check-syntax.mjs

# 单测/验收（node --test 全绿）
node --test workbench/tests/unit/acceptance.test.mjs
node --test workbench/tests/e2e/negative.test.mjs
node --test workbench/tests/e2e/ui-client.test.mjs

# 14 步预演：--strict 时「模块缺失/待落地」也算失败（最终验收用）
node workbench/tests/e2e/replay-14-steps.mjs --strict

# 隔离实例生命周期
node workbench/scripts/dev-instance.mjs start          # 启动并输出/记录带 token 的 URL
node workbench/scripts/dev-instance.mjs status --json  # 进程 + 首页健康
node workbench/scripts/dev-instance.mjs restart
node workbench/scripts/dev-instance.mjs stop

# 实例级 HTTP/SSE 验证（--strict = pending 计入失败）
node workbench/tests/e2e/instance-http.mjs --strict
```

退出码约定：`0` 通过（或非 strict 下 pending）；`1` 有失败（strict 下 pending 计失败）；
`2` 参数/环境错误；dev-instance `status` 未运行时返回 `3`。

## 实例凭据

- `dev-instance.mjs start` 会从实例 stdout 日志解析 `dsh web: http://127.0.0.1:52999/?token=...`，
  写入 `workbench/tests/e2e/.artifacts/dev-instance/instance.url`，并用 token 换 cookie 后做健康检查。
- `instance-http.mjs` 凭据优先级：`--cookie` / `--cookie-file` > 本脚本管理的 state > `--start` 启动 >
  自动回退 `.poc/devhome-cookies.txt`（外部已启动实例的旧会话 cookie；仅用于只读验证）。
- 完整 SSO/权限行为以真实浏览器为准：本套件不做 headless 浏览器，不伪造登录。

## 环境变量

| 变量 | 作用 |
|---|---|
| `WORKBENCH_E2E_KEEP=1` | 保留临时项目目录（默认删除） |
| `DSH_DESKTOP_EXE` / `DSH_DESKTOP_CLI` | 覆盖 DSH 可执行文件/CLI 路径（默认本机安装路径） |
| `DSH_HOME` | dev-install 默认目标 home；dev-instance 默认用 `<workspace>/.devhome` |
