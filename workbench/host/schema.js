// SQLite schema for the project runtime (single writer). One workspace = one project = one DB.
// All DDL is idempotent; migrations are linear and recorded in schema_migrations.
//
// 版本历史：
//   v2  W1：append-only 触发器 + 唯一事实约束 + 状态枚举
//   v3  decisions.answer（人到底选了哪个选项）
//   v4  失败状态 / 租约栅栏 / 切片作用域 / 导出 outbox / 身份（见 §V4）
//   v5  Verified Done：slices 增 verified 状态与验收人 / 证据增 verified_at；触发器防「未验证冒充已完成」
export const SCHEMA_VERSION = 5

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
  "CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_path TEXT NOT NULL, content_hash TEXT NOT NULL, document_id TEXT, version INTEGER, kind TEXT NOT NULL DEFAULT 'inbox', imported_by TEXT, imported_at TEXT NOT NULL)",
  // ---- v4 新表（建表即幂等；迁移只补列/回填，不改这些 CREATE） ----
  // 切片写作用域：领域声明 + 路径模式；收工时用真实 git diff 校验（见 host/scope.js）。
  "CREATE TABLE IF NOT EXISTS slice_scopes (slice_id TEXT NOT NULL, project_id TEXT NOT NULL, path_pattern TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'glob', added_by TEXT, created_at TEXT NOT NULL, PRIMARY KEY(slice_id, path_pattern))",
  // 导出 outbox：文件系统与 DB 不在同一事务里，所以「要写哪些文件」先落盘成意图，
  // 写完再回填各自 hash/状态。崩溃后由 replayPendingExports 补偿（见 host/export.js）。
  "CREATE TABLE IF NOT EXISTS export_outbox (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, batch_id TEXT NOT NULL, doc_id TEXT, version INTEGER, kind TEXT NOT NULL DEFAULT 'document', path TEXT NOT NULL, content_hash TEXT, desired_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, settled_at TEXT)",
  "CREATE INDEX IF NOT EXISTS ix_outbox_batch ON export_outbox(project_id, batch_id, status)",
  // 人身份：单机单用户时只有一个 'local' 行；共享实例按登录主体逐行（见 host/identity.js）。
  "CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, subject TEXT NOT NULL, display_name TEXT, kind TEXT NOT NULL DEFAULT 'human', source TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL, UNIQUE(project_id, subject))",
  // 审批签名的结构化身份（approvals.approved_by 保持字符串向后兼容）。
  "CREATE TABLE IF NOT EXISTS approval_signers (approval_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, identity_id TEXT, subject TEXT NOT NULL, display_name TEXT, source TEXT NOT NULL DEFAULT 'local', client_hint TEXT, signed_at TEXT NOT NULL)"
]

export const DDL = STATEMENTS.join(';\n') + ';'

export function migrate(db, at = new Date().toISOString()) {
  db.exec(DDL)
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()
  const current = row && row.v !== null && row.v !== undefined ? Number(row.v) : 0
  if (current < 2) {
    // v1 -> v2：先去重再加约束。幂等：重复执行时去重删 0 行、DDL 全部 IF NOT EXISTS。
    migrateV2(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, at)
  }
  if (current < 3) {
    // v2 -> v3：补 decisions.answer —— 「人到底选了哪个选项」。
    // 设计文档 §7.2 的决策卡是「[批准 A] [选 B]」，但 v1/v2 的表里只有 approved/rejected，
    // 选项是纯展示，裁决结果根本记不下来选的是哪一条。这一列补上这个语义。
    migrateV3(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(3, at)
  }
  if (current < 4) {
    // v3 -> v4：失败原因 / 租约栅栏 / 切片作用域 / 导出 outbox / 身份。
    migrateV4(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(4, at)
  }
  if (current < 5) {
    // v4 -> v5：Verified Done。设计 §6.2 定「唯一进度口径 = 已验证完成」，但 v4 的 slices 状态枚举里
    // 根本没有 verified —— 进度、验证吞吐、一次验收通过率全都算不出来（没有分母）。
    migrateV5(db)
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(5, at)
  }
  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, at)
  }
  // 防线「每次打开都补齐」而不是「只在新库建一次」：
  // v4 之前 GUARD_TRIGGERS 只在 current<2 时执行，于是 v3 库永远拿不到后来新增的触发器。
  // 全部语句都是 IF NOT EXISTS，重复执行无副作用；放在迁移之后，保证引用的列已存在。
  ensureGuards(db)
  return SCHEMA_VERSION
}

