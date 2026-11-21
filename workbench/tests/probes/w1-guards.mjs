#!/usr/bin/env node
// W1 验收探针：绕过应用层直连 SQLite，验证 v2 防线是否真的会拒绝。
// 用法：node workbench/tests/probes/w1-guards.mjs
// 退出码：0 = 全部符合预期；1 = 有任一断言不符。
import { ProjectDb } from '../../host/db.js'
import * as store from '../../host/store.js'
import * as docs from '../../host/docs.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

// 探针会用 process.exit 报结果：被 import（例如 check-syntax）时绝不能执行。
const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) {

const dir = mkdtempSync(join(tmpdir(), 'w1-'))
const db = new ProjectDb(join(dir, 'project.db'), { projectId: 'prj-w1', projectName: 'W1', root: dir })
const raw = db.db
let failures = 0

const expectBlocked = (label, fn) => {
  try { fn(); failures += 1; console.log('  FAIL     ' + label + '  <-- 应被拒但放行了') }
  catch (e) { console.log('  BLOCKED  ' + label + '  [' + String(e.message || '').split('\n')[0].slice(0, 44) + ']') }
}
const expectAllowed = (label, fn) => {
  try { fn(); console.log('  ALLOWED  ' + label) }
  catch (e) { failures += 1; console.log('  FAIL     ' + label + '  <-- 应放行但被拒 [' + String(e.message || '').split('\n')[0].slice(0, 44) + ']') }
}

// 基线数据
const s = store.createSlice(db, { key: 'w1', title: 'W1', type: 'workitem' })
db.tx(() => db.appendEvent({ kind: 'test/base' }))
const doc = docs.createDocument(db, { sliceId: s.id, type: 'prd', logicalKey: 'prd/w1', title: 'W1' })
docs.writeDocumentVersion(db, { docId: doc.id, content: 'v1' })
store.addArtifact(db, { sliceId: s.id, kind: 'code-file', path: 'a.js' })
store.addEvidence(db, { sliceId: s.id, kind: 'command', uri: 'EV-1.md', resultSummary: 'x' })
const dec = store.createDecision(db, { title: 'D', question: 'Q', options: ['a'] })

console.log('=== 反证：绕过应用层直连 DB（必须全部 BLOCKED）===')
expectBlocked('删 events 行（append-only）', () => raw.exec("DELETE FROM events WHERE kind='test/base'"))
expectBlocked('改 events payload', () => raw.exec("UPDATE events SET payload_json='{}' WHERE kind='test/base'"))
expectBlocked('插一条跳号 event', () => raw.prepare('INSERT INTO events(id,project_id,seq,at,kind,payload_json) VALUES (?,?,?,?,?,?)').run('e-x', 'prj-w1', 999, 'now', 'x', '{}'))
expectBlocked('删 doc_versions（版本只增）', () => raw.exec('DELETE FROM doc_versions'))
expectBlocked('改 doc_versions 正文', () => raw.exec("UPDATE doc_versions SET content='forged'"))
expectBlocked('重复 artifact（同 path 同 kind）', () => raw.prepare('INSERT INTO artifacts(id,project_id,kind,path,created_at) VALUES (?,?,?,?,?)').run('a-dup', 'prj-w1', 'code-file', 'a.js', 'now'))
expectBlocked('重复 evidence（同 uri 同 kind）', () => raw.prepare('INSERT INTO evidence(id,project_id,kind,uri,result_summary,created_at) VALUES (?,?,?,?,?,?)').run('ev-dup', 'prj-w1', 'command', 'EV-1.md', 'y', 'now'))
raw.exec("UPDATE decisions SET status='approved' WHERE id='" + dec.id + "'")
expectBlocked('把已批准 decision 改回 pending', () => raw.exec("UPDATE decisions SET status='pending' WHERE id='" + dec.id + "'"))

console.log('\n=== 合法写必须仍然通过（必须全部 ALLOWED）===')
expectAllowed('正常追加 event（seq 连续）', () => db.tx(() => db.appendEvent({ kind: 'test/ok' })))
expectAllowed('冻结版本（只改 frozen 列）', () => docs.freezeDocument(db, { docId: doc.id }))
expectAllowed('正常 artifact 新路径', () => store.addArtifact(db, { sliceId: s.id, kind: 'code-file', path: 'b.js' }))
expectAllowed('pending decision 正常落定', () => {
  const d2 = store.createDecision(db, { title: 'D2', question: 'Q', options: ['a'] })
  store.resolveDecision(db, { id: d2.id, status: 'rejected', decidedBy: 'user' })
})

console.log('\n=== 事实核对 ===')
console.log('  触发器 7 条:', raw.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger'").get().c)
console.log('  事件数（应 12）:', raw.prepare('SELECT COUNT(*) AS c FROM events').get().c)
console.log('  doc_versions（应 1）:', raw.prepare('SELECT COUNT(*) AS c FROM doc_versions').get().c)
console.log('  artifacts（应 2）:', raw.prepare('SELECT COUNT(*) AS c FROM artifacts').get().c)
console.log('  evidence（应 1）:', raw.prepare('SELECT COUNT(*) AS c FROM evidence').get().c)
console.log('  迁移版本:', JSON.stringify(raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all()))

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\nRESULT: PASS（8 项反证全拦、4 项合法写全放行）' : '\nRESULT: FAIL（' + failures + ' 项不符预期）')
process.exitCode = failures === 0 ? 0 : 1
}
