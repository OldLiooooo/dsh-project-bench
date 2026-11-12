// SQLite schema for the project runtime (single writer). One workspace = one project = one DB.
// All DDL is idempotent; migrations are linear and recorded in schema_migrations.
export const SCHEMA_VERSION = 1

const STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS project_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL, stage_template_json TEXT NOT NULL DEFAULT '[]', config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS stages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', gate TEXT, started_at TEXT, ended_at TEXT, position INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, key))",
  "CREATE TABLE IF NOT EXISTS slices (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'workitem', key TEXT NOT NULL, title TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL DEFAULT 'open', owner_role TEXT, owner_session TEXT, current_handoff TEXT, acceptance_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, key))",
  "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slice_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', assignee_session TEXT, acceptance_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ix_tasks_slice ON tasks(project_id, slice_id, status)",
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, role TEXT, slice_id TEXT, dsh_session_id TEXT, parent_session_id TEXT, provider TEXT, model TEXT, reasoning_effort TEXT, status TEXT NOT NULL DEFAULT 'active', started_at TEXT NOT NULL, ended_at TEXT, handoff_id TEXT, context_json TEXT NOT NULL DEFAULT '{}', UNIQUE(project_id, dsh_session_id))",
  "CREATE INDEX IF NOT EXISTS ix_sessions_kind ON sessions(project_id, kind, status)",
  "CREATE INDEX IF NOT EXISTS ix_sessions_slice ON sessions(project_id, slice_id, status)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_active_role ON sessions(project_id, slice_id, role) WHERE status = 'active' AND kind = 'task'",
  "CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_active_name ON sessions(project_id, name) WHERE status = 'active'",
  "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slice_id TEXT, type TEXT NOT NULL, logical_key TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', current_version INTEGER NOT NULL DEFAULT 0, owner_session TEXT, stage TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, logical_key))",
  "CREATE INDEX IF NOT EXISTS ix_documents_slice ON documents(project_id, slice_id, status)",
  "CREATE TABLE IF NOT EXISTS doc_versions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, author_session TEXT, event_id TEXT, frozen INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(document_id, version))",
  "CREATE TABLE IF NOT EXISTS doc_sections (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, version INTEGER NOT NULL, ordinal INTEGER NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL, UNIQUE(document_id, version, ordinal))",
  "CREATE INDEX IF NOT EXISTS ix_doc_sections_doc ON doc_sections(document_id, version, ordinal)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(document_id UNINDEXED, version UNINDEXED, heading, content, tokenize = 'trigram')",
  "CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slice_id TEXT, kind TEXT NOT NULL DEFAULT 'decision', title TEXT NOT NULL, question TEXT NOT NULL, options_json TEXT NOT NULL DEFAULT '[]', recommended TEXT, consequences TEXT, status TEXT NOT NULL DEFAULT 'pending', irreversible INTEGER NOT NULL DEFAULT 0, deadline TEXT, decided_by TEXT, rationale TEXT, stage TEXT, gate TEXT, created_by TEXT, created_at TEXT NOT NULL, decided_at TEXT)",
  "CREATE INDEX IF NOT EXISTS ix_decisions_status ON decisions(project_id, status, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, stage TEXT, gate TEXT, decision_id TEXT, status TEXT NOT NULL DEFAULT 'pending', evidence_ids_json TEXT NOT NULL DEFAULT '[]', snapshot_json TEXT NOT NULL DEFAULT '{}', approved_by TEXT, approved_at TEXT)",
  "CREATE INDEX IF NOT EXISTS ix_approvals_gate ON approvals(project_id, gate, status)",
  "CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slice_id TEXT, task_id TEXT, kind TEXT NOT NULL, uri TEXT, content_hash TEXT, command TEXT, result_summary TEXT NOT NULL DEFAULT '', created_by TEXT, verified_by TEXT, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ix_evidence_slice ON evidence(project_id, slice_id, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slice_id TEXT, kind TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT, bytes INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ix_artifacts_slice ON artifacts(project_id, slice_id, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, actor_session TEXT, role TEXT, slice_id TEXT, subject_type TEXT, subject_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}', UNIQUE(project_id, seq))",
  "CREATE INDEX IF NOT EXISTS ix_events_seq ON events(project_id, seq DESC)",
  "CREATE INDEX IF NOT EXISTS ix_events_kind ON events(project_id, kind, at DESC)",
  "CREATE INDEX IF NOT EXISTS ix_events_subject ON events(project_id, subject_type, subject_id, seq DESC)",
  "CREATE TABLE IF NOT EXISTS links (src_type TEXT NOT NULL, src_id TEXT NOT NULL, dst_type TEXT NOT NULL, dst_id TEXT NOT NULL, rel TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(src_type, src_id, dst_type, dst_id, rel))",
  "CREATE TABLE IF NOT EXISTS leases (slice_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS exports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, content_hash TEXT, version INTEGER, exported_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok')",
  "CREATE INDEX IF NOT EXISTS ix_exports_project ON exports(project_id, exported_at DESC)",
  "CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_path TEXT NOT NULL, content_hash TEXT NOT NULL, document_id TEXT, version INTEGER, kind TEXT NOT NULL DEFAULT 'inbox', imported_by TEXT, imported_at TEXT NOT NULL)"
]

export const DDL = STATEMENTS.join(';\n') + ';'

export function migrate(db, at = new Date().toISOString()) {
  db.exec(DDL)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()
  const current = row && row.v !== null && row.v !== undefined ? Number(row.v) : 0
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, at)
  }
  return SCHEMA_VERSION
}
