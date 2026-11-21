
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
const { migrate, auditStatuses, SCHEMA_VERSION } = await import('../../host/schema.js')

// 探针会读工作区外的真实库副本并打印报告：被 import（例如 check-syntax）时绝不能执行。
const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (!isMain) {
  // imported: nothing to run
} else {
const SRC = process.env.WORKBENCH_REALDB_SRC || 'C:/Users/oldap/Documents/lumio/.project'
const dir = mkdtempSync(join(tmpdir(), 'mig-'))
for (const f of ['project.db','project.db-wal','project.db-shm']) {
  if (existsSync(join(SRC,f))) copyFileSync(join(SRC,f), join(dir,f))
}
const db = new DatabaseSync(join(dir,'project.db'))
console.log('=== 迁移前 ===')
console.log(' evidence:', db.prepare('SELECT COUNT(*) c FROM evidence').get().c, '| artifacts:', db.prepare('SELECT COUNT(*) c FROM artifacts').get().c)
console.log(' 重复 evidence:', JSON.stringify(db.prepare("SELECT kind,uri,COUNT(*) n FROM evidence WHERE uri IS NOT NULL GROUP BY kind,uri HAVING n>1").all()))
console.log(' schema 版本:', JSON.stringify(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()))
console.log(' 状态越界:', JSON.stringify(auditStatuses(db)))

const t0 = Date.now()
const v = migrate(db)
console.log('\n=== 迁移后（耗时 ' + (Date.now()-t0) + 'ms, 目标版本 ' + v + '）===')
console.log(' evidence:', db.prepare('SELECT COUNT(*) c FROM evidence').get().c, '| artifacts:', db.prepare('SELECT COUNT(*) c FROM artifacts').get().c)
console.log(' 重复 evidence:', JSON.stringify(db.prepare("SELECT kind,uri,COUNT(*) n FROM evidence WHERE uri IS NOT NULL GROUP BY kind,uri HAVING n>1").all()))
console.log(' 触发器:', db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'").get().c)
console.log(' 唯一索引:', db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'ux_%'").all().map(r=>r.name).join(','))
console.log(' schema 版本:', JSON.stringify(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()))
console.log(' 状态越界:', JSON.stringify(auditStatuses(db)))
console.log(' 事件数不变:', db.prepare('SELECT COUNT(*) c FROM events').get().c)
console.log(' doc_versions 不变:', db.prepare('SELECT COUNT(*) c FROM doc_versions').get().c)

// 幂等：再跑一次
migrate(db)
console.log('\n=== 二次迁移（幂等）===')
console.log(' evidence:', db.prepare('SELECT COUNT(*) c FROM evidence').get().c, '| 触发器:', db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'").get().c, '| 版本行:', db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c)
db.close(); rmSync(dir,{recursive:true,force:true})
console.log('done (真实库未被触碰)')
}
