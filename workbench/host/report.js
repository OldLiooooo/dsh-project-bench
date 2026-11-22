// 周报生成器（MVP 验收标准 ⑤）：把项目状态渲染成一段**可直接贴进 GitHub Issue** 的 Markdown。
//
// 为什么放在 host 而不是让 PM 自己写：
//   设计 §6.2 的原则是「指标必须能从项目文件/会话事件自动生成；需要人手动维护的指标一律不做」。
//   让模型每周现编一份周报，等于把「唯一进度口径」交回给自然语言描述 —— 那正是这个插件要消灭的东西。
//
// 数据来源（全部只读、全部可复核）：
//   - 进度：projectProgress（唯一口径 = verified）
//   - 本期完成/新增：按 period.startedAt 之后的事件统计（period_roll 写入）
//   - 待决策/阻塞：decisions(status=pending) / slices(status=blocked)
//   - 证据：本期 slice/verify 与 evidence/add 计数
//
// 输出契约：
//   - 确定性：同一项目状态下内容完全一致（不含墙钟时间，时间来自 period.startedAt）
//   - 自包含：不引用内部 id 也会给人看懂；id 只出现在折叠的明细里
//   - 可粘贴：顶层标题 + 一句结论 + 表格，放进 Issue 正文不需要改格式
import { fail } from './db.js'
import { newId, sha256 } from './util.js'

/**
 * 本期的起始时间：优先显式 since，其次 period.startedAt，最后回退到**项目创建时间**。
 *
 * 为什么不用「近 7 天」：那会让同一项目状态在两次调用间产生不同内容
 * （Date.now() 每次都变），而周报的输出契约是「确定性：同一状态内容完全一致」。
 * 一个每次内容都变的报告，既不能被 hash 去重，也没法判断「这周报是不是最新的」。
 * 用项目创建时间做兜底：语义是「本期 = 项目至今」，稳定且可解释。
 */
function periodStart(db, input) {
  if (input && typeof input.since === 'string' && input.since.trim() !== '') return input.since.trim()
  const fromMeta = db.getMeta('period.startedAt')
  if (fromMeta) return fromMeta
  const project = db.project() || {}
  if (project.created_at) return String(project.created_at)
  // 极端兜底（迁移过程中的老库可能没有 created_at）：用 epoch，仍然稳定。
  return '1970-01-01T00:00:00.000Z'
}

function countEvents(db, kinds, since) {
  const placeholders = kinds.map(() => '?').join(',')
  try {
    const row = db.db.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE project_id = ? AND kind IN (' + placeholders + ') AND at >= ?'
    ).get(db.projectId, ...kinds, since)
    return Number(row && row.n ? row.n : 0)
  } catch (error) { return 0 }
}

function listRows(db, sql, params = []) {
  try { return db.db.prepare(sql).all(db.projectId, ...params) } catch (error) { return [] }
}

/** 进度数字（与 snapshot.projectProgress 同口径；这里独立算一遍是为了 host 内部不反向依赖 snapshot）。 */
function progressOf(db) {
  const rows = listRows(db, 'SELECT status, COUNT(*) AS n FROM slices WHERE project_id = ? GROUP BY status')
  const by = new Map()
  for (const row of rows) by.set(String(row.status), Number(row.n))
  const num = (key) => Number(by.get(key) || 0)
  const verified = num('verified')
  const doneUnverified = num('done')
  const inFlight = num('in_progress') + num('review')
  const blocked = num('blocked')
  const notStarted = num('open')
  const abandoned = num('archived') + num('cut')
  const total = verified + doneUnverified + inFlight + blocked + notStarted
  return {
    total, verified, doneUnverified, inFlight, blocked, notStarted, abandoned,
    percent: total === 0 ? 0 : Math.round((verified / total) * 100),
  }
}

/**
 * 渲染周报 Markdown。
 * @param {object} db ProjectDb
 * @param {object} [input] { since?, title? }
 * @returns {string}
 */
