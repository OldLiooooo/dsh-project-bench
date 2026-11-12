#!/usr/bin/env node
// T5 verify · 插件安装检查/规划脚本（契约 §0 / §11.4；不修改 ~/.dsh）。
// 只依赖 node: 内置模块。
//
// 用法：
//   node workbench/scripts/dev-install.mjs check [--home <DSH_HOME>] [--profile web] [--bundle <dir>] [--json]
//   node workbench/scripts/dev-install.mjs plan  [--home <DSH_HOME>] [--profile web] [--bundle <dir>]
//   node workbench/scripts/dev-install.mjs install [--home <DSH_HOME>] [--profile web] [--bundle <dir>] [--dry-run]
//   node workbench/scripts/dev-install.mjs instructions
//
// 说明：DSH 把 desktop 设为 Electron 保留 profile，外部 CLI 不能管理它；
// 安装到用户日常 app 的说明见 instructions（在 app 的插件管理器里加入本地 bundle，然后重启）。
// 本脚本的 install 只面向隔离 profile（默认 <workspace>/.devhome 的 web）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const WORKBENCH_ROOT = resolve(SCRIPT_DIR, '..')
export const WORKSPACE_ROOT = resolve(WORKBENCH_ROOT, '..')
export const PLUGIN_NAME = '@local/dsh-project-workbench'
export const DEFAULT_HOME = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), '.dsh')
export const DEV_HOME = join(WORKSPACE_ROOT, '.devhome')
export const DEFAULT_PROFILE = 'web'
export const DEFAULT_EXE = process.env.DSH_DESKTOP_EXE || 'C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
export const DEFAULT_CLI = process.env.DSH_DESKTOP_CLI || 'C:/Users/oldap/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'

const REQUIRED_BUNDLE_FILES = ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'package.json', 'host/db.js']
const RESERVED_PROFILES = new Set(['desktop'])

export class InstallError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InstallError'
    this.code = code
  }
}

/** Windows 大小写不敏感，比较安装链接路径时统一小写。 */
export function canonicalPath(path) {
  const resolved = resolve(path)
  let real = resolved
  try { real = realpathSync.native(resolved) } catch { /* 不存在时保留解析结果 */ }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

export function profileDir(home, profile) { return join(home, 'profiles', profile) }

export function bundlePath(options = {}) { return resolve(options.bundle || WORKBENCH_ROOT) }

/** 静态检查 bundle 是否是可安装的 DSH 插件。 */
export function inspectBundle(bundle = WORKBENCH_ROOT) {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })
  const pkgFile = join(bundle, 'package.json')
  const pkg = readJson(pkgFile)
  push('bundle/package.json', Boolean(pkg), pkgFile)
  if (!pkg) return checks
  push('bundle/name', pkg.name === PLUGIN_NAME, '期望 ' + PLUGIN_NAME + '，实际 ' + String(pkg.name))
  push('bundle/type=module', pkg.type === 'module', String(pkg.type))
  push('bundle/dsh 清单', Boolean(pkg.dsh && pkg.dsh.manifestVersion), JSON.stringify(pkg.dsh || null))
  push('bundle/patch 声明', Boolean(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), JSON.stringify((pkg.dsh && pkg.dsh.bundle) || null))
  push('bundle/client 声明', Boolean(pkg.dsh && pkg.dsh.client), JSON.stringify((pkg.dsh && pkg.dsh.client) || null))
  for (const rel of REQUIRED_BUNDLE_FILES) {
    const file = join(bundle, rel)
    push('bundle/file:' + rel, existsSync(file), file)
  }
  const patchFile = join(bundle, 'cordis.patch.yml')
  const patch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  push('bundle/patch 含 project-workbench 行', patch.includes('project-workbench') && patch.includes(PLUGIN_NAME), patchFile)
  return checks
}

