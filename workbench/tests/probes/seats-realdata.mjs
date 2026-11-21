#!/usr/bin/env node
// 探针：用真实项目库副本 + 真实 client bundle 渲染侧栏席位，验证不会出 [object Object] / 不渲染。
// 用法：node workbench/tests/probes/seats-realdata.mjs [--project <dir>]
// 退出码：0 = 全部符合预期。

import { copyFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';

// ---- 1. 用真实库副本生成真实 snapshot ----
const SRC = process.env.WORKBENCH_PROJECT_SRC || 'C:/Users/oldap/Documents/lumio/.project';
const dir = mkdtempSync(join(tmpdir(), 'seat-'));
for (const f of ['project.db', 'project.db-wal', 'project.db-shm']) {
  if (existsSync(join(SRC, f))) copyFileSync(join(SRC, f), join(dir, f));
}
const { ProjectDb } = await import('../../host/db.js');
const { buildSnapshot } = await import('../../host/snapshot.js');
const pdb = new ProjectDb(join(dir, 'project.db'), { projectId: 'proj-copy', projectName: 'lumio', root: dir });
const snap = buildSnapshot(pdb, { root: dir });
pdb.close();
rmSync(dir, { recursive: true, force: true });

// ---- 2. 加载 client bundle（stub react），拿真实组件 ----
const src = readFileSync(new URL('../../client.js', import.meta.url), 'utf8');
let captured = null;
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useSyncExternalStore: (sub, get) => get(),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useReducer: (r, i) => [typeof i === 'function' ? i() : i, () => {}],
  useEffect: (fn) => { fn(); },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
};
globalThis.React = react;
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
const fakeTag = () => ({ dataset: {}, setAttribute() {}, appendChild() {}, nodeType: 1 });
globalThis.document = { documentElement: { lang: 'zh-CN' }, head: { appendChild() {} }, createElement: fakeTag, querySelector: () => fakeTag(), getElementById: () => null };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', clipboard: { writeText: async () => {} } }, configurable: true });
new Function('window', 'document', 'navigator', 'React', src)(globalThis.window, globalThis.document, globalThis.navigator, react);
const exports = captured.factory((id) => (id === 'react' ? react : {}));
const { __pure: pure, __components: C, __dictionaries } = exports;
const zh = __dictionaries.zh;
const t = (key, params) => String(zh[key] ?? key).replace(/\{(\w+)\}/g, (m, n) => (params && params[n] !== undefined ? String(params[n]) : m));

// ---- 3. 组一个"真实形状"的 hub ----
const project = {
  workspaceId: 'ws-lumio', root: 'C:/Users/oldap/Documents/lumio', title: 'lumio',
  exists: true, initialized: true, projectId: 'proj-lumio', name: 'lumio',
  stage: snap.project.stage,              // ← 真实形状：阶段记录对象
  pendingDecisions: snap.pendingDecisions.length,
};
const state = {
  version: 1,
  projects: { phase: 'ready', items: [project], error: null },
  selectedRoot: project.root,
  snapshots: { [project.root]: { phase: 'ready', data: snap, error: null } },
  roots: {}, focusRequest: null,
};
state.sessionIndex = pure.buildSessionIndex(state.projects.items, state.snapshots);
const hub = { subscribe: () => () => {}, getState: () => state, ensureProjects: () => {}, ensureSnapshot: () => {}, acquire: () => () => {}, requestFocus: () => 1, consumeFocus: () => undefined };
const runtime = { openPanel: () => {}, openSlice: () => {}, currentSessionCwd: () => project.root, sessionSummary: () => ({ cwd: project.root }), subscribeSessions: () => () => {} };

const flat = (node) => {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const kids = (node.children || []).map(flat).join('');
  const props = node.props || {};
  return (props.title || props['aria-label'] ? '' : '') + kids;
};

