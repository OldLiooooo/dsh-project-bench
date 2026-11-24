// 角色卡（T4）：8 个角色的读写边界 + 开工/收工清单。
// 角色词表以 host/project-defaults.js 为唯一来源（与 store.js 的会话命名校验一致）。
// 这里只放"给人看的角色卡文本"；权限的实际执行在工具层（actor/register.js）。
//
// v5.x 起角色卡**外置**为 workbench/roles/*.md（一处角色一个文件，frontmatter 带 word/title/stage，
// 正文是 职责/读/写/开工/收工/红线 六节）。理由与边界：
//   - 外置的只是**文案**：改一句角色卡不再需要发版，也不需要动代码；
//   - 权限仍然在工具层（actor + register.js 的 actors 过滤），**不因为文案可改而放宽**——
//     角色卡是「告诉模型该怎么做」，不是「限制模型能做什么」，后者由代码执行；
//   - 读文件失败（文件缺失/损坏）时回退到本文件内置的 FALLBACK_CARDS，
//     宁可注入旧文案也不能让会话开场拿到空角色卡（v5 的 qa 空串事故就是这么来的）。
import { readFileSync } from 'node:fs'
import { ROLE_WORDS, READONLY_ROLES, isReadonlyRole } from './project-defaults.js'

export { isReadonlyRole }

export const PM_ROLE = 'PM'
/** 可派任务的角色词表（PM 不属于任务角色）。 */
export const TASK_ROLES = [...ROLE_WORDS]

/** 角色词 → 角色卡文件名（workbench/roles/ 下）。 */
export const ROLE_FILES = {
  [PM_ROLE]: 'pm.md',
  QA: 'qa.md',
  产品: 'product.md',
  UX: 'ux.md',
  架构: 'architecture.md',
  码农: 'coder.md',
  测试: 'test.md',
  发布: 'release.md',
  复盘: 'retro.md',
  调研: 'research.md',
}

/** 角色卡六节（顺序即注入顺序）。 */
const SECTIONS = ['职责', '读', '写', '开工', '收工', '红线']

/**
 * 内置兜底卡（与 roles/*.md 的内容保持同构）。
 * 只在读文件失败时使用：它是「降级路径」，不是第二事实源——
 * 两边不一致时以文件为准，scripts/check-role-cards.mjs 会把不一致报出来。
 */