/** 检查目标 profile 的安装状态（不写盘）。 */
export function inspectProfile(options = {}) {
  const home = resolve(options.home || DEFAULT_HOME)
  const profile = options.profile || DEFAULT_PROFILE
  const bundle = bundlePath(options)
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail })
  const dir = profileDir(home, profile)
  const pkgFile = join(dir, 'package.json')
  push('profile/' + profile + ' 目录存在', existsSync(dir), dir)
  push('profile/package.json 存在', existsSync(pkgFile), pkgFile)
  const pkg = readJson(pkgFile)
  if (!pkg) return checks
  const deps = pkg.dependencies || {}
  const link = deps[PLUGIN_NAME]
  push('profile 依赖含 ' + PLUGIN_NAME, Boolean(link), String(link || '未安装'))
  if (link) {
    const target = String(link).replace(/^link:/, '').replace(/^file:/, '')
    const absolute = isAbsolute(target) ? target : resolve(dir, target)
    push('profile 依赖指向本 bundle', canonicalPath(absolute) === canonicalPath(bundle), '实际 ' + absolute + ' / 期望 ' + bundle)
  }
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  push('profile bundles 含 ' + PLUGIN_NAME, bundles.includes(PLUGIN_NAME), JSON.stringify(bundles))
  push('profile 清单其余 bundle 未丢失', bundles.includes('@deepseek-ai/dsh-base'), JSON.stringify(bundles))
  return checks
}

export function collectChecks(options = {}) {
  const bundle = bundlePath(options)
  return [
    ...inspectBundle(bundle).map((c) => ({ ...c, scope: 'bundle' })),
    ...inspectProfile({ ...options, bundle }).map((c) => ({ ...c, scope: 'profile' })),
  ]
}

export function renderChecks(checks) {
  const lines = []
  let failures = 0
  for (const check of checks) {
    const mark = check.ok ? '[ok]  ' : '[FAIL]'
    if (!check.ok) failures += 1
    const displayName = check.name.startsWith(check.scope + '/') ? check.name : check.scope + '/' + check.name
    lines.push(mark + ' ' + displayName + (check.detail ? '  — ' + check.detail : ''))
  }
  return { text: lines.join('\n'), failures }
}

/** 生成安装/校验命令（不执行）。 */
export function planInstall(options = {}) {
  const home = resolve(options.home || DEV_HOME)
  const profile = options.profile || DEFAULT_PROFILE
  const bundle = bundlePath(options)
  const exe = options.exe || DEFAULT_EXE
  const cli = options.cli || DEFAULT_CLI
  const env = { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }
  const installArgs = ['--expose-internals', cli, 'plugin', '--profile', profile, 'add', bundle]
  const startArgs = ['--expose-internals', cli, '--profile', profile, '--no-open', '--port', '52999']
  return {
    home,
    profile,
    bundle,
    reservedProfile: RESERVED_PROFILES.has(profile),
    env,
    install: { exe, args: installArgs, env },
    start: { exe, args: startArgs, env },
    verify: 'node workbench/scripts/dev-install.mjs check --home "' + home + '" --profile ' + profile,
    restart: 'node workbench/scripts/dev-instance.mjs restart --home "' + home + '"',
  }
}

function shellQuote(value) { return '"' + String(value).replaceAll('"', '\\"') + '"' }

export function planText(plan) {
  const lines = []
  lines.push('安装到 profile: ' + plan.profile)
  lines.push('DSH_HOME:      ' + plan.home)
  lines.push('bundle:        ' + plan.bundle)
  lines.push('')
  lines.push('1) 安装（DSH CLI 转发 pnpm；需要 ELECTRON_RUN_AS_NODE=1 与 DSH_HOME）:')
  lines.push('   ELECTRON_RUN_AS_NODE=1 DSH_HOME=' + shellQuote(plan.home) + ' ' + shellQuote(plan.install.exe) + ' ' + plan.install.args.map(shellQuote).join(' '))
  lines.push('')
  lines.push('2) 校验:')
  lines.push('   ' + plan.verify)
  lines.push('')
  lines.push('3) 重启隔离实例:')
  lines.push('   ' + plan.restart)
  if (plan.reservedProfile) {
    lines.push('')
    lines.push('注意：desktop 是 Electron 保留 profile，外部 CLI 的 plugin 命令会被拒绝；')
    lines.push('     用户日常 app 的安装请在 DSH「设置 → 插件」里添加本地插件（见 instructions）。')
  }
  return lines.join('\n')
}

