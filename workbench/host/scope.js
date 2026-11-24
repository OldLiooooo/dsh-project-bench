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
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fail, requireProjectId } from './db.js'
import { nowIso } from './util.js'

/** 视为「非源码改动」的路径前缀：它们由插件自己写，不该算进任何人的写作用域。 */
export const IGNORED_PREFIXES = ['.project/', '.devhome/', '.artifacts/', '.runtime/', 'node_modules/']

/** 收工作用域策略（project.json.scopePolicy）。缺省 strict；唯一写入口是 PM 的 scope_policy 工具。 */
export const SCOPE_POLICIES = ['strict', 'declare', 'off']

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
// 工作区快照（v6.4：把归因从「工作树有多脏」改成「这次会话动了什么」）
// ---------------------------------------------------------------------------

/** 快照索引文件的临时名（放在仓库 git 目录下，避免跨盘）。 */
function tempIndexPath(gitDir, tag) {
  const safe = String(tag || 'snap').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'snap'
  return join(gitDir, 'workbench-' + safe + '-' + process.pid + '-' + Date.now() + '.index')
}

function runGit(cwd, args, options = {}) {
  const env = { ...process.env }
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 15000,
    windowsHide: true,
    env,
  })
}

/** 仓库 git 目录（worktree 里 .git 是文件，`--absolute-git-dir` 会解析到真正的 objects/ 所在处）。 */
function gitDirOf(root) {
  try {
    const out = String(runGit(root, ['rev-parse', '--absolute-git-dir'])).trim()
    return out || undefined
  } catch (error) { return undefined }
}

/**
 * 给当前工作树拍一张快照，返回一个可 diff 的 git 树对象 id。
 *
 * 为什么不能直接 `git add -A`：那会把别人的改动**暂存**进真索引，
 * 改变用户与其它会话看到的 `git status`（从「未暂存」变成「已暂存」）——
 * 校验动作不该有副作用。所以：
 *   1) `git stash create` 收录已跟踪改动（只写对象库，工作树与索引都不变）；
 *   2) 临时索引 `git add -A` 收录未跟踪文件，写成第二棵树；
 *   3) 两棵树做一次 `read-tree`+`commit-tree`? —— 不，直接用 `git write-tree` 的结果对比即可，
 *      调用方要的是「两次快照之间新增/修改了哪些路径」，两棵树 diff 就够。
 *
 * 返回 undefined 表示「拍不出来」，调用方必须降级并如实标注，不能当成「没有改动」。
 */
export function captureWorkspaceSnapshot(root, options = {}) {
  if (!root || typeof root !== 'string') return undefined
  if (!existsSync(join(root, '.git'))) return undefined
  const timeoutMs = options.timeoutMs || 15000
  const gitDir = gitDirOf(root)
  if (!gitDir) return undefined
  const indexFile = tempIndexPath(gitDir, options.tag)
  const treeIds = []
  try {
    // ① 已跟踪改动（含已暂存）→ stash create 生成一个 commit 对象，只写对象库
    let trackedTree = ''
    try {
      const stash = String(runGit(root, ['stash', 'create', 'workbench snapshot'], { timeoutMs })).trim()
      if (stash) trackedTree = String(runGit(root, ['rev-parse', stash + '^{tree}'], { timeoutMs })).trim()
      else trackedTree = String(runGit(root, ['rev-parse', 'HEAD^{tree}'], { timeoutMs })).trim()
    } catch (error) { trackedTree = '' }
    if (trackedTree) treeIds.push(trackedTree)
    // ② 未跟踪文件 → 临时索引（不碰真索引）
    let allTree = ''
    try {
      runGit(root, ['add', '-A', '--', '.'], { timeoutMs, indexFile })
      allTree = String(runGit(root, ['write-tree'], { timeoutMs, indexFile })).trim()
    } catch (error) { allTree = '' }
    if (allTree) treeIds.push(allTree)
    if (treeIds.length === 0) return undefined
    let head = ''
    try { head = String(runGit(root, ['rev-parse', 'HEAD'], { timeoutMs })).trim() } catch (error) { head = '' }
    return {
      basis: 'git',
      root,
      head: head || undefined,
      trackedTree: trackedTree || undefined,
      allTree: allTree || undefined,
      capturedAt: nowIso(),
    }
  } catch (error) {
    return undefined
  } finally {
    // 临时索引必须清掉：它会随仓库越来越大，且下次 `git status` 可能读到残余。
    try { rmSync(indexFile, { force: true }) } catch (error) { /* 删不掉就留着，不影响判定 */ }
    try { rmSync(indexFile + '.lock', { force: true }) } catch (error) { /* 同上 */ }
  }
}
/**
 * 两次快照之间的真实改动（会话级归因）。
 *
 * 与 collectWorkspaceChanges 的区别就是**归因对象**：那个问「工作树有多脏」，这个问
 * 「从 baseline 到现在新增/改了哪些路径」。后者才是「本次会话的改动」。
 *
 * 实现取舍：不用 `git diff A B` 的 patch，用 `--name-status` —— 判定只需要路径与状态，
 * 拿 patch 反而要为超大二进制/编码多写一堆防御。
 *
 * @returns {{basis:'git'|'unavailable', reason?:string, files:Array<{path:string,status:string}>, baseline?:string}}
 */
