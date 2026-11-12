# DSH 运行时记忆机制：源码事实清单

> 审计对象：DSH checkout `C:/Users/oldap/Documents/deepseek-harness-a/deepseek-harness`，根 `package.json` 版本 **0.2.1-rc.2**（`package.json:3`）。本机运行的 Desktop 声明 **0.2.2-rc.1**（见 §8），存在版本漂移风险。
> 方法：源码逐包审计 + 本机 `~/.dsh` 实测（解压当天会话 JSONL，只读）。标记约定：**[源码]** 有行号证据；**[实测]** 本机数据；**[推断]** 由源码组合推出、未直接运行；**[待验证]** 找不到证据或需要 0.2.2 侧验证。
> 所有路径均相对 checkout 根（`packages/...`），行号以本 checkout 为准；行号可能随版本漂移，符号名为准。

---

## 0. 一页纸结论

### 0.1 插件/preset 在「会话运行时」能做什么（均有源码证据）

| 能力 | 机制 | 时机 | 证据 |
|---|---|---|---|
| 写入系统提示（静态/每步求值） | `ctx.systemPrompt.section({name,order,text})`，`text` 可为 `(AssembleContext)=>string` | 每步 assemble；作为 `system/message` 落盘为 surface 节点 0，稳定则只记一次 | `core/system-prompt/src/index.ts:53`（PromptSection）、`:429`（SystemPrompt）、`agent-loop/src/runtime-context.ts:65` |
| 注入动态上下文（durable user message） | `ctx.systemPrompt.context({name,order,text,required})` | 每步 assemble 求值；**值变化才**追加一条 `user/message`；每次请求 admission 用 `refreshContext` 重算 | `core/system-prompt/src/index.ts:79`、`:582`；`core/agent-loop/src/agent.ts:411,430,434,439` |
| 全局改 prompt assembly | 事件 `system-prompt/assemble`（waterfall） | 每步 assemble 内，可改 sections/contexts/tools/variables | `core/system-prompt/src/index.ts:31` |
| 每步注入任意 user 消息（不进 system prompt） | 监听 `agent/pre-step` waterfall，返回替换后的 `messages`；或 `agent.inject()` | 步边界（claim inbox 之后、请求前） | `core/agent/src/runtime-types.ts:320,241`；`agent-loop/src/agent.ts:267` |
| 注入工作区规则 | `agent-instructions` 插件：AGENTS.md/CLAUDE.md → baseline user 消息，文件 touch 后增量刷新 | 首个 pre-step + read/write/edit 结果后 | `context/agent-instructions/src/index.ts:86,179,300` |
| 技能目录/正文 | 技能目录摘要 user 消息（digest 去重）+ `skill` 工具按需加载正文 | 目录每步检查、变化才注入；正文按需 | `skill/tool-skill/src/index.ts:147,215` |
| preset 定制注入 | preset = 一组 per-agent 插件行；装 `persona` 或自研插件，在 agent scope 注册 section/context | 会话创建时组装，随后每步生效 | `preset/agent-preset-registry/src/definition.ts:5`；`bundle/web-app/presets/ptc.patch.yml:11-20` |
| 持久化插件状态 | `storageDomain`（schema KV）或 `appendPluginRecord(session,'plugin:...')` | 随时（domain 可写；plugin record 是日志） | `storage/storage-domain/src/index.ts:84`；`core/session/src/index.ts:492` |
| 写前闸门 | 事件 `tools/pre-execute` waterfall，返回 `{kind:'deny',reason}`，reason 模型可读 | 工具执行前 | `core/tools/src/index.ts:154,608-612` |

### 0.2 明确做不到（或只能有限做到）

1. **没有「压缩前」钩子**：只有 `compaction/start|summary|end|prune` 已落盘事件可观察 + `compaction/summary-error` 恢复 waterfall（§2.4）。
2. **不能给已接受的请求改消息**：`agent/request` waterfall 明确「cannot mutate messages；model-visible content 必须走 logged channels」（`core/agent/src/runtime-types.ts:328-329`）。
3. **不能新增会话事件类型**：持久化读路径只认 `KNOWN_SESSION_EVENT_TYPES`，未知类型未标 `ignorable` 会拒绝重建会话（`core/session/src/known-event-types.ts:8-21`、`types.ts:494-520`）。出仓插件的唯一合规自定义日志是 `plugin:` 记录（实验性，§5.3）。
4. **没有 context token 预算 API**：`PromptContext`/`PromptSection` 无 token 字段，只有字节/字符预算散落在各插件（§1.5）。水位要自己用 `tokenMeter` 算。
5. **默认组合没有全文会话检索**：base 组合 `session-query-sqlite` 配置 `openAt: never, path: ':memory:'`；桌面 profile 未覆盖（`bundle/base/cordis.patch.yml:157-163`；本机 profile 无该 id patch）。精确读/血缘 trace 仍可用。
6. **storage domain 没有 CAS/多记录事务**：只有 per-key `put/delete/update`（原子 RMW）+ global（§5.2）。任务板式并发要自己用「记录内 revision + update()」。
7. **跨进程不行**：会话 JSONL 单写者租约（`session/session-persistence/src/index.ts:120-160`），别的进程只能读；跨会话消息必须走 team/remote API。
8. **插件代码在进程内、workspace 沙箱之外**（`boot/plugin-manager/README.md`：「installed Host code executes in-process outside the workspace sandbox」）——记忆插件本身是可信代码边界。

### 0.3 五个对设计最致命的事实

- **注入即历史**：每步注入的「项目简报」会变成 durable `user/message`，和用户消息一样被压缩、被检索、被冷恢复；不是旁路注解。
- **只有变化的注入才会追加**：runtime-context 快照按文本去重（`agent-loop/src/runtime-context.ts:152-162`），稳定前缀才可能有 provider 缓存收益（实测：69 步只有 1 条 system/message、4 条 user/message）。
- **压缩后注入需要自愈**：system head 永不压缩；其余注入若被 shadow，需要插件自己从 surface 重建（runtime-context 与 agent-instructions 都这么做，§2.6）。
- **跨重启只记得住落盘的东西**：会话日志 + storage domain；插件内存状态（WeakMap/Map）冷恢复后为空（agent-instructions 的 version cache 就是 WeakMap，`context/agent-instructions/src/index.ts:88`）。
- **多 agent 记忆按 sessionId 隔离**：spawn 请求只带 `prompt`，没有任意 context 字段；拿到子 Agent 后 `child.inject()` 才可注入（§6）。

