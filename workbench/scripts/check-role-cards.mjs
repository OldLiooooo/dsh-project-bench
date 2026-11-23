#!/usr/bin/env node
// 角色卡一致性校验：把 roles/*.md 与 host/roles.js 的内置兜底卡对回同一个事实。
//
// 为什么需要它：角色卡外置之后出现了**两份**同一内容（文件是事实源，内置卡是读文件失败时的降级路径）。
// 两份不一致时不会报错，只会让「读不到文件」的会话拿到一份过时文案 —— 这种漂移没有任何测试会变红。
// 与 scripts/check-doc-counts.mjs 同一思路：把「必须一致」的那件事写成可复算的断言。
//
// 用法：
//   node workbench/scripts/check-role-cards.mjs          # 打印对照结论
//   node workbench/scripts/check-role-cards.mjs --json   # 机器可读
// 退出码：0 全部一致；1 发现漂移（可用于 CI / 收工前置）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKBENCH = join(HERE, '..')

/** 六节字段：文件侧（parseRoleCard 的输出）与兜底卡侧（FALLBACK_CARDS 的键）对照。 */
const FIELDS = [
  { key: 'title', file: 'title', fallback: 'title' },
  { key: 'stage', file: 'stage', fallback: 'stage' },
  { key: '职责', file: 'duty', fallback: 'duty' },
  { key: '读', file: 'reads', fallback: 'reads' },
  { key: '写', file: 'writes', fallback: 'writes' },
  { key: '开工', file: 'start', fallback: 'start' },
  { key: '收工', file: 'finish', fallback: 'finish' },
  { key: '红线', file: 'guardrails', fallback: 'guardrails' },
]

function same(a, b) {
  const normalize = (value) => Array.isArray(value) ? value.map((item) => String(item).trim()).join('\n') : String(value === undefined || value === null ? '' : value).trim()
  return normalize(a) === normalize(b)
}

/**
 * 实测：逐个角色比对文件卡与兜底卡。
 * @returns {{ok:boolean, findings:Array<{word:string,file:string,field:string,fileValue:string,fallbackValue:string}>, missingFiles:string[], errors:string[]}}
 */
export async function measure() {
  const roles = await import(new URL('../host/roles.js', import.meta.url).href)
  const findings = []
  const missingFiles = []
  const errors = []
  for (const [word, file] of Object.entries(roles.ROLE_FILES)) {
    let text
    try {
      text = readFileSync(join(WORKBENCH, 'roles', file), 'utf8')
    } catch (error) {
      missingFiles.push(file)
      continue
    }
    let parsed
    try {
      parsed = roles.parseRoleCard(text)
    } catch (error) {
      errors.push(file + ': ' + String((error && error.message) || error))
      continue
    }
    if (parsed.word !== word) {
      findings.push({ word, file, field: 'word', fileValue: String(parsed.word || ''), fallbackValue: word })
    }
    const fallback = roles.FALLBACK_CARDS[word]
    if (!fallback) {
      findings.push({ word, file, field: '(fallback)', fileValue: '有文件', fallbackValue: '缺兜底卡' })
      continue
    }
    for (const field of FIELDS) {
      if (!same(parsed[field.file], fallback[field.fallback])) {
        findings.push({
          word,
          file,
          field: field.key,
          fileValue: Array.isArray(parsed[field.file]) ? parsed[field.file].join(' / ') : String(parsed[field.file] || ''),
          fallbackValue: Array.isArray(fallback[field.fallback]) ? fallback[field.fallback].join(' / ') : String(fallback[field.fallback] || ''),
        })
      }
    }
  }
  return { ok: findings.length === 0 && missingFiles.length === 0 && errors.length === 0, findings, missingFiles, errors }
}

async function run() {
  const json = process.argv.includes('--json')
  const result = await measure()
  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    if (result.errors.length > 0) for (const item of result.errors) console.log('ERROR ' + item)
    if (result.missingFiles.length > 0) for (const item of result.missingFiles) console.log('MISSING roles/' + item)
    for (const item of result.findings) {
      console.log('DRIFT ' + item.file + ' — ' + item.word + ' / ' + item.field)
      console.log('      文件：' + item.fileValue)
      console.log('      兜底：' + item.fallbackValue)
    }
    // 张数从代码实测取，不写死：v6 加「调研」时这条文案立刻漂了（说 9 张、实际校验 10 张）。
    // 用 ROLE_FILES 的长度（= PM + QA + 任务角色），它才是「要校验几张」的唯一来源。
    const rolesModule = await import(new URL('../host/roles.js', import.meta.url).href)
    if (result.ok) console.log('RESULT: PASS（' + Object.keys(rolesModule.ROLE_FILES).length + ' 张角色卡的文件与内置兜底完全一致）')
    else console.log('RESULT: FAIL（' + (result.findings.length + result.missingFiles.length + result.errors.length) + ' 处漂移）')
  }
  process.exitCode = result.ok ? 0 : 1
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) run()
