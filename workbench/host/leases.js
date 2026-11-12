// 写作用域租约（T1）：同一切片同一时刻只有一个任务会话可写。
// 规则（合同 §3）：
// - 未过期且他人持租 -> LEASE_HELD（错误 code）。
// - 过期租约可抢占（takeover），并记录事件；同一 session 重复 acquire 视为续期。
// - PM 会话不受租约限制（由工具层判断；这里对 pm 会话 id 做防御性放行）。
// - 释放只允许持租者；租约不存在时释放幂等（released=false）。
import { fail, requireProjectId } from './db.js'
import { nowIso } from './util.js'

export const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000

function requiredText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw fail('INVALID', field + ' 必须是非空字符串')
  return value.trim()
}

function expiresAtMs(lease) {
  const parsed = Date.parse(lease.expiresAt)
  return Number.isFinite(parsed) ? parsed : 0
}

export function mapLease(row) {
  if (!row) return undefined
  return {
    sliceId: row.slice_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    expiresAt: row.expires_at,
    reason: row.reason ?? undefined,
    createdAt: row.created_at,
  }
}

export function getLease(db, sliceId) {
  if (!sliceId) return undefined
  const row = db.db.prepare('SELECT * FROM leases WHERE slice_id = ? AND project_id = ?').get(sliceId, requireProjectId(db))
  return mapLease(row)
}

function requireSlice(db, sliceId) {
  const row = db.db.prepare('SELECT id FROM slices WHERE id = ? AND project_id = ?').get(sliceId, requireProjectId(db))
  if (!row) throw fail('NOT_FOUND', 'slice not found: ' + sliceId)
  return row.id
}

export function acquireLease(db, input = {}) {
  const sliceId = requiredText(input.sliceId, 'sliceId')
  const sessionId = requiredText(input.sessionId, 'sessionId')
  requireSlice(db, sliceId)
  const ttlValue = Number(input.ttlMs)
  const ttlMs = Number.isFinite(ttlValue) && ttlValue > 0 ? Math.floor(ttlValue) : DEFAULT_LEASE_TTL_MS
  return db.tx(() => {
    const now = Date.now()
    const existing = getLease(db, sliceId)
    const active = Boolean(existing) && expiresAtMs(existing) > now
    if (active && existing.sessionId !== sessionId) {
      throw fail('LEASE_HELD', '切片写作用域被其它会话持有：' + existing.sessionId, {
        sliceId: sliceId,
        holder: existing.sessionId,
        expiresAt: existing.expiresAt,
      })
    }
    const renewed = active && existing.sessionId === sessionId
    const expiresAt = new Date(now + ttlMs).toISOString()
    const at = nowIso()
    const reason = input.reason === undefined || input.reason === null ? null : String(input.reason)
    if (existing) {
      // 续期保留 created_at；抢占（过期）刷新 created_at。
      db.db.prepare('UPDATE leases SET session_id = ?, expires_at = ?, reason = ?, created_at = ? WHERE slice_id = ?')
        .run(sessionId, expiresAt, reason, renewed ? existing.createdAt : at, sliceId)
    } else {
      db.db.prepare('INSERT INTO leases(slice_id, project_id, session_id, expires_at, reason, created_at) VALUES (?,?,?,?,?,?)')
        .run(sliceId, db.projectId, sessionId, expiresAt, reason, at)
    }
    db.appendEvent({
      kind: 'lease/acquire',
      sliceId: sliceId,
      subjectType: 'lease',
      subjectId: sliceId,
      actorSession: sessionId,
      payload: {
        sessionId: sessionId,
        ttlMs: ttlMs,
        expiresAt: expiresAt,
        renewed: renewed,
        previousHolder: existing && !renewed ? existing.sessionId : undefined,
      },
    })
    return getLease(db, sliceId)
  })
}

export function releaseLease(db, input = {}) {
  const sliceId = requiredText(input.sliceId, 'sliceId')
  const sessionId = requiredText(input.sessionId, 'sessionId')
  return db.tx(() => {
    const existing = getLease(db, sliceId)
    if (!existing) return { released: false, sliceId: sliceId, sessionId: sessionId }
    if (existing.sessionId !== sessionId) {
      throw fail('LEASE_HELD', '租约由其它会话持有，不能释放：' + existing.sessionId, {
        sliceId: sliceId,
        holder: existing.sessionId,
      })
    }
    db.db.prepare('DELETE FROM leases WHERE slice_id = ?').run(sliceId)
    db.appendEvent({
      kind: 'lease/release',
      sliceId: sliceId,
      subjectType: 'lease',
      subjectId: sliceId,
      actorSession: sessionId,
      payload: { sessionId: sessionId },
    })
    return { released: true, sliceId: sliceId, sessionId: sessionId }
  })
}

/**
 * 只读检查：ok=true 表示「当前会话持有有效租约」。
 * - 无租约 -> {ok:false, required:true}；
 * - 租约已过期 -> {ok:false, expired:true, holder}（可被抢占，不算有效）；
 * - 有效租约但持租者是他人 -> {ok:false, holder}。
 * 注意：是否允许「无租约写」由 assertWriteScope / 工具层决定（产品/UX 阶段通常无租约）。
 */
export function checkLease(db, input = {}) {
  const sliceId = input.sliceId
  if (!sliceId) throw fail('INVALID', 'sliceId 必须是非空字符串')
  const sessionId = input.sessionId
  const existing = getLease(db, sliceId)
  if (!existing) return { ok: false, sliceId: sliceId, holder: undefined, required: true }
  const active = expiresAtMs(existing) > Date.now()
  if (!active) return { ok: false, sliceId: sliceId, holder: existing, expired: true }
  if (sessionId && existing.sessionId === sessionId) return { ok: true, sliceId: sliceId, holder: existing }
  return { ok: false, sliceId: sliceId, holder: existing }
}

/**
 * 写文档/证据/任务状态前调用：PM 会话放行；他人有效租约 -> LEASE_HELD；
 * 无租约放行（租约只约束实现阶段的并发，产品/UX 等阶段由工具层做角色校验）。
 */
export function assertWriteScope(db, input = {}) {
  const sliceId = requiredText(input.sliceId, 'sliceId')
  const sessionId = requiredText(input.sessionId, 'sessionId')
  const session = db.db.prepare('SELECT id, kind FROM sessions WHERE id = ? AND project_id = ?').get(sessionId, requireProjectId(db))
  if (session && session.kind === 'pm') return { ok: true, sliceId: sliceId, pm: true }
  const existing = getLease(db, sliceId)
  if (existing && expiresAtMs(existing) > Date.now() && existing.sessionId !== sessionId) {
    throw fail('LEASE_HELD', '写作用域被其它会话持有：' + existing.sessionId, {
      sliceId: sliceId,
      holder: existing,
      sessionId: sessionId,
    })
  }
  return { ok: true, sliceId: sliceId, holder: existing && existing.sessionId === sessionId ? existing : undefined }
}
