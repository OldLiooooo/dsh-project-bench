#!/usr/bin/env node
// T5 verify · 语法检查（等价于对所有改动 js 的 node --check，可在 ops_bash 不可用时用 node 直接运行）。
//
// 做法：对 workbench/**/*.js|*.mjs 逐个动态 import：
// - host 模块导入即完成 ESM 解析，语法错误会抛 SyntaxError；
// - client.js 是浏览器 bundle，用最小 window/document 桩让顶层 __ModuleLoader__.load(...) 只被捕获、不执行 factory；
// - 测试/脚本文件均有 isMain/NODE_TEST_CONTEXT 守卫，导入不会触发副作用。
//
// 用法：node workbench/scripts/check-syntax.mjs [--json] [--list]
// 退出码：0 全部可解析；1 有语法错误/导入错误。
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const WORKBENCH_ROOT = dirname(SCRIPT_DIR)
/**
 * Directories never imported by the checker.
 * `probes` holds 一次性验收探针（直连 SQLite / 拷真实库），它们在模块顶层就执行并 `process.exit`，
 * 被 import 会劫持本脚本的退出码（让语法门禁失效）。探针必须用 `node <file>` 单独跑。
 */
const SKIP_DIRS = new Set(['node_modules', '.artifacts', '.tmp', '.git', 'probes'])
const EXTENSIONS = ['.js', '.mjs']

/** 浏览器桩：client.js 顶层只调用 __ModuleLoader__.load 注册 factory（不执行 factory）。 */
export function installBrowserStubs() {
  const captured = []
  const element = () => ({ appendChild() {}, remove() {}, setAttribute() {}, dataset: {}, style: {}, set textContent(value) {}, set innerHTML(value) {}, set href(value) {}, set rel(value) {}, set type(value) {} })
  const defineGlobal = (name, value) => {
    try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }) } catch { /* 内建只读属性 */ }
  }
  defineGlobal('window', {
    __ModuleLoader__: { load(spec) { captured.push(spec) }, },
    addEventListener() {}, removeEventListener() {},
    location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    matchMedia() { return { matches: false, addEventListener() {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
  })
  defineGlobal('document', {
    head: { appendChild() {} },
    body: { appendChild() {} },
    createElement() { return element() },
    querySelector() { return null },
    querySelectorAll() { return [] },
    addEventListener() {}, removeEventListener() {},
  })
  defineGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'], clipboard: { writeText: async () => {} } })
  defineGlobal('EventSource', class { constructor() {} close() {} addEventListener() {} removeEventListener() {} })
  defineGlobal('HTMLElement', class {})
  defineGlobal('self', globalThis)
  return captured
}

export function listSourceFiles(root = WORKBENCH_ROOT) {
  const files = []
  // 自身必须排除：动态 import 自己会形成顶层 await 循环，进程静默挂死（不是语法问题）。
  const self = fileURLToPath(import.meta.url)
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
      } else if (entry.isFile() && EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        const file = join(dir, entry.name)
        if (file === self) continue
        files.push(file)
      }
    }
  }
  walk(root)
  return files.sort()
}

/**
 * 逐个动态 import；返回 {files, syntaxErrors, importErrors, ok, testFiles}。
 * 默认跳过 *.test.mjs 的执行（它们由 node --test / 直接 import 覆盖；导入会真的执行测试并打印报告），
 * 用 --include-tests 强制一并导入。`tests/probes/` 整个目录不进扫描（见 SKIP_DIRS 的说明）。
 */
export async function checkSyntax(options = {}) {
  const root = options.root || WORKBENCH_ROOT
  const files = listSourceFiles(root)
  const captured = options.stubBrowser === false ? [] : installBrowserStubs()
  const syntaxErrors = []
  const importErrors = []
  const ok = []
  const testFiles = []
  for (const file of files) {
    const rel = relative(root, file)
    if (!options.includeTests && /.test.mjs$/.test(file)) { testFiles.push(rel); continue }
    try {
      await import(pathToFileURL(file).href)
      ok.push(rel)
    } catch (error) {
      if (error && (error.name === 'SyntaxError' || error instanceof SyntaxError)) syntaxErrors.push({ file: rel, message: String(error.message) })
      else importErrors.push({ file: rel, message: String((error && error.message) || error) })
    }
  }
  return { files: files.map((file) => relative(root, file)), syntaxErrors, importErrors, ok, testFiles, captured }
}

export function renderReport(result) {
  const lines = []
  lines.push('checked files: ' + String(result.files.length))
  lines.push('parsed ok:     ' + String(result.ok.length))
  lines.push('syntax errors: ' + String(result.syntaxErrors.length))
  for (const item of result.syntaxErrors) lines.push('  [SYNTAX] ' + item.file + ' :: ' + item.message)
  lines.push('skipped test files (由 node --test 覆盖): ' + String((result.testFiles || []).length))
  lines.push('import errors: ' + String(result.importErrors.length))
  for (const item of result.importErrors) lines.push('  [IMPORT] ' + item.file + ' :: ' + item.message)
  if (result.syntaxErrors.length === 0 && result.importErrors.length === 0) lines.push('RESULT: PASS')
  else lines.push('RESULT: FAIL')
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json')
  const list = argv.includes('--list')
  const result = await checkSyntax({ includeTests: argv.includes('--include-tests') })
  if (json) {
    console.log(JSON.stringify({ files: result.files.length, ok: result.ok.length, testFiles: result.testFiles, syntaxErrors: result.syntaxErrors, importErrors: result.importErrors }, null, 2))
  } else {
    if (list) console.log(result.files.join('\n'))
    console.log(renderReport(result))
  }
  return result.syntaxErrors.length === 0 && result.importErrors.length === 0 ? 0 : 1
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href
// 不能用顶层 await 调 main()：main() 会动态 import 其它脚本（例如 tests/e2e/instance-http.mjs），
// 那些脚本又静态 import 本文件；本模块若在顶层 await 中挂起，循环 import 会死锁（unsettled top-level await）。
if (isMain) {
  main().then((code) => { process.exitCode = code }, (error) => {
    console.error(error)
    process.exitCode = 1
  })
}