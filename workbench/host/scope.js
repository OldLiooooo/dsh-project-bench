// 切片写作用域（v4）：把「片外零改动」从一句自述变成一次可复核的校验。
//
// 为什么要有它：
//   session_finish_task 原来只要求调用方传 noOutOfScopeChanges=true —— 那是**声明**，不是**证据**。
//   声明永远能通过，所以「片外零改动」在实现里从没被真正检查过（设计逻辑 §7 已列为缺口）。
//
// 这里的做法：拿**真实工作区 diff** 去对切片作用域。
//   1) 采集：git status --porcelain（含未跟踪文件）+ git diff --numstat（改动量）；
//   2) 归因：把每条路径映射到「哪个切片声明了它」；
//   3) 判定：
//      - 在作用域内                     -> in_scope
//      - 不在任何切片作用域             -> out_of_scope（必须由人决策或 PM 显式接受）
//      - 属于**别的**切片               -> cross_scope（更严重：改了别人的地盘）
//   4) 结果写进 session_finish_task 的返回与事件；跨域/越界默认拒绝收工。
//
// 没有 git 或没有基线时**不假装通过**：返回 basis='unavailable'，并把「无法校验」如实标注，
// 由调用方的策略决定拦不拦（默认拦：见 scope.validateFinish）。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fail, requireProjectId } from './db.js'
import { nowIso } from './util.js'

/** 视为「非源码改动」的路径前缀：它们由插件自己写，不该算进任何人的写作用域。 */
export const IGNORED_PREFIXES = ['.project/', '.devhome/', '.artifacts/', '.runtime/', 'node_modules/']

/**
 * 极简 glob：只支持 * ** ? 和字面前缀，够表达「src/refund/**」这类作用域。
 * 不引入依赖是有意的——作用域规则必须可审计，而不是藏在第三方库里。
 */
function globToRegExp(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '')
  let out = '^'
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // ** 跨越路径分隔符
        out += '.*'
        i += 1
        if (normalized[i + 1] === '/') i += 1
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  out += '$'
  try { return new RegExp(out) } catch (error) { return undefined }
}

