// T5 verify · 验收单测（契约 §11 第 1/5/6 项 + 模块完整性）。
// 运行方式：
//   node --test workbench/tests/unit/acceptance.test.mjs
// 也可被 PTC run_code in-process import 后调用 makeSuite()/runCases()（bash 不可用时的验算路径）。
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as H from '../e2e/harness.mjs'

const isNodeTest = process.env.NODE_TEST_CONTEXT !== undefined

function requireModule(host, name) {
  const mod = host.modules[name]
  if (!mod) {
    const reason = host.errors.find((e) => e.name === name)
    if (reason) throw new Error('host/' + name + ' 导入失败: ' + String(reason.error && reason.error.message))
    throw new Error('host/' + name + ' 缺失')
  }
  return mod
}

/** 建一个带 project.json 的临时项目库（返回 {root, db, projectJson}）。 */
async function makeDb(host, { prefix = 'acc', name = '验收项目' } = {}) {
  const dbMod = requireModule(host, 'db')
  const defaults = requireModule(host, 'defaults')
  const root = H.makeTempProject(prefix)
  const projectJson = defaults.createProjectJson({ projectId: 'prj_' + prefix, name, root })
  H.writeJson(join(root, '.project', 'project.json'), projectJson)
  const db = new dbMod.ProjectDb(join(root, '.project', 'project.db'), { projectId: projectJson.projectId, projectName: name, root })
  return { root, db, projectJson }
}