---

## 1. 上下文注入

### 1.1 两条独立通道：system prompt 与 runtime-context 快照

**[源码]** `SystemPrompt` 是 Cordis service（`core/system-prompt/src/index.ts:429`），两条注册 API：

- `section(section: PromptSection)`：`{name, order, text: string | ((ctx: AssembleContext) => string), interpolate?, complete?}`。`complete: true` 表示「本 section 独占整个系统提示」，其他 section 全部抑制（`:53-77`、`:620-687`）。系统提示以 `system/message` 事件落盘。
- `context(context: PromptContext)`：`{name, order, text, required?}`，"Dynamic model context materialized as a durable user-role snapshot"（`:79-91`）。`order` 决定拼接顺序，`required: true` 在 `suppressRuntimeContext` 时仍保留。

**[源码]** agent loop 每步：`preStep` 调 `systemPrompt.assemble(assembleContextFor(this, signal))`（`agent-loop/src/agent.ts:267-283`）；`step` 内每次请求 admission 再 `refreshContext(assembly, ...)`（`:411`），重新求值 context providers（sections/tools/variables 不重跑，`:582` 文档）。随后把 `context` 与 claimed messages 落盘为 `user/message`（`:430,434,439`）。

**[源码]** 去重/恢复：`RuntimeContextProjection` 记住最近一条存活快照；值相同不追加；空值发一条 `Current runtime context: none...` 清除提示；被 surface replace 覆盖时 `retained=null`，下一步重新追加（`agent-loop/src/runtime-context.ts:19-20,114-163`）。这就是「会话中途刷新」的真实机制：**不是改历史，而是追加新快照**。

### 1.2 全局注册与作用域

- **[源码]** `SystemPrompt` 内部用 `ScopedLayers`：global 层 + 每 agent 的 scope 链；scoped section/context 同名**遮蔽** global（`:395-427`、`:620-640`）。插件在 `apply(ctx)` 顶层调用 = global（对所有 agent 生效，含 subagent）；在 preset 子插件或 `agent.ctx` 调用 = 单 agent。
- **[源码]** `suppressRuntimeContext()` 可按 scope 关掉可选上下文（`:505-515`），persona 的 `includeRuntimeContext:false` 即用此（`preset/persona/src/index.ts:74`）。
- **[源码]** 事件 `system-prompt/assemble` 是 waterfall，listener 收到 mutable `PromptAssembly {sections,contexts,tools,variables}` 与 `AssembleContext`；返回值为准；但仍会被 `complete` section 规则收尾（`:18-38`、`:687`）。**这是插件实现「每步项目简报」最省事的位置**（不用自己管去重，因为 runtime-context 通道会去重）。
- **[推断]** waterfall 里的临时 context 不进入 `refreshContext` 的 provider 表，因此「step 内重试/admission 刷新」不会重算它们的文本（`:582-600` 注释：waterfall-only contexts retain accepted values）。

### 1.3 preset 的注入能力

**[源码]** preset 不是 prompt 容器：`PresetDefinition` 只有 `{id,name,description,order,plugins[]}`，是一组 child Cordis 插件行（`preset/agent-preset-registry/src/definition.ts:5-11`、`preset/agent-preset/src/index.ts:27-29`）。注入必须由被挂载的插件完成：

- `persona`：把 `prefix/suffix` 注册为 `deployment:persona-prefix/suffix` section，可 `complete:true` 独占系统提示（`preset/persona/src/index.ts:30-75`）。
- `agent-instructions`：AGENTS.md 注入（§4.1）。
- `time-context`：每步时间上下文（§1.4 参考实现）。
- 自研插件：任一 preset 插件行都可在 apply 里 `systemPrompt.section/context`，因为挂载点带 agent scope（`preset/agent-preset-registry/src/mount.ts:20-35` 的 PresetMount/ScopeKey）。

**[实测/本机]** 运行中的 `ptc` preset 实际声明：persona / agent-instructions(maxBytes 65536) / time-context / 工具组 / compaction isolate 组 / delegation 组（`bundle/web-app/presets/ptc.patch.yml:10-110`）。preset 选择会落 `agent-preset/selected` 事件并可切换（`preset/agent-preset-registry/src/types.ts:60-70`）；会话开始对话后 composition 锁定（`agent-preset/locked`，同文件 `:45-47`）。

### 1.4 参考实现：time-context（最接近「项目简报」的范式）

**[源码]** `context/time-context/src/index.ts`：

1. 注册 `sessionProjections` 定义 `timeContext`：从会话日志纯函数 fold 出 `{lastMessageTime,lastInjectionTime,lastTurnInjectionTime}`（`:166-199`）。
2. `agent/pre-step`（`{prepend:true}`）读 projection 状态：距上次注入 < `refreshIntervalMs`（默认 600000ms=10min）就跳过（`:184-208`）。
3. 注入一条 `user/message`，source `{kind:'time-context', form:'snapshot', sections:[...]}`（`:218-225`）。
4. 冷恢复时 projection 从日志重算，不依赖内存（projection `init/apply` 定义）。

**结论**：可复制的四件套 = **projection 状态 + pre-step 去重/节流 + source 标记的 user message + 从日志可重建**。项目简报可按同样形状做，只是内容来自文件/工作区而不是时钟。

### 1.5 token/字节预算控制（现状：没有统一预算）

**[源码]** 没有任何 prompt-context token 预算；实际预算分散：

