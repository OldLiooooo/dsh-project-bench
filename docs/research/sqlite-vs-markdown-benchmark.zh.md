# SQLite / FTS5 与 Markdown 检索基准（1k 档，5k/20k 待补）

> 2026-11-11 · 研究（非设计提案）。
> 问题：中大型项目文档很多，用关系库 + 索引是不是比 Markdown 检索快很多？顺带回答「内容放 DB 与放文件的成本差异」。
> 环境：Windows，Node 内置 node:sqlite（SQLite 3.53.4），FTS5 + trigram 可用；ripgrep 15.2.0；grep (WinuxCmd) 1.2.1。
> 脚本：research/bench/（gen-corpus.mjs / build-db.mjs / queries.mjs / ext-bench.sh）；
> 原始结果：research/bench/results/（combined-1k.json / ext-1k.tsv）。

---

## 0. 结论（先看这五条）

1. **「DB 比 Markdown 快」成立，但快的是「结构化过滤 + 小载荷」**：1k 文档下 FTS5 查询 1–3ms，rg 用文件列表模式约 42ms、输出行模式约 100ms，grep 约 160ms；元数据过滤 + 时间线查询 DB 在 1ms 内，grep 需要 60–80ms 且做不了结构化过滤。
2. **查询延迟不是 agent 的主要成本，载荷才是**：DB 默认返回 20 行全文/片段是 5–10KB（1.5k–3k tokens）；rg 只返回文件名（0 载荷），但后续读文件要另付 token。**必须返回 snippet + 字段裁剪 + limit**，否则「快查」省下的时间会被 token 成本吃掉。
3. **中文必须用 trigram**：unicode61 对中文按整段 token 切，短语召回崩（会话保持 41/285、回滚 46/945）；trigram 与 LIKE 召回一致（285/285、945/945），但 **trigram 最小 3 字符**，两字词（回滚）匹配为 0，需 trigram + LIKE 混合兜底。
4. **体积可接受但要看索引选择**：1k 文档 3.1MB 正文；纯元数据库 1.06MB、全文库 4.79MB、unicode61 FTS 5.85MB、双 FTS 13.61MB、contentless 双 FTS 9.87MB；建库 23–215ms。按此线性估算 20k 文档约 100–280MB（双 FTS），需要控制索引字段或用 contentless。
5. **建议**：长文档正文仍以文件为编辑面，DB 存全文镜像 + 一个 trigram FTS（+ 两字词 LIKE 兜底）；短记忆单独一表/一 FTS；默认返回 **snippet + <5KB 载荷**。1k 已足够证明方向，5k/20k 需要补跑确认。

---

## 1. 方法

| 项 | 设置 |
|---|---|
| 语料 | 1,000 篇合成 Markdown，正文 3.14MB（3.1KB/篇），混合中英文 + 代码标识符/路径/错误码，带 module/role/stage/date/author 元数据与 change 事件 |
| 变更事件 | 2,640 条（时间线查询用） |
| DB 形态 | ① meta：只存元数据 + 全文列（LIKE）；② full：全文列；③ full_uni：+FTS5 unicode61；④ full_uni_tri：+双 FTS（uni + trigram）；⑤ idxonly_uni_tri：contentless 双 FTS（正文只留文件） |
| 查询集 | 英文关键词 20 条；中文短语 9 条；元数据+关键词 5 条；时间线查询（某周某模块）5 条 |
| 计时 | 每查询跑多轮；cold = 新进程/新连接首跑，warm = 同进程重复；报告 p50/p95（ms） |
| 对照 | ripgrep（文件列表模式 / 输出行模式）、grep -r；SQLite LIKE、FTS5 unicode61、FTS5 trigram、trigram+LIKE 混合 |

> 限制：这是**合成语料**，不是真实项目；只跑了 1k 档（5k/20k 脚本就绪，未完成）；Windows 文件系统与 rg/grep 版本会影响绝对值，**看相对差距与量级，不看小数点**。

---

## 2. 查询延迟（1k 文档，warm p50 / p95，ms）

| 查询类别 | SQLite LIKE | FTS5 unicode61 | FTS5 trigram | trigram+LIKE | ripgrep（文件列表） | grep（输出行） |
|---|---:|---:|---:|---:|---:|---:|
| 英文关键词（20） | 0.29 / 0.39 | 1.58 / 2.06 | 2.28 / 3.05 | **1.18 / 1.40** | 42 / 43 | 161 / 168 |
| 中文短语（9） | 0.45 / 0.70 | 0.85 / 1.46 | 1.30 / 2.08 | **1.00 / 1.23** | 42 / 43 | 158 / 185 |
| 元数据 + 关键词（5） | 0.19 / 0.34 | 1.01 / 1.52 | 1.52 / 2.23 | — | 67 / 73 | 76 / 81 |
| 时间线（某周某模块） | **0.047 / 0.085** | — | — | — | 无等价能力 | 无等价能力 |