console.log('=== 真实数据下各席位渲染结果 ===');
console.log('project.stage 真实形状:', JSON.stringify(project.stage).slice(0, 90));
console.log();
console.log('1) 侧栏图标角标 WorkbenchIcon:');
const glyph = C.WorkbenchIcon({ t, hub, runtime, size: 18, active: false });
console.log('   title =', JSON.stringify(glyph.props.title), '| 有红点 =', glyph.children.some((c) => c && c.props && c.props.className === 'wb-glyph-badge'));
console.log();
console.log('2) 底部状态条 SidebarProjectStatus:');
const foot = C.SidebarProjectStatus({ t, hub, runtime, wide: true });
console.log('   文本 =', JSON.stringify(flat(foot)));
console.log('   含 [object Object] ?', flat(foot).includes('[object Object]'));
console.log();
for (const s of snap.sessions) {
  console.log('3) 会话行 ' + (s.role || s.kind) + ' (' + (s.dshSessionId || '').slice(0, 20) + '...):');
  const chip = C.SessionRoleChip({ t, hub, runtime, sessionId: s.dshSessionId });
  console.log('   角色徽章 =', chip ? flat(chip) : '(不渲染)', '| aria =', chip ? chip.props['aria-label'] : '-');
  const mark = C.SessionSliceMark({ t, hub, runtime, sessionId: s.dshSessionId });
  console.log('   行尾切片标记 =', mark ? JSON.stringify(mark.props.title) : '(不渲染)');
  const hover = C.SessionProjectHover({ t, hub, runtime, sessionId: s.dshSessionId });
  console.log('   悬停卡 =', hover ? flat(hover) : '(不渲染)');
  console.log('     含 [object Object] ?', hover ? flat(hover).includes('[object Object]') : '-');
  const loc = C.SessionLocateButton({ t, hub, runtime, sessionId: s.dshSessionId });
  console.log('   定位按钮 =', loc ? loc.props['aria-label'] : '(不渲染，无切片)');
}
console.log();
console.log('4) 面板「更多」行 PanelMoreMenuItem:');
const more = C.PanelMoreMenuItem({ t, hub, runtime });
console.log('   文本 =', JSON.stringify(more ? flat(more) : '(不渲染)'));
console.log();
console.log('5) 全量扫描：任何席位出现 [object Object] ?');
const all = [flat(foot), ...snap.sessions.map((s) => { const h = C.SessionProjectHover({ t, hub, runtime, sessionId: s.dshSessionId }); return h ? flat(h) : ''; })].join('|');
console.log('   →', all.includes('[object Object]') ? '有（BUG）' : '没有 ✓');

// ---- 判定 ----
const problems = [];
const footText = flat(foot);
if (footText.includes('[object Object]')) problems.push('底部状态条出现 [object Object]');
if (!/·.*·/.test(footText)) problems.push('底部状态条缺少 项目·阶段·待决策 三段');
// 取样要按 kind 找 PM 行，不能假设 sessions[0] 就是 PM —— 真实库里第一条往往是某个任务会话
// （之前的实现取 sessions[0]，在 lumio 真库上恒判 FAIL，是探针的取样假设过期，不是席位组件坏了）。
const pmSession = snap.sessions.find((s) => s.kind === 'pm');
if (!pmSession) problems.push('快照里没有 PM 会话行');
else {
  const pmChip = C.SessionRoleChip({ t, hub, runtime, sessionId: pmSession.dshSessionId });
  if (!pmChip || flat(pmChip) !== 'P') problems.push('PM 会话的角色徽章不是 P');
}
if (all.includes('[object Object]')) problems.push('某个席位出现 [object Object]');
if (!more) problems.push('面板更多行不渲染');
console.log('');
console.log('RESULT:', problems.length === 0 ? 'PASS（真实数据下席位渲染正常）' : 'FAIL — ' + problems.join('; '));
process.exitCode = problems.length === 0 ? 0 : 1;