| 预算 | 值 | 位置 |
|---|---|---|
| AGENTS.md 总注入字节 | 65536（base/preset 均配置） | `bundle/base/cordis.patch.yml:303-305`、`web-app/presets/ptc.patch.yml:15-18`；渲染截断+标记 `context/agent-instructions/src/render.ts:25-35,292-301` |
| 单个指令文件读取上限 | 1,048,576 bytes（默认） | `context/agent-instructions/src/config.ts:14,40` |
| 工具结果落模型前裁剪 | thresholdChars 8192 / head 4096 / tail 1024 | `bundle/base/cordis.patch.yml:426-431`；`compaction/compaction-tool-result-pruner/src/index.ts:21-80` |
| 大结果 spill | maxInlineTokens 12500 | `bundle/base/cordis.patch.yml:410-412`（spill-policy） |
| 整窗压力 | 0.8 × contextWindow（且 ≤ window-reserved-headroom） | `compaction/compaction-basic/src/config.ts:18-22,60-70,164-190` |
| 压缩保留近端原文 | 0.16 × messageBudget（默认） | 同上 `:23`、`:164-190` |
| 工具 schema 延迟加载 | `deferLoading`（ToolSchema） | `core/system-prompt/src/index.ts:113-121,596-610` |

**[推断]** 读水位：`ctx.tokenMeter.measure(session, requestHeader?)` 返回 `TokenMeasurement`（`llm/token-meter/src/index.ts:146`、`types.ts:22`），base 组合已挂 `token-meter`（`bundle/base/cordis.patch.yml:348-351`）；插件可 `inject:['tokenMeter']` 估算当前 surface 压力，在压缩前主动固化记忆。

### 1.6 会话中途刷新：可行，但有三种不同语义

| 语义 | 可行 | 机制 |
|---|---|---|
| 值变了 → 追加新快照 | ✅ | systemPrompt.context + RuntimeContextProjection 去重（§1.1） |
| 文件变了 → 注入增量规则 | ✅ | agent-instructions：tools/result 追踪 read/write/edit 触碰路径，step/end 后排队，pre-step 用 `compose` 重建 baseline/增量（`context/agent-instructions/src/index.ts:300-379`） |
| 改已写下的历史 | ❌ | 只能 surface `replace`（compaction 等），插件无通用 API；见 §0.2 |

---

## 2. 压缩 compaction

### 2.1 触发条件

**[源码]** 三个入口（`compaction/compaction/src/index.ts:31-32,136-192`；`compaction-basic/src/index.ts:158-215`）：

1. **pressure**：`agent/pre-step` 里 `compactIfNeeded(agent,'pressure',signal)`；
2. **context-overflow**：`agent/request-error` 里收到 provider 上下文溢出后 `compactIfNeeded(agent,'context-overflow',signal)`；
3. **手动** `/compact`：`compactNow(agent,signal,sourceCommandId)`（`compaction/command-compact/src/index.ts`；agent idle 时 `runMaintenance`）。

**[源码]** 触发阈值（`compaction-basic/src/config.ts`）：`thresholdRatio=0.8`（`:19`）、`headroomTokens=65536`（`:20`）、`retainRatio=0.16`（`:23`）、`auto=true`、`compactionRetries=1`、`maxOverflowRetries=1`（`:55-60`）；实际 `thresholdTokens = min(window*ratio, window - reservedCompletion - headroom)`、`retainTokens = messageBudget*retainRatio`（`:164-190`）。context-overflow 触发还可能「即使低于阈值也做一次有用缩减」。压力预算不足时**加载即报错**（TargetPressureConfigError，`:92-150`）。

### 2.2 算法与「保什么、丢什么」

**[源码]** `compaction-basic/src/region.ts:117-155` `selectCompactableRange`：

- 起点 = surface 第 1 个非 system 节点（`system/message` 永远是节点 0，**永不参与压缩**）；
- 从尾部向前累积 token，保留最近 ≥ `retainTokens` 的原文尾巴；
- 前边界回退到 tool-call/result 成对处（`toolPairingBalancedBefore`，`compaction/compaction/src/tool-pairing.ts`），**绝不切断工具对**；
- 无法选出「起点 < 保留起点」的安全范围则返回 null。

**[源码]** 摘要：`summarizer.ts:32-67` 固定 8 段 Markdown 结构（Primary Request / Key Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context），规则要求保留精确路径、命令、错误串、标识符、用户纠正。做法是把**当前请求前缀（system+工具+被压缩消息）原样重放**，末尾追加压缩指令作为最后一条 user 消息，以复用 provider KV cache（`:25-31`）。压缩后要求摘要比原文小，否则失败（`region.ts:73-87`）。

**[源码]** 事务（`compaction/compaction/src/types.ts:17-90`；`region.ts:158-278`）：`compaction/start`（durable 锁）→ `compaction/summary`（含 summary、shadowedRange/shadowedSeqs/token 数、provider/model/usage/rawOutput）→ 紧随一条 surface `user/message`（source `kind:'compact-checkpoint'`，`compaction/src/checkpoint.ts:19-42`）→ `compaction/end`。失败也写 `compaction/end{error}`；未配对的 start 是可检测的未完成事务（`region.ts:302-330`）。`compaction/prune` 是免模型裁剪的 shadow-price 事件（`types.ts:82-89`）。

- **保**：system prompt 头部；最近 ~16% token 尾巴原文；所有被 shadow 的原始日志行（JSONL 不删，只换 surface）；摘要 + 用户纠正类信息的摘要版。
- **丢**：被压缩区间内的逐字工具结果/中间推理（若超过 pruner 阈值，工具结果在压缩前就已被 head/tail 裁剪）；压缩边界外的注入消息不受影响（`region.ts:443-460` 只要求选中区间稳定）。
- **[推断]** 注入的项目简报若落在被压缩区间，逐字版丢失，只剩摘要中的转述；但如果插件像 runtime-context/agent-instructions 那样做 surface 自检，会被重新注入（§2.6）。

### 2.3 压缩后恢复与摘要存哪

**[源码]** 摘要双写：`compaction/summary.data.summary`（log-only 事件）+ 紧随的 surface user message（`compact-checkpoint` source）。冷恢复：`foldSurface` 重放日志得 surface，摘要作为 user 消息进入历史（`core/session/src/surface.ts:594`；`session-format-catalog` 的消息投影参与）。摘要 preamble 明确「Treat the captured context as established background... without acknowledging this checkpoint」（`summarizer.ts:69-71`）。

**[源码]** 压缩与 usage 计量：`token-meter` 消费 `compaction/summary|prune` 的 shadow price 来保持 surface 计价一致（`compaction/src/types.ts:25-33,73-81` 注释）。

