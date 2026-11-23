#!/usr/bin/env node
// 文档计数校验：把「文档里写的数字」对回代码实测值。
//
// 为什么需要它：2026-11-21 的审计发现 design-logic 里 4 处、README 里 6 处计数写错
// （26/19/7 工具表触发器、58 例、3/3…）。这类漂移不会让测试变红，但会让「诚实」先烂在最容易改的地方。
// 与其依赖人记得改，不如让一个脚本每次跑都算一遍并对照。
//
// 设计取舍：只校验**规范句**（canonical claims），不做全文数字扫描。
// 全文扫描会把「v1.0 写 19 张表」这类历史引述、以及「11 个 UI 槽位」这类别的数字
// 全判成漂移 —— 假阳性一多，脚本就没人看了，等于没写。
//
// 用法：
//   node workbench/scripts/check-doc-counts.mjs          # 打印实测值 + 对照结论
//   node workbench/scripts/check-doc-counts.mjs --json   # 机器可读
// 退出码：0 全部一致；1 发现漂移（可用于 CI / 收工前置）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKBENCH = join(HERE, '..')
const WORKSPACE = join(WORKBENCH, '..')

function readText(path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function walk(dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.artifacts' || name === '.tmp') continue
    const full = join(dir, name)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (stat.isDirectory()) walk(full, out)
    else if (full.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * 实测值：每个都可复算，不靠人记。
 * 口径与交付审计一致：空 catch 统计 host/**、index.js、client.js 三处
 * （早期审计写 58 例时就是这个口径，只统计 host 会少算 client 里的 4 个）。
 */
export function measure() {
  const hostFiles = walk(join(WORKBENCH, 'host'))
  const allJsForCatch = hostFiles
    .concat([join(WORKBENCH, 'index.js'), join(WORKBENCH, 'client.js')])
    .filter((file) => readText(file) !== '')
  const schema = readText(join(WORKBENCH, 'host', 'schema.js'))
  const http = readText(join(WORKBENCH, 'host', 'http.js'))
  const toolFiles = readdirSync(join(WORKBENCH, 'host', 'tools')).filter((f) => f.endsWith('.js'))
  let tools = 0
  for (const file of toolFiles) {
    const text = readText(join(WORKBENCH, 'host', 'tools', file))
    // 工具名统一定义在对象字面量的第一层：`  name: 'xxx',`
    tools += (text.match(/^  name: '[a-z_]+',$/gm) || []).length
  }
  let catchTotal = 0
  let catchEmpty = 0
  for (const file of allJsForCatch) {
    const src = readText(file)
    const re = /catch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g
    let match
    while ((match = re.exec(src))) {
      catchTotal += 1
      const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim()
      if (body === '') catchEmpty += 1
    }
  }
  // 按 actor 统计可见工具数（v6 起文档写「PM 可见 27」，这类数字最容易漂）
  let pmVisible = 0
  let taskVisible = 0
  let qaVisible = 0
  for (const file of toolFiles) {
    const text = readText(join(WORKBENCH, 'host', 'tools', file))
    const blocks = text.split(/^  name: /m).slice(1)
    for (const block of blocks) {
      const actors = block.match(/actors: \[([^\]]*)\]/)
      if (!actors) continue
      const list = actors[1].split(',').map((item) => item.trim().replace(/['"]/g, ''))
      if (list.includes('pm')) pmVisible += 1
      if (list.includes('task')) taskVisible += 1
      if (list.includes('qa')) qaVisible += 1
    }
  }
  return {
    tools,
    pmVisible,
    taskVisible,
    qaVisible,
    tables: (schema.match(/CREATE TABLE|CREATE VIRTUAL TABLE/g) || []).length,
    // 只数**真的** CREATE TRIGGER 语句：行首是两个空格 + 反引号（模板字符串里的 DDL），
    // 这样注释、正则字符串里的 "CREATE TRIGGER" 不会被误算（verifyMigration 里就有一处）。
    triggers: (schema.match(/^\s{2}`CREATE TRIGGER/gm) || []).length,
    routes: (http.match(/^      case '/gm) || []).length,
    hostModules: readdirSync(join(WORKBENCH, 'host')).filter((f) => f.endsWith('.js')).length + toolFiles.length,
    clientLines: readText(join(WORKBENCH, 'client.js')).split('\n').length - 1,
    catchTotal,
    catchEmpty,
  }
}

/**
 * 规范句断言：把文档里「必须与代码一致」的那一句原样写下来，用包含判定。
 * 这样文档改一个字（比如把 27 改成 30）会被抓到，讲历史的段落不会被误判。
 */
const CLAIMS = [
  {
    file: 'docs/workbench-design-logic.zh.md',
    label: '【插件】一行：工具/表/触发器',
    contains: (a) => `${a.tools} 个工具、${a.tables} 张表（23 普通 + 1 FTS5 虚拟）、${a.triggers} 个触发器`,
  },
  {
    file: 'docs/workbench-design-logic.zh.md',
    label: '能拒绝的状态机一行',
    contains: (a) => `阶段机 + 门禁 + 租约 + ${a.triggers} 个 DB 触发器`,
  },
  {
    file: 'docs/workbench-design-logic.zh.md',
    label: '存储层一行',
    contains: (a) => `ProjectDb（单实例）→ ${a.tables} 表（23 普通 + 1 FTS5 虚拟）+ ${a.triggers} 触发器`,
  },
  {
    file: 'docs/workbench-design-logic.zh.md',
    label: '通道层一行',
    contains: (a) => `HTTP ${a.routes} 路由`,
  },
  {
    file: 'docs/workbench-design-logic.zh.md',
    label: '能力层一行（工具数）',
    contains: (a) => `能力层：${a.tools} 个工具`,
  },
  {
    // v6：这一句曾经同时漂了三个数（工具 30/31、PM 可见 26/27、「验收独有 1」其实是共享）
    file: 'docs/workbench-design-logic.zh.md',
    label: '工具可见数一行（PM/任务/验收）',
    contains: (a) => `PM 可见 ${a.pmVisible}，任务可见 ${a.taskVisible}，验收（qa）可见 ${a.qaVisible}`,
  },
  {
    file: 'docs/workbench-design-logic.zh.md',
    label: '空 catch 缺口行',
    contains: (a) => `${a.catchEmpty} 个空 catch 仍在（共 ${a.catchTotal} 个 catch`,
  },
  {
    file: 'README.md',
    label: 'host 模块 + client 行数（英）',
    contains: (a) => `host runtime (${a.hostModules} modules)`,
  },
  {
    file: 'README.md',
    label: 'host 模块 + client 行数（中）',
    contains: (a) => `Host 运行时（${a.hostModules} 个模块）`,
  },
]

function run() {
  const json = process.argv.includes('--json')
  const actual = measure()
  const findings = []
  for (const claim of CLAIMS) {
    const text = readText(join(WORKSPACE, claim.file))
    if (!text) {
      findings.push({ file: claim.file, label: claim.label, problem: '文件不存在' })
      continue
    }
    const expected = claim.contains(actual)
    if (!text.includes(expected)) {
      findings.push({ file: claim.file, label: claim.label, expected, problem: '文档里找不到这句话（数已漂移或行被改写）' })
    }
  }
  if (json) {
    console.log(JSON.stringify({ actual, findings, ok: findings.length === 0 }, null, 2))
  } else {
    console.log('实测值：')
    for (const [key, value] of Object.entries(actual)) console.log('  ' + key.padEnd(14) + value)
    console.log()
    if (findings.length === 0) {
      console.log('RESULT: PASS（' + CLAIMS.length + ' 条规范句与代码实测一致）')
    } else {
      for (const item of findings) {
        console.log('DRIFT ' + item.file + ' — ' + item.label)
        console.log('      期望包含：' + (item.expected || item.problem))
      }
      console.log('RESULT: FAIL（' + findings.length + ' 处漂移）')
    }
  }
  process.exitCode = findings.length === 0 ? 0 : 1
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) run()
