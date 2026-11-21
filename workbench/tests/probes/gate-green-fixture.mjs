// 绿灯 fixture：一个「结构完整、判据全过」的最小仓库。
// 用途：证明 true positive（真红灯被拒）之外，false positive 也不存在 —— 干净仓库必须放行。
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function buildGreenFixture(root) {
  await mkdir(join(root, 'tools/engineering'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  // 判据模块：结构自洽（policy 里登记的目录都存在，无断链、无重复 ID、交接字段齐全）
  await writeFile(join(root, 'tools/engineering/policy.json'), JSON.stringify({
    version: 1,
    directories: ['tools', 'tools/engineering', 'docs'],
    ignoredDirectories: ['.git', 'node_modules'],
    requiredFiles: [],
    moduleReadmes: [],
    handoffFiles: [],
    legacyOwners: [],
    deferredChecks: [],
    staleHandoffExempt: [],
    generatedArtifacts: [],
  }, null, 2), 'utf8')
  await writeFile(join(root, 'tools/engineering/checker.mjs'), [
    "import fs from 'node:fs/promises'",
    "import path from 'node:path'",
    'export async function checkRepository(repoRoot) {',
    '  const issues = []',
    "  const policy = JSON.parse(await fs.readFile(path.join(repoRoot, 'tools/engineering/policy.json'), 'utf8'))",
    '  for (const dir of policy.directories) {',
    "    try { await fs.stat(path.join(repoRoot, dir)) } catch (error) { issues.push({ code: 'DIR_MISSING', path: dir, message: 'Directory is registered but missing.' }) }",
    '  }',
    '  return { ok: issues.length === 0, issues, counts: { directories: policy.directories.length } }',
    '}',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'tools/engineering/closeout.mjs'), [
    'export function checkCloseout() { return { ok: true, issues: [] } }',
  ].join('\n'), 'utf8')
  await writeFile(join(root, 'docs/README.md'), '# Fixture\n', 'utf8')
  return root
}

export function policyPath(root) { return join(root, 'tools/engineering/policy.json') }
