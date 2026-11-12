# 决策卡（decision-card）

用途：需要人拍板时使用决策卡，而不是在对话里追问用户。

## 要素
- 问题（一句话，可回答）
- 选项（≤4 个，互斥可执行）
- 推荐（含一句理由）
- 不返工后果 / 选错的代价
- 是否不可逆（不可逆必须用户二次确认）

## 用法
- PM：`decision_create` 创建决策卡；门禁类用 `gate_submit` 生成。
- 任务会话：用 `session_task_report` 把问题回 PM，由 PM 汇总成卡片。
- 用户批准/驳回由面板/HTTP 执行；agent 不得代批、不得自行 resolve。

## actionCards（宿主启用时）
加载本技能后，可调用 `propose_action` 展示卡片：
- action: `project-decision`
- details: `{ decisionId, title, question, options, recommended, irreversible }`
若宿主未启用 actionCards，直接给出决策卡摘要文本，等待用户答复。
