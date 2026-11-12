// 通用工具：ID、哈希、时间、token 估算、路径、原子写。被 host 各模块共享。
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export function newId(prefix) {
  return prefix ? prefix + '-' + randomUUID() : randomUUID()
}

export function nowIso() {
  return new Date().toISOString()
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

export function jsonText(value) {
  return JSON.stringify(value ?? null)
}

export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback
  try { return JSON.parse(text) } catch { return fallback }
}

/** 保守 token 估算：CJK 每字 1 token，其余按 4 字符 1 token。用于 2k 装载预算硬裁剪。 */
export function estimateTokens(text) {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef) || (code >= 0x3400 && code <= 0x4dbf)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

/** 按 token 预算截断文本（保留头尾，尾部更重要时传 preferTail=true）。 */
export function truncateToTokens(text, budget, preferTail = false) {
  if (!text) return ''
  if (estimateTokens(text) <= budget) return text
  const chars = [...String(text)]
  let lo = 0
  let hi = chars.length
  const build = (n) => preferTail ? chars.slice(chars.length - n).join('') : chars.slice(0, n).join('')
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(build(mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  const cut = build(lo)
  return preferTail ? '…' + cut : cut + '…'
}

/** 从 cwd 向上查找包含 .project/project.json 的项目根。 */
export function findProjectRoot(cwd) {
  if (!cwd) return undefined
  let dir = isAbsolute(cwd) ? cwd : resolve(cwd)
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, '.project', 'project.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

export async function atomicWriteFile(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const temp = file + '.' + process.pid + '.tmp'
  await writeFile(temp, content, 'utf8')
  await rename(temp, file)
}

/** 将文档标题变成可检索的章节标题列表：按 #/##/### 切分 markdown。 */
export function parseMarkdownSections(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/)
  const sections = []
  let current = { heading: '', body: [] }
  const flush = () => {
    const content = current.body.join('\n').trim()
    if (current.heading || content) sections.push({ heading: current.heading || '正文', content })
    current = { heading: '', body: [] }
  }
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) { flush(); current.heading = m[2].trim() }
    else current.body.push(line)
  }
  flush()
  return sections.filter((s) => s.content.length > 0 || s.heading !== '正文')
}