### 2.4 插件可观察/可干预的边界

- **可观察**：`ctx.on('session/event', (session,event)=>... )` 能看到 `compaction/start|summary|end|prune`（`session/event` 的 listener 名单里已有 compaction-basic/token-meter 先例，见 `docs/event-producer-consumer.md`；事件声明 `compaction/src/types.ts:24-89`）。但 `start` 是**锁已落盘**之后，此时摘要调用已开始准备，无法否决。
- **可参与失败恢复**：`compaction/summary-error` waterfall（payload `{session,sourceEventSeqs,error,signal}`，返回 true 表示已做 durable 修改可重试），`compaction/src/index.ts:92-107`；目前唯一 listener 是 image-offload。
- **可替换实现**：`ctx.compaction` 是抽象 `CompactionEngine`（`compaction/src/index.ts:119`），可自行实现后端；但 preset 内是 `isolate: {compaction:true}` 组（`web-app/presets/ptc.patch.yml:66-82`），替换只影响该挂载域。
- **不可做**：无 pre-compaction 事件/审批；无法阻止一次已决定执行的压缩；没有「压缩前给我 N ms 保存记忆」的钩子。要防遗忘只能**在更早的 pre-step 主动检测水位**（tokenMeter）并落盘（§7）。

### 2.5 对「任务进行中遗忘」的实际影响

1. 摘要由模型生成、非确定性；结构里虽有 Pending Jobs/Current Work/Next Step，但**不能当精确记忆**用（`summarizer.ts:32-67`）。
2. 最近 16% 尾巴原文保留，通常覆盖「当前正在改的文件/刚跑的命令」；但阈值下的工作细节仍会丢。
3. 工具结果先被 pruner 裁剪（8192 chars 以上只留头 4096+尾 1024），再参与压缩；**长命令输出/长 diff 的中间段在压缩前后都不可靠**。
4. 压缩只改 surface，不改 JSONL：**原始内容仍可被 `session-query` 读回并标记 shadowed**（§3.4），所以「压缩后检索找回」是可行的，但需要检索能力开启（默认关，§0.2-5）。

### 2.6 压缩后「已注入上下文」如何自愈（关键设计事实）

- **[源码]** runtime-context：`RuntimeContextProjection` 监听 `session/event`，若替换事件的 `sourceEventSeqs` 包含自己记录的 seq 就把 `retained` 置 null（`agent-loop/src/runtime-context.ts:134-143`）→ 下一次 step 重新追加快照。
- **[源码]** agent-instructions：`visibleBaselineSource` 从**当前 surface** 反向找 baseline 消息；被压缩掉就重新加载并注入（`context/agent-instructions/src/index.ts:48-64,86-260`）。
- **[推断]** 自研记忆插件若只往 inbox/历史里塞消息而**不检查 surface**，压缩后不会自动回来；必须自带「surface 扫描 + 缺失重建」。

---

## 3. 会话持久化与检索

### 3.1 落盘布局（源码 + 本机实测一致）

**[源码]** `session/session-persistence-jsonl/src/format.ts`：

- 根：`dshHomePath('sessions')` = `~/.dsh/sessions`（`bundle/base/cordis.patch.yml:138-140`；`util/home-paths/src/index.ts:70-72` `defaultDshHome`/`DSH_HOME_DIR_NAME='.dsh'`）。
- 项目目录：`projectKey(cwd)`，把路径分隔符与冒号换成 `-`，非安全字符 `~XXXX`，形如 `--C-Users-oldap-Documents-dsh-porject-bench--`（`format.ts:225-245`）。
- 会话目录：`<root>/<projectKey>/<encodeSegment(sessionId)>/`（`:267-269`）。
- 文件名：`session.vN.jsonl[.zstd]`，v0 为 `session.jsonl`；当前 `N=4`（`:42-59`、`session-format/src/filename.ts:5-16`、`core/session/src/types.ts:90` `SESSION_FORMAT_VERSION=4`）。
- 一行一个 JSON：首行 header（`type:'session', version, id, createdAt, cwd?, parentSession?, isSeeded, delegationDepth, origin?, agentPreset?`，`format.ts:83-97`），其后每个事件一行；尾部半行视为 torn tail 忽略并在下次写前截断（`format.ts:326-537` `SessionLogScanner`）。
- 压缩可选 zstd；单写者租约；写后 flush 才是 durability barrier（`session/session-persistence/src/index.ts:120-170`）。

**[实测]** 本机 `~/.dsh/sessions/--C-Users-oldap-Documents-dsh-porject-bench--/<id>/session.v4.jsonl.zstd`，解压后确实是「1 行 header + N 行 `{type,seq,time,data}`」；今天（2026-11-11）仍在写 **v4**。

### 3.2 事件模型与扩展边界

- **[源码]** `SessionEvent` envelope：`type, seq, time, data, ignorable?, surfaceOp?, sourceEventSeqs?`；surface 事件仅 5 类 `system/message, developer/message, user/message, assistant/message, tool/result`，其余 log-only（`core/session/src/types.ts:435-520`）。
- **[源码]** `surfaceOp`：`'append'` 或 `{op:'replace',startSeq,endSeq}`（替换必须覆盖全部被 shadow 节点，`types.ts:452-478`；`core/session/src/surface.ts:404` 校验）。
- **[源码]** 可接受的事件类型集合是生成物 `KNOWN_SESSION_EVENT_TYPES`（`known-event-types.ts:22-85`，含 `compaction/*`、`team/task`、`hook/*` 等）。未知且必需的 type 会让读路径拒绝重建；唯一兼容机制是 `ignorable: true`（`known-event-types.ts:8-21`）。
- **[源码]** 出仓插件的合规自定义日志：`appendPluginRecord(session,'plugin:<ns>/<name>',data)`（`core/session/src/index.ts:466-497`），总是 `ignorable:true`、log-only、语法受校验（`:435-463`）；读回 `pluginRecordOf(event)`（`:508-512`）。目录文档明确其**实验性**、不进已知事件集/持久化 schema 指纹，迁移 best-effort（`docs/experimental-persistence-catalog.md:8-10`，当前仅 translator 两例）。

