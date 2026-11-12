# 项目工作台业务逻辑审查

结论：当前实现存在可触发的业务一致性缺陷，不能判定业务逻辑正确。仅审查，未修改产品代码。

范围：workbench 业务源码、实现契约、现有测试；覆盖任务/切片状态、会话编排、租约、阶段门禁、文档冻结与导出、客户端刷新。未做真实模型端到端及浏览器交互验收。

## 优先修复（P1）

1. **阶段门禁缺少当前阶段约束。** [project.js:47](../../workbench/host/project.js#L47)、[pm-tools.js:270](../../workbench/host/tools/pm-tools.js#L270)。S1 active 时提交并批准 S4/G4，实际 S4 done、S5 active，同时 S1 仍 active。应在提交和批准时验证阶段存在、gate 匹配、当前状态及过期审批，保证最多一个 active。
2. **审批文档集合与提交集合不一致。** [project.js:35](../../workbench/host/project.js#L35)、[pm-tools.js:302](../../workbench/host/tools/pm-tools.js#L302)。提交接受 docIds，但批准完全忽略该列表，改按 stage/slice 查找。实测提交 S2 文档 A 到 S1 门禁被接受，批准冻结 S1 文档 B，A 未冻结。即便产品有意按整个阶段冻结，也必须拒绝不一致的提交并明确展示实际集合，不能接受 A 后批准 B。
3. **审批未绑定提交版本。** [pm-tools.js:302](../../workbench/host/tools/pm-tools.js#L302)、[project.js:106](../../workbench/host/project.js#L106)。提交 v1 后追加 v2，原审批直接冻结 v2。应保存 docId/version/hash 快照，内容变动后要求重新提交或明确批准旧版本。
4. **失去租约的会话仍可收工写入。** [task-tools.js:217](../../workbench/host/tools/task-tools.js#L217)。A 租约过期后 B 接管，assertWriteScope 对 A 返回 LEASE_HELD，但 session_finish_task 仍返回 finished=true，任务变 done、切片变 review，B 仍持租。收工路径应在任何写入前校验租约，并以事务完成领域状态变更。

## 其他确定缺陷（P2）

5. **不同文档导出覆盖。** [export.js:66](../../workbench/host/export.js#L66)。逻辑键 prd/a-b 和 prd/a/b 均合法且唯一，却都映射为 docs/product/prd-a-b.md；后者覆盖前者，两次调用均成功。应使用稳定唯一 ID/哈希后缀或检测路径冲突。
6. **失败收工返回错误切片状态。** [task-tools.js:271](../../workbench/host/tools/task-tools.js#L271)。status=failed 后 DB 为 blocked，返回 slice.status 却固定为 review。返回值应来自更新后实际记录。
7. **派活失败留下虚假进行中任务。** [orchestration.js:280](../../workbench/host/orchestration.js#L280)、[orchestration.js:311](../../workbench/host/orchestration.js#L311)。startActivation 抛错时会话结束、租约释放，但 task 保持 in_progress 且指派 failed 会话。独立审查使用内存领域模块和抛错服务替身复现。应补偿恢复任务状态和负责人，或原子标记启动失败。
8. **SSE 刷新可丢失。** [client.js:1788](../../workbench/client.js#L1788)、[client.js:1818](../../workbench/client.js#L1818)。旧快照请求未完成时收到新 revision，去抖刷新复用旧 Promise；旧请求完成后未再补拉。独立审查以可控 Promise/定时器复现 revision=2 已收到但仅请求一次，显示 revision=1，且没有待执行刷新。应记录目标 revision/dirty 标志，在旧请求结束后补拉。
9. **headless 会话生命周期未正确打开项目。** [session-hooks.js:88](../../workbench/host/session-hooks.js#L88)、[session-hooks.js:142](../../workbench/host/session-hooks.js#L142)。headless 根解析返回 root 但 workspaceId=undefined，hooks 却 open(workspaceId)，失败后不登记 sessionIndex；任务 origin=subagent 导致 disposed 提前退出。独立审查以符合 headless 契约的 registry 替身复现 active 会话和租约残留；随后同切片同角色重新派活被重复 active 校验阻断。应使用 workspaceId ?? root，并在销毁时按预登记项目行核对身份。

## 验证记录

- Node v26.11.1。
- 常规 node --test 首次因子进程 spawn EPERM 未执行用例；改为 --test-isolation=none 后基础测试通过。
- acceptance 独立摘要：17 passed，0 failed，0 skipped。
- negative 独立运行：10 passed，0 failed，0 skipped。
- ui-client 独立运行：3 passed，0 failed，0 skipped（仅注册与纯变换，非浏览器交互）。
- 运行器曾临时失败于私有 Bash 环境准备，未执行命令；一次重试后上述验证完成。
- [复现脚本](../../.poc/business-logic-review.mjs) 在内存 SQLite 中验证前六项；导出测试仅写独立临时目录。

执行：

~~~bash
node .poc/business-logic-review.mjs
~~~

关键输出：

~~~text
STALE_LEASE_done guard=LEASE_HELD finished=true task=done dbSlice=review holderStillB=true
STALE_LEASE_failed dbSlice=blocked returnedSlice=review
FUTURE_GATE S1=active S4=done S5=active
WRONG_DOC_SET submitted=prd/requested actual=[prd/unrequested] submittedFrozen=false
VERSION_DRIFT submitted=1 approved=2
EXPORT_COLLISION samePath=true firstContentLost=true
~~~

这些复现脚本打印错误行为作为审查证据，退出码 0 表示复现顺利执行，不表示业务通过验收。优先修复审批对象/版本绑定、阶段状态机和租约约束，再补充失败恢复、导出唯一性与刷新竞态回归。