export function diffWorkspaceSnapshots(root, before, after, options = {}) {
  const unavailable = (reason) => ({ basis: 'unavailable', reason, files: [] })
  if (!before || !before.allTree) return unavailable('no-baseline-snapshot')
  if (!after || !after.allTree) return unavailable('no-finish-snapshot')
  if (!root || !existsSync(join(root, '.git'))) return unavailable('no-git-baseline')
  const timeoutMs = options.timeoutMs || 15000
  try {
    // 两棵树都含未跟踪文件，所以 diff 结果天然覆盖「新建了片外文件」这种最该拦的情况。
    const out = String(runGit(root, ['diff', '--name-status', '--no-renames', before.allTree, after.allTree], { timeoutMs }))
    const files = []
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      if (parts.length < 2) continue
      const status = (parts[0] || 'M').trim().slice(0, 1) || 'M'
      const path = normalizePath(parts[1])
      if (!path || isIgnored(path)) continue
      files.push({ path, status })
    }
    return { basis: 'git', baseline: before.allTree.slice(0, 12), files }
  } catch (error) {
    return unavailable('git-failed:' + String((error && error.message) || error).slice(0, 160))
  }
}

/**
 * 采集「本次会话的改动」：有 baseline 快照时按两次快照归因，没有时降级为整个工作树并标注。
 *
 * 降级不是静默的：返回值里 `attribution` 明确写 'session'（按会话归因）还是 'workspace'
 * （只能看整个工作树，可能被别人的未提交改动污染）。PM 与报告要能区分这两件事。
 */