> cold 首跑：SQLite LIKE 0.65–1.02ms、FTS5 1.5–4.7ms、rg 40–42ms（另有约 70–350ms 进程启动开销）、grep 65–212ms（含进程启动）。
> rg/grep 这里测的是「查找」本身；真实流程还要读命中文件（rg 返回 0 载荷，读取另算），DB 直接返回片段。

**怎么读这张表**：1k 档里 DB 比 rg 快 15–40 倍、比 grep 快 50–100 倍；但 100ms 与 3ms 对人都是「瞬间」，**真正的差别是 DB 一次返回可用片段 + 可过滤，而 grep 返回文件列表后还要再读**。

---

## 3. 载荷与召回（比延迟更重要）

| 后端 | 默认载荷（20 行） | tokens（估） | 召回 |
|---|---:|---:|---|
| SQLite LIKE（全文） | 9.5KB | ~2,891 | 与 LIKE 一致 |
| FTS unicode61 | 8.6KB | ~2,552 | 中文差：会话保持 41/285、回滚 46/945 |
| FTS trigram | **5.2KB** | **~1,479** | 与 LIKE 一致（≥3 字）；两字词 0 |
| trigram+LIKE | 5.2KB | ~1,479 | 与 LIKE 一致（含两字词） |
| 元数据 + 关键词（5 行） | 1.3–2.5KB | 373–752 | 正常 |
| 时间线（6 行） | 1.7KB | ~501 | 正常 |
| ripgrep（文件列表） | 0 | 0 | 需要后续读文件 |

**召回关键数据（中文）**：LIKE 285 / unicode61 41 / trigram 285（会话保持）；LIKE 945 / unicode61 46 / trigram 0（回滚，两字）。

结论：**中文默认 trigram + 两字词 LIKE 兜底**；查询返回必须复用 snippet 列（FTS5 snippet 函数）并限制字段，否则 9.5KB×N 条很快吃满 2k 注入预算。

---

## 4. 库体积与建库时间（1k 文档）

| DB 形态 | 体积 | 建库时间 |
|---|---:|---:|
| 纯元数据（LIKE 用） | 1.06MB | 23ms |
| 全文列 | 4.79MB | 33ms |
| 全文 + FTS unicode61 | 5.85MB | 71ms |
| 全文 + FTS unicode61 + trigram | 13.61MB | 209ms |
| contentless 双 FTS（正文留文件） | 9.87MB | 215ms |

按 1k→20k 线性估算：全文+双 FTS 约 **270MB**；contentless 双 FTS 约 **200MB**；单 trigram FTS 约 **140MB**。对单机项目可接受，但**不建议把正文同时存 DB 与 FTS**（双份膨胀）；更省的是「正文文件 + contentless trigram FTS + 两字词 LIKE 回退」。

---

## 5. 对方案的直接含义

| 判断 | 结论 |
|---|---|
| 是否值得上 DB | 值得：结构化过滤、时间线、全文检索都比 grep 稳；但别把「DB 快」当成主要收益，收益是**少读 + 读得准** |
| 正文放哪 | 文件为编辑面（多工具直接改、git diff/review）；DB 存镜像/索引；若只索引，用 contentless FTS 省体积 |
| 中文 | 必须 trigram；两字词用 LIKE 兜底；unicode61 只适合英文标识符（或单独列） |
| 返回什么 | 默认 snippet ≤5KB/次，禁止默认返回全文列；limit + 字段裁剪 + 预算 |
| 时间线 | 纯 SQL，1ms 内；应作为 DB 的首选能力（grep 无法替代） |
| 规模 | 1k 已足够；5k/20k 建议补跑（脚本已就绪），估算 20k 单次 FTS 仍 <10ms |

---

## 6. 复现与待补

- 生成语料：node research/bench/gen-corpus.mjs --tier 1k；建库：node research/bench/build-db.mjs --tier 1k；查询：node research/bench/queries.mjs --tier 1k；外部对照：bash research/bench/ext-bench.sh 1k。
- **未完成**：5k / 20k 档（本报告只含 1k）；rg/grep 全量对照只完成 1k；真实项目语料未测；冷/热缓存与 Windows Defender 影响未隔离。
- 结论仍足以支撑方向判断；补跑 5k/20k 后应更新 §2/§4 的线性估算。
