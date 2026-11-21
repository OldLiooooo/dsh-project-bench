#!/usr/bin/env node
// W2 验收探针：在 lumio 真实项目库的副本上评估「换成 lumio 生命周期」的影响。
// 只读评估，不改任何数据；真实库不受影响。
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as defaults from '../../host/project-defaults.js'

const SRC = 'C:/Users/oldap/Documents/lumio/.project'
const dir = mkdtempSync(join(tmpdir(), 'w2-'))
for (const f of ['project.db', 'project.db-wal', 'project.db-shm', 'project.json']) {
  if (existsSync(join(SRC, f))) copyFileSync(join(SRC, f), join(dir, f))
}
const db = new DatabaseSync(join(dir, 'project.db'))
const rows = db.prepare('SELECT key, name, gate, status, position FROM stages ORDER BY position ASC').all()

console.log('=== 当前阶段（lumio 项目）===')
for (const r of rows) console.log('  ' + r.key.padEnd(4) + ' ' + r.name.padEnd(6) + ' gate=' + String(r.gate).padEnd(4) + ' status=' + r.status)

console.log('\n=== 换成 lumio 生命周期模板的影响 ===')
const plan = defaults.planStageRemap(rows, defaults.normalizeStageTemplate(defaults.LUMIO_STAGE_TEMPLATE).template)
console.log('  新增:', plan.added.join(', ') || '(无)')
console.log('  移除:', plan.removed.join(', ') || '(无)')
console.log('  改名:', plan.renamed.length ? JSON.stringify(plan.renamed) : '(无)')
console.log('  改门禁:', plan.regated.length ? JSON.stringify(plan.regated) : '(无)')
console.log('  当前阶段:', plan.activeStage, '| 换成新模板后是否还存在:', plan.activeStageSurvives)
console.log('  需要人确认:', plan.needsConfirmation)

console.log('\n=== 结论 ===')
if (!plan.activeStageSurvives) {
  console.log('  ⚠ 当前 active 阶段在新模板里不存在 —— 直接换会让项目"没有当前阶段"。')
  console.log('  这正是不做自动 remap 的原因：必须由人决定新模板里哪个阶段接手。')
} else {
  console.log('  active 阶段可延续；仍需人确认增删改。')
}
db.close()
rmSync(dir, { recursive: true, force: true })
console.log('\n(真实库未被触碰)')