### 3.3 恢复 / 分叉 / 清空

- **[源码]** `SessionStartSource = 'startup'|'resume'|'clear'|'compact'`（`core/agent/src/runtime-types.ts:125`）。
- **[源码]** 冷恢复：`SessionPersistence.open(id,'read'|'write')`（`session/session-persistence/src/index.ts:150-170`）→ `SessionQueryEngine.observeSession` → `ctx.agents.resume({resumeSessionId,...})`（`api/session-controller/src/agent.ts:410-445`）。恢复时按 header 的 `agentPreset` 重组合同一 composition（`:432-440`）。
- **[源码]** 分叉：`SessionStore.fork(source,boundary,childId)`（`core/session/src/index.ts:1380`）→ `buildForkSeed` 复制前 boundary 个事件，追加 `session/end-seed{inherited:true}`，再补齐未闭合 turn 的合成收尾（`core/session/src/fork.ts:21-29`）；子 header `parentSession` + `isSeeded=true`（`format.ts:113-133`）。
- **[源码]** cwd 绑定：`SessionHeader.cwd` 不可变；create/resume 时 cwd 不一致直接拒绝（`ApiSessionCwdConflict`，`api/session-controller/src/agent.ts:470-500`）。项目分组按 cwd 派生路径（§3.1），所以「工作区 ↔ 会话」是**物理目录 + header 双重绑定**。

### 3.4 session-query / SQLite FTS5 能力

- **[源码]** `ctx.sessionQuery`（`session/session-query/src/index.ts:98`，`SessionQueryEngine extends Service`，`inject:['sessions']`）。能力：`observeSession`、`searchSessions/searchEvents`（需后端）、`readSession/listEvents/readSurface/filterSessions/filterEvents/readTitle/traceSession/traceEvent/readEvent`（`:130-400`）。
- **[源码]** 后端 `session-query-sqlite`：`openAt: 'startup'|'first-search'|'never'`（`session-query-sqlite/src/index.ts:88-119`）；SQLite FTS5 虚拟表 `persisted_docs`（`unicode61`）+ `session_id/seq/type/time/surface/codepoint_length` 元数据（`schema.ts:103-168`）；`SCHEMA_VERSION=8`、`application_id=0x44534851`，版本不符**直接 drop 重建**（派生索引，可随时重建，`:7-13,96-101`）；`:memory:` 支持。
- **[源码]** 失效令牌：`revision` 来自文件 stat 指纹（`session-persistence-jsonl/src/index.ts:1124-1131` `fileRevision`），不是内容 hash；live corpus 优先（`session-query/src/corpus.ts:35,100-110`）。surface 分类 `current/shadowed/log-only`（`documents.ts:72-90`），所以**被压缩的历史可检索但标注 shadowed**。
- **[源码]** base 组合默认 `path:':memory:'` + `openAt:never`（`bundle/base/cordis.patch.yml:157-163`），精确读/trace 仍可用，`searchSessions/searchEvents` 会报 `SESSION_QUERY_SEARCH_DISABLED`。**桌面 profile 未覆盖**（本机 `~/.dsh/profiles/desktop/cordis.patch.yml` 无该行）→ 默认运行态没有内容检索。
- **[源码]** 插件可 `inject:['sessionQuery']` 使用；但**不能**指望默认有 FTS。若记忆设计要检索，需自建索引（storage domain 或自研 sqlite）或改 profile 配置。

---

## 4. 技能 / 规则记忆

### 4.1 AGENTS.md / CLAUDE.md

- **[源码]** 候选名：`AGENTS.md`、`CLAUDE.md`（base）+`AGENTS.local.md`、`CLAUDE.local.md`（local overlay，后加载）（`context/agent-instructions/src/config.ts:11-14,37-43`）。
- **[源码]** 发现顺序：用户全局两处 → `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md`（`files.ts:82-105` `userGlobalRoots`；`render.ts:96-122` 常量）→ 项目根（向上找 `.git` marker，默认）→ 从根到 cwd 的祖先链逐目录读 base+local（`files.ts:323-377`）。同一候选组内**trim 内容去重**（保留最早，`render.ts:430-455`），单文件读取上限 1MB，总渲染预算 `maxBytes`（base/preset 均 65536），超预算截断并留标记（`render.ts:292-345`）。
- **[源码]** 注入：以 **user 消息**（source `kind:'agent-instructions'`, `form:'instructions'`, `baseline:true`, `baselineIdentity`, `changes[{action,scope,path,digest}]`）注入；首个 pre-step 建 baseline，之后按 scope 增量更新（`index.ts:86-260`）。文件变更感知：`tools/result` 里对 `read/write/edit` 的 `file_path` 记录 touch，`step/end` 后排队，下一 pre-step 用 `reconcileInstructionContext` 重算（`index.ts:300-379`、`files.ts:276-291` `descendantDirsBetween`）。
- **[源码]** 跨重启：不靠额外状态文件，从 **surface 里的 agent-instructions 消息**恢复（含每个 scope 的 digest）；provider version 缓存是 per-session `WeakMap`（`index.ts:88`、`state.ts:140-190`），冷恢复后靠 digest 比对重读。
- **[推断]** 因此 AGENTS.md 型规则天然具备「压缩后自愈」和「多会话共享同一份文件」两条好性质，可作为项目简报的**低频骨架层**。

### 4.2 skill 包

- **[源码]** `ctx.skills` = `SkillRegistry`（`skill/skill/src/index.ts:356`），provider 注册表 + scoped layers；`skills/change` 事件（`:288-297`）；`SkillDefinition` 含 `content`、`resourceBase`（目录/URL/opaque，`tool-skill` 返回给调用方，`:147-190`）。
- **[源码]** 文件系统根（`skill/skill-filesystem/src/index.ts:245-265`，rank 决定优先级）：项目 `.dsh/skills`(100) → `.agents/skills`(200) → `customSkillDirs`(300) → 用户 `~/.dsh/skills`(400) → `~/.agents/skills`(500) → bundled；支持目录包与平面 Markdown，YAML frontmatter（name/description/whenToUse/invocation 等）。
- **[源码]** 动态更新：`watch:true` 默认，chokidar 监听根目录（`:40-100,300-420`），变化触发 catalog 失效 → `skills/change`。
- **[源码]** 注入方式：① **技能目录摘要**以 user 消息注入，内容用 digest 去重、只在变化时替换/追加（`tool-skill/src/index.ts:215-265`）——即「技能一直在上下文里，正文不在」；② 正文按需：`skill` 工具调用（`:147-190`），或用户消息首行 `/<name>` 触发的 deterministic 注入（`disable-model-invocation` 技能唯一入口，`:179-215`）。
- **[源码]** 作用域：全局（用户目录）、项目（项目根）、custom、bundled、以及 per-agent scope（preset 内挂 provider 只对该 agent 可见）。**没有「会话内临时规则」**：会话级只能通过注入内容实现。

