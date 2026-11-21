#!/usr/bin/env node
// 真实判据接入验证：用 lumio 仓库里**现成的** tools/engineering/*.mjs 跑门禁前置机检。
//
// 这不是模拟：checker.mjs / closeout.mjs 是 lumio 自己的判据（16 条结构规则 + 3 条收尾对账），
// 纯 Node 只读，插件 Host 进程直接 import，不 spawn、不 shell。
//
// 用法：node workbench/tests/probes/gate-real-checkers.mjs [--root <repo>]
// 退出码：0 证明「红灯被拒 + 绿灯放行」两条都成立；1 任一不成立。
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import process from 'node:process'
import { runProjectCheckers, summarizeCheckRun, DEFAULT_CHECKERS } from '../../host/checkers.js'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const targetRoot = resolve(argOf('--root', 'C:/Users/oldap/Documents/lumio'))

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + String(detail).slice(0, 400) : ''))
}

// ① 真实红灯：lumio 当前状态跑真实判据，应当 ok=false 且 issues 非空
const red = await runProjectCheckers(targetRoot, { checkers: DEFAULT_CHECKERS })
record('真实仓库跑真实判据（应红灯）', red.skipped === false && red.ok === false && red.issues.length > 0,
  summarizeCheckRun(red).split(String.fromCharCode(10)).slice(0, 3).join(' | '))
const codes = [...new Set(red.issues.map((issue) => issue.code))]
console.log('      issues=' + String(red.issues.length) + ' codes=' + codes.join(',') + ' duration=' + String(red.durationMs) + 'ms')

// ② 有判据但仓库干净 → 应当放行（用一个只读的最小 fixture 证明「绿灯也真的会绿」）
const fixtureRoot = resolve(argOf('--fixture', new URL('./.artifacts/green-fixture', import.meta.url).pathname.slice(1)))
const fixture = await import(pathToFileURL(resolve(import.meta.dirname, 'gate-green-fixture.mjs')).href).catch(() => undefined)
if (fixture && typeof fixture.buildGreenFixture === 'function') {
  await fixture.buildGreenFixture(fixtureRoot)
  const green = await runProjectCheckers(fixtureRoot, { checkers: DEFAULT_CHECKERS })
  record('干净仓库跑真实判据（应绿灯）', green.ok === true && green.issues.length === 0, summarizeCheckRun(green))
} else {
  record('干净仓库跑真实判据（应绿灯）', false, '缺少 fixture 构造器 gate-green-fixture.mjs')
}

// ③ 判据跑不起来 → fail-closed
const brokenRoot = resolve(argOf('--broken', new URL('./.artifacts/broken-fixture', import.meta.url).pathname.slice(1)))
const broken = await import('node:fs/promises')
await broken.mkdir(resolve(brokenRoot, 'tools/engineering'), { recursive: true })
await broken.writeFile(resolve(brokenRoot, 'tools/engineering/checker.mjs'), 'export async function checkRepository() { throw new Error("判据自身故障") }\n', 'utf8')
const brokenRun = await runProjectCheckers(brokenRoot, { checkers: [DEFAULT_CHECKERS[0]] })
record('判据故障 → fail-closed', brokenRun.ok === false && brokenRun.issues.some((issue) => issue.code === 'CHECKER_ERROR'), summarizeCheckRun(brokenRun))

const failed = results.filter((item) => !item.ok).length
console.log('\n[gate-real-checkers] passed=' + String(results.length - failed) + ' failed=' + String(failed))
process.exitCode = failed > 0 ? 1 : 0