export function collectSessionChanges(root, options = {}) {
  const baseline = options.baselineSnapshot
  if (baseline && baseline.allTree) {
    const after = captureWorkspaceSnapshot(root, { timeoutMs: options.timeoutMs, tag: 'finish' })
    const diff = diffWorkspaceSnapshots(root, baseline, after, { timeoutMs: options.timeoutMs })
    if (diff.basis === 'git') return { ...diff, attribution: 'session' }
    // 快照拍得出来但 diff 失败：如实降级，不假装能归因。
    const fallback = collectWorkspaceChanges(root, { timeoutMs: options.timeoutMs })
    return { ...fallback, attribution: 'workspace', attributionNote: 'baseline 已记录但收工快照/diff 失败：' + (diff.reason || 'unknown') }
  }
  const fallback = collectWorkspaceChanges(root, { timeoutMs: options.timeoutMs })
  // 没有 baseline 时仍然能判（老项目/没有快照的历史会话），但必须标注这是整树口径。
  // 采集本身也失败时 basis='unavailable'，attribution 同样是 'unavailable' ——
  // 三种状态（session / workspace / unavailable）分开，调用方才能做对的事。
  return { ...fallback, attribution: fallback.basis === 'git' ? 'workspace' : 'unavailable' }
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
    // 还没有第一次提交的仓库（unborn HEAD）跑 `git diff HEAD` 会直接报错，
    // 而那是**合法状态**（新项目/刚 git init）。以前它会把整个采集拖成 unavailable，
    // 于是这类项目永远「无法校验」。单独 try：拿不到改动量就退化为「只有路径」。
    let numstat = ''
    try { numstat = run(['diff', '--numstat', 'HEAD']) } catch (error) { numstat = '' }
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
 * 唯一例外是 input.acceptCrossScope=true（PM 显式接受，见 session_finish_task 的实现边界说明）。
 *
 * v6.3（lumio 真库反馈 P0-1）：新增 input.blockOutOfScope（默认 true）。
 *   failed 收工传 false —— 不是放宽判定，而是**不让一个与本次交付无关的存量改动把失败也堵死**：
 *   失败收工不产出交付物，这时把 outOfScope 拦死等于「诚实比撒谎更贵」。
 *   crossScope 不在放宽范围内：那是改到了别人的已声明地盘，与成败无关，仍须显式接受。
 */
export function validateFinish(db, input = {}) {
  const policy = SCOPE_POLICIES.includes(input.policy) ? input.policy : 'strict'
  const blockOutOfScope = input.blockOutOfScope !== false
  const acceptedReason = typeof input.outOfScopeReason === 'string' && input.outOfScopeReason.trim() !== ''
  // crossScope 的显式接受：只在非 strict 策略 + 给了理由时成立（默认仍然拒绝）。
  const acceptCrossScope = input.acceptCrossScope === true && policy !== 'strict' && acceptedReason
  const sliceId = input.sliceId
  if (!sliceId) throw fail('INVALID', 'validateFinish 需要 sliceId')
  // 采集口径（v6.4）：
  //   1) input.changes —— 显式注入（测试用；也为将来「按 worktree 采集」留口）；
  //   2) input.baselineSnapshot —— spawn 时拍下的工作树快照，做**会话级归因**；
  //   3) 都没有时退回整树口径，并在 attribution 里如实标注（老项目/历史会话）。
  // 只有第 2 条能回答「这次会话动了什么」；第 3 条回答的是「工作树有多脏」——
  // 它们被混为一谈正是 lumio P1-1 那条误报的根因。
  const changes = input.changes && typeof input.changes === 'object' && Array.isArray(input.changes.files)
    ? { ...input.changes, attribution: input.changes.attribution || 'injected' }
    : (input.root && input.baselineSnapshot
      ? collectSessionChanges(input.root, { baselineSnapshot: input.baselineSnapshot, timeoutMs: input.timeoutMs })
      : { ...collectWorkspaceChanges(input.root, { timeoutMs: input.timeoutMs }), attribution: 'workspace' })
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
    if (classified.crossScope.length > 0 && !acceptCrossScope) {
      issues.push({
        code: 'CROSS_SCOPE_CHANGES',
        message: '改动了其它切片声明的作用域：' + classified.crossScope.map((file) => file.path).slice(0, 8).join(', ')
          + (input.acceptCrossScope === true && policy === 'strict'
            ? '（当前策略为 strict：crossScope 只在 declare/off 策略下可被显式接受，先 scope_policy 切到 declare）'
            : (input.acceptCrossScope === true
              ? '（显式接受还需要 outOfScopeReason；没有理由的接受等于没接受）'
              : '（crossScope 默认拒绝：这是改到了别人已声明的地盘，请与对应切片 owner 对齐或回滚）')),
        files: classified.crossScope.map((file) => ({ path: file.path, ownerSliceId: file.ownerSliceId })),
      })
    }
    // 只有「能判定」时，outOfScope 才是一个有意义的违规；否则它只是「没有边界」的同义词。
    if (blockOutOfScope && scopeDeclared && classified.outOfScope.length > 0) {
      const accepted = input.acceptedOutOfScope === true && acceptedReason
      // 文案判据必须是 policy，不是 accepted —— 旧代码在这里用 accepted 拼出
      // 「（declare 策略下仍不允许越界…）」，于是 strict 下传了 accepted 的人会看到一句
      // 指向另一个策略的提示，反过来去改自己改不了的策略（lumio P0-2）。
      if (policy === 'strict' || !accepted) {
        issues.push({
          code: 'OUT_OF_SCOPE_CHANGES',
          message: '存在本切片作用域之外的改动：' + classified.outOfScope.map((file) => file.path).slice(0, 8).join(', ')
            + (accepted
              ? '（当前策略为 strict：acceptedOutOfScope 只在 declare 策略下生效，请用 scope_policy 把项目切到 declare，或调整作用域声明/回滚）'
              : (policy === 'declare'
                ? '（declare 策略：PM 显式接受越界需同时给 acceptedOutOfScope=true 与 outOfScopeReason）'
                : '')),
          files: classified.outOfScope.map((file) => file.path),
        })
      }
    }
  }
  return {
    policy,
    basis: changes.basis,
    baseline: changes.baseline,
    // 归因口径必须回传：'session' = 只算本次会话的改动；
    // 'workspace' = 只能看整个工作树（可能被别人的未提交改动污染）。
    // 把两者混同，正是让「我没有越界」变成一句无法自证的话的原因。
    attribution: changes.attribution,
    attributionNote: changes.attributionNote,
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
  return SCOPE_POLICIES.includes(value) ? value : 'strict'
}
