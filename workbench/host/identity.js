// 人身份（v4）：把「人」从字符串提升为一条可追溯的主体记录。
//
// 问题（设计逻辑 §决策 5「已知边界」）：
//   decidedBy 默认就是字符串 'user'。于是：
//     - 共享实例上，A 和 B 的批准长得一模一样，审批记录无法回答「谁批的」；
//     - 「人批准」的判据退化成「这个请求通过了宿主 cookie 围栏」，而 cookie 是浏览器共享的；
//     - 不可逆操作要二次确认，但无法要求「不同的人确认」或「同一个人不能既提又批」。
//
// v4 的模型（刻意简单，避免假装有大权限系统）：
//   主体 subject —— 稳定标识。来源按可信度从高到低：
//     1) 宿主注入的登录主体（ctx.connection / header 里的 authenticated user），source='host'；
//     2) 面板显式传入的 actingAs（人自己填的名字），source='declared'；
//     3) 兜底 'local'，source='local'（单机单用户）。
//   每个 subject 在 identities 里有且只有一行；审批时把结构化身份写进 approval_signers。
//
// 明确不做（写在这里是为了不让人误以为已经做了）：
//   - 不做密码、不做 RBAC、不做「谁能批哪类门禁」。单机单用户这句话仍然成立；
//   - host 来源的解析只在宿主真的提供了主体时才成立，拿不到就退到 declared/local 并**如实标注来源**；
//   - **不阻止同一 subject 既提交又批准**，只在审批记录里记下 submitter 与 approver 是否同一人
//     （separated=false），由面板/策略去决定要不要警告。假装阻止会造出「换个名字就绕过」的安全感。
import { fail, requireProjectId } from './db.js'
import { newId, nowIso } from './util.js'

export const IDENTITY_SOURCES = ['host', 'declared', 'local']
export const LOCAL_SUBJECT = 'local'

export function mapIdentity(row) {
  if (!row) return undefined
  return {
    id: row.id,
    projectId: row.project_id,
    subject: row.subject,
    displayName: row.display_name ?? undefined,
    kind: row.kind,
    source: row.source,
    createdAt: row.created_at,
  }
}

/** 规范化 subject：去空白、限长、拒绝控制字符（它会进事件 payload 与审批行）。 */
function normalizeSubject(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/[\u0000-\u001f]/g, '')
  if (!trimmed) return undefined
  return trimmed.slice(0, 120)
}

/**
 * 从一次人操作里解析身份。
 *
 * 入参优先级（高 → 低）：
 *   input.identity   —— 结构化 {subject, displayName, source}（宿主注入时用它）
 *   input.decidedBy  —— 旧接口的字符串（向后兼容：仍然是 subject）
 *   input.actingAs   —— 面板上人自己填的名字
 *   兜底              —— 'local'
 *
 * @returns {{subject:string, displayName?:string, source:'host'|'declared'|'local', clientHint?:string}}
 */
export function resolveIdentity(input = {}) {
  const structured = input.identity && typeof input.identity === 'object' ? input.identity : undefined
  if (structured) {
    const subject = normalizeSubject(structured.subject)
    if (subject) {
      const source = IDENTITY_SOURCES.includes(structured.source) ? structured.source : 'declared'
      return {
        subject,
        displayName: typeof structured.displayName === 'string' && structured.displayName.trim() ? structured.displayName.trim().slice(0, 120) : undefined,
        source,
        clientHint: typeof structured.clientHint === 'string' ? structured.clientHint.slice(0, 200) : undefined,
      }
    }
  }
  const declaredBy = normalizeSubject(input.decidedBy)
  if (declaredBy) {
    return {
      subject: declaredBy,
      displayName: declaredBy,
      // decidedBy 是请求体里人自己给的：来源只能是 declared。
      // 但历史上 'user' 这个值是插件写的默认值，不是人填的 —— 归到 local 更诚实。
      source: declaredBy === 'user' ? 'local' : 'declared',
      clientHint: typeof input.clientHint === 'string' ? input.clientHint.slice(0, 200) : undefined,
    }
  }
  const actingAs = normalizeSubject(input.actingAs)
  if (actingAs) {
    return { subject: actingAs, displayName: actingAs, source: 'declared', clientHint: typeof input.clientHint === 'string' ? input.clientHint.slice(0, 200) : undefined }
  }
  return { subject: LOCAL_SUBJECT, displayName: undefined, source: 'local', clientHint: typeof input.clientHint === 'string' ? input.clientHint.slice(0, 200) : undefined }
}