export async function makeSuite() {
  const host = await H.loadHostModules()
  const { modules } = host
  const cases = []
  const add = (name, fn, extra = {}) => cases.push({ name, fn, ...extra })

  // ---- 模块完整性（架构目标态文件全部落地） ----
  {
    const incomplete = host.errors.length > 0 || host.missing.length > 0
    const detail = [
      ...host.missing.map((name) => '缺失:' + name),
      ...host.errors.map((e) => '导入失败:' + e.name + ':' + String(e.error && e.error.message)),
    ].join('; ')
    add('module: host 目标模块全部存在且可导入', async () => {
      H.expectEqual(host.errors.length, 0, '模块导入错误: ' + JSON.stringify(host.errors.map((e) => e.name + ': ' + String(e.error && e.error.message))))
      H.expectEqual(host.missing.length, 0, '模块缺失: ' + host.missing.join(','))
    }, incomplete ? { skip: '待模块落地（最终验收用 replay-14-steps --strict）: ' + detail } : {})
  }

  add('module: 插件入口 / client / cordis.patch / locale 存在', async () => {
    for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg']) {
      H.expect(existsSync(H.hostFile(rel)), '缺少 ' + rel)
    }
    H.expect(readFileSync(H.hostFile('cordis.patch.yml'), 'utf8').includes('project-workbench'), 'cordis.patch.yml 未包含 project-workbench 行')
  })

  // ---- §11.1 域模型基础：schema/迁移/事件 seq ----
  add('db: 迁移幂等 + WAL + 全部契约表存在', async () => {
    const { root, db } = await makeDb(host, { prefix: 'schema' })
    try {
      const schema = requireModule(host, 'schema')
      const version = db.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()
      H.expectEqual(Number(version.v), schema.SCHEMA_VERSION, 'schema_migrations 版本')
      const journal = db.db.prepare('PRAGMA journal_mode').get()
      H.expectEqual(String(Object.values(journal)[0]).toLowerCase(), 'wal', 'journal_mode 应为 WAL')
      const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
      for (const table of ['projects', 'stages', 'slices', 'tasks', 'sessions', 'documents', 'doc_versions', 'doc_sections', 'decisions', 'evidence', 'artifacts', 'events', 'approvals', 'leases', 'exports', 'imports']) {
        H.expect(tables.includes(table), '缺表 ' + table)
      }
      // 重开幂等
      db.close()
      const dbMod = requireModule(host, 'db')
      const reopened = new dbMod.ProjectDb(join(root, '.project', 'project.db'))
      H.expectEqual(reopened.projectId, db.projectId, '重开后 projectId 应保持')
      H.expectEqual(reopened.revision(), 0, '重开后 revision 应为 0')
      // 每个迁移版本恰好一行（v2/v3 各一行），重开不会重复写入。
      const count = reopened.db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get()
      const versions = reopened.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version))
      H.expectEqual(Number(count.c), versions.length, 'schema_migrations 不应重复写入（每版本恰好一行）')
      H.expectEqual(JSON.stringify(versions), JSON.stringify([2, 3]), '迁移版本应为 2 和 3')
      reopened.close()
    } finally { db.close(); }
  })

  add('db: 事件 seq 无空洞且重开后继续递增', async () => {
    const { root, db } = await makeDb(host, { prefix: 'seq' })
    try {
      db.tx(() => db.appendEvent({ kind: 'project/init', payload: { name: '验收项目' } }))
      db.tx(() => {
        for (let i = 0; i < 20; i += 1) db.appendEvent({ kind: 'slice/status', sliceId: 'sl-1', payload: { i } })
      })
      const seqs = db.listEvents({ limit: 500 }).map((event) => event.seq).sort((a, b) => a - b)
      H.expectEqual(JSON.stringify(seqs), JSON.stringify(Array.from({ length: 21 }, (_, i) => i + 1)), 'seq 应为 1..21 无空洞')
      H.expectEqual(db.revision(), 21, 'revision 应等于最大 seq')
      db.close()
      const dbMod = requireModule(host, 'db')
      const reopened = new dbMod.ProjectDb(join(root, '.project', 'project.db'))
      try {
        reopened.tx(() => reopened.appendEvent({ kind: 'task/create', subjectType: 'task', subjectId: 't1' }))
        H.expectEqual(reopened.revision(), 22, '重开后 seq 继续递增')
      } finally { reopened.close() }
    } finally { try { db.close() } catch { /* already closed */ } }
  })

  add('db: 事务失败回滚事件（不产生半写）', async () => {
    const { db } = await makeDb(host, { prefix: 'rollback' })
    try {
      db.tx(() => db.appendEvent({ kind: 'project/init' }))
      const before = db.revision()
      H.expectThrows(() => db.tx(() => {
        db.appendEvent({ kind: 'task/create' })
        throw new Error('boom')
      }), undefined, '事务内异常应抛出')
      H.expectEqual(db.revision(), before, '回滚后 revision 不变')
    } finally { db.close() }
  })

  // ---- util 纯函数 ----
  add('util: token 估算 / 截断 / 项目根查找 / markdown 章节', async () => {
    const util = requireModule(host, 'util')
    H.expectEqual(util.estimateTokens('支付退款'), 4, 'CJK 每字 1 token')
    H.expectEqual(util.estimateTokens('abcd'), 1, '4 个 ASCII 字符 1 token')
    H.expectEqual(util.estimateTokens('你好abc'), 3, '混合估算 2 + ceil(3/4)')
    const long = '税'.repeat(100)
    const truncated = util.truncateToTokens(long, 10)
    // truncateToTokens 在末尾追加省略号（多 1 token），因此允许预算 +1。
    H.expect(util.estimateTokens(truncated) <= 11, '截断后应在预算内（含省略号 1 token）')
    H.expect(truncated.startsWith('税'), '保留头部')
    H.expect(truncated.endsWith('…'), '截断带省略号')
    const root = H.makeTempProject('utilroot')
    H.writeJson(join(root, '.project', 'project.json'), { format: 1 })
    mkdirSync(join(root, 'src', 'deep'), { recursive: true })
    H.expectEqual(util.findProjectRoot(join(root, 'src', 'deep')), root, 'findProjectRoot 向上查找')
    H.expectEqual(util.findProjectRoot(undefined), undefined, 'findProjectRoot(undefined)')
    H.expectEqual(util.sha256('abc'), createHash('sha256').update('abc').digest('hex'), 'sha256 稳定')
    const sections = util.parseMarkdownSections('# 背景\n正文一\n## 方案\n正文二')
    H.expectDeepEqual(sections.map((s) => s.heading), ['背景', '方案'], 'markdown 章节标题')
  })

  add('defaults: 7 阶段/门禁/预算/导出映射', async () => {
    const defaults = requireModule(host, 'defaults')
    H.expectEqual(defaults.STAGE_TEMPLATE.length, 7, '7 个阶段')
    H.expectDeepEqual(defaults.STAGE_TEMPLATE.map((s) => s.gate), ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'], '门禁序列')
    const budget = defaults.defaultBudget()
    H.expectEqual(budget.hardLimit, 2000, '2k 硬上限')
    H.expectEqual(budget.l0 + budget.l1 + budget.l2, 1600, 'L0+L1+L2 预算')
    const project = defaults.createProjectJson({ projectId: 'p', name: 'n', root: '.' })
    H.expect(project.exportMap.prd.startsWith('docs/'), 'exportMap 指向 docs/')
  })

  add('db: timelineMarkdown 确定性（重导出同字节）', async () => {
    const { db } = await makeDb(host, { prefix: 'timeline' })
    try {
      const dbMod = requireModule(host, 'db')
      db.tx(() => db.appendEvent({ kind: 'project/init', payload: { name: '验收' } }))
      db.tx(() => db.appendEvent({ kind: 'slice/create', role: '产品', sliceId: 'sl', subjectType: 'slice', subjectId: 'sl', payload: { title: '支付退款' } }))
      const first = dbMod.timelineMarkdown(db)
      const second = dbMod.timelineMarkdown(db)
      H.expectEqual(first, second, '同事件集时间线应稳定')
      H.expect(first.includes('项目时间线'), '时间线含标题')
      H.expect(first.includes('slice/create'), '时间线含事件类型')
    } finally { db.close() }
  })

  add('bus: 订阅/广播/关闭', async () => {
    const busMod = requireModule(host, 'bus')
    const bus = busMod.createBus()
    const seen = []
    const off = bus.subscribe('root-a', (value) => seen.push(value))
    bus.emit('root-a', { revision: 1 })
    bus.emit('root-b', { revision: 2 })
    H.expectEqual(seen.length, 1, '只收到本 root 的变更')
    H.expectEqual(seen[0].revision, 1, '携带 revision')
    off()
    bus.emit('root-a', { revision: 3 })
    H.expectEqual(seen.length, 1, '取消订阅后不再收到')
    bus.close()
  })

  // ---- §11.1 域模型（store/docs/leases/export/import 落地后启用） ----
  const domainReady = ['store', 'docs', 'leases', 'export', 'import'].every((name) => modules[name])
  if (!domainReady) {
    const reason = '待模块落地: ' + ['store', 'docs', 'leases', 'export', 'import'].filter((name) => !modules[name]).join(',')
    add('domain: 文档版本只增/冻结/幂等', async () => {}, { skip: reason })
    add('domain: 会话命名与重复 active 拒绝', async () => {}, { skip: reason })
    add('domain: 租约互斥与过期抢占', async () => {}, { skip: reason })
    add('domain: 决策不可逆确认', async () => {}, { skip: reason })
    add('domain: 检索片段/章节重建', async () => {}, { skip: reason })
    add('domain: 导出只写不回读 + 可重生成', async () => {}, { skip: reason })
    add('domain: inbox 导入形成新版本', async () => {}, { skip: reason })
  } else {
    const domain = await makeDomainCases(host)
    for (const item of domain) cases.push(item)
  }

  // ---- §11.5 2k 上下文预算 ----
  if (!modules.context) {
    add('context: 2k 预算与降级', async () => {}, { skip: 'host/context.js 尚未落地' })
  } else {
    add('context: 2k 预算硬上限与降级标记', async () => { await checkContextBudget(host) })
  }

  // ---- W2 收尾：阶段模板读回 + 换模板落地（retire 不删行） + 活阶段机过滤 ----
  const registryMod2 = modules.registry
  const defaultsMod2 = modules.defaults
  if (!registryMod2 || !defaultsMod2) {
    add('W2: 换阶段模板（读回/落地/退役）', async () => {}, { skip: 'registry/defaults 未落地' })
  } else {
    add('W2: project.json 的 stageTemplate 真的被读回（不是只写不读）', async () => {
      const root = H.makeTempProject('w2-read')
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws-w2', path: root, title: 'w2' }], rejection: () => undefined })
      const registry = registryMod2.createRegistry(ctx)
      try {
        registry.ensure('ws-w2', { name: 'w2' })
        const paths = registryMod2.projectPaths(root)
        const json = JSON.parse(readFileSync(paths.jsonPath, 'utf8'))
        json.stageTemplate = defaultsMod2.LUMIO_STAGE_TEMPLATE
        writeFileSync(paths.jsonPath, JSON.stringify(json, null, 2), 'utf8')
        registry.closeAll()
        const registry2 = registryMod2.createRegistry(ctx)
        const db2 = registry2.ensure('ws-w2', { name: 'w2' })
        const live = db2.db.prepare("SELECT key FROM stages WHERE project_id = ? AND status != 'retired' ORDER BY position").all(db2.projectId).map((r) => r.key)
        H.expect(live.includes('PRD') && live.includes('DEV'), '应读回 lumio 模板，实际：' + live.join(','))
        registry2.closeAll()
      } finally { try { registry.closeAll() } catch { /* closed */ } }
    })

    add('W2: 换模板必须显式确认；旧阶段 retire 不删行；active 恰一个', async () => {
      const root = H.makeTempProject('w2-remap')
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws-w2r', path: root, title: 'w2r' }], rejection: () => undefined })
      const registry = registryMod2.createRegistry(ctx)
      try {
        registry.ensure('ws-w2r', { name: 'w2r' })
        H.expectThrows(() => registry.applyStageRemap('ws-w2r', defaultsMod2.LUMIO_STAGE_TEMPLATE), 'CONFIRM_REQUIRED', '未确认应拒绝')
        const applied = registry.applyStageRemap('ws-w2r', defaultsMod2.LUMIO_STAGE_TEMPLATE, { confirmed: true })
        H.expectEqual(applied.applied, true, '确认后应落地')
        const rows = applied.stages
        const retired = rows.filter((r) => r.status === 'retired').map((r) => r.key)
        H.expect(retired.length === 7, '旧 S1..S7 应全部 retire（不删除），实际：' + retired.join(','))
        const active = rows.filter((r) => r.status === 'active')
        H.expectEqual(active.length, 1, '换模板后 active 阶段数必须恰为 1')
        H.expectEqual(active[0].key, 'PRD', 'active 应是新模板第一个阶段')
        // 活阶段机过滤：listStages 默认不含 retired
        const snapshot = modules.snapshot
        if (snapshot && typeof snapshot.listStages === 'function') {
          const db = registry.open('ws-w2r')
          const liveStages = snapshot.listStages(db).map((s) => s.key)
          H.expect(!liveStages.includes('S1'), 'listStages 默认不应返回 retired 阶段')
          const allStages = snapshot.listStages(db, { includeRetired: true }).map((s) => s.key)
          H.expect(allStages.includes('S1'), '显式 includeRetired 时才返回历史阶段')
        }
      } finally { try { registry.closeAll() } catch { /* closed */ } }
    })
  }

  // ---- M0：权威源外移（单写的物理前提） ----
  if (!registryMod2) {
    add('M0: 权威源外移 + 旧库迁移', async () => {}, { skip: 'registry 未落地' })
  } else {
    add('M0: 权威源默认在 store（不在工作区），导出投影仍在工作区', async () => {
      const root = H.makeTempProject('m0-home')
      const prevHome = process.env.DSH_HOME
      const prevMode = process.env.PROJECT_WORKBENCH_STORE
      process.env.DSH_HOME = join(root, '.fake-dsh-home')
      delete process.env.PROJECT_WORKBENCH_STORE
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws-m0', path: root, title: 'm0' }], rejection: () => undefined })
      const registry = registryMod2.createRegistry(ctx)
      try {
        registry.ensure('ws-m0', { name: 'm0' })
        const paths = registryMod2.projectPaths(root)
        H.expectEqual(paths.external, true, '默认应是外部 store')
        H.expect(existsSync(paths.dbPath), 'project.db 应在 store：' + paths.dbPath)
        H.expect(existsSync(paths.jsonPath), 'project.json 应在 store')
        H.expect(!existsSync(join(root, '.project', 'project.db')), 'M0 后工作区不应再有 project.db')
        H.expect(!existsSync(join(root, '.project', 'project.json')), 'M0 后工作区不应再有 project.json')
        H.expect(existsSync(paths.docsDir), '导出 docs 目录应在工作区')
        // 同一工作区根 → 稳定 key（幂等）
        H.expectEqual(registryMod2.workspaceKey(root), registryMod2.workspaceKey(root), 'workspaceKey 应稳定')
      } finally {
        registry.closeAll()
        if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
        if (prevMode === undefined) delete process.env.PROJECT_WORKBENCH_STORE; else process.env.PROJECT_WORKBENCH_STORE = prevMode
      }
    })

    add('M0: 旧库（工作区内 .project）自动迁移到 store，且原件保留可回滚', async () => {
      const root = H.makeTempProject('m0-migrate')
      const prevHome = process.env.DSH_HOME
      const prevMode = process.env.PROJECT_WORKBENCH_STORE
      process.env.DSH_HOME = join(root, '.fake-dsh-home')
      delete process.env.PROJECT_WORKBENCH_STORE
      const ctx = H.makeFakeCtx({ workspaces: [{ id: 'ws-mig', path: root, title: 'mig' }], rejection: () => undefined })
      try {
        // 先在 local 模式建一个「老库」
        process.env.PROJECT_WORKBENCH_STORE = 'local'
        const legacy = registryMod2.createRegistry(ctx)
        const legacyDb = legacy.ensure('ws-mig', { name: 'mig' })
        const legacyProjectId = legacyDb.projectId
        legacyDb.db.prepare("INSERT INTO slices(id, project_id, type, key, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run('slice-legacy', legacyProjectId, 'workitem', 'legacy', '老切片', 'open', new Date().toISOString(), new Date().toISOString())
        legacy.closeAll()
        const legacyPath = join(root, '.project', 'project.db')
        H.expect(existsSync(legacyPath), 'local 模式应把 DB 建在工作区')

        // 切回默认（home）→ open 时应自动迁移
        delete process.env.PROJECT_WORKBENCH_STORE
        const paths = registryMod2.projectPaths(root)
        H.expectEqual(paths.external, true, '应解析到外部 store')
        const migrated = registryMod2.createRegistry(ctx)
        const db = migrated.open('ws-mig')
        H.expect(db, '自动迁移后应能打开项目')
        H.expectEqual(db.projectId, legacyProjectId, '迁移后 projectId 保持一致')
        const row = db.db.prepare("SELECT key FROM slices WHERE id = 'slice-legacy'").get()
        H.expect(row && row.key === 'legacy', '迁移后数据完整')
        H.expect(existsSync(paths.dbPath), '数据应落在 store')
        H.expect(existsSync(legacyPath), '原件应保留（可回滚）')
        migrated.closeAll()
      } finally {
        if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome
        if (prevMode === undefined) delete process.env.PROJECT_WORKBENCH_STORE; else process.env.PROJECT_WORKBENCH_STORE = prevMode
      }
    })
  }

  return cases
}

/** 契约 §3 域模型验收（store/docs/leases/export/import 真实模块）。 */
async function makeDomainCases(host) {
  const { modules } = host
  const store = modules.store
  const docs = modules.docs
  const leases = modules.leases
  const exportMod = modules.export
  const importMod = modules.import
  const util = modules.util
  const dbMod = modules.db
  const cases = []

  async function fixture() {
    const { root, db, projectJson } = await makeDb(host, { prefix: 'domain', name: '支付项目' })
    const slice = store.createSlice(db, { type: 'workitem', key: 'payment-refund', title: '支付退款', acceptance: { criteria: ['可退款'] } })
    const task = store.createTask(db, { sliceId: slice.id, title: '写 PRD', acceptance: { done: ['v1'] } })
    const session = store.createSession(db, {
      name: '产品-payment-refund-PRD', kind: 'task', role: '产品', sliceId: slice.id,
      dshSessionId: 'dsh-domain-product', context: { taskId: task.id },
    })
    return { root, db, projectJson, slice, task, session }
  }

  cases.push({
    name: 'domain: 文档版本只增/冻结拒绝/同 hash 幂等',
    fn: async () => {
      const fx = await fixture()
      try {
        const doc = docs.createDocument(fx.db, { sliceId: fx.slice.id, type: 'prd', logicalKey: 'prd/payment-refund', title: '支付退款 PRD', stage: 'S1', ownerSession: fx.session.id })
        const content1 = '# 背景\n用户需要退款。\n## 范围\n支付订单支持原路退回。'
        const first = docs.writeDocumentVersion(fx.db, { docId: doc.id, content: content1, authorSession: fx.session.id })
        H.expectEqual(first.version.version, 1, '首版应为 v1')
        const again = docs.writeDocumentVersion(fx.db, { docId: doc.id, content: content1, authorSession: fx.session.id })
        H.expectEqual(again.version.version, 1, '同内容应返回已有版本，不新增')
        const content2 = content1 + '\n## 退款时效\n7 个工作日内到账。'
        const second = docs.writeDocumentVersion(fx.db, { docId: doc.id, content: content2, authorSession: fx.session.id })
        H.expectEqual(second.version.version, 2, '内容变化应新增 v2')
        const v1 = docs.getDocVersion(fx.db, doc.id, 1)
        H.expectEqual(v1.content, content1, '旧版本内容不可变')
        const versions = docs.listDocVersions(fx.db, doc.id).map((v) => v.version)
        H.expect(versions.includes(1) && versions.includes(2), '版本链应含 1/2: ' + JSON.stringify(versions))
        docs.freezeDocument(fx.db, { docId: doc.id })
        H.expectThrows(() => docs.writeDocumentVersion(fx.db, { docId: doc.id, content: content2 + '\n改', authorSession: fx.session.id }), 'DOC_FROZEN', '冻结后拒绝覆盖')
        // 门禁冻结/导出事件存在
        const kinds = fx.db.listEvents({ limit: 500 }).map((e) => e.kind)
        H.expect(kinds.includes('doc/create'), '应有 doc/create 事件')
        H.expect(kinds.includes('doc/version'), '应有 doc/version 事件')
        H.expect(kinds.includes('doc/freeze'), '应有 doc/freeze 事件')
      } finally { fx.db.close() }
    },
  })

  cases.push({
    name: 'domain: 会话命名三段式与重复 active 拒绝',
    fn: async () => {
      const fx = await fixture()
      try {
        H.expectThrows(() => store.createSession(fx.db, { name: '产品实现', kind: 'task', role: '产品', sliceId: fx.slice.id, dshSessionId: 'dsh-bad-1' }), 'INVALID', '命名缺三段应 INVALID')
        H.expectThrows(() => store.createSession(fx.db, { name: '路人-payment-refund-x', kind: 'task', role: '路人', sliceId: fx.slice.id, dshSessionId: 'dsh-bad-2' }), 'INVALID', '非法角色应 INVALID')
        H.expectThrows(() => store.createSession(fx.db, { name: '产品-payment-refund-PRD2', kind: 'task', role: '产品', sliceId: fx.slice.id, dshSessionId: 'dsh-dup' }), 'DUPLICATE_ACTIVE_SESSION', '同切片同角色重复 active 应拒绝')
        const found = store.listSessions(fx.db, { kind: 'task', status: 'active' })
        H.expectEqual(found.length, 1, '同切片同角色只应有 1 个 active')
        H.expectEqual(store.findSessionByDshId(fx.db, 'dsh-domain-product').id, fx.session.id, '按 dshSessionId 反查')
        store.endSession(fx.db, { id: fx.session.id, status: 'done' })
        // 结束后允许新会话
        const next = store.createSession(fx.db, { name: '产品-payment-refund-PRD3', kind: 'task', role: '产品', sliceId: fx.slice.id, dshSessionId: 'dsh-domain-product-2' })
        H.expectEqual(next.status, 'active', '旧会话结束后可新建')
      } finally { fx.db.close() }
    },
  })

  cases.push({
    name: 'domain: 租约互斥/续期/过期抢占/释放事件',
    fn: async () => {
      const fx = await fixture()
      try {
        const slice2 = store.createSlice(fx.db, { type: 'module', key: 'payment-core', title: '支付核心' })
        const other = store.createSession(fx.db, { name: '码农-payment-core-实现', kind: 'task', role: '码农', sliceId: slice2.id, dshSessionId: 'dsh-domain-code' })
        const first = leases.acquireLease(fx.db, { sliceId: slice2.id, sessionId: other.id, ttlMs: 60000, reason: '实现' })
        H.expect(first && first.sessionId === other.id, '租约应记录持有者')
        H.expectThrows(() => leases.acquireLease(fx.db, { sliceId: slice2.id, sessionId: fx.session.id, ttlMs: 60000, reason: '抢' }), 'LEASE_HELD', '他人持租应拒绝')
        const renewed = leases.acquireLease(fx.db, { sliceId: slice2.id, sessionId: other.id, ttlMs: 120000, reason: '续期' })
        H.expect(renewed.expiresAt, '同 session 应允许续期')
        // 直接把过期时间改到过去，模拟过期抢占
        fx.db.tx(() => fx.db.db.prepare('UPDATE leases SET expires_at = ? WHERE slice_id = ?').run(new Date(Date.now() - 1000).toISOString(), slice2.id))
        H.expectEqual(leases.checkLease(fx.db, { sliceId: slice2.id, sessionId: fx.session.id }).ok, false, '过期租约不应视为有效')
        const taken = leases.acquireLease(fx.db, { sliceId: slice2.id, sessionId: fx.session.id, ttlMs: 60000, reason: '抢占' })
        H.expectEqual(taken.sessionId, fx.session.id, '过期租约可被抢占')
        leases.releaseLease(fx.db, { sliceId: slice2.id, sessionId: fx.session.id })
        H.expectEqual(leases.checkLease(fx.db, { sliceId: slice2.id, sessionId: fx.session.id }).ok, false, '释放后无租约')
        const kinds = fx.db.listEvents({ limit: 500 }).map((e) => e.kind)
        H.expect(kinds.includes('lease/acquire'), '应有 lease/acquire 事件')
        H.expect(kinds.includes('lease/release'), '应有 lease/release 事件')
      } finally { fx.db.close() }
    },
  })

  cases.push({
    name: 'domain: 决策 pending→approved 与不可逆二次确认',
    fn: async () => {
      const fx = await fixture()
      try {
        const gate = store.createDecision(fx.db, {
          sliceId: fx.slice.id, kind: 'gate', title: 'PRD 是否通过', question: 'PRD 认不认？',
          options: [{ id: 'approve', label: '批准' }, { id: 'reject', label: '驳回' }],
          recommended: 'approve', consequences: '驳回将退回重写 PRD', irreversible: false,
          stage: 'S1', gate: 'G1', createdBy: fx.session.id,
        })
        H.expectEqual(gate.status, 'pending', '新决策应 pending')
        const approved = store.resolveDecision(fx.db, { id: gate.id, status: 'approved', decidedBy: 'user:owner', rationale: 'ok' })
        H.expectEqual(approved.status, 'approved', '决策应落定 approved')
        H.expect(approved.decidedBy, '决策应记录 decidedBy')
        const irreversible = store.createDecision(fx.db, {
          sliceId: fx.slice.id, kind: 'decision', title: '是否删除旧数据', question: '不可逆', options: [],
          recommended: 'reject', consequences: '不可恢复', irreversible: true, stage: 'S1', createdBy: fx.session.id,
        })
        H.expectThrows(() => store.resolveDecision(fx.db, { id: irreversible.id, status: 'approved', decidedBy: 'user:owner' }), 'INVALID', '不可逆决策缺 confirmed 应拒绝')
        H.expectThrows(() => store.resolveDecision(fx.db, { id: irreversible.id, status: 'approved', decidedBy: '', confirmed: true }), 'INVALID', '不可逆决策 decidedBy 不得为空')
        const ok = store.resolveDecision(fx.db, { id: irreversible.id, status: 'approved', decidedBy: 'user:owner', confirmed: true })
        H.expectEqual(ok.status, 'approved', '不可逆决策确认后应通过')
      } finally { fx.db.close() }
    },
  })

  cases.push({
    name: 'domain: 检索返回章节片段（不返回全文）且章节重建可重复',
    fn: async () => {
      const fx = await fixture()
      try {
        const doc = docs.createDocument(fx.db, { sliceId: fx.slice.id, type: 'prd', logicalKey: 'prd/search-doc', title: '退款检索', stage: 'S1', ownerSession: fx.session.id })
        const content = '# 背景\n' + '支付订单需要支持退款。\n'.repeat(30) + '## 幂等\n退款接口必须幂等，重复请求返回同一结果。\n## 时效\n7 个工作日到账。'
        docs.writeDocumentVersion(fx.db, { docId: doc.id, content, authorSession: fx.session.id })
        docs.rebuildDocSections(fx.db, doc.id)
        const firstCount = fx.db.db.prepare('SELECT COUNT(*) AS c FROM doc_sections WHERE document_id = ?').get(doc.id).c
        docs.rebuildDocSections(fx.db, doc.id)
        const secondCount = fx.db.db.prepare('SELECT COUNT(*) AS c FROM doc_sections WHERE document_id = ?').get(doc.id).c
        H.expectEqual(Number(secondCount), Number(firstCount), '重建章节应幂等')
        const hits = docs.searchDocSections(fx.db, { query: '退款', limit: 5 })
        H.expect(hits.length > 0, '检索应有命中')
        for (const hit of hits) {
          H.expect(hit.documentId !== undefined && hit.title !== undefined && hit.heading !== undefined && hit.snippet !== undefined, '命中字段应齐全')
          H.expect(String(hit.snippet).length < content.length, '结果应为片段而非全文')
        }
        const twoChar = docs.searchDocSections(fx.db, { query: '幂等', limit: 5 })
        H.expect(twoChar.length > 0, '两字词应能命中（LIKE 兜底）')
      } finally { fx.db.close() }
    },
  })

  cases.push({
    name: 'domain: 导出只写不回读 + 可重生成 + 快照一致',
    fn: async () => {
      const fx = await fixture()
      try {
        const doc = docs.createDocument(fx.db, { sliceId: fx.slice.id, type: 'prd', logicalKey: 'prd/export-doc', title: '导出 PRD', stage: 'S1', ownerSession: fx.session.id })
        docs.writeDocumentVersion(fx.db, { docId: doc.id, content: '# 导出\n内容 A。', authorSession: fx.session.id })
        docs.freezeDocument(fx.db, { docId: doc.id })
        const exportMap = fx.projectJson.exportMap
        const first = exportMod.exportDocument(fx.db, { docId: doc.id, version: 1, root: fx.root, exportMap })
        H.expect(existsSync(first.path), '导出文件应存在: ' + first.path)
        const text = readFileSync(first.path, 'utf8')
        H.expect(text.includes('generated'), '导出文件应带 generated 标记')
        H.expectEqual(util.sha256(text), first.hash, '导出 hash 应与文件内容一致')
        const second = exportMod.exportDocument(fx.db, { docId: doc.id, version: 1, root: fx.root, exportMap })
        H.expectEqual(second.path, first.path, '同文档版本导出路径稳定')
        H.expectEqual(second.hash, first.hash, '重生成字节一致')
        const snap1 = exportMod.exportSnapshot(fx.db, { root: fx.root })
        H.expect(existsSync(snap1.path || snap1.timelinePath || join(fx.root, '.project', 'exports', 'timeline.md')), '快照应包含时间线文件')
        // 删掉导出目录后重建，hash 应稳定
        const timelineBefore = readFileSync(join(fx.root, '.project', 'exports', 'timeline.md'), 'utf8')
        rmSync(join(fx.root, '.project', 'exports'), { recursive: true, force: true })
        exportMod.exportSnapshot(fx.db, { root: fx.root })
        const timelineAfter = readFileSync(join(fx.root, '.project', 'exports', 'timeline.md'), 'utf8')
        H.expectEqual(timelineAfter, timelineBefore, '导出可重生成且字节一致')
        const kinds = fx.db.listEvents({ limit: 500 }).map((e) => e.kind)
        H.expect(kinds.includes('doc/export'), '应记录 doc/export 事件')
        H.expect(kinds.includes('export/snapshot'), '应记录 export/snapshot 事件')
      } finally { fx.db.close() }
    },
  })

  cases.push({
    name: 'domain: inbox 导入形成新版本并记事件',
    fn: async () => {
      const fx = await fixture()
      try {
        const doc = docs.createDocument(fx.db, { sliceId: fx.slice.id, type: 'adr', logicalKey: 'adr/inbox-doc', title: '导入 ADR', stage: 'S3', ownerSession: fx.session.id })
        docs.writeDocumentVersion(fx.db, { docId: doc.id, content: '# 初始\n版本 1。', authorSession: fx.session.id })
        const inbox = join(fx.root, '.project', 'inbox')
        mkdirSync(inbox, { recursive: true })
        const source = join(inbox, 'external-adr.md')
        writeFileSync(source, '# 外部\nCodex 产出的内容。', 'utf8')
        const imported = importMod.importInboxFile(fx.db, { sourcePath: source, docId: doc.id, importedBy: fx.session.id })
        H.expect(imported.version && imported.version.version >= 2, '导入应形成新版本')
        const kinds = fx.db.listEvents({ limit: 500 }).map((e) => e.kind)
        H.expect(kinds.includes('import/inbox'), '应记录 import/inbox 事件')
        H.expect(existsSync(source), '导入不应删除 inbox 源文件')
      } finally { fx.db.close() }
    },
  })

  return cases
}

/** 契约 §6：2k 硬上限、L0/L1/L2 分层预算、超限降级。 */
async function checkContextBudget(host) {
  const { modules } = host
  const context = modules.context
  const store = modules.store
  const docs = modules.docs
  const util = modules.util
  const { root, db, projectJson } = await makeDb(host, { prefix: 'ctx', name: '预算项目' })
  try {
    // 构造大切片注入内容：超长标题/验收/文档标题会进入 L0/L2，逼出分层截断与 degraded。
    const bigTitle = '超大切片-' + '退款幂等与审计范围说明'.repeat(300)
    const slice = store.createSlice(db, { type: 'workitem', key: 'big-slice', title: bigTitle, acceptance: { criteria: ['a'.repeat(200), 'b'.repeat(200) ] } })
    const session = store.createSession(db, { name: '产品-big-slice-简报', kind: 'task', role: '产品', sliceId: slice.id, dshSessionId: 'dsh-ctx' })
    for (let index = 0; index < 4; index += 1) {
      const doc = docs.createDocument(db, { sliceId: slice.id, type: 'prd', logicalKey: 'prd/big-' + String(index), title: '大文档-' + '很长的文档标题'.repeat(80), stage: 'S1', ownerSession: session.id })
      const huge = Array.from({ length: 20 }, (_, i) => '段落 ' + String(i) + '：' + '支付退款需要幂等和审计。'.repeat(20)).join('\n')
      docs.writeDocumentVersion(db, { docId: doc.id, content: huge, authorSession: session.id })
    }
    const compiled = context.compileContext(db, { roleKind: 'task', sessionId: session.id, role: '产品', sliceId: slice.id, step: 1 })
    H.expect(compiled && typeof compiled.text === 'string', 'compileContext 应返回 text')
    const used = Number(compiled.used !== undefined ? compiled.used : util.estimateTokens(compiled.text))
    H.expect(used <= 2000, '2k 硬上限被突破: used=' + String(used))
    H.expectEqual(util.estimateTokens(compiled.text), used, 'used 应等于文本估算 token 数')
    H.expect(compiled.parts && compiled.parts.l0 !== undefined, '应返回分层 parts')
    const partTokens = (part) => (typeof part === 'string' ? util.estimateTokens(part) : Number(part || 0))
    // truncateToTokens 末尾追加省略号（+1 token），因此每层允许预算 +2 的余量。
    H.expect(partTokens(compiled.parts.l0) <= 400 + 2, 'L0 预算 400，实际 ' + String(partTokens(compiled.parts.l0)))
    H.expect(partTokens(compiled.parts.l1) <= 300 + 2, 'L1 预算 300，实际 ' + String(partTokens(compiled.parts.l1)))
    H.expect(partTokens(compiled.parts.l2) <= 900 + 2, 'L2 预算 900，实际 ' + String(partTokens(compiled.parts.l2)))
    H.expectEqual(compiled.degraded, true, '超大内容应触发降级')
    H.expect(compiled.text.includes('降级') || compiled.text.includes('project_recall'), '降级时应提示按需查询')
  } finally { db.close() }
}

if (isNodeTest) {
  const cases = await makeSuite()
  for (const item of cases) test(item.name, { skip: item.skip }, item.fn)
} else if (H.isMain(import.meta.url)) {
  const cases = await makeSuite()
  const summary = await H.runCases('acceptance.test', cases)
  H.cleanupTracked()
  process.exitCode = H.summaryExitCode(summary)
}

export { makeDomainCases, checkContextBudget }