# 交接：真实实例上的治理闭环（Round 3）

> 2026-11-14 第六批 · 目标 ②：**用插件对真实仓库实施治理**，而且要走宿主真实链路。
> 前几批：[live-instance](handoff-2026-11-14-live-instance.zh.md) / [M0](handoff-2026-11-14-m0-external-store.zh.md)。

---

## 1. 这一轮补的是「宿主真实链路」

Round 2 证明了插件能**加载**进真实实例（工具 25 个、client bundle 注入首页、HTTP/SSE 通）。
但治理闭环此前只在 `governance-e2e.mjs` 里验过 —— 那个探针**直接 import host 模块**，绕过了宿主。

本轮新增 [live-governance-http.mjs](../workbench/tests/e2e/live-governance-http.mjs)：
**全程走宿主**：真 `ctx` → 真 `tools` 服务 → 真 HTTP 路由 → 真 cookie 鉴权 → 真 `workspaceRegistry` 准入。

## 2. 13 条断言全过（`passed=13 failed=0`）

日志：[.artifacts/live-governance-http.log](../.artifacts/live-governance-http.log)

```text
PASS ① 真实实例启动且插件已加载  — port=53140
PASS ② token 换 cookie（真实鉴权）  — 303
PASS ③ POST /init 在真实 lumio 副本上初始化项目  — 200
PASS ④ 换阶段模板未确认 → CONFIRM_REQUIRED
PASS ⑤ 落地 lumio 生命周期 PRD/DEV/FILE/CODE
PASS ⑥ 真实 lumio 判据在副本上跑出红灯  — 4 issues: DIR_UNREGISTERED,MEMORY_BEHIND
PASS ⑦ 治理后判据真实转绿  — clean
PASS ⑧ 真实 tools 服务里的 gate_submit 可执行且机检通过  — approvalId=appr-7a8cd062…
PASS ⑨ 不可逆门禁缺二次确认 → 409 CONFIRM_REQUIRED
PASS ⑩ 真实 HTTP 批准 → 阶段 PRD→DEV  — 200
PASS ⑪ 真实 HTTP /snapshot 反映新阶段  — 200
PASS ⑫ 时间线含 gate/approve + stage/change  — 200
PASS ⑬ 权威源已外移（工作区无 project.db）
```

关键点：

- **⑧ 走的是宿主注册的那份工具定义**（`ctx.get('tools').definitions()` 取出 `gate_submit` 再 execute），
  不是直接调 `pm-tools.js`。因此它证明的是「模型真调用时会走同一条路」。
- **⑥→⑦ 是双向的**：真实 lumio 判据先红（`DIR_UNREGISTERED` + `MEMORY_BEHIND`），
  治理动作（登记 `.project` 进 policy + 更新项目记忆）后**真转绿**，不是绕过。
- **⑩ 走真实 HTTP POST**，经过 cookie 鉴权、workspace 准入、`resolveDecisionAction`，阶段真的从 PRD 推到 DEV。

## 3. 全量回归

| 套件 | 结果 |
|---|---|
| `checkSyntax()` | PASS 49 文件 |
| unit db / api / tools / acceptance | 30 / 16 / 25 / 21 |
| e2e negative / ui-client / dev-instance | 10 / 7 / 8 |
| replay-14-steps | 17 / 0 |
| gate-real-checkers | 3 / 0 |
| governance-e2e（host 模块直调） | 27 / 0 |
| live-inprocess-instance（真实例加载） | 15 / 0 |
| **live-governance-http（真实例 + 真实治理）** | **13 / 0** |

## 4. 关于真实模型会话

想过在真实实例上跑一次真实模型驱动 PM/任务会话（`live-e2e.mjs` 的等价物）。探测结果：

- 实例里有 provider：`deepseek-official`、`deepseek-account`
- 但隔离 home 的 credentials 里**没有可用的 LLM API key**（只有 `A_API_KEY` / lumio 服务账号）
- 用真实账号凭据跑模型会消耗用户额度，**这件事应该由用户决定，我不代劳**

因此本轮不做真实模型会话，**如实记档**。

## 5. 目标核对

| 目标项 | 状态 |
|---|---|
| ①a 官方命令跑通 | ❌ `ops_bash` 第 3 轮仍 `EXECUTOR_UNAVAILABLE`；`spawn` 仍 `EPERM` |
| ①b 真实实例跑通 | ✅ 15/15 + 13/13，两条独立链路 |
| ②a 门禁判据真实生效 | ✅ 真实 checker 红灯拦截、治理后放行，双向且走宿主 |
| ②b 阶段机匹配 | ✅ PRD→DEV 在真实 HTTP 上推进 |
| ②c 单写成立 | ✅ store 外移（⑬ 验证工作区无 project.db） |

## 6. 阻塞状态

**①a（官方命令）连续 3 轮不可达**：

- `ops_bash` → `EXECUTOR_UNAVAILABLE`（niubash 硬链接池耗尽，8 个陈旧执行树 EPERM 删不掉）
- `child_process.spawn` → `EPERM`（沙箱禁止）

这是**宿主环境故障**，不是本项目代码问题，我这一侧既不能修也不应绕过。
恢复后需要补跑：`node --test workbench/tests/unit/`、`replay-14-steps.mjs --strict`、`instance-http.mjs --strict`、`live-e2e.mjs`。

## 7. 下一轮（不依赖 shell 的部分）

1. **M1 反向登记**：把 lumio 的 49 WI / 40 DEC 以 `external_ref + hash` 建进 DB（不复制正文）。这是实施计划里明确的一步。
2. 真实模型会话：等你决定是否用你的账号额度跑。