### 4.3 与「程序性记忆」的映射

| 记忆类型 | DSH 现成载体 | 刷新 | 恢复 |
|---|---|---|---|
| 声明性约束（项目事实/规范） | AGENTS.md / CLAUDE.md（含 local overlay） | 文件 touch 后重读 | surface 消息重建 |
| 程序性知识（怎么做某类任务） | skill 包（`SKILL.md` + `resourceBase` 资源） | catalog watch + `skills/change` | 按需加载，无会话内状态 |
| 情景记忆（发生了什么） | 会话 JSONL + compaction summary | 每事件追加 | foldSurface + session-query |
| 运行态提示（时间/水位/工作区） | runtime-context / time-context / working-directory | 每步求值、变化追加 | projection 从日志重算 |

---

## 5. 插件 Host API 能力边界

### 5.1 插件形态与装配

- **[源码]** Cordis 插件：default export `apply(ctx, config)` 或 `Service` 子类；`inject` 声明依赖；`ctx.effect` 管理生命周期（`docs/cordis-api/service.md`、`inherited.md`）。service 注册即 `super(ctx,'<name>')`（`vendor/cordis/src/service.ts:11-30`）。
- **[源码]** 部署装配 = profile `package.json#dsh.profile.bundles` + `cordis.patch.yml` 覆盖/插入（本机 `~/.dsh/profiles/desktop/`）；HMR 可热重载配置。插件在 Host 进程内运行，**在 workspace 沙箱之外**（`boot/plugin-manager/README.md`）。
- **[源码]** 作用域/隔离：`ctx.extend/isolate/intercept`（`docs/cordis-api/inherited.md:16`）；preset 与 compaction 用 `isolate` 组（`web-app/presets/ptc.patch.yml:45-49,66-71`）。

### 5.2 可用 API（按用途）

| 用途 | API / service | 关键证据 |
|---|---|---|
| 注册工具 | `ctx.tools.register(definition)`（schema/execute/render/present） | `skill/tool-skill/src/index.ts:125-170`；`core/tools/src/index.ts` |
| 自定义 service | `class X extends Service { constructor(ctx){super(ctx,'x')} }` + `inject` | `docs/cordis-api/service.md`；`llm/token-meter/src/index.ts:101-111` |
| 会话投影 | `ctx.sessionProjections.register({key,stateSchema,init,apply,wire?,stateVersion})`（纯同步 fold，state 必须 plain JSON） | `session/session-projection/src/index.ts:48-99,233-260`；读取 `stateOf/snapshot` `:320,339` |
| 持久 KV 域 | `defineDomain`（zod 记录 schema）+ `ctx.storageDomain.open(...)`，`table.get/entries/put/delete/update`、`global.get/set`；写先落盘再改内存再发 `domain/changed` | `storage/storage-domain/src/index.ts:84-220`；`domain.ts:19-130,281-340`；事件 `events.ts:46` |
| 事件钩子 | `ctx.on(name,fn)`，模式 `emit/serial/waterfall/parallel/bail`；scoped dispatch 用 `scopeTarget` | `docs/cordis-api/inherited.md:14`；`core/agent/src/dispatch.ts:54-148` |
| 定时器 | `ctx.timeout/interval/throttle/debounce`（随 fiber 自动 dispose） | `vendor/timer/src/index.ts:4-16` |
| 提示注入 | `systemPrompt.section/context/tools/variable/suppressRuntimeContext`；`system-prompt/assemble` waterfall | §1 |
| 给 agent 发消息 | `agent.send(msg,target,wakeup)`/`followup`/`steer`/`inject`；`runMaintenance`；`inbox` | `core/agent/src/runtime-types.ts:180-241` |
| 会话耐久写 | `session.append(type,data,surfaceIntent?)`、`appendPluginRecord`、`ctx.sessions.flush(session)` | `core/session/src/index.ts:492-512,798-846` |
| 命令/技能/调度 | `ctx.commands.register`；skill provider 注册；`ctx.schedule` | `interaction/commands`、`skill/skill/src:356`、`schedule/schedule/src/index.ts` |
| 会话查询 | `ctx.sessionQuery`（精确读/trace 总可用；全文检索取决于后端配置） | §3.4 |

### 5.3 明确不能做

1. **不能改已接受请求的消息**（`agent/request` 文档原文：cannot mutate messages；必须走 logged channels，`core/agent/src/runtime-types.ts:321-337`）。
2. **不能定义新会话事件类型**（出仓）：`KNOWN_SESSION_EVENT_TYPES` 是生成集合，未知 type 未标 `ignorable` 时读路径拒绝重建会话；`plugin:` 记录是唯一合规路径但**实验性**、迁移 best-effort（§3.2）。[推断] 强行 append 未知事件会让会话在下次冷加载时被判不可重建。
3. **不能拦截压缩开始**；只能在 `session/event` 观察、在 `compaction/summary-error` 补救（§2.4）。
4. **不能跨进程写会话**（单写者租约）；跨会话/跨进程只能走 team/remote API。
5. **storage domain 无 CAS、无跨域事务、无任意查询**：只有 KV 键值 + 每域写链；并发控制要在记录里带 revision 自己实现（team task board 即如此：README「Task updates keep the domain's owner and revision checks」）。
6. **没有统一 prompt token 预算/裁剪 API**；预算由各消费方（agent-instructions、pruner、spill、compaction）各管一段（§1.5）。
7. **client/UI 侧**需要单独的 client 插件 bundle 与 wire 投影（`SessionProjectionMap` + `wire`），Host 插件不能直接画 UI（`session/session-projection/src/index.ts:71-99`）。[待验证] 是否有官方 host-route 注入 API（`webserver/index-inject` 存在但未见公开注册 API 文档）。
8. **实验性包（agent-team / plugin records / hooks-*）不保证 API 稳定**，0.2.1→0.2.2 可能变（§8）。

