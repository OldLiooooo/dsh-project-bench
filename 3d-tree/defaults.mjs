// 3d-tree/defaults.mjs
//
// 阶段模板的默认值。**镜像自 workbench/host/project-defaults.js 的 STAGE_TEMPLATE**
// （那份是唯一事实源）。这里之所以复制而不是 import：
//   3d-tree/ 是一个可独立启动、可整目录拷走的只读服务，不该在运行时依赖插件目录结构。
// 漂移由 tests/model.test.mjs 里的「镜像一致性」用例守住：文件存在就逐字比对。

export const MIRROR_SOURCE = 'workbench/host/project-defaults.js'

/** 与 project-defaults.js 的 STAGE_TEMPLATE 逐字一致。 */
export const DEFAULT_STAGE_TEMPLATE = [
  { key: 'S1', name: '产品', gate: 'G1', deliverableTypes: ['prd'] },
  { key: 'S2', name: 'UX', gate: 'G2', deliverableTypes: ['ux'] },
  { key: 'S3', name: '架构', gate: 'G3', deliverableTypes: ['adr', 'design', 'spec'] },
  { key: 'S4', name: '实现', gate: 'G4', deliverableTypes: ['design', 'report'] },
  { key: 'S5', name: '测试', gate: 'G5', deliverableTypes: ['report'] },
  { key: 'S6', name: '发布', gate: 'G6', deliverableTypes: ['report'] },
  { key: 'S7', name: '复盘', gate: 'G7', deliverableTypes: ['retro'] },
]

/** 文档状态 -> 完成度权重。冻结/批准算完成，评审中算大半，草稿算起步。 */
export const DOC_STATE_WEIGHT = { frozen: 1, approved: 1, review: 0.6, draft: 0.3 }

/** 任务状态 -> 完成度权重。 */
export const TASK_STATUS_WEIGHT = { done: 1, review: 0.7, in_progress: 0.4, pending: 0, blocked: 0, failed: 0 }

/** 切片状态：cut/archived 不参与总完成度（已出局，不该稀释分母）。 */
export const SLICE_EXCLUDED_STATUS = new Set(['archived', 'cut'])

/** 决策状态：这几个算已拍板。 */
export const DECISION_RESOLVED_STATUS = new Set(['approved', 'rejected', 'superseded'])

/** 扫描时跳过的目录名（体积大或纯运行时产物）。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.runtime', '.pnpm-store', '.devhome', '.dsh-poc', '.poc',
  'dist', 'build', '.cache', '.tmp', 'tmp',
])