/** 取/建身份行（幂等）。 */
export function ensureIdentity(db, identity) {
  const projectId = requireProjectId(db)
  const subject = normalizeSubject(identity && identity.subject)
  if (!subject) throw fail('INVALID', 'identity.subject 必须是非空字符串')
  const source = IDENTITY_SOURCES.includes(identity.source) ? identity.source : 'local'
  return db.tx(() => {
    const existing = db.db.prepare('SELECT * FROM identities WHERE project_id = ? AND subject = ?').get(projectId, subject)
    if (existing) {
      // 显示名/来源可能在本轮变准（例如首次是 declared，后来宿主注入了同一个人）：
      // 只允许把来源「升级」成更可信的，不允许降级，避免历史记录被改写成更弱的声明。
      const rank = { local: 0, declared: 1, host: 2 }
      const nextSource = rank[source] > rank[existing.source] ? source : existing.source
      const nextName = identity.displayName || existing.display_name
      if (nextSource !== existing.source || nextName !== existing.display_name) {
        db.db.prepare('UPDATE identities SET source = ?, display_name = ? WHERE id = ?').run(nextSource, nextName ?? null, existing.id)
        return mapIdentity(db.db.prepare('SELECT * FROM identities WHERE id = ?').get(existing.id))
      }
      return mapIdentity(existing)
    }
    const id = newId('ident')
    db.db.prepare('INSERT INTO identities(id, project_id, subject, display_name, kind, source, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, projectId, subject, identity.displayName ?? null, 'human', source, nowIso())
    return mapIdentity(db.db.prepare('SELECT * FROM identities WHERE id = ?').get(id))
  })
}

/** 记录「谁签了这条审批」。approval_id 是主键，重复签名覆盖为最后一次（同一审批只有一次有效签名）。 */
export function recordApprovalSigner(db, input = {}) {
  const approvalId = typeof input.approvalId === 'string' ? input.approvalId.trim() : ''
  if (!approvalId) throw fail('INVALID', 'approvalId 必须是非空字符串')
  const identity = ensureIdentity(db, input.identity || resolveIdentity(input))
  db.db.prepare('INSERT INTO approval_signers(approval_id, project_id, identity_id, subject, display_name, source, client_hint, signed_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(approval_id) DO UPDATE SET identity_id = excluded.identity_id, subject = excluded.subject, display_name = excluded.display_name, source = excluded.source, client_hint = excluded.client_hint, signed_at = excluded.signed_at')
    .run(approvalId, requireProjectId(db), identity.id, identity.subject, identity.displayName ?? null, identity.source, input.clientHint ?? null, nowIso())
  return getApprovalSigner(db, approvalId)
}

export function getApprovalSigner(db, approvalId) {
  const row = db.db.prepare('SELECT * FROM approval_signers WHERE approval_id = ? AND project_id = ?').get(approvalId, requireProjectId(db))
  if (!row) return undefined
  return {
    approvalId: row.approval_id,
    identityId: row.identity_id ?? undefined,
    subject: row.subject,
    displayName: row.display_name ?? undefined,
    source: row.source,
    clientHint: row.client_hint ?? undefined,
    signedAt: row.signed_at,
  }
}

export function listIdentities(db) {
  return db.db.prepare('SELECT * FROM identities WHERE project_id = ? ORDER BY created_at ASC').all(requireProjectId(db)).map(mapIdentity)
}

/**
 * 「提交人」与「批准人」是否不同。
 * 这是**如实报告**，不是阻止：单机单用户下两者必然相同，假装它是错误只会让所有人绕开它。
 */
export function separationOf(db, input = {}) {
  const submitter = typeof input.submittedBy === 'string' ? input.submittedBy.trim() : ''
  const approver = typeof input.approvedBy === 'string' ? input.approvedBy.trim() : ''
  return {
    submittedBy: submitter || null,
    approvedBy: approver || null,
    separated: Boolean(submitter && approver && submitter !== approver),
  }
}