---

## 6. 多 agent / 团队记忆

### 6.1 会话隔离与血缘

- **[源码]** 每个 agent 一个 Session，id 即 agent id（不一致会抛错，`core/agent/src/index.ts:517-525`）。子会话 header：`parentSession`、`origin:'subagent'`、`delegationDepth`、`agentPreset`（`format.ts:83-97`；`subagent/subagent/src/child-agent.ts:119-150`）。
- **[源码]** 两种上下文继承：
  - `spawn`：全新子 session，`inheritsParentContext=false`，只继承 route/agentOptions 与 preset composition（`subagent/subagent-spawn-in-process/src/index.ts:38-56`；`child-agent.ts:61-131`）。
  - `fork`：child 以父会话「最后一个 `turn/end` 之前的完整前缀」为 seed（`subagent-fork-in-process/src/index.ts:46-78`），`inheritsParentContext=true`；seed 在创建时**一次性快照**进子日志，之后冷恢复重放 seed 而不是重新 fork（`:72-77`）。
- **[源码]** subagent 会话不能当顶层会话 resume：session-controller 的 `resume` 对「有 subagent owner 的 session」抛 `ApiSessionSubagentOwnership`（`api/session-controller/src/agent.ts:410-445`）。
- **[实测]** 本会话（teammate 子会话）解压 header：`origin:'subagent', parentSession:'session-9126...', isSeeded:false, delegationDepth:1, agentPreset:'ptc'`；705 行事件、仅 1 条 `system/message`。

### 6.2 teammate（Agent Teams）与任务板持久化

- **[源码]** `dsh-experimental-agent-team`：TeamId 取 Lead 的 SessionId；**没有创建事件**，durable Team 状态从第一条成员/任务记录开始（`experimental/agent-team/README.md:126`）。每人一个独立 Session（与 subagent 相同 lineage 机制）。
- **[源码]** 任务板/roster 持久化在 **Lead 的会话日志里**：`team/member`、`team/task`、`team/message/queued|delivered` 事件（log-only）；写入经 `TeamJournal.transact`（按 Lead sessionId 串行）+ `appendAndFlush`（append → `ctx.sessions.flush` → 通知）（`experimental/agent-team/src/journal.ts:9-88`）；投影 `agentTeam` 从日志 fold（`projection.ts:105-120`）。
- **[实测]** 本机当前 Lead 会话日志里 `team/task`×7、`team/member`×6，证明就在会话 JSONL 中，而非独立 DB。
- **[源码]** 冷启动/恢复：teammate 消息投递可冷恢复已存会话；provisioning 记录恢复时与子会话独立持久化状态对账（匹配 parent+continuable+初始 user 消息 → active，否则 failed）；名字首次 provisioning 永久保留（`agent-team/README.md:126`）。
- **[源码]** 消息投递：Lead 用 `Agent.steer()`，teammate 走 continuation owner 的 host-only Steer（授权 Lead→child 边 + 冷恢复），消息追加在目标会话可复用历史前缀之后（README:132,192）。

### 6.3 插件给子会话注入记忆的可行路径

1. **[源码]** `ctx.on('agent/created', ...)`（serial，创建完成前）→ 用 `agent.inject(createUserMessage(...))` 注入模型可见上下文；hooks 的 `SessionStart`/`SubagentStart` 就这样干（`experimental/hooks-claude-code/src/index.ts:209-230,288-296`；`agent.inject` 定义 `core/agent/src/runtime-types.ts:233-241`）。
2. **[源码]** 全局 `systemPrompt.context` 注册对**所有 agent**生效（scope 链 global→agent）；per-agent 需在 `agent.ctx` 或 preset 子插件里注册。
3. **[源码]** `subagent/start` / `subagent/end` 事件（`subagent/subagent/src/index.ts:158-166`）可观察子 agent 生命周期。
4. **[源码]** teammate spawn 请求 **没有**任意 context/metadata 字段：`SpawnTeammateRequest = {name, description, prompt: ContentBlock[], context:'fresh'|'fork', provider, signal}`（`experimental/agent-team/src/types.ts:156-163`）。公开创建/列表结果只给 `target` 名，不给 sessionId（`tool-agent-team/README.md:64`）。
5. **[推断/待验证]** 插件要把 target 名映射到真实 sessionId，需要自己从 `team/member` 记录或 `agent/created` 关联；没有公开 API 保证。

### 6.4 inactive 恢复时「记得什么」

- **[源码]** `inactive` = 没有 turn 在执行，可能是已加载也可能是已存盘（README:62）；被唤醒时从自己的会话日志恢复（消息、inbox splice、team mailbox 事件都在日志里）。
- **[源码]** inbox 本身 durable：`agent/inbox/spliced` 事件 + projection 重建 pending 输入（`core/agent-loop/src/inbox.ts:20-65`）。
- **[推断]** 插件内存状态（Map/WeakMap/定时器）在 inactive（进程内仍存活）保留、重启后丢失；**任何跨重启要记住的东西必须落 session log / storage domain**。

---

## 7. 对我们记忆设计的硬约束