/**
 * 幂等补齐 v2+v4 的全部防线（触发器 + 唯一索引）。
 * 必须在列迁移之后调用：v4 触发器引用 lease/approval 的 epoch 列。
 * @returns {{triggers:number, indexes:number}}
 */
export function ensureGuards(db) {
  let triggers = 0
  let indexes = 0
  for (const statement of GUARD_INDEXES) { db.exec(statement); indexes += 1 }
  for (const statement of GUARD_TRIGGERS) { db.exec(statement); triggers += 1 }
  return { triggers, indexes }
}

/**
 * v4 迁移：把「失败状态、栅栏、作用域、补偿、身份」这五件事需要的列补上。
 *
 * 为什么每一条都要有列而不是只写进 payload：
 *   - sessions.failure_*  —— 会话失败不记原因时，重启对账只能标 interrupted，人无法知道为什么；
 *                           「失败」必须是一个可查询的状态，而不是时间线里的一句自由文本。
 *   - sessions.attempt     —— 同一 (切片,角色) 的多次派活要能区分「第几次」，
 *                           否则重试与对账会把新旧两次混成一次。
 *   - leases.epoch         —— 租约抢占后旧持有者的写入必须被挡（见 host/leases.js 的 fence）。
 *   - approvals.epoch/…    —— 审批是对「某一版快照」的签名；快照换了一次就必须换 epoch。
 *   - exports.status/error —— 导出的部分失败要能被看见并补偿，而不是静默丢文件。
 *
 * 幂等：全部按列存在性跳过，重复执行不报错、不改数据。
 * @returns {{addedColumns:string[], backfilled:{sessionsEpoch:number, leasesEpoch:number}}}
 */
export function migrateV4(db) {
  const summary = { addedColumns: [], backfilled: { sessionsEpoch: 0, leasesEpoch: 0 } }
  const addColumn = (table, column, ddl) => {
    const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => String(row.name))
    if (columns.includes(column)) return false
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl)
    summary.addedColumns.push(table + '.' + column)
    return true
  }
  // 会话：失败原因与派活次数
  addColumn('sessions', 'failure_code', 'failure_code TEXT')
  addColumn('sessions', 'failure_detail', 'failure_detail TEXT')
  addColumn('sessions', 'failure_at', 'failure_at TEXT')
  addColumn('sessions', 'attempt', 'attempt INTEGER NOT NULL DEFAULT 1')
  // 租约：栅栏令牌（每次抢占 +1，旧令牌的写一律拒绝）
  const leasesEpochAdded = addColumn('leases', 'epoch', 'epoch INTEGER NOT NULL DEFAULT 1')
  // 审批：快照代次 + 驳回/过期原因（重提时旧审批要能说明为什么不再有效）
  addColumn('approvals', 'epoch', 'epoch INTEGER NOT NULL DEFAULT 1')
  addColumn('approvals', 'superseded_reason', 'superseded_reason TEXT')
  addColumn('approvals', 'superseded_by', 'superseded_by TEXT')
  // 导出：状态与错误（ok / pending / failed），既有行一律视为 ok
  addColumn('exports', 'error', 'error TEXT')
  addColumn('exports', 'batch_id', 'batch_id TEXT')
  // 切片：写作用域是否已声明（未声明 = 只能靠显式模式，不能默默放行）
  addColumn('slices', 'scope_declared', 'scope_declared INTEGER NOT NULL DEFAULT 0')
  if (leasesEpochAdded) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM leases').get()
    summary.backfilled.leasesEpoch = Number(row && row.n ? row.n : 0)
  }
  return summary
}

