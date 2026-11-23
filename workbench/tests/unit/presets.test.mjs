// preset 工具面契约（v6）：把「PM 不亲自调查」从提示词落成可测的结构事实。
//
// 为什么这个测试值得单独存在：
//   设计原则第 1 条是「约束要么在 DB，要么在领域函数；提示词里的话不算约束」。
//   「PM 不要自己 read/grep 仓库」如果只写在 persona 里，它就是一句话；
//   真正的约束是 **preset 里根本没有 tool-fs / tool-fs-search 这两行**。
//   而这个文件恰好是最容易被「顺手加回来」的地方 —— 所以要有断言守住。
//
// 解析方式：不引入 YAML 依赖（插件 Host 只允许 node: 内置模块），
// 用缩进扫描取「preset id → 该 preset 下所有插件 id/name」。这对本文件的结构足够，
// 且刻意只在 preset 边界内比较，避免把 qa/research 的 tool-fs 误判成 PM 的。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH = join(HERE, '..', '..', 'cordis.patch.yml')

/** 取 patch 文本里某个 preset id 的插件名清单（含 disabled 行）。 */
function pluginNamesOfPreset(text, presetId) {
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^\\s+- id: ' + presetId + '$').test(lines[i])) { start = i; break }
  }
  assert.ok(start >= 0, 'patch 里找不到 preset：' + presetId)
  const names = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // 遇到下一个 preset 行即结束
    if (/^\s+- id: preset-/.test(line)) break
    const match = line.match(/^\s+(?:- )?name: '([^']+)'$/)
    if (match) names.push(match[1])
  }
  return names
}

const patch = readFileSync(PATCH, 'utf8')

test('v6：PM preset 没有文件读工具（「不亲自调查」是工具面事实，不是提示词）', () => {
  const names = pluginNamesOfPreset(patch, 'preset-project-office')
  for (const forbidden of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search']) {
    assert.ok(!names.includes(forbidden), 'PM preset 不应挂 ' + forbidden + '（要调查请派 role=调研）')
  }
  // 也不能有 bash/pwsh：那是「换一种方式自己调查」
  for (const forbidden of ['@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-pwsh']) {
    assert.ok(!names.includes(forbidden), 'PM preset 不应挂 ' + forbidden)
  }
})

test('v6：PM preset 仍然保留对话与项目工具装配所需的行', () => {
  const names = pluginNamesOfPreset(patch, 'preset-project-office')
  assert.ok(names.includes('@deepseek-ai/dsh-persona'), 'PM 需要 persona')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-ask-user'), 'PM 是唯一能问用户的会话')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-skill'), 'PM 需要按需加载技能')
})

test('v6：调研 preset 只读（无 write/edit/applyPatch）但能检索与跑命令', () => {
  const names = pluginNamesOfPreset(patch, 'preset-project-research')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs'), '调研需要读文件')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-fs-search'), '调研需要 glob/grep')
  assert.ok(names.includes('@deepseek-ai/dsh-tool-web'), '调研可能需要外部资料')
  // 不允许再拉子 agent（否则「谁在查」不可追）
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-subagent'), '调研会话不应再拉子 agent')
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-ask-user'), '调研不直接问用户')
})

test('v6：调研 preset 的 tool-fs 三个写开关全为 false', () => {
  const text = patch
  const start = text.indexOf('- id: preset-project-research')
  assert.ok(start >= 0)
  const next = text.indexOf('- id: preset-project-', start + 10)
  const block = text.slice(start, next > 0 ? next : text.length)
  const fsStart = block.indexOf("name: '@deepseek-ai/dsh-tool-fs'")
  assert.ok(fsStart >= 0, '调研 preset 应有 tool-fs 行')
  const fsBlock = block.slice(fsStart, fsStart + 400)
  for (const key of ['write', 'edit', 'applyPatch']) {
    const match = fsBlock.match(new RegExp(key + ':\\s*(\\w+)'))
    assert.ok(match, 'tool-fs 应显式声明 ' + key)
    assert.equal(match[1], 'false', '调研会话的 tool-fs.' + key + ' 必须显式为 false')
  }
})

test('v6：验收与调研是两个独立 preset（不能被合并成 project-task）', () => {
  for (const preset of ['preset-project-qa', 'preset-project-research']) {
    assert.ok(patch.includes('id: ' + preset), 'patch 应包含 ' + preset)
  }
  // preset id 唯一
  const ids = [...patch.matchAll(/^\s+- id: (preset-[a-z-]+)$/gm)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, 'preset id 不应重复：' + ids.join(','))
})
