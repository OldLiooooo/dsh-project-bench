// 写作用域租约（T1）：同一切片同一时刻只有一个任务会话可写。
//
// 规则（合同 §3 + v4 栅栏）：
// - 未过期且他人持租 -> LEASE_HELD。
// - 过期租约可抢占（takeover），并记录事件；同一 session 重复 acquire 视为续期。
// - PM 会话不受租约限制（由工具层判断；这里对 pm 会话 id 做防御性放行）。
// - 释放只允许持租者；租约不存在时释放幂等（released=false）。
//
// v4 新增「栅栏令牌（fencing token）」——为什么必须有：
//   只有「当前 holder 是谁」这一个判断，存在一个无法自证的窗口：
//   A 持租 → A 卡住（进程挂起/GC/网络等待）→ 租约过期 → B 抢占 → A 醒来继续写。
//   此时若只比对 holder=A？不成立（holder 已是 B），但如果 A 的写路径是「先检查后写」，
//   检查与写之间仍可能被抢占（TOCTOU）。栅栏令牌把这件事变成单调比较：
//   每次 acquire 生成一个严格递增的 epoch，写方必须出示自己持有的那个 epoch，
//   **过期或已失效的令牌一律拒绝**（LEASE_FENCED）。这样即使 A 的检查发生在抢占之前，
//   真正的写也会因为令牌落后而被拒——判断的对象从「谁持有」变成「这一次授权是否仍然有效」。
//
// 令牌从哪来：spawn 时把当次 epoch 写进 sessions.context.fenceEpoch；
// 之后所有写路径（doc_write/evidence_add/artifact_add/doc_freeze/session_finish_task）
// 都带这个值。租约被抢占后 epoch 前进，旧会话的写必然对不上。
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
    /** 栅栏令牌：单调递增；写方必须出示当前值（见文件头注释）。 */
    epoch: Number(row.epoch === undefined || row.epoch === null ? 1 : row.epoch),
  }
}

export function getLease(db, sliceId) {
  if (!sliceId) return undefined
  const row = db.db.prepare('SELECT * FROM leases WHERE slice_id = ? AND project_id = ?').get(sliceId, requireProjectId(db))
  return mapLease(row)
}

/**
 * 下一个栅栏令牌。**必须是项目内单调递增**，并且即便持租行被删除也不能回退，
 * 否则「释放后重新获取」会复用旧令牌，让已失效的写重新变合法。
 * 这里取 max(历史最大值, 现存行最大值) + 1，历史最大值记在 project_meta 里。
 */
function nextEpoch(db, sliceId) {
  const key = 'lease.epoch.' + sliceId
  const metaRow = db.db.prepare('SELECT value FROM project_meta WHERE key = ?').get(key)
  const metaMax = metaRow ? Number(metaRow.value) : 0
  const row = db.db.prepare('SELECT MAX(epoch) AS e FROM leases WHERE project_id = ?').get(db.projectId)
  const tableMax = row && row.e !== null && row.e !== undefined ? Number(row.e) : 0
  const next = Math.max(Number.isFinite(metaMax) ? metaMax : 0, Number.isFinite(tableMax) ? tableMax : 0, 0) + 1
  db.db.prepare('INSERT INTO project_meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(next))
  return next
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
        epoch: existing.epoch,
      })
    }
    const renewed = active && existing.sessionId === sessionId
    const expiresAt = new Date(now + ttlMs).toISOString()
    const at = nowIso()
    const reason = input.reason === undefined || input.reason === null ? null : String(input.reason)
    // 续期沿用旧令牌（授权未变）；新建与抢占都必须换发新令牌（授权主体或有效期变了）。
    const epoch = renewed ? existing.epoch : nextEpoch(db, sliceId)
    if (existing) {
      db.db.prepare('UPDATE leases SET session_id = ?, expires_at = ?, reason = ?, created_at = ?, epoch = ? WHERE slice_id = ? AND project_id = ?')
        .run(sessionId, expiresAt, reason, renewed ? existing.createdAt : at, epoch, sliceId, db.projectId)
    } else {
      db.db.prepare('INSERT INTO leases(slice_id, project_id, session_id, expires_at, reason, created_at, epoch) VALUES (?,?,?,?,?,?,?)')
        .run(sliceId, db.projectId, sessionId, expiresAt, reason, at, epoch)
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
        epoch: epoch,
        previousEpoch: existing && !renewed ? existing.epoch : undefined,
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
        epoch: existing.epoch,
      })
    }
    db.db.prepare('DELETE FROM leases WHERE slice_id = ? AND project_id = ?').run(sliceId, db.projectId)
    // 令牌不作废重发：释放后这一代的写必须仍然被拒（epoch 只增）。
    db.db.prepare('INSERT INTO project_meta(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('lease.epoch.' + sliceId, String(existing.epoch))
    db.appendEvent({
      kind: 'lease/release',
      sliceId: sliceId,
      subjectType: 'lease',
      subjectId: sliceId,
      actorSession: sessionId,
      payload: { sessionId: sessionId, epoch: existing.epoch },
    })
    return { released: true, sliceId: sliceId, sessionId: sessionId, epoch: existing.epoch }
  })
}