/**
 * 迁移后自检（P0）：确认「本该立起来的结构」真的立起来了。
 *
 * 为什么需要它：迁移函数是幂等的、每一步都 try 不了全局（SQLite DDL 不支持事务回滚 DDL 的部分场景），
 * 所以「迁移跑完没报错」不等于「结构对」。真出问题时最糟的表现是**静默半迁移**：
 * 库能打开、能读写，但某个触发器没建上 —— 于是一条本该被拒的非法写会悄悄成功。
 *
 * 检查项（都便宜，都是结构级事实）：
 *   ① schema_migrations 的 MAX(version) == SCHEMA_VERSION
 *   ② 13 个触发器全在（缺一个 = 一条不变量失守）
 *   ③ v4/v5 的关键列存在（列缺失会让读侧静默 undefined，最难查）
 *
 * @returns {{ok:boolean, issues:string[], version:number, triggers:number, columns:number}}
 */
export function verifyMigration(db) {
  const issues = []
  let version = 0
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()
    version = row && row.v !== null && row.v !== undefined ? Number(row.v) : 0
  } catch (error) { issues.push('读不到 schema_migrations：' + String(error.message || error)) }
  if (version !== SCHEMA_VERSION) issues.push('版本应到 v' + SCHEMA_VERSION + '，实际 v' + version)

  let triggers = 0
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => String(row.name))
    triggers = names.length
    const expected = GUARD_TRIGGERS.map((sql) => {
      const match = /CREATE TRIGGER IF NOT EXISTS (\w+)/.exec(sql)
      return match ? match[1] : null
    }).filter(Boolean)
    for (const name of expected) {
      if (!names.includes(name)) issues.push('缺触发器 ' + name)
    }
  } catch (error) { issues.push('读不到触发器：' + String(error.message || error)) }

  const REQUIRED_COLUMNS = {
    sessions: ['failure_code', 'failure_detail', 'failure_at', 'attempt'],
    leases: ['epoch'],
    approvals: ['epoch'],
    exports: ['error', 'batch_id'],
    slices: ['scope_declared', 'verified_by', 'verified_at', 'verified_session'],
    evidence: ['verified_at'],
    decisions: ['default_option'],
  }
  let columns = 0
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    try {
      const names = db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => String(row.name))
      columns += names.length
      for (const column of required) {
        if (!names.includes(column)) issues.push('缺列 ' + table + '.' + column)
      }
    } catch (error) { issues.push('读不到 ' + table + ' 的列：' + String(error.message || error)) }
  }
  return { ok: issues.length === 0, issues, version, triggers, columns }
}

/**
 * v5 迁移：Verified Done —— 把「已验证完成」变成数据模型里的一等状态。
 *
 * 为什么必须有这一步：设计 §6.2 定「唯一进度口径 = 已验证完成」，但 v4 的 slices 状态枚举是
 * open/in_progress/review/blocked/done/archived/cut，**没有 verified**。于是：
 *   - 进度百分比没有分子（done ≠ verified）；
 *   - evidence.verified_by 列存在却从没被写入，「谁验收的」不可追溯；
 *   - 「建造者不验收」只靠角色卡里一句提示词 —— 而提示词不算约束（设计逻辑 §8 第 1 条）。
 *
 * 语义约定（不做静默映射）：
 *   - 存量 done 行**保持 done**，不自动升级成 verified。done = 交付方自认完成；verified = 独立验收通过。
 *     自动升级等于伪造验收记录，而 events 是 append-only、事后无法纠正。
 *   - verified 是终态：guard_verified_slice_terminal 禁止 verified 回退（返工走新切片或 archived）。
 *
 * 幂等：全部按列存在性跳过。
 * @returns {{addedColumns:string[], backfilled:{verified:number}}}
 */