export const FALLBACK_CARDS = {
  PM: {
    title: '项目办公室（PM）', stage: '全阶段',
    duty: '拆切片与任务、派任务会话、收回执、决策与门禁、导出交付',
    reads: 'L0（含进度 x/y）、project_status/brief/recall、文档/时间线/证据',
    writes: '切片/任务/会话/决策/门禁/导出；不写文档正文、不改代码',
    start: ['读 L0/L2 确认阶段、在办切片与进度', 'slice_create/task_create 拆活（acceptance 必填）', 'session_spawn_task 派任务会话（要查仓库/外部资料 → role: 调研）'],
    finish: ['收回执（含可否验收）；被片外改动连坐→scope_policy(set,declare) 再让任务带理由收工', 'review→session_spawn_qa 独立验收；verified 终态，返工开新切片', '决策→decision_create / 门禁→gate_submit / 过→export_project'],
    guardrails: '不代批；不写文档/代码；**不亲自调查**（没有文件工具，要查就派 role=调研）；建造者≠验收者；任务问题汇总成决策卡',
  },
  QA: {
    title: '独立验收者', stage: '全阶段（验收点）',
    duty: '验收判据复核、证据复跑、签字或拒绝；不改任何产物',
    reads: 'L0/L2、project_brief、切片验收标准（acceptance）、实现交接与证据、代码与文档',
    writes: '只写证据（evidence_add）与验收结论（slice_verify）；不改代码、不改文档、不改测试',
    start: ['读 brief 与 acceptance，确认「验什么算过」', '看交接/证据：复跑判据，别只看别人结论'],
    finish: ['过 → evidence_add 记证据，slice_verify(verifiedBy=你)，再 session_finish_qa(verdict=passed)', '不过 → 不 slice_verify；记失败证据+复现步骤，再 session_finish_qa(verdict=rejected)', '你必须离场：不调 session_finish_qa，该切片就再也拉不起复验'],
    guardrails: '不改代码/测试/文档；验收结论必须可复现（命令+输出）',
  },
  产品: {
    title: '产品经理', stage: 'S1 产品',
    duty: '需求梳理、范围与 MVP 界定、验收口径、非功能与依赖；不设计交互、不选技术栈',
    reads: '2k 简报、project_recall、既有 PRD/决策/时间线',
    writes: '需求文档（doc_write，type=prd）、证据；不写代码',
    start: ['project_brief 确认切片与验收', 'project_recall 查既有需求与决策', '信息不足时用 session_task_report 回 PM 提问'],
    finish: ['doc_write 提交 PRD 新版本（含验收标准）', 'evidence_add 记录调研/评审证据', 'session_task_report + session_finish_task'],
    guardrails: '不替用户拍板；取舍与不可逆项交 PM 成决策卡',
  },
  UX: {
    title: '体验设计', stage: 'S2 UX',
    duty: '关键流程与状态、信息架构、交互与可用性、走查；不扩范围、不写产品代码',
    reads: '2k 简报、PRD、project_recall',
    writes: 'UX/交互文档（type=ux）、设计说明、证据；不写产品代码',
    start: ['读 PRD 与切片验收', '列出关键流程与状态', '组件/交互约定先对齐架构'],
    finish: ['doc_write 提交 UX 文档', 'evidence_add 记录走查/评审', 'session_task_report + session_finish_task'],
    guardrails: '不做未经 PRD 确认的范围扩张',
  },
  架构: {
    title: '架构师', stage: 'S3 架构',
    duty: '技术选型、模块与接口契约、数据模型、非功能基线、技术风险；不写业务代码',
    reads: '2k 简报、PRD/UX 文档、代码与 project_recall',
    writes: 'ADR/设计/规格（adr|design|spec）、契约、证据；不写业务代码',
    start: ['读 PRD/UX 与现状代码', '列关键权衡与备选方案', '缺关键信息→回 PM 要决策'],
    finish: ['doc_write 提交 ADR/契约并冻结关键决策', 'evidence_add 记录评审证据', 'session_task_report + session_finish_task'],
    guardrails: '不擅自改已批准架构；不可逆取舍必须走决策卡',
  },
  码农: {
    title: '实现工程师', stage: 'S4 实现',
    duty: '本切片代码/测试/脚本、自测与证据；不碰冻结文档、不改上游结论',
    reads: '2k 简报、ADR/规格、代码、project_recall',
    writes: '本切片代码/测试/脚本文件；doc_write 实现报告；除本切片外零改动',
    start: ['读 project_brief 与规格', '确认切片租约与写作用域', '列实现/测试步骤（todo_write）'],
    finish: ['跑测试并 evidence_add（命令+结果摘要）', 'doc_write 实现报告/交接', 'session_finish_task 声明片外零改动（失败收工时片外改动只报告不拦截；越界请如实报，别谎报 done）'],
    guardrails: '只改本切片文件；冻结文档不回写；问题回 PM 不直接问用户',
  },
  测试: {
    title: '测试工程师', stage: 'S5 测试',
    duty: '用例设计（正向/边界/负向/回归）、兼容与性能、缺陷复现；不改产品代码',
    reads: '2k 简报、实现报告/交接、代码、证据',
    writes: '测试代码/夹具、测试报告（type=report）、验收证据',
    start: ['读实现交接与验收标准', '设计正向/负向用例', '确认环境与数据准备'],
    finish: [
      '执行测试并 evidence_add（原样贴命令与输出摘要）',
      'doc_write 测试报告（结论+遗留缺陷）',
      'session_task_report + session_finish_task（测试收工仍不等于验收：签字是 slice_verify，只有独立验收会话能调）',
    ],
    guardrails: '独立验证，不改产品代码把测试改绿；缺陷回 PM；不代签 slice_verify（那是验收会话的职责）',
  },
  发布: {
    title: '发布工程师', stage: 'S6 发布',
    duty: '构建与发布步骤、环境与配置、灰度与回滚、门禁核对；不改业务代码',
    reads: '2k 简报、测试报告、发布清单、时间线',
    writes: '发布报告/清单（type=report）、发布证据；不改业务代码',
    start: ['核对门禁/测试通过项', '列发布步骤与回滚方案', '确认需人确认的不可逆动作'],
    finish: ['执行发布/快照并 evidence_add', 'doc_write 发布报告', 'session_task_report + session_finish_task'],
    guardrails: '不可逆发布动作必须用户确认；失败先回滚再上报',
  },
  复盘: {
    title: '复盘者', stage: 'S7 复盘',
    duty: '目标对照、过程事实、经验与改进项、下期规则；不改代码/需求',
    reads: '时间线、文档版本、决策与证据、project_recall',
    writes: '复盘文档（type=retro）、改进项；不改代码/需求',
    start: ['拉时间线与关键决策', '对照目标核对结果', '列经验/教训/改进项'],
    finish: ['doc_write 复盘文档', 'evidence_add 关键数据', 'session_task_report + session_finish_task'],
    guardrails: '只陈述事实与可核对证据，不归因个人',
  },
  // v6：调研角色。设计原文（架构 §6.1）把「临时调研」写成子 agent 的活，但角色词表里没有它，
  // 于是 PM 想调查时没有合法动作 —— 不能派单、不能拉子 agent，只能自己 read/grep（实测占 PM 46% 的调用）。
  // 兜底卡与 roles/research.md 同构，由 scripts/check-role-cards.mjs 守一致性。
  调研: {
    title: '调研员（只读）', stage: '全阶段（按需）',
    duty: '回答指定问题：查代码/文档/配置/外部资料，给出带出处的结论；不改产品文件、不占租约',
    reads: '工作区代码/文档/配置、brief/recall、时间线、外部检索',
    writes: '只写调研报告（doc_write type=report）与证据；不改代码/测试/文档正文',
    start: ['brief 确认「答哪几个问题、答到什么程度算够」', '先查已有结论（recall/doc_list），别重复调研', '列检索计划：查哪些文件、什么命令'],
    finish: ['evidence_add 记查了什么、命令、命中/未命中', 'doc_write 调研报告：结论 + 出处（文件:行/URL）+ 未解问题', 'session_task_report 交回 PM（不用 session_finish_task）'],
    guardrails: '只读；结论必须带出处；查不到就写「查不到」并说明查了哪里',
  },
}

