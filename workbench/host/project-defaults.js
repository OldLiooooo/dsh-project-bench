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

export const ROLE_WORDS = ['产品', 'UX', '架构', '码农', '测试', '发布', '复盘']

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