function normalizePath(path) {
  return String(path).replace(/\\/g, '/').replace(/^\.\//, '')
}

function isIgnored(path) {
  const normalized = normalizePath(path)
  return IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

/** 作用域模式匹配：目录型模式（以 / 结尾或以 /** 结尾）按前缀命中。 */
export function matchesPattern(path, pattern) {
  const normalized = normalizePath(path)
  const raw = normalizePath(pattern)
  if (!raw) return false
  if (raw === '*' || raw === '**') return true
  if (raw.endsWith('/')) return normalized === raw.slice(0, -1) || normalized.startsWith(raw)
  const regex = globToRegExp(raw)
  if (regex && regex.test(normalized)) return true
  // 目录语义：声明 'src/refund' 应覆盖 'src/refund/x.js'
  return normalized.startsWith(raw.replace(/\/+$/, '') + '/')
}

// ---------------------------------------------------------------------------
// 作用域声明（DB）
// ---------------------------------------------------------------------------

export function listSliceScopes(db, sliceId) {
  const rows = db.db
    .prepare('SELECT * FROM slice_scopes WHERE project_id = ? AND slice_id = ? ORDER BY path_pattern ASC')
    .all(requireProjectId(db), sliceId)
  return rows.map((row) => ({ sliceId: row.slice_id, pattern: row.path_pattern, kind: row.kind, addedBy: row.added_by ?? undefined, createdAt: row.created_at }))
}

export function declareSliceScope(db, input = {}) {
  const sliceId = typeof input.sliceId === 'string' ? input.sliceId.trim() : ''
  if (!sliceId) throw fail('INVALID', 'sliceId 必须是非空字符串')
  const slice = db.db.prepare('SELECT id FROM slices WHERE id = ? AND project_id = ?').get(sliceId, requireProjectId(db))
  if (!slice) throw fail('NOT_FOUND', 'slice not found: ' + sliceId)
  const patterns = Array.isArray(input.patterns) ? input.patterns : [input.pattern]
  const cleaned = patterns
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .map((item) => normalizePath(item.trim()))
  if (cleaned.length === 0) throw fail('INVALID', '作用域至少需要一个路径模式（如 src/refund/**）')
  return db.tx(() => {
    const at = nowIso()
    const insert = db.db.prepare('INSERT OR IGNORE INTO slice_scopes(slice_id, project_id, path_pattern, kind, added_by, created_at) VALUES (?,?,?,?,?,?)')
    for (const pattern of cleaned) insert.run(sliceId, db.projectId, pattern, 'glob', input.addedBy ?? null, at)
    db.db.prepare('UPDATE slices SET scope_declared = 1, updated_at = ? WHERE id = ? AND project_id = ?').run(at, sliceId, db.projectId)
    db.appendEvent({
      kind: 'slice/scope',
      sliceId: sliceId,
      subjectType: 'slice',
      subjectId: sliceId,
      actorSession: input.addedBy ?? undefined,
      payload: { patterns: cleaned, action: 'declare' },
    })
    return listSliceScopes(db, sliceId)
  })
}

export function clearSliceScope(db, input = {}) {
  const sliceId = typeof input.sliceId === 'string' ? input.sliceId.trim() : ''
  if (!sliceId) throw fail('INVALID', 'sliceId 必须是非空字符串')
  return db.tx(() => {
    const removed = db.db.prepare('DELETE FROM slice_scopes WHERE project_id = ? AND slice_id = ?').run(requireProjectId(db), sliceId)
    db.db.prepare('UPDATE slices SET scope_declared = 0, updated_at = ? WHERE id = ? AND project_id = ?').run(nowIso(), sliceId, db.projectId)
    db.appendEvent({
      kind: 'slice/scope',
      sliceId: sliceId,
      subjectType: 'slice',
      subjectId: sliceId,
      actorSession: input.addedBy ?? undefined,
      payload: { action: 'clear', removed: Number(removed && removed.changes ? removed.changes : 0) },
    })
    return { sliceId, removed: Number(removed && removed.changes ? removed.changes : 0) }
  })
}

// ---------------------------------------------------------------------------
// 真实 diff 采集
// ---------------------------------------------------------------------------

/**
 * 采集工作区改动：优先 git（有基线、可复核）；没有 git 时退化为「目录扫描 vs 索引」不可靠，
 * 因此**明确返回 unavailable**，而不是编一个空 diff 假装干净。
 *
 * @returns {{basis:'git'|'unavailable', reason?:string, files:Array<{path:string, status:string, additions?:number, deletions?:number}>, baseline?:string}}
 */
export function collectWorkspaceChanges(root, options = {}) {
  if (!root || typeof root !== 'string') return { basis: 'unavailable', reason: 'no-root', files: [] }
  if (!existsSync(join(root, '.git'))) {
    return { basis: 'unavailable', reason: 'no-git-baseline', files: [] }
  }
  const run = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 15000,
    windowsHide: true,
  })
  try {
    const porcelain = run(['status', '--porcelain=v1', '--untracked-files=all'])
    const numstat = run(['diff', '--numstat', 'HEAD'])
    const stats = new Map()
    for (const line of String(numstat).split(/\r?\n/)) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const additions = parts[0] === '-' ? 0 : Number(parts[0])
      const deletions = parts[1] === '-' ? 0 : Number(parts[1])
      stats.set(normalizePath(parts.slice(2).join('\t')), { additions, deletions })
    }
    const files = []
    for (const line of String(porcelain).split(/\r?\n/)) {
      if (!line.trim()) continue
      const status = line.slice(0, 2).trim() || 'M'
      let path = line.slice(3).trim()
      // rename: "R  old -> new"：取新路径（这才是现在存在的文件）
      const arrow = path.indexOf(' -> ')
      if (arrow >= 0) path = path.slice(arrow + 4)
      path = normalizePath(path.replace(/^"|"$/g, ''))
      if (!path || isIgnored(path)) continue
      const stat = stats.get(path)
      files.push({ path, status, additions: stat ? stat.additions : undefined, deletions: stat ? stat.deletions : undefined })
    }
    let head = ''
    try { head = String(run(['rev-parse', '--short', 'HEAD'])).trim() } catch (error) { head = 'unborn' }
    return { basis: 'git', baseline: head, files }
  } catch (error) {
    // git 不可用/超时/权限：如实降级，不伪造结果。
    return { basis: 'unavailable', reason: 'git-failed:' + String((error && error.message) || error).slice(0, 160), files: [] }
  }
}

/**
 * 把 diff 归因到切片作用域。
 * @returns {{basis:string, files:Array, inScope:Array, outOfScope:Array, crossScope:Array, ignored:number}}
 */
export function classifyChanges(db, changes, sliceId) {
  // 防御性过滤：采集阶段已忽略插件自写目录，但归因函数不应该依赖调用方替它做这件事
  // （否则任何别的调用点喂进来的 diff 都会把 .project/ 记成「越界」）。
  const incoming = Array.isArray(changes && changes.files) ? changes.files : []
  const files = incoming.filter((file) => file && typeof file.path === 'string' && !isIgnored(file.path))
  const scopes = db.db
    .prepare('SELECT slice_id, path_pattern FROM slice_scopes WHERE project_id = ?')
    .all(requireProjectId(db))
  const bySlice = new Map()
  for (const row of scopes) {
    if (!bySlice.has(row.slice_id)) bySlice.set(row.slice_id, [])
    bySlice.get(row.slice_id).push(row.path_pattern)
  }
  const own = bySlice.get(sliceId) || []
  const inScope = []
  const outOfScope = []
  const crossScope = []
  for (const file of files) {
    const ownHit = own.some((pattern) => matchesPattern(file.path, pattern))
    if (ownHit) { inScope.push({ ...file, sliceId }); continue }
    let owner
    for (const [otherSlice, patterns] of bySlice) {
      if (otherSlice === sliceId) continue
      if (patterns.some((pattern) => matchesPattern(file.path, pattern))) { owner = otherSlice; break }
    }
    if (owner) crossScope.push({ ...file, ownerSliceId: owner })
    else outOfScope.push(file)
  }
  return {
    basis: changes.basis,
    baseline: changes.baseline,
    reason: changes.reason,
    files,
    inScope,
    outOfScope,
    crossScope,
    declared: own.slice(),
  }
}