export function migrateV5(db) {
  const summary = { addedColumns: [], backfilled: { verified: 0 } }
  const columnsOf = (table) => db.prepare('PRAGMA table_info(' + table + ')').all().map((row) => String(row.name))
  const addColumn = (table, column, ddl) => {
    if (columnsOf(table).includes(column)) return false
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl)
    summary.addedColumns.push(table + '.' + column)
    return true
  }
  // 切片：谁在什么时候、从哪个会话验收的。
  addColumn('slices', 'verified_by', 'verified_by TEXT')
  addColumn('slices', 'verified_at', 'verified_at TEXT')
  addColumn('slices', 'verified_session', 'verified_session TEXT')
  // 证据：验收人（v4 只有列、没有写入点，见 BACKLOG B5）。
  addColumn('evidence', 'verified_at', 'verified_at TEXT')
  // 决策：超时后默认采用的选项（设计 §6.3；deadline 列 v1 就有，但一直没有写入入口与消费方）。
  addColumn('decisions', 'default_option', 'default_option TEXT')
  // 周期（设计 §5.4）：period 元数据此前从未被写入，route 图/燃起图没有分母。
  // 这里只补「能存」；推进周期是显式动作（period_roll），不做日历自动滚动 —— 自动滚动会让
  // 「这一周期做了什么」变成不可复核的推测。
  // 存量统计（只报告，不改数据）。
  const row = db.prepare("SELECT COUNT(*) AS n FROM slices WHERE status = 'verified'").get()
  summary.backfilled.verified = Number(row && row.n ? row.n : 0)
  return summary
}

/**
 * v3 迁移：给 decisions 加 answer 列（幂等 —— 已存在则跳过）。
 * 值域与写入约定：
 *   - answer 存**选项的 value**（A/B/C/D 或自定义 value），不存整句，便于机器读；
 *   - 无选项的决策（例如门禁只问「批准/驳回」）answer 为 NULL；
 *   - 兼容旧库：老行 answer 为 NULL，读侧按「未记录选哪项」处理，不报错。
 * @returns {{added:boolean, column:boolean}}
 */
export function migrateV3(db) {
  const columns = db.prepare('PRAGMA table_info(decisions)').all().map((row) => String(row.name))
  if (columns.includes('answer')) return { added: false, column: true }
  db.exec('ALTER TABLE decisions ADD COLUMN answer TEXT')
  return { added: true, column: true }
}

// ---------------------------------------------------------------------------
// v2：数据库层防线（W1）
//
// 为什么要有这一层：应用层（store/docs/leases）已经有 6 条会真的拒绝的写前校验，
// 但它们是"参与者自愿走应用层"才生效。任务会话带 bash + fs write，绕过应用层直连
// SQLite 时，上面那些规则一条都拦不住（实测见 docs/research/governance-facts/
// plugin-constraint-audit.zh.md）。
//
// 这里只钉「单调不变量」——它们的否定式永远不会是合法写入：
//   1. events / doc_versions 追加后不可改（append-only、版本只增）；
//   2. events.seq 必须连续（时间线可重放的前提）；
//   3. decision 终态不可回退、approval 通过后不可改判；
//   4. artifacts / evidence 一个事实一行（同 project+kind+path / project+kind+uri）。
//
// 刻意不做：「pending → approved 只能由人触发」。SQLite 触发器只认数据，不认发起者，
// 加这样的规则挡不住伪造首次批准，却会给人虚假的安全感（见计划的 W1「不做」一节）。
// ---------------------------------------------------------------------------

export const IMMUTABLE_TABLES = ['events', 'doc_versions']