1. **注入即历史**：项目简报进入模型上下文的每条内容都会变成 durable user message（§1.1），必须能定义「版本/来源/digest」，否则压缩与检索都会把它当普通聊天。建议照 `source.kind` + `form:'snapshot'` + `sections` 的模式（`agent-loop/src/runtime-context.ts:156-162`）。
2. **用「projection + pre-step 去重」而不是每步重灌**：参考 time-context（§1.4）。否则每步新增消息会毁掉 provider 前缀缓存并加速压缩。
3. **注入内容必须可重建**：冷恢复后从 session 日志 fold 出状态（`sessionProjections.register`），不要在插件内存里放唯一副本。
4. **压缩会重写 surface，注入要自愈**：仿 runtime-context（监听 replacement、清 retained）与 agent-instructions（surface 自检重注入），否则压缩后「任务中记忆」静默消失（§2.6）。
5. **关键不变量不能只活在 user 消息里**：`system/message` 头部不参与压缩（§2.2），或放 storage domain / 外部文件 + 每步少量重述。摘要不可作精确约束。
6. **水位要主动检测**：没有压缩前钩子（§2.4），要在 pre-step 用 tokenMeter 估算，到阈值前主动「固化 checkpoint」到 domain/文件，并让下一会话可读。
7. **检索能力默认是关的**：默认 base 组合 `openAt:never`（§3.4），工作台插件要自带索引（storage domain 或自研 SQLite），且索引必须**可重建**（版本/schema/内容 hash 失效），不能当唯一真相。
8. **写前闸门**：`tools/pre-execute` deny+reason 是唯一「模型可读拒绝」的官方入口（`core/tools/src/index.ts:608-612`）；需要覆盖 PTC 内部调用时还要看 `tools/ptc-dispatch-log`（`core/tools/src/index.ts:191`）。[推断] 该 waterfall 对 PTC 子调用是否触发未验证。
9. **多 agent 记忆按 sessionId 命名空间**：teammate/subagent 各自有会话；spawn 无任意注入字段，只能在 `agent/created`/`subagent/start` 后 `inject`；不要把「agent 对象」当记忆 key（重启后对象消失）。
10. **插件状态落盘有两条合规路径**：storage domain（结构化、可更新、有变更事件）或 `plugin:` 记录（追加、可回放、实验性）。任务板式并发用「记录内 revision + update()」，不要假设 CAS。
11. **实验 API 风险**：agent-team / plugin records / hooks 都在 experimental 包；0.2.1-rc.2 ↔ 0.2.2-rc.1 之间可能变（§8），工作台插件应做能力探测（`ctx.get('service')`）与优雅降级。

---

## 8. 版本差异与待验证

### 8.1 版本证据与风险

- **[源码]** checkout 根 `package.json:3` = `0.2.1-rc.2`；本清单全部行号以该 checkout 为准。
- **[实测]** 本机 `~/.dsh/profiles/desktop/package.json` 的依赖声明 `@deepseek-ai/dsh-experimental-plugin-market-bundle: 0.2.2-rc.1`、`@deepseek-ai/dsh-subagent-codex: 0.2.2-rc.1`；`~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 写 `"desktopVersion": "0.2.1-rc.2"`；安装目录 `app.asar` 内同时出现 `0.2.2-rc.1` 与 `0.2.1-rc.2` 字符串 → **本机是混合版本状态**，不能假设与 checkout 完全同构。
- **[实测]** 今天仍在写的会话文件是 `session.v4.jsonl.zstd`（`SESSION_FORMAT_VERSION=4` 与运行态一致）→ **格式目前兼容**；但 0.2.2 若升级格式，旧插件记录的迁移只保证 best-effort（`docs/experimental-persistence-catalog.md:8-10`）。

**风险点（按严重度）**：① 会话格式 v5 / 事件词汇变化 → 插件自己解析 JSONL 会坏，优先用 `ctx.sessionQuery`/`sessionProjections` 而非裸读；② `plugin:` 记录与 `storageDomain` 的 schema/迁移策略变化；③ agent-team 事件/API 变化（team/* 虽在 v4 已知集合，但 experimental 包语义可能变）；④ base 组合默认值变化（`openAt`、路径、压缩阈值）会改变「记忆可用性」假设；⑤ client 插件 wire 投影契约变化（UI 侧）。

### 8.2 待验证清单

1. 0.2.2-rc.1 中 `SystemPrompt.section/context/refreshContext`、`agent/pre-step`、`tools/pre-execute` 的签名/语义是否与 0.2.1-rc.2 一致（本机 asar 只能搜到字符串，未解包比对）。
2. 默认桌面 profile 是否真的没开 FTS（推测由 base patch 继承；可在 0.2.2 运行态调 `searchSessions` 看是否 `SESSION_QUERY_SEARCH_DISABLED`）。
3. `tools/pre-execute` 是否覆盖 PTC（`tool/ptc-dispatch`）内部工具调用。
4. 出仓插件能否实际使用 `appendPluginRecord`（需要 `PluginRecordMap` 声明合并；session-query 是否索引 plugin records 未见证据）。
5. `storageDomain` 在 0.2.2 的 sqlite 后端是否默认可用（base 组合只挂 `storage-json`，`backend:'json'`）。
6. teammate target 名 → sessionId 的公开映射是否存在（当前文档明确只说 target 名）。
7. Host 插件注册 Web 路由/面板的官方 API（`webserver/index-inject` 有事件，但未见公开注册契约）。
8. compact 的 `agent/pre-step` listener 顺序（compaction 与自研记忆插件谁先跑；依赖注册顺序，未见排序契约）。
9. `complete:true` section 与 runtime-context 的组合在多 agent/preset 下的实测行为（源码逻辑清楚，缺运行时样例）。
10. 本机 0.2.2-rc.1 是否有新增的 memory/context 相关包（checkout 的 `packages/context/*` 只覆盖 agent-instructions/time/harness-dev/file/session-reference/tmux）。

### 8.3 附：本次审计的实证快照（[实测]，只读）

- Lead 会话（330 行）：`team/task`×7、`team/member`×6、`subagent/catalog`×3、`todo/write`×1、`agent/inbox/spliced`×5；user/message 来源分布：`user`×1、`runtime-context`×1、`skill-catalog`×1、`time-context`×1、`agent-message`×1、`subagent-settled`×1。
- teammate 子会话（705 行）：`system/message` 仅 1 条、`user/message` 4 条、`tool/call` 69 条、`step/start` 69 条 → 印证「系统提示/动态上下文按变化才追加」。
- 磁盘：`~/.dsh/sessions/<projectKey>/<sessionId>/session.v4.jsonl.zstd`；`~/.dsh/storages/session_projcache/sessions/<sessionId>.json`（投影缓存，写回节流 200 事件/5s，`bundle/base/cordis.patch.yml:190-196`）；`~/.dsh/storages/<domain>.json`（storage domain）。
