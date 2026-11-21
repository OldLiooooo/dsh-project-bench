// 角色卡（T4）：8 个角色的读写边界 + 开工/收工清单，静态内容。
// 角色词表以 host/project-defaults.js 为唯一来源（与 store.js 的会话命名校验一致）。
// 这里只放"给人看的角色卡文本"；权限的实际执行在工具层（actor/register.js）。
import { ROLE_WORDS } from './project-defaults.js'

export const PM_ROLE = 'PM'
/** 可派任务的角色词表（PM 不属于任务角色）。 */
export const TASK_ROLES = [...ROLE_WORDS]

/** 单张角色卡：word/title/stage/reads/writes/start/finish/guardrails。 */
const CARDS = {
  产品: {
    title: '产品经理',
    stage: 'S1 产品',
    reads: '2k 简报、project_recall、既有 PRD/决策/时间线',
    writes: '需求文档（doc_write，type=prd）、证据；不写代码',
    start: ['project_brief 确认切片与验收', 'project_recall 查既有需求与决策', '信息不足时用 session_task_report 回 PM 提问'],
    finish: ['doc_write 提交 PRD 新版本（含验收标准）', 'evidence_add 记录调研/评审证据', 'session_task_report + session_finish_task'],
    guardrails: '不替用户拍板；取舍与不可逆项交 PM 成决策卡',
  },
  UX: {
    title: '体验设计',
    stage: 'S2 UX',
    reads: '2k 简报、PRD、project_recall',
    writes: 'UX/交互文档（type=ux）、设计说明、证据；不写产品代码',
    start: ['读 PRD 与切片验收', '列出关键流程与状态', '组件/交互约定先对齐架构'],
    finish: ['doc_write 提交 UX 文档', 'evidence_add 记录走查/评审', 'session_task_report + session_finish_task'],
    guardrails: '不做未经 PRD 确认的范围扩张',
  },
  架构: {
    title: '架构师',
    stage: 'S3 架构',
    reads: '2k 简报、PRD/UX 文档、代码与 project_recall',
    writes: 'ADR/设计/规格（adr|design|spec）、契约、证据；不写业务代码',
    start: ['读 PRD/UX 与现状代码', '列关键权衡与备选方案', '缺关键信息→回 PM 要决策'],
    finish: ['doc_write 提交 ADR/契约并冻结关键决策', 'evidence_add 记录评审证据', 'session_task_report + session_finish_task'],
    guardrails: '不擅自改已批准架构；不可逆取舍必须走决策卡',
  },
  码农: {
    title: '实现工程师',
    stage: 'S4 实现',
    reads: '2k 简报、ADR/规格、代码、project_recall',
    writes: '本切片代码/测试/脚本文件；doc_write 实现报告；除本切片外零改动',
    start: ['读 project_brief 与规格', '确认切片租约与写作用域', '列实现/测试步骤（todo_write）'],
    finish: ['跑测试并 evidence_add（命令+结果摘要）', 'doc_write 实现报告/交接', 'session_finish_task 声明片外零改动'],
    guardrails: '只改本切片文件；冻结文档不回写；问题回 PM 不直接问用户',
  },
  测试: {
    title: '测试工程师',
    stage: 'S5 测试',
    reads: '2k 简报、实现报告/交接、代码、证据',
    writes: '测试代码/夹具、测试报告（type=report）、验收证据',
    start: ['读实现交接与验收标准', '设计正向/负向用例', '确认环境与数据准备'],
    finish: [
      '执行测试并 evidence_add（原样贴命令与输出摘要）',
      'doc_write 测试报告（结论+遗留缺陷）',
      'session_task_report + session_finish_task（**测试角色的收工仍不等于验收**：signing 是 slice_verify，只有独立验收会话能调）',
    ],
    guardrails: '独立验证，不改产品代码把测试改绿；缺陷回 PM；不代签 slice_verify（那是验收会话的职责）',
  },
  发布: {
    title: '发布工程师',
    stage: 'S6 发布',
    reads: '2k 简报、测试报告、发布清单、时间线',
    writes: '发布报告/清单（type=report）、发布证据；不改业务代码',
    start: ['核对门禁/测试通过项', '列发布步骤与回滚方案', '确认需人确认的不可逆动作'],
    finish: ['执行发布/快照并 evidence_add', 'doc_write 发布报告', 'session_task_report + session_finish_task'],
    guardrails: '不可逆发布动作必须用户确认；失败先回滚再上报',
  },
  复盘: {
    title: '复盘者',
    stage: 'S7 复盘',
    reads: '时间线、文档版本、决策与证据、project_recall',
    writes: '复盘文档（type=retro）、改进项；不改代码/需求',
    start: ['拉时间线与关键决策', '对照目标核对结果', '列经验/教训/改进项'],
    finish: ['doc_write 复盘文档', 'evidence_add 关键数据', 'session_task_report + session_finish_task'],
    guardrails: '只陈述事实与可核对证据，不归因个人',
  },
}

