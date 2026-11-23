// Default project configuration shared by the registry (T2) and orchestration (T4).
// project.json is the only file in .project/ that belongs in git; the DB is not committed.
export const FORMAT = 1

export const STAGE_TEMPLATE = [
  { key: 'S1', name: '产品', gate: 'G1', deliverableTypes: ['prd'] },
  { key: 'S2', name: 'UX', gate: 'G2', deliverableTypes: ['ux'] },
  { key: 'S3', name: '架构', gate: 'G3', deliverableTypes: ['adr', 'design', 'spec'] },
  { key: 'S4', name: '实现', gate: 'G4', deliverableTypes: ['design', 'report'] },
  { key: 'S5', name: '测试', gate: 'G5', deliverableTypes: ['report'] },
  { key: 'S6', name: '发布', gate: 'G6', deliverableTypes: ['report'] },
  { key: 'S7', name: '复盘', gate: 'G7', deliverableTypes: ['retro'] },
]

// 可派任务的角色词表（命名 角色-切片-动作 的第一段）。
//
// 「调研」在 v6 才加进来，原因见 docs/workbench-design-logic.zh.md §4.7：
// 设计原文把「调研/起草/评审」写成任务会话的子 agent 临时工，但角色词表里没有它，
// 于是 PM 想调查时**没有任何合法动作** —— 它不能派单（角色未知直接 INVALID），
// 也不能拉子 agent（PM preset 故意不挂 delegation），只能自己 read/grep（46% 的工具调用）。
// 把调研变成一个正式角色，PM 才有「派一个调研会话」这条路。
export const ROLE_WORDS = ['产品', 'UX', '架构', '码农', '测试', '发布', '复盘', '调研']

/**
 * 只读角色：派单时不占切片租约、不能用 session_finish_task 推进切片状态。
 *
 * 为什么「调研」必须不占租约：租约是**写作用域锁**（同一切片同时只有一个写者）。
 * 调研是只读动作，让它持租会把同切片的实现会话挡在门外 —— 那不是保护，是拿锁当排队用。
 * 它也不能用 session_finish_task：那个工具会把切片推到 review，而调研并不产出切片交付物。
 */
export const READONLY_ROLES = ['调研']

/** 这个角色词是不是只读角色（不占租约、不收工推进切片）。 */
export function isReadonlyRole(word) {
  return typeof word === 'string' && READONLY_ROLES.includes(word)
}

export function defaultExportMap() {
  return {
    prd: 'docs/product',
    ux: 'docs/ux',
    adr: 'docs/architecture',
    design: 'docs/design',
    spec: 'docs/spec',
    report: 'docs/reports',
    handoff: 'docs/handoffs',
    retro: 'docs/retro',
  }
}

export function defaultBudget() {
  return { l0: 400, l1: 300, l2: 900, spare: 400, recall: 500, hardLimit: 2000 }
}

export function defaultProviderRouting() {
  // Provider/model names are deployment facts; the PM selects per task and never hardcodes them.
  return {
    product: { provider: '', model: '' },
    ux: { provider: '', model: '' },
    architecture: { provider: '', model: '' },
    code: { provider: '', model: '' },
    test: { provider: '', model: '' },
    release: { provider: '', model: '' },
    retrospective: { provider: '', model: '' },
  }
}

export function createProjectJson(input) {
  const createdAt = input.createdAt || new Date().toISOString()
  return {
    format: FORMAT,
    projectId: input.projectId,
    name: input.name,
    root: input.root || '.',
    createdAt,
    stageTemplate: STAGE_TEMPLATE,
    exportMap: defaultExportMap(),
    budget: defaultBudget(),
    providerRouting: defaultProviderRouting(),
    roles: { pm: '项目办公室', words: ROLE_WORDS },
  }
}

export const PROJECT_DIR = '.project'
export const PROJECT_JSON = 'project.json'
export const PROJECT_DB = 'project.db'
export const EXPORTS_DIR = 'exports'
export const INBOX_DIR = 'inbox'
export const PACKAGES_DIR = 'packages'