/** v2 追加的触发器：全部 BEFORE 级 RAISE(ABORT)，错误信息即拒绝码。 */
export const GUARD_TRIGGERS = [
  // events：append-only
  `CREATE TRIGGER IF NOT EXISTS guard_events_no_update BEFORE UPDATE ON events
   BEGIN SELECT RAISE(ABORT, 'EVENT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS guard_events_no_delete BEFORE DELETE ON events
   BEGIN SELECT RAISE(ABORT, 'EVENT_IMMUTABLE'); END`,
  // events.seq：必须是该项目的 MAX(seq)+1（禁止跳号与倒填）
  `CREATE TRIGGER IF NOT EXISTS guard_events_seq_contiguous BEFORE INSERT ON events
   WHEN NEW.seq != (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE project_id = NEW.project_id)
   BEGIN SELECT RAISE(ABORT, 'SEQ_NOT_CONTIGUOUS'); END`,
  // doc_versions：版本行不可删、正文与 hash 不可改（frozen 仍可被 freezeDocument 更新）
  `CREATE TRIGGER IF NOT EXISTS guard_doc_versions_no_delete BEFORE DELETE ON doc_versions
   BEGIN SELECT RAISE(ABORT, 'DOCVERSION_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS guard_doc_versions_body_immutable BEFORE UPDATE OF content, content_hash ON doc_versions
   BEGIN SELECT RAISE(ABORT, 'DOCVERSION_IMMUTABLE'); END`,
  // decisions：终态不可回退（pending -> approved/rejected 允许，反向不允许）
  `CREATE TRIGGER IF NOT EXISTS guard_decisions_terminal BEFORE UPDATE OF status ON decisions
   WHEN OLD.status IN ('approved', 'rejected') AND NEW.status != OLD.status
   BEGIN SELECT RAISE(ABORT, 'DECISION_TERMINAL'); END`,
  // approvals：已通过的审批行不可改判
  `CREATE TRIGGER IF NOT EXISTS guard_approvals_terminal BEFORE UPDATE OF status ON approvals
   WHEN OLD.status IN ('approved', 'rejected') AND NEW.status != OLD.status
   BEGIN SELECT RAISE(ABORT, 'APPROVAL_TERMINAL'); END`,
  // ---- v4：栅栏与终态（同样只认数据，不认发起者）----
  // 租约 epoch 只能单调增：栅栏令牌一旦被回退，旧持有者就能重新写（这就是 fencing token 的意义）。
  `CREATE TRIGGER IF NOT EXISTS guard_lease_epoch_monotonic BEFORE UPDATE OF epoch ON leases
   WHEN NEW.epoch < OLD.epoch
   BEGIN SELECT RAISE(ABORT, 'LEASE_EPOCH_REGRESSION'); END`,
  // 任务会话终态不可复活：复活会让「租约已释放 + 又持租」与 attempt 账同时错位。
  `CREATE TRIGGER IF NOT EXISTS guard_task_session_terminal BEFORE UPDATE OF status ON sessions
   WHEN OLD.kind = 'task' AND OLD.status != 'active' AND NEW.status = 'active'
   BEGIN SELECT RAISE(ABORT, 'SESSION_TERMINAL'); END`,
  // 审批 epoch 只能单调增：批准必须对「提交时那一代快照」签名。
  `CREATE TRIGGER IF NOT EXISTS guard_approval_epoch_monotonic BEFORE UPDATE OF epoch ON approvals
   WHEN NEW.epoch < OLD.epoch
   BEGIN SELECT RAISE(ABORT, 'APPROVAL_EPOCH_REGRESSION'); END`,
  // 已完成的导出意图不可回退成 pending：否则补偿会无限重放已成功的写。
  `CREATE TRIGGER IF NOT EXISTS guard_outbox_done_terminal BEFORE UPDATE OF status ON export_outbox
   WHEN OLD.status = 'done' AND NEW.status != 'done'
   BEGIN SELECT RAISE(ABORT, 'OUTBOX_TERMINAL'); END`,
  // ---- v5：Verified Done ----
  // 已验收的切片不可回退成未验收：验收是一次人/独立验证者签的字，
  // 允许回退等于允许「悄悄撤回」一次验收结论，而 events 是 append-only、撤不回记录。
  // 返工的正确路径是：新切片，或先 archived 再开新切片。
  `CREATE TRIGGER IF NOT EXISTS guard_verified_slice_terminal BEFORE UPDATE OF status ON slices
   WHEN OLD.status = 'verified' AND NEW.status != 'verified'
   BEGIN SELECT RAISE(ABORT, 'SLICE_VERIFIED_TERMINAL'); END`,
  // 未验收不能冒充已验证：verified_by 为空时不允许写 verified（防止代码路径漏填）。
  `CREATE TRIGGER IF NOT EXISTS guard_verified_requires_signer BEFORE UPDATE OF status ON slices
   WHEN NEW.status = 'verified' AND (NEW.verified_by IS NULL OR TRIM(NEW.verified_by) = '')
   BEGIN SELECT RAISE(ABORT, 'VERIFY_REQUIRES_SIGNER'); END`
]