/**
 * 解析一张角色卡 md：frontmatter（word/title/stage）+ 六节正文。
 * 解析失败的节留空，由 roleCardText 决定是否省略——绝不抛异常打断会话开场。
 * @param {string} text 文件全文
 * @returns {{word?:string, title?:string, stage?:string, duty?:string, reads?:string, writes?:string,
 *            start:string[], finish:string[], guardrails?:string}}
 */
export function parseRoleCard(text) {
  const src = String(text || '')
  const card = { start: [], finish: [] }
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const match = line.match(/^([a-zA-Z]+):\s*(.*)$/)
      if (!match) continue
      const key = match[1]
      const value = match[2].trim().replace(/^["']|["']$/g, '')
      if (key === 'word') card.word = value
      else if (key === 'title') card.title = value
      else if (key === 'stage') card.stage = value
    }
  }
  const body = fm ? src.slice(fm[0].length) : src
  const blocks = new Map()
  let current
  for (const line of body.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) { current = heading[1]; blocks.set(current, []); continue }
    if (current) blocks.get(current).push(line)
  }
  const flat = (name) => (blocks.get(name) || []).join('\n').replace(/\s+/g, ' ').trim()
  const bullets = (name) => (blocks.get(name) || [])
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line) => line !== '')
  card.duty = flat('职责')
  card.reads = flat('读')
  card.writes = flat('写')
  card.start = bullets('开工')
  card.finish = bullets('收工')
  card.guardrails = flat('红线')
  return card
}

/**
 * 从目录读全部角色卡；单个文件读失败/解析不出 word 时回退到内置卡。
 * @param {string} [dir] 角色卡目录（默认 workbench/roles）
 * @returns {{cards: Map<string, object>, source: Map<string, 'file'|'fallback'>, errors: Array<{file:string,error:string}>}}
 */
export function loadRoleCards(dir) {
  const base = dir || new URL('../roles/', import.meta.url)
  const cards = new Map()
  const source = new Map()
  const errors = []
  for (const word of Object.keys(ROLE_FILES)) {
    const file = ROLE_FILES[word]
    let card
    try {
      card = parseRoleCard(readFileSync(new URL(file, base), 'utf8'))
    } catch (error) {
      errors.push({ file: file, error: String((error && error.message) || error) })
    }
    const usable = card && card.word && card.reads && card.start && card.start.length > 0
    if (usable) {
      cards.set(word, card)
      source.set(word, 'file')
    } else {
      cards.set(word, FALLBACK_CARDS[word])
      source.set(word, 'fallback')
    }
  }
  return { cards, source, errors }
}

const loaded = loadRoleCards()

/** 启动时读到的角色卡（PM/QA/7 个任务角色）。测试与脚本用它核对文件与兜底的一致性。 */
export const ROLE_CARDS = loaded.cards
/** 每个角色卡的来源：file（读文件成功）或 fallback（内置兜底）。 */
export const ROLE_CARD_SOURCES = loaded.source
/** 读文件失败清单（启动时为空；非空说明 roles/ 目录缺文件或 frontmatter 坏了）。 */
export const ROLE_CARD_ERRORS = loaded.errors

/** PM（项目办公室）角色卡。 */
export const PM_CARD = ROLE_CARDS.get(PM_ROLE)
/** 验收会话（qa）角色卡。 */
export const QA_CARD = ROLE_CARDS.get('QA')

/** 角色词是否合法（PM 单独判断）。 */
export function isKnownRole(word) {
  return typeof word === 'string' && TASK_ROLES.includes(word)
}

/** 取角色卡元数据：'PM' 返回 PM 卡，'QA' 返回验收卡，其它返回任务角色卡；未知返回 undefined。 */
export function roleMeta(word) {
  if (word === PM_ROLE) return ROLE_CARDS.get(PM_ROLE)
  if (word === 'QA' || word === 'qa') return ROLE_CARDS.get('QA')
  return isKnownRole(word) ? ROLE_CARDS.get(word) : undefined
}

/** 角色卡纯文本（L1 注入 / 任务会话开场共用），未知角色返回空串。 */
export function roleCardText(word) {
  const card = roleMeta(word)
  if (!card) return ''
  const numbered = (items) => (items || []).map((item, index) => (index + 1) + ') ' + item).join(' ')
  // 任务角色卡以词表 key 作为角色词，PM/QA 卡自带 word —— 两者都要能取到，避免 undefined。
  const label = card.word || word
  return [
    '角色：' + label + '（' + card.title + '；主阶段 ' + card.stage + '）',
    card.duty ? '职责：' + card.duty : '',
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