// ---------------------------------------------------------------------------
// 阶段模板：可配置（W2）
//
// 为什么要有这一段：模板原本是 registry.js 里的一个模块常量，project.json 里的
// stageTemplate 只被写入、从未被读回——改配置文件对已初始化的项目完全无效。
// 而 lumio 的真实生命周期（PRD-W* → PRD-AUDIT → DEV-W* → FILE-W* → CODE-W*）
// 与内置的 S1..S7 不是同一个坐标系，硬套会让阶段推进落在错误的语义上。
//
// 这里的职责边界：
//   - normalizeStageTemplate()：校验并规范化一份模板（纯函数，无 IO）。
//   - resolveStageTemplate()：从 project.json 取模板，缺失/非法时回退默认。
//   - 已有项目不会被自动改写——换模板要显式调用 planStageRemap() 并确认。
// ---------------------------------------------------------------------------

/** 模板里每个阶段最多允许的字符长度（防止畸形配置把 UX 撑爆）。 */
const MAX_STAGE_NAME = 40
const MAX_STAGE_KEY = 24

/**
 * 校验并规范化阶段模板。
 * 规则：非空数组；每项有非空 key/name；key 与 gate 各自唯一；position 由数组顺序决定。
 * @param {unknown} input 候选模板
 * @returns {{ok: true, template: Array<object>} | {ok: false, code: string, message: string}}
 */
export function normalizeStageTemplate(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate 必须是非空数组' }
  }
  const seenKeys = new Set()
  const seenGates = new Set()
  const template = []
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate[' + index + '] 必须是对象' }
    }
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!key) return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate[' + index + '].key 必须是非空字符串' }
    if (!name) return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate[' + index + '].name 必须是非空字符串' }
    if (key.length > MAX_STAGE_KEY) return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate[' + index + '].key 过长（>' + MAX_STAGE_KEY + '）' }
    if (name.length > MAX_STAGE_NAME) return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate[' + index + '].name 过长（>' + MAX_STAGE_NAME + '）' }
    if (seenKeys.has(key)) return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate 的 key 重复：' + key }
    seenKeys.add(key)
    const gate = raw.gate === undefined || raw.gate === null || raw.gate === '' ? null : String(raw.gate).trim()
    if (gate !== null) {
      if (seenGates.has(gate)) return { ok: false, code: 'POLICY_INVALID', message: 'stageTemplate 的 gate 重复：' + gate }
      seenGates.add(gate)
    }
    const types = Array.isArray(raw.deliverableTypes)
      ? raw.deliverableTypes.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : []
    template.push({ key, name, gate, deliverableTypes: types, position: index })
  }
  return { ok: true, template }
}

/**
 * 从 project.json 的形状里解析模板；缺失或非法时回退到内置默认。
 * @param {object|undefined} projectJson
 * @returns {{template: Array<object>, source: 'project.json'|'default', error?: {code:string,message:string}}}
 */
/**
 * 解析「每个阶段允许产出哪些文档类型」（B3：deliverableTypes 此前只写不读）。
 *
 * 为什么要读它：内置模板给 S1 写了 deliverableTypes:['prd']、S2 写 ['ux']……
 * 但这些声明从来没有被任何代码消费，于是「S1 阶段只能产 PRD」一直只是文案。
 * 设计 §12.1 把「每阶段写路径硬控制」列为阶段机的核心，这是它的最小可用版：
 * 不拦文件系统（那是 scope.js 的事），只拦**文档类型**这件可判定的事。
 *
 * 返回 stageKey → 允许的 type 数组。没有 deliverableTypes 的阶段不出现在 Map 里
 * （= 该阶段不做类型约束，例如 lumio 模板里只声明了部分阶段的场景）。
 * @returns {Map<string, string[]>}
 */
export function resolveStageDeliverables(projectJson) {
  const map = new Map()
  const resolved = resolveStageTemplate(projectJson)
  for (const stage of resolved.template || []) {
    const types = Array.isArray(stage.deliverableTypes) ? stage.deliverableTypes.filter((t) => typeof t === 'string' && t.trim() !== '') : []
    if (types.length > 0) map.set(String(stage.key), types)
  }
  return map
}

/**
 * 判断某阶段是否允许产出某文档类型（B3）。
 *
 * 三档结论，与 scope.js 的策略一致：能判定才判定，不能判定如实标注。
 *   { allowed: true,  enforced: false } —— 该阶段没声明 deliverableTypes，不约束
 *   { allowed: true,  enforced: true  } —— 声明了且类型在允许列表里
 *   { allowed: false, enforced: true  } —— 声明了但类型不在列表里 → 拒绝
 *
 * @returns {{allowed:boolean, enforced:boolean, stageKey?:string, allowedTypes?:string[], reason?:string}}
 */
