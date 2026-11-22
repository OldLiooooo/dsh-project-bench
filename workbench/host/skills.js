// 技能模板（T4，契约 §8）：把 workbench/skills/*.md 注册为运行时技能。
// 技能是"按需加载"的完整指令（不占 2k 注入预算）；模型通过 skill 工具加载。
import { readFileSync } from 'node:fs'

/** 决策卡技能名（host/cards.js 的 actionCards kind.skill 必须与之相同）。 */
export const DECISION_CARD_SKILL = 'decision-card'

/** 技能清单：name 必须 kebab-case；description 一行；file 对应 workbench/skills/。 */
export const SKILLS = [
  {
    name: 'requirement-grooming',
    description: '需求梳理：把一句话需求拆成切片/任务与待拍板问题，避免重复切片与范围膨胀。',
    file: 'requirement-grooming.md',
    fallback: '# 需求梳理\n\n1) project_status/slice_list 查重；2) 四段式：用户故事/范围边界/验收标准/不做；3) 需要用户取舍的走 decision_create 或 session_task_report；4) PM 用 slice_create + task_create + session_spawn_task 派活。',
  },
  {
    name: 'prd-writing',
    description: 'PRD 写作：背景/用户场景/功能需求/非功能/验收/边界/依赖，写 DB 版本链。',
    file: 'prd-writing.md',
    fallback: '# PRD 写作\n\n用 doc_write(type=prd, logicalKey=prd/<切片key>) 写；修订追加新版本；结构：背景目标/用户场景/FR 编号需求/非功能/验收/不做/依赖风险。',
  },
  {
    name: 'adr-writing',
    description: 'ADR/架构文档：背景/决策/备选/后果/验证方式，供实现与测试按契约执行。',
    file: 'adr-writing.md',
    fallback: '# ADR 写作\n\n用 doc_write(type=adr|design|spec) 写；一篇 ADR 一个决策；不可逆取舍先 decision_create 等用户批准。',
  },
  {
    name: 'implementation-execution',
    description: '实现执行：按 ADR/规格改本切片代码、跑测试、留证据、写交接并收工。',
    file: 'implementation-execution.md',
    fallback: '# 实现执行\n\n开工读 project_brief/ADR；只改本切片写作用域；evidence_add 记录命令与输出；session_task_report + session_finish_task(noOutOfScopeChanges=true)。',
  },
  {
    name: 'testing-verification',
    description: '测试验证：独立验证实现，产出可复核验收证据与测试报告。',
    file: 'testing-verification.md',
    fallback: '# 测试验证\n\n读交接与验收；正向/边界/负向/回归用例；evidence_add 记录命令与输出摘要；doc_write(type=report) 写报告；缺陷回 PM。',
  },
  {
    name: 'handoff-writeup',
    description: '交接写作：做了什么/怎么验证/风险与遗留/下一步，让下一会话零提问接手。',
    file: 'handoff-writeup.md',
    fallback: '# 交接写作\n\n四段式：做了什么、怎么验证（命令+证据）、现状与风险、下一步；用 session_task_report(handoff=...) 或 doc_write(type=handoff) 落库。',
  },
  {
    name: DECISION_CARD_SKILL,
    description: '决策卡：把需要人拍板的问题整理成问题/选项/推荐/后果/不可逆标记，等用户答复。',
    file: 'decision-card.md',
    fallback: '# 决策卡\n\n要素：问题/选项/推荐/后果/不可逆；PM 用 decision_create，门禁用 gate_submit；agent 不得代批。',
  },
  {
    name: 'testing-acceptance',
    description: '独立验收：验收会话的硬边界、开工三步、签字与拒绝的写法（v5 Verified Done）。',
    file: 'testing-acceptance.md',
    fallback: '# 独立验收\n\n1) project_brief 读 acceptance 确认「验什么算过」；2) 看交接与证据；3) 复跑命令，别只看结论。'
      + '过 → evidence_add + slice_verify(verifiedBy)；不过 → 只 evidence_add，不签字。'
      + '不要用实现会话验收（SELF_VERIFICATION_DENIED），不要直接改状态成 verified（INVALID）。',
  },
  {
    name: 'cycle-retrospective',
    description: '周期复盘：把本周期事实固定下来（数据自动取，不手填），并推进周期。',
    file: 'cycle-retrospective.md',
    fallback: '# 周期复盘\n\n数据从 project_status.progress 与 weekly_report 取，不要自己编数字。'
      + '四段式：做成了什么（只写 verified）/没做成什么及原因/口径是否可信（done 未验收堆积=验收瓶颈）/下期最多 3 条可验证的规则变更。'
      + '写完用 period_roll 推进（会把本期验证数定格）。',
  },
]

function loadContent(skill) {
  try {
    return readFileSync(new URL('../skills/' + skill.file, import.meta.url), 'utf8')
  } catch (error) {
    return skill.fallback
  }
}

/**
 * 注册全部技能模板（全局 registry 层）。
 * @returns {{name:string, dispose:Function}[]}
 */
export function registerSkills(ctx, registry) {
  if (!ctx || !ctx.skills || typeof ctx.skills.register !== 'function') return []
  const registered = []
  for (const skill of SKILLS) {
    const content = loadContent(skill)
    const dispose = ctx.skills.register({
      name: skill.name,
      description: skill.description,
      content: content,
      invocation: { modelInvocable: true, userInvocable: true },
    })
    registered.push({ name: skill.name, dispose: dispose, chars: content.length })
  }
  return registered
}