/**
 * 只读检查：ok=true 表示「当前会话持有有效租约」。
 * - 无租约 -> {ok:false, required:true}；
 * - 租约已过期 -> {ok:false, expired:true, holder}（可被抢占，不算有效）；
 * - 有效租约但持租者是他人 -> {ok:false, holder}；
 * - 给了 fence 且与当前 epoch 不符 -> {ok:false, fenced:true}（授权已换代）。
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
  if (sessionId && existing.sessionId === sessionId) {
    if (input.fence !== undefined && input.fence !== null && Number(input.fence) !== existing.epoch) {
      return { ok: false, sliceId: sliceId, holder: existing, fenced: true, epoch: existing.epoch, presented: Number(input.fence) }
    }
    return { ok: true, sliceId: sliceId, holder: existing }
  }
  return { ok: false, sliceId: sliceId, holder: existing }
}

/** 从会话行读它被派活时拿到的栅栏令牌（spawn 时写入 context.fenceEpoch）。 */
export function fenceOfSession(db, sessionId) {
  if (!sessionId) return undefined
  const row = db.db.prepare('SELECT context_json FROM sessions WHERE id = ? AND project_id = ?').get(sessionId, requireProjectId(db))
  if (!row || !row.context_json) return undefined
  try {
    const context = JSON.parse(row.context_json)
    const value = context && context.fenceEpoch
    return Number.isFinite(Number(value)) ? Number(value) : undefined
  } catch (error) {
    return undefined
  }
}

/**
 * 写文档/证据/任务状态前调用：PM 会话放行；他人有效租约 -> LEASE_HELD；
 * 无租约放行（租约只约束实现阶段的并发，产品/UX 等阶段由工具层做角色校验）。
 *
 * 栅栏：会话行里记录了 fenceEpoch 时，必须与当前租约 epoch 一致。
 * 这条检查是**写路径**的一部分，因此抢占后旧会话的重试也会被拒（不是只在入口检查一次）。
 */
export function assertWriteScope(db, input = {}) {
  const sliceId = requiredText(input.sliceId, 'sliceId')
  const sessionId = requiredText(input.sessionId, 'sessionId')
  const session = db.db.prepare('SELECT id, kind FROM sessions WHERE id = ? AND project_id = ?').get(sessionId, requireProjectId(db))
  if (session && session.kind === 'pm') return { ok: true, sliceId: sliceId, pm: true }
  const existing = getLease(db, sliceId)
  const presented = input.fence === undefined || input.fence === null ? fenceOfSession(db, sessionId) : Number(input.fence)
  if (existing && expiresAtMs(existing) > Date.now() && existing.sessionId !== sessionId) {
    throw fail('LEASE_HELD', '写作用域被其它会话持有：' + existing.sessionId, {
      sliceId: sliceId,
      holder: existing,
      sessionId: sessionId,
    })
  }
  if (existing && existing.sessionId === sessionId && presented !== undefined && Number(presented) !== existing.epoch) {
    throw fail('LEASE_FENCED', '写作用域授权已换代（栅栏令牌失效）：持有 epoch ' + existing.epoch + '，本会话出示 ' + presented, {
      sliceId: sliceId,
      sessionId: sessionId,
      epoch: existing.epoch,
      presented: Number(presented),
    })
  }
  return { ok: true, sliceId: sliceId, holder: existing && existing.sessionId === sessionId ? existing : undefined }
}