export function checkDeliverableType(projectJson, stageKey, type) {
  if (!stageKey) return { allowed: true, enforced: false, reason: 'no-stage：当前没有 active 阶段，不做类型约束' }
  if (!type) return { allowed: true, enforced: false, reason: 'no-type：调用方没指定文档类型' }
  const deliverables = resolveStageDeliverables(projectJson)
  const allowedTypes = deliverables.get(String(stageKey))
  if (!allowedTypes) {
    return { allowed: true, enforced: false, stageKey: String(stageKey), reason: 'stage-declares-nothing：阶段 ' + stageKey + ' 没有声明 deliverableTypes' }
  }
  const allowed = allowedTypes.includes(String(type))
  return {
    allowed,
    enforced: true,
    stageKey: String(stageKey),
    allowedTypes,
    reason: allowed ? undefined : ('阶段 ' + stageKey + ' 只允许产出 ' + allowedTypes.join('/') + '，不接受 ' + type),
  }
}

export function resolveStageTemplate(projectJson) {
  const candidate = projectJson && projectJson.stageTemplate
  if (candidate === undefined || candidate === null) {
    return { template: STAGE_TEMPLATE, source: 'default' }
  }
  const normalized = normalizeStageTemplate(candidate)
  if (!normalized.ok) {
    // 不静默吞掉：回退默认，但把原因带出去，由调用方决定是否告警/拒绝启动。
    return { template: STAGE_TEMPLATE, source: 'default', error: { code: normalized.code, message: normalized.message } }
  }
  return { template: normalized.template, source: 'project.json' }
}

/**
 * 计算「现有阶段行 → 新模板」的差异，只报告不改写。
 * 已有项目换模板必须显式确认，因此这里只产出计划，不执行。
 * @param {Array<{key:string,name:string,status:string,gate:string|null,position:number}>} currentRows
 * @param {Array<object>} targetTemplate 已规范化的模板
 */
export function planStageRemap(currentRows, targetTemplate) {
  const currentByKey = new Map((currentRows || []).map((row) => [row.key, row]))
  const targetKeys = new Set(targetTemplate.map((stage) => stage.key))
  const added = targetTemplate.filter((stage) => !currentByKey.has(stage.key)).map((stage) => stage.key)
  const removed = (currentRows || []).filter((row) => !targetKeys.has(row.key)).map((row) => row.key)
  const renamed = []
  const regated = []
  for (const stage of targetTemplate) {
    const row = currentByKey.get(stage.key)
    if (!row) continue
    if (row.name !== stage.name) renamed.push({ key: stage.key, from: row.name, to: stage.name })
    const rowGate = row.gate === undefined ? null : row.gate
    if ((rowGate || null) !== (stage.gate || null)) regated.push({ key: stage.key, from: rowGate, to: stage.gate })
  }
  const activeRow = (currentRows || []).find((row) => row.status === 'active')
  const activeStays = activeRow ? targetKeys.has(activeRow.key) : false
  return {
    added,
    removed,
    renamed,
    regated,
    activeStage: activeRow ? activeRow.key : null,
    activeStageSurvives: activeStays,
    needsConfirmation: added.length > 0 || removed.length > 0 || renamed.length > 0 || regated.length > 0,
  }
}

/**
 * lumio 项目的真实生命周期（DEC-20261106-001 的 PRD → DEV → FILE → CODE 四段）。
 * 只作为「可选的命名模板」提供，不改变内置默认；由项目自己在 project.json 里选用。
 */
export const LUMIO_STAGE_TEMPLATE = [
  { key: 'PRD', name: '产品需求', gate: 'PRD-AUDIT', deliverableTypes: ['prd'] },
  { key: 'DEV', name: '开发设计', gate: 'DEV-GATE', deliverableTypes: ['design', 'adr', 'spec'] },
  { key: 'FILE', name: '文件级规格', gate: 'FILE-GATE', deliverableTypes: ['spec'] },
  { key: 'CODE', name: '编码实现', gate: 'CODE-GATE', deliverableTypes: ['report'] },
]