/** PM（项目办公室）角色卡。 */
export const PM_CARD = {
  word: PM_ROLE,
  title: '项目办公室（PM）',
  stage: '全阶段',
  reads: 'L0（含进度 x/y）、project_status/brief/recall、文档/时间线/证据',
  writes: '切片/任务/会话/决策/门禁/导出；不写文档正文、不改代码',
  start: ['读 L0/L2 确认阶段、在办切片与进度', 'slice_create/task_create 拆活（acceptance 必填）', 'session_spawn_task 派任务会话'],
  finish: [
    '收回执（含该切片可否验收）',
    'review→session_spawn_qa 独立验收；verified 终态，返工开新切片',
    '决策→decision_create / 门禁→gate_submit / 过→export_project',
  ],
  guardrails: '不代批；不写文档/代码；建造者≠验收者；任务问题汇总成决策卡',
}

/**
 * 验收会话（qa）角色卡。
 *
 * 为什么需要它：v5 加了 project-qa 会话类型，但角色卡表里只有 7 个任务角色 + PM，
 * 于是 qa 会话的 L1 注入会拿到空串 —— 它会不知道自己是来验收的、更不知道能调什么。
 * 这正是「加了能力没接线」的同一个病。
 */
export const QA_CARD = {
  word: 'QA',
  title: '独立验收者',
  stage: '全阶段（验收点）',
  reads: 'L0/L2、project_brief、切片验收标准（acceptance）、实现交接与证据、代码与文档',
  writes: '只写证据（evidence_add）与验收结论（slice_verify）；**不改代码、不改文档、不改测试**',
  start: ['读 brief 与 acceptance，确认「验什么算过」', '看交接/证据：复跑判据，别只看别人结论'],
  finish: [
    '过 → evidence_add 记复核证据，再 slice_verify(verifiedBy=你)',
    '不过 → 不要 slice_verify；记失败证据+复现步骤，交回 PM',
    '收工用 session_finish_task 写交接',
  ],
  guardrails: '不改代码/测试/文档；验收结论必须可复现（命令+输出）',
}

/** 角色词是否合法（PM 单独判断）。 */
export function isKnownRole(word) {
  return typeof word === 'string' && TASK_ROLES.includes(word)
}

/** 取角色卡元数据：'PM' 返回 PM 卡，'QA' 返回验收卡，其它返回任务角色卡；未知返回 undefined。 */
export function roleMeta(word) {
  if (word === PM_ROLE) return PM_CARD
  if (word === 'QA' || word === 'qa') return QA_CARD
  return isKnownRole(word) ? CARDS[word] : undefined
}

/** 角色卡纯文本（L1 注入 / 任务会话开场共用），未知角色返回空串。 */
export function roleCardText(word) {
  const card = roleMeta(word)
  if (!card) return ''
  const numbered = (items) => items.map((item, index) => (index + 1) + ') ' + item).join(' ')
  // 任务角色卡以词表 key 作为角色词（CARDS 的键），PM 卡自带 word —— 两者都要能取到，避免 undefined。
  const label = card.word || word
  return [
    '角色：' + label + '（' + card.title + '；主阶段 ' + card.stage + '）',
    '读：' + card.reads,
    '写：' + card.writes,
    '开工：' + numbered(card.start),
    '收工：' + numbered(card.finish),
    card.guardrails ? '红线：' + card.guardrails : '',
  ].filter(Boolean).join('\n')
}

/** 任务会话命名：角色-切片-动作（store.js 的命名校验以此为准）。 */
export function taskSessionName(role, sliceKey, action) {
  if (!isKnownRole(role)) return ''
  const key = String(sliceKey === undefined || sliceKey === null ? '' : sliceKey).trim()
  const act = String(action === undefined || action === null ? '' : action).trim()
  if (!key || !act) return ''
  return role + '-' + key + '-' + act
}

/** 预校验任务会话名（提前给模型友好错误；最终仍由 store.createSession 校验）。 */
export function validateTaskName(name, options = {}) {
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: '会话名不能为空' }
  const value = name.trim()
  const role = TASK_ROLES.find((word) => value.startsWith(word + '-'))
  if (!role) return { ok: false, reason: '任务会话名必须以角色开头：' + TASK_ROLES.join('/') }
  if (options.role && options.role !== role) return { ok: false, reason: '会话名角色与参数 role 不一致：' + value + ' / ' + options.role }
  const rest = value.slice(role.length + 1)
  const parts = rest.split('-').filter((part) => part.length > 0)
  if (parts.length < 2) return { ok: false, reason: '任务会话名必须是 角色-切片-动作 三段：' + value }
  if (options.sliceKey && parts[0] !== options.sliceKey) {
    return { ok: false, reason: '会话名切片段与 sliceKey 不一致：' + value + ' / ' + options.sliceKey }
  }
  return { ok: true, role, sliceKey: parts[0], action: parts.slice(1).join('-') }
}

export const ROLE_HELP = TASK_ROLES.join('、')