/** v2 追加的唯一索引：一个事实一行。 */
export const GUARD_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_artifacts_fact ON artifacts(project_id, kind, path)`,
  // uri 允许 NULL（运行期证据可能没有文件），非 NULL 时必须唯一
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_evidence_fact ON evidence(project_id, kind, uri) WHERE uri IS NOT NULL`
]

/** v2 的状态枚举：每个实体一张白名单，迁移时用它校验存量数据。 */
export const STATUS_ENUMS = {
  // v5 加 verified：交付方自认完成（done）与独立验收通过（verified）是两件事，
  // 设计 §6.2 的「唯一进度口径」只认后者。
  slices: ['open', 'in_progress', 'review', 'blocked', 'done', 'verified', 'archived', 'cut'],
  tasks: ['pending', 'in_progress', 'review', 'blocked', 'done', 'failed'],
  decisions: ['pending', 'approved', 'rejected', 'superseded', 'hang'],
  approvals: ['pending', 'approved', 'rejected'],
  documents: ['draft', 'review', 'approved', 'frozen'],
  sessions: ['active', 'done', 'failed', 'interrupted', 'ended'],
  // retired：换阶段模板时被替换掉的旧阶段（保留行与历史事件，不删除）。
  stages: ['pending', 'active', 'done', 'retired'],
  // v4：导出的三种结果（部分失败要能被看见，而不是静默丢文件）。
  exports: ['ok', 'pending', 'failed'],
  export_outbox: ['pending', 'done', 'failed'],
}

/**
 * v2 迁移：先降噪（去重）再加约束，任何一步失败都整体回滚。
 * 去重策略：保留最早创建的一行（rowid 最小），删除其后完全重复的行。
 * @returns {{dedupedArtifacts:number, dedupedEvidence:number, triggers:number, indexes:number}}
 */
export function migrateV2(db) {
  const summary = { dedupedArtifacts: 0, dedupedEvidence: 0, triggers: 0, indexes: 0 }
  const dupArtifacts = db.prepare(
    `SELECT COUNT(*) AS n FROM artifacts WHERE rowid NOT IN (
       SELECT MIN(rowid) FROM artifacts GROUP BY project_id, kind, path)`,
  ).get()
  const dupEvidence = db.prepare(
    `SELECT COUNT(*) AS n FROM evidence WHERE uri IS NOT NULL AND rowid NOT IN (
       SELECT MIN(rowid) FROM evidence WHERE uri IS NOT NULL GROUP BY project_id, kind, uri)`,
  ).get()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`DELETE FROM artifacts WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM artifacts GROUP BY project_id, kind, path)`)
    db.exec(`DELETE FROM evidence WHERE uri IS NOT NULL AND rowid NOT IN (
      SELECT MIN(rowid) FROM evidence WHERE uri IS NOT NULL GROUP BY project_id, kind, uri)`)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch (rollbackError) { /* 保留原始错误 */ }
    throw error
  }
  summary.dedupedArtifacts = Number(dupArtifacts && dupArtifacts.n ? dupArtifacts.n : 0)
  summary.dedupedEvidence = Number(dupEvidence && dupEvidence.n ? dupEvidence.n : 0)
  // 约束与索引各自独立提交：SQLite 的 DDL 可回滚，但分开执行便于报错定位。
  for (const statement of GUARD_INDEXES) { db.exec(statement); summary.indexes += 1 }
  for (const statement of GUARD_TRIGGERS) { db.exec(statement); summary.triggers += 1 }
  return summary
}

/**
 * 存量数据的状态校验：迁移前后都可用，返回越界行（不抛错，由调用方决定）。
 * 接受 ProjectDb 包装器或裸 DatabaseSync —— 前者是调用方最常见的手上对象。
 */
export function auditStatuses(db) {
  const raw = db && db.db ? db.db : db
  const findings = []
  for (const [table, allowed] of Object.entries(STATUS_ENUMS)) {
    let rows = []
    try { rows = raw.prepare('SELECT status, COUNT(*) AS n FROM ' + table + ' GROUP BY status').all() } catch (error) { continue }
    for (const row of rows) {
      if (!allowed.includes(String(row.status))) findings.push({ table, status: String(row.status), count: Number(row.n) })
    }
  }
  return findings
}