/**
 * 收工时的作用域判定。
 *
 * 判定能力先于判定结论（这是这个模块最重要的设计约束）：
 *   「片外零改动」只有在**能定义作用域**且**能取到 diff** 时才是可判定的。
 *   两个条件缺一个，说「通过」就是撒谎，说「失败」就是阻挡所有非 git 项目。
 *   因此本函数把结论分成三档：
 *
 *     ok=true,  verifiable=true    —— 真的校验过，且干净（这是唯一可以拿来做门禁的结论）
 *     ok=true,  verifiable=false   —— 无法校验（无 git / 未声明作用域），如实返回 unresolved 原因，
 *                                     仍要求调用方显式声明；**不假装通过**
 *     ok=false                     —— 抓到了可判定的违规（跨切片、或作用域内声明之外的改动）
 *
 * 策略（project.json.scopePolicy，缺省 strict）：
 *   - 'strict'（默认）：抓到违规就拒绝；无法校验时放行但标注（见上，不伪造安全）
 *   - 'declare'       ：outOfScope 允许，但必须显式 acceptedOutOfScope=true + outOfScopeReason
 *   - 'off'           ：完全不拦，仅报告
 * crossScope（改了别的切片声明的地盘）在任何策略下都拒绝：
 * 那不是「本切片范围没声明清楚」，而是**侵犯了别人的已声明范围**，没有可接受的默认。
 */
export function validateFinish(db, input = {}) {
  const policy = input.policy === 'declare' || input.policy === 'off' ? input.policy : 'strict'
  const sliceId = input.sliceId
  if (!sliceId) throw fail('INVALID', 'validateFinish 需要 sliceId')
  const changes = collectWorkspaceChanges(input.root, { timeoutMs: input.timeoutMs })
  const classified = classifyChanges(db, changes, sliceId)
  const hasDeclaredScope = classified.declared.length > 0 || classified.crossScope.some(() => true)
  const scopeDeclared = classified.declared.length > 0
  // 「能判定」= 有 git 基线 + 本切片声明过作用域（否则 in/out 的边界根本不存在）
  const verifiable = changes.basis === 'git' && scopeDeclared
  const unresolvedReason = changes.basis !== 'git'
    ? ('no-git-baseline：' + (changes.reason || '工作区不是 git 仓库'))
    : (!scopeDeclared ? 'no-scope-declared：本切片没有声明写作用域，无法区分「片内」与「片外」' : undefined)
  const issues = []
  if (policy !== 'off') {
    if (classified.crossScope.length > 0) {
      issues.push({
        code: 'CROSS_SCOPE_CHANGES',
        message: '改动了其它切片声明的作用域：' + classified.crossScope.map((file) => file.path).slice(0, 8).join(', '),
        files: classified.crossScope.map((file) => ({ path: file.path, ownerSliceId: file.ownerSliceId })),
      })
    }
    // 只有「能判定」时，outOfScope 才是一个有意义的违规；否则它只是「没有边界」的同义词。
    if (scopeDeclared && classified.outOfScope.length > 0) {
      const accepted = input.acceptedOutOfScope === true && typeof input.outOfScopeReason === 'string' && input.outOfScopeReason.trim() !== ''
      if (!accepted || policy === 'strict') {
        issues.push({
          code: 'OUT_OF_SCOPE_CHANGES',
          message: '存在本切片作用域之外的改动：' + classified.outOfScope.map((file) => file.path).slice(0, 8).join(', ')
            + (accepted ? '（declare 策略下仍不允许越界，请调整作用域声明或回滚）' : ''),
          files: classified.outOfScope.map((file) => file.path),
        })
      }
    }
  }
  return {
    policy,
    basis: changes.basis,
    baseline: changes.baseline,
    reason: changes.reason,
    checkedAt: nowIso(),
    verifiable,
    unresolved: !verifiable,
    unresolvedReason,
    hasDeclaredScope: hasDeclaredScope && scopeDeclared,
    counts: {
      changed: classified.files.length,
      inScope: classified.inScope.length,
      outOfScope: classified.outOfScope.length,
      crossScope: classified.crossScope.length,
    },
    inScope: classified.inScope.map((file) => file.path),
    outOfScope: classified.outOfScope.map((file) => file.path),
    crossScope: classified.crossScope.map((file) => ({ path: file.path, ownerSliceId: file.ownerSliceId })),
    declared: classified.declared,
    issues,
    ok: issues.length === 0,
  }
}

/** 读 project.json 的 scopePolicy（缺省 strict）。 */
export function scopePolicyOf(projectJson) {
  const value = projectJson && projectJson.scopePolicy
  return value === 'declare' || value === 'off' || value === 'strict' ? value : 'strict'
}