export function runInstall(plan, options = {}) {
  if (RESERVED_PROFILES.has(plan.profile)) {
    throw new InstallError('RESERVED_PROFILE', 'profile "' + plan.profile + '" 是 Electron 保留 profile，外部 CLI 无法安装；请用 instructions 里的 app 内插件管理流程。')
  }
  if (options.dryRun) return { status: 'dry-run', command: plan.install }
  const result = spawnSync(plan.install.exe, plan.install.args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600000,
    env: { ...process.env, ...plan.install.env },
  })
  return {
    status: result.status === 0 ? 'installed' : 'failed',
    exitCode: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

export function instructions() {
  return [
    '用户安装（不改 ~/.dsh；在 DSH app 内操作）:',
    '  1) 打开 DeepSeek Harness → 设置 → 插件（plugin manager）；',
    '  2) 选择「添加本地插件 / 安装本地 bundle」，路径填:',
    '     ' + WORKBENCH_ROOT,
    '  3) 完全退出 DSH（托盘也退出）后重新打开；',
    '  4) 在某个工作区打开右侧栏「项目」面板，点「初始化项目」；',
    '  5) 校验（只读，不会改 ~/.dsh）:',
    '     node workbench/scripts/dev-install.mjs check --home "' + join(homedir(), '.dsh') + '" --profile desktop',
    '',
    '隔离开发实例（推荐先用它验证，DSH_HOME 用 workspace 内 .devhome）:',
    '  node workbench/scripts/dev-install.mjs plan --home "' + DEV_HOME + '" --profile web',
    '  node workbench/scripts/dev-instance.mjs start',
    '',
    '说明：desktop profile 由 Electron app 保留管理，外部 dsh CLI 的 plugin --profile desktop 会被拒绝；',
    '因此用户安装一律走 app 内插件管理器。.devhome 下的 web profile 可以用 CLI 自动安装（install 子命令）。',
  ].join('\n')
}

function parseArgs(argv) {
  const options = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--home') options.home = resolve(argv[++i])
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--bundle') options.bundle = resolve(argv[++i])
    else if (arg === '--exe') options.exe = argv[++i]
    else if (arg === '--cli') options.cli = argv[++i]
    else options._.push(arg)
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const command = argv[0]
  const options = parseArgs(argv.slice(1))
  const emitJson = Boolean(options.json)
  try {
    switch (command) {
      case 'check': {
        const checks = collectChecks(options)
        const rendered = renderChecks(checks)
        if (emitJson) console.log(JSON.stringify({ home: options.home || DEFAULT_HOME, profile: options.profile || DEFAULT_PROFILE, checks, failures: rendered.failures }, null, 2))
        else console.log(rendered.text)
        return rendered.failures > 0 ? 1 : 0
      }
      case 'plan': {
        const plan = planInstall(options)
        if (emitJson) console.log(JSON.stringify(plan, null, 2))
        else console.log(planText(plan))
        return 0
      }
      case 'install': {
        const plan = planInstall(options)
        if (!emitJson && !options.dryRun) console.log(planText(plan))
        const result = runInstall(plan, { dryRun: options.dryRun })
        if (emitJson) console.log(JSON.stringify(result, null, 2))
        else if (result.status === 'dry-run') console.log('dry-run: 未执行安装')
        else console.log('install: ' + result.status + (result.exitCode !== 0 ? ' (exit ' + String(result.exitCode) + ')\n' + result.stderr.slice(-2000) : ''))
        if (result.status === 'failed') return 1
        if (options.dryRun) return 0
        const checks = collectChecks(options)
        const rendered = renderChecks(checks)
        if (!emitJson) console.log('\n' + rendered.text)
        return rendered.failures > 0 ? 1 : 0
      }
      case 'instructions': {
        console.log(instructions())
        return 0
      }
      default:
        console.error('用法：node workbench/scripts/dev-install.mjs <check|plan|install|instructions> [--home <DSH_HOME>] [--profile web] [--bundle <dir>] [--json] [--dry-run]')
        return 2
    }
  } catch (error) {
    const code = error && error.code ? error.code : 'ERROR'
    if (emitJson) console.log(JSON.stringify({ status: 'error', code, message: String(error && error.message) }, null, 2))
    else console.error('ERROR[' + code + '] ' + String(error && error.message))
    return 1
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (isMain) process.exitCode = main(process.argv.slice(2))