export function renderWeeklyReport(db, input = {}) {
  const project = db.project() || {}
  const since = periodStart(db, input)
  const periodLabel = db.getMeta('period.current') || '（未开周期）'
  const periodIndex = db.getMeta('period.index')
  const progress = progressOf(db)
  const pendingDecisions = listRows(db, "SELECT id, title, question, irreversible, deadline FROM decisions WHERE project_id = ? AND status = 'pending' ORDER BY irreversible DESC, created_at ASC")
  const blockedSlices = listRows(db, "SELECT key, title FROM slices WHERE project_id = ? AND status = 'blocked' ORDER BY updated_at DESC")
  const verifiedInPeriod = listRows(db, "SELECT key, title, verified_by, verified_at FROM slices WHERE project_id = ? AND status = 'verified' AND verified_at >= ? ORDER BY verified_at ASC", [since])
  const evidenceCount = countEvents(db, ['evidence/add'], since)
  const verifyEvents = countEvents(db, ['slice/verify'], since)
  const gateEvents = countEvents(db, ['gate/approve'], since)

  const lines = []
  const title = input.title || (String(project.name || '项目') + ' 周报 · ' + periodLabel)
  lines.push('# ' + title)
  lines.push('')
  // 一句话结论：先给数字，再给解释。人看 Issue 第一行就该知道「到哪了」。
  lines.push('> 进度 **' + progress.verified + '/' + progress.total + '**（' + progress.percent + '%）已独立验收'
    + (progress.doneUnverified > 0 ? '，另有 **' + progress.doneUnverified + '** 项已交付但未验收（不计入进度）' : '')
    + '；待决策 **' + pendingDecisions.length + '** 项，阻塞 **' + blockedSlices.length + '** 项。')
  lines.push('')
  lines.push('## 本期概览')
  lines.push('')
  lines.push('| 指标 | 数值 |');
  lines.push('|---|---|');
  lines.push('| 周期 | ' + periodLabel + (periodIndex ? '（第 ' + periodIndex + ' 期）' : '') + ' |');
  lines.push('| 周期起始 | ' + since + ' |');
  lines.push('| 本期验收通过 | ' + verifyEvents + ' 项 |');
  lines.push('| 本期门禁通过 | ' + gateEvents + ' 次 |');
  lines.push('| 本期新增证据 | ' + evidenceCount + ' 条 |');
  lines.push('| 累计已验收 | ' + progress.verified + ' / ' + progress.total + '（' + progress.percent + '%） |');
  lines.push('')
  lines.push('## 进度分解')
  lines.push('');
  lines.push('| 状态 | 数量 | 含义 |');
  lines.push('|---|---|---|');
  lines.push('| 已验收 verified | ' + progress.verified + ' | 独立验收通过，计入进度 |');
  lines.push('| 已交付未验收 done | ' + progress.doneUnverified + ' | 交付方自认完成，**不计入进度** |');
  lines.push('| 进行中 in_progress/review | ' + progress.inFlight + ' | 在做或等待验收 |');
  lines.push('| 阻塞 blocked | ' + progress.blocked + ' | 需要解阻塞 |');
  lines.push('| 未开始 open | ' + progress.notStarted + ' | 还没动 |');
  lines.push('| 已裁剪 archived/cut | ' + progress.abandoned + ' | 有意不做，不进分母 |');
  lines.push('')

  if (verifiedInPeriod.length > 0) {
    lines.push('## 本期完成（已独立验收）')
    lines.push('')
    for (const slice of verifiedInPeriod) {
      lines.push('- **' + String(slice.title || slice.key) + '** — 验收人 ' + String(slice.verified_by || '?') + '（' + String(slice.verified_at || '') + '）')
    }
    lines.push('')
  }

  if (pendingDecisions.length > 0) {
    lines.push('## 需要拍板的决策（' + pendingDecisions.length + '）')
    lines.push('')
    for (const decision of pendingDecisions) {
      const flags = []
      if (Number(decision.irreversible) === 1) flags.push('不可逆')
      if (decision.deadline) flags.push('截止 ' + String(decision.deadline))
      lines.push('- **' + String(decision.title) + '**' + (flags.length > 0 ? '（' + flags.join('，') + '）' : ''))
      if (decision.question) lines.push('  - ' + String(decision.question).replace(/\n+/g, ' '))
    }
    lines.push('')
  }

  if (blockedSlices.length > 0) {
    lines.push('## 阻塞项（' + blockedSlices.length + '）')
    lines.push('')
    for (const slice of blockedSlices) lines.push('- ' + String(slice.key) + ' — ' + String(slice.title))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('_本报告由工作台从项目库自动生成（不是手写），口径为 Verified Done。_')
  return lines.join('\n')
}

export { periodStart, progressOf as reportProgressOf }
