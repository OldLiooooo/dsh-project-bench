// PoC Host plugin: verify node:sqlite + plugin load + custom web route.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const inject = ['webServer']

export function apply(ctx) {
  const root = process.cwd()
  const dir = join(root, '.poc')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'probe.db'))
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS probe(id TEXT PRIMARY KEY, at TEXT NOT NULL, note TEXT);
    CREATE VIRTUAL TABLE IF NOT EXISTS probe_fts USING fts5(note, tokenize='trigram');`)
  db.prepare('INSERT OR REPLACE INTO probe(id, at, note) VALUES (?, ?, ?)').run('boot', new Date().toISOString(), 'node:sqlite inside DSH host plugin')
  db.prepare('INSERT INTO probe_fts(note) VALUES (?)').run('node:sqlite inside DSH host plugin')
  const row = db.prepare('SELECT note FROM probe WHERE id = ?').get('boot')
  const hit = db.prepare("SELECT count(*) AS n FROM probe_fts WHERE probe_fts MATCH ?").get('"sqlite inside"')
  writeFileSync(join(dir, 'host-probe.json'), JSON.stringify({ ok: true, sqlite: process.versions.sqlite ?? 'n/a', row, ftsHits: hit.n, at: new Date().toISOString() }, null, 2))
  console.log('[poc-host-probe] loaded; sqlite row =', JSON.stringify(row), 'ftsHits =', hit.n)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/poc/probe',
    handler: async (_req, res) => {
      const now = db.prepare('SELECT note, at FROM probe WHERE id = ?').get('boot')
      const hits = db.prepare("SELECT count(*) AS n FROM probe_fts WHERE probe_fts MATCH ?").get('"sqlite inside"')
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: true, route: 'webServer', row: now, ftsHits: hits.n }))
    },
  }), 'poc-host-probe: GET /poc/probe')
}
