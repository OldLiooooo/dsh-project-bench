// DSH 软件项目工作台 · Client UI (T3 client-ui, single-file browser bundle)
//
// Registrations (window.__ModuleLoader__ + ctx.slots):
//   main keyed slot            key = 'project-workbench'        -> WorkbenchPanel
//   sidebar.panellist          id  = 'project-workbench'        -> WorkbenchIcon
//   conversation.session.header.utilities  id = 'wb-pm-badge'   -> PMSessionBadge (PM session only)
//   conversation.composer.dock             id = 'wb-pm-summary' -> PMComposerSummary (PM session only)
//
// Data channel (contracts §5/§10): fetch('/project-workbench/api/*', {credentials:'same-origin'})
//   GET  /projects                -> project switcher
//   GET  /snapshot?root=          -> cockpit state
//   GET  /slice?id=&root=         -> slice detail (the panel falls back to the snapshot tree)
//   GET  /doc?id=&version=&root=  -> DB document preview + version list
//   GET  /timeline?root=&after=&limit=&kinds= -> timeline page
//   POST /init     {root}                    -> initialize project
//   POST /decision {root,id,status,rationale,confirmed} -> human decision (irreversible: confirmed=true)
//   POST /pm       {root,dshSessionId}       -> bind the PM session created/opened from the panel
//   EventSource /events?root= ; on 'change' reload the snapshot (no polling).
//
// Styles only use var(--dsw-*) tokens; every class is wb-prefixed; one <style> is injected into
// document.head. Copy comes from ctx.locale.register('workbench', {zh,en}) + the injected t seat.
// No @deepseek-ai/* imports: only require('react') and browser globals.
//
// @workbench:pure-start
// Pure data transforms live between the pure markers and are exported through __pure (test seam).
// They take no React/DOM/ctx dependencies so node self-tests can exercise them directly.
// @workbench:pure-end
window.__ModuleLoader__.load({
  id: '@local/dsh-project-workbench',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const Fragment = React.Fragment

    // ---------------------------------------------------------------------------------------------
    // Constants shared by the hub, the pure transforms and the components.
    // ---------------------------------------------------------------------------------------------
    const NS = 'workbench'
    const PANEL_KEY = 'project-workbench'
    const PM_PRESET = 'project-office'
    const PM_ROLE = 'pm'
    const API_BASE = '/project-workbench/api'
    const STYLE_KEY = 'dsh-project-workbench/client.css'
    const MAX_DOC_BLOCK = 4000

    const KNOWN_STATUSES = new Set([
      'active', 'pending', 'open', 'in_progress', 'done', 'completed', 'complete', 'blocked',
      'review', 'draft', 'frozen', 'exported', 'approved', 'rejected', 'ended', 'interrupted',
      'ready', 'waiting', 'degraded', 'unknown', 'archived', 'paused', 'claimed', 'running',
      'failed', 'error', 'risk', 'ok',
    ])

    const STATUS_TONES = {
      active: 'busy', in_progress: 'busy', open: 'busy', ongoing: 'busy', claimed: 'busy', running: 'busy',
      done: 'success', completed: 'success', complete: 'success', approved: 'success', frozen: 'success',
      ready: 'success', exported: 'success', ok: 'success',
      pending: 'warn', review: 'warn', waiting: 'warn', draft: 'warn', paused: 'warn', interrupted: 'warn',
      degraded: 'warn',
      blocked: 'danger', rejected: 'danger', failed: 'danger', error: 'danger', risk: 'danger',
      ended: 'neutral', archived: 'neutral', unknown: 'neutral',
    }

    const EVENT_KINDS = [
      'project/init', 'stage/change', 'slice/create', 'slice/status', 'task/create', 'task/status',
      'session/create', 'session/end', 'doc/create', 'doc/version', 'doc/freeze', 'doc/export',
      'decision/create', 'decision/resolve', 'gate/submit', 'gate/approve', 'gate/reject',
      'evidence/add', 'artifact/add', 'lease/acquire', 'lease/release', 'import/inbox',
      'export/snapshot', 'context/downgrade',
    ]
    const EVENT_KIND_SET = new Set(EVENT_KINDS)

    const EVENT_CATEGORY_LABELS = {
      project: 'event.category.project', stage: 'event.category.stage', slice: 'event.category.slice',
      task: 'event.category.task', session: 'event.category.session', doc: 'event.category.doc',
      decision: 'event.category.decision', gate: 'event.category.gate', evidence: 'event.category.evidence',
      artifact: 'event.category.artifact', lease: 'event.category.lease', import: 'event.category.import',
      export: 'event.category.export', context: 'event.category.context', other: 'event.category.other',
    }
    const EVENT_CATEGORY_ORDER = [
      'project', 'stage', 'slice', 'task', 'session', 'doc', 'decision', 'gate',
      'evidence', 'artifact', 'lease', 'import', 'export', 'context', 'other',
    ]

    const DOC_TYPES = ['prd', 'ux', 'adr', 'design', 'spec', 'report', 'handoff', 'retro']

    const TREE_GROUPS = [
      { key: 'tasks', type: 'task', label: 'tree.section.tasks' },
      { key: 'sessions', type: 'session', label: 'tree.section.sessions' },
      { key: 'documents', type: 'document', label: 'tree.section.documents' },
      { key: 'decisions', type: 'decision', label: 'tree.section.decisions' },
      { key: 'evidence', type: 'evidence', label: 'tree.section.evidence' },
    ]

    const TABS = [
      { id: 'overview', label: 'tabs.overview' },
      { id: 'sessions', label: 'tabs.sessions' },
      { id: 'documents', label: 'tabs.documents' },
      { id: 'decisions', label: 'tabs.decisions' },
      { id: 'timeline', label: 'tabs.timeline' },
    ]

    const HEALTH_KEYS = {
      ok: 'health.ok', healthy: 'health.ok', good: 'health.ok',
      warn: 'health.warn', warning: 'health.warn', attention: 'health.warn',
      risk: 'health.risk', blocked: 'health.blocked', error: 'health.risk',
      degraded: 'health.degraded', unknown: 'health.unknown',
    }

    const ACTION_KEYS = {
      init: 'panel.init.action', initBusy: 'panel.init.busy',
      enterPM: 'panel.header.enterPM', createPM: 'panel.header.createPM',
      enterPMBusy: 'panel.header.enterPMBusy',
      refresh: 'panel.header.refresh',
    }
    
    // ---------------------------------------------------------------------------------------------
    // Stylesheet: one <style> per document, tokens only. Injected when the factory executes.
    // ---------------------------------------------------------------------------------------------
    const WB_CSS = `
.wb-root{box-sizing:border-box;height:100%;width:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-s-14);overflow:hidden;position:relative}
.wb-root *,.wb-root *::before,.wb-root *::after{box-sizing:border-box}
.wb-header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:calc(14px + var(--dsh-frame-top-clearance,0px)) 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.wb-title-block{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 240px}
.wb-title{margin:0;font:var(--dsw-font-m-18);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-subtitle{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.wb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;white-space:nowrap}
.wb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wb-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wb-btn:disabled{cursor:default;opacity:.55}
.wb-btn[data-variant=primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.wb-btn[data-variant=primary]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.wb-btn[data-variant=danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:transparent}
.wb-btn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.wb-btn[data-variant=ghost]{border-color:transparent;background:transparent}
.wb-btn[data-variant=ghost]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.wb-btn[data-size=sm]{min-height:24px;padding:0 8px;font:var(--dsw-font-xxs-12)}
.wb-icb{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.wb-icb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.wb-icb:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wb-select{height:28px;max-width:280px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.wb-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wb-input,.wb-textarea{width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}
.wb-textarea{min-height:64px;resize:vertical}
.wb-input:focus-visible,.wb-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wb-cockpit{flex:1;min-height:0;display:flex}
.wb-tree-pane{flex:0 0 340px;max-width:44%;min-width:240px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.wb-tree-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px}
.wb-tree-title{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-secondary)}
.wb-tree-scroll{flex:1;min-height:0;overflow:auto;padding:2px 8px 16px}
.wb-tree-row{display:flex;align-items:center;gap:6px;width:100%;padding:4px 6px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);text-align:left;cursor:pointer}
.wb-tree-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-tree-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.wb-tree-row[data-selected=true]{background:var(--dsw-alias-interactive-bg-active)}
.wb-tree-row[data-kind=stage]{font:var(--dsw-font-xs-strong-13)}
.wb-tree-row[data-kind=group]{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-strong-12)}
.wb-tree-chevron{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.wb-tree-chevron:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.wb-tree-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-tree-meta{display:inline-flex;align-items:center;gap:4px;flex:none}
.wb-tree-count{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);min-width:14px;text-align:right}
.wb-tree-footer{flex:none;display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
.wb-detail{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}
.wb-tabs{flex:none;display:flex;align-items:center;gap:4px;padding:8px 16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.wb-tab{display:inline-flex;align-items:center;gap:5px;padding:6px 10px 7px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer;white-space:nowrap}
.wb-tab:hover{color:var(--dsw-alias-label-primary)}
.wb-tab:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.wb-tab[data-active=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.wb-tab-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary-foreground);font:var(--dsw-font-xxxs-strong-11)}
.wb-detail-scroll{flex:1;min-height:0;overflow:auto;padding:14px 18px 40px}
.wb-stack{display:flex;flex-direction:column;gap:12px}
.wb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.wb-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}
.wb-card-title{margin:0;font:var(--dsw-font-s-strong-14)}
.wb-card-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}
.wb-card-actions{display:flex;gap:6px;flex-wrap:wrap;flex:none}
.wb-muted{color:var(--dsw-alias-label-tertiary)}
.wb-secondary{color:var(--dsw-alias-label-secondary)}
.wb-mono{font-family:var(--dsw-font-mono,monospace);font-size:12px;overflow-wrap:anywhere}
.wb-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);white-space:nowrap;max-width:100%}
.wb-badge[data-tone=busy]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.wb-badge[data-tone=success]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-secondary)}
.wb-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-label);border-color:var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-state-warn-tertiary)}
.wb-badge[data-tone=danger]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary)}
.wb-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.wb-badges{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.wb-badge-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px;margin:4px 0 0}
.wb-count{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}
.wb-count-value{font:var(--dsw-font-l-20);line-height:1.2}
.wb-count-label{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.wb-kv{display:grid;grid-template-columns:minmax(72px,120px) 1fr;gap:4px 10px;margin:0;font:var(--dsw-font-xs-13)}
.wb-kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.wb-kv dd{margin:0;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.wb-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.wb-list-row{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 8px;border-radius:var(--dsw-radius-sm)}
.wb-list-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-list-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;text-align:left}
.wb-list-title{font:var(--dsw-font-xs-13);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-list-sub{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-list-actions{display:flex;align-items:center;gap:4px;flex:none}
.wb-linkrow{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);text-align:left;cursor:pointer}
.wb-linkrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-linkrow:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}
.wb-sep{height:1px;background:var(--dsw-alias-border-l1);margin:4px 0;border:0}
.wb-section-title{margin:0 0 6px;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-tertiary);letter-spacing:.04em}
.wb-stage-row{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:var(--dsw-radius-sm)}
.wb-stage-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-stage-key{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-tertiary);width:26px;flex:none}
.wb-stage-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-events{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.wb-event{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border-radius:var(--dsw-radius-sm)}
.wb-event:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wb-event-time{flex:none;width:104px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);padding-top:2px}
.wb-event-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.wb-event-main{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font:var(--dsw-font-xs-13)}
.wb-event-detail{color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);overflow-wrap:anywhere}
.wb-event-raw{margin:2px 0 0;padding:6px 8px;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm);font-family:var(--dsw-font-mono,monospace);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
.wb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 16px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.wb-empty-title{margin:0;font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-secondary)}
.wb-loading{display:flex;align-items:center;gap:8px;padding:14px 4px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13)}
.wb-spinner{width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:wb-spin .8s linear infinite;flex:none}
@keyframes wb-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.wb-spinner{animation:none;border-top-color:var(--dsw-alias-label-tertiary)}}
.wb-banner{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.wb-banner[data-tone=error]{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}
.wb-banner[data-tone=warn]{border-color:var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label)}
.wb-banner-grow{flex:1;min-width:120px}
.wb-init{max-width:640px;margin:48px auto;display:flex;flex-direction:column;gap:12px}
.wb-init-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-business-primary)}
.wb-init h2{margin:0;font:var(--dsw-font-l-20)}
.wb-init p{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13)}
.wb-doc-layout{display:flex;gap:14px;align-items:flex-start;min-height:0}
.wb-doc-list{flex:0 0 300px;max-width:38%;display:flex;flex-direction:column;gap:2px}
.wb-doc-preview{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-document-preview,var(--dsw-alias-bg-layer-1));padding:14px 16px}
.wb-doc-header{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;justify-content:space-between;margin-bottom:6px}
.wb-doc-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);margin-bottom:10px}
.wb-doc-body{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px;display:flex;flex-direction:column;gap:8px;font:var(--dsw-font-markdown-base);color:var(--dsw-alias-label-document-preview,var(--dsw-alias-label-primary))}
.wb-doc-block{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.wb-doc-block[data-type=h1]{font:var(--dsw-font-markdown-h1)}
.wb-doc-block[data-type=h2]{font:var(--dsw-font-markdown-h2)}
.wb-doc-block[data-type=h3]{font:var(--dsw-font-markdown-h3)}
.wb-doc-block[data-type=li]{padding-left:16px;position:relative}
.wb-doc-block[data-type=li]::before{content:"\\2022";position:absolute;left:4px;color:var(--dsw-alias-label-tertiary)}
.wb-doc-block[data-type=quote]{padding:4px 10px;border-left:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.wb-doc-block[data-type=code]{font:var(--dsw-font-markdown-code-block);background:var(--dsw-alias-markdown-code-block);border-radius:var(--dsw-radius-md);padding:10px 12px;overflow:auto;max-height:420px;white-space:pre}
.wb-doc-block[data-type=hr]{height:1px;background:var(--dsw-alias-border-l1)}
.wb-doc-filter{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
.wb-decision{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:12px 14px}
.wb-decision[data-irreversible=true]{border-color:var(--dsw-alias-state-warn-secondary)}
.wb-decision-title{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;font:var(--dsw-font-s-strong-14)}
.wb-decision-question{margin:0;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);white-space:pre-wrap;overflow-wrap:anywhere}
.wb-options{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.wb-option{display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font:var(--dsw-font-xs-13)}
.wb-option[data-recommended=true]{border:1px solid var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}
.wb-option-value{flex:none;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-tertiary);min-width:20px}
.wb-option-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.wb-warnbox{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);font:var(--dsw-font-xxs-12)}
.wb-warnbox .wb-dot{margin-top:5px}
.wb-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;padding:calc(48px + var(--dsh-frame-top-clearance,0px)) 16px 16px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));overflow:auto}
.wb-modal{width:min(560px,100%);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel);box-shadow:var(--dsw-elevation-prominent);padding:16px}
.wb-modal-title{margin:0 0 6px;font:var(--dsw-font-m-18)}
.wb-modal-desc{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);white-space:pre-wrap}
.wb-modal-body{display:flex;flex-direction:column;gap:10px}
.wb-modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap}
.wb-field{display:flex;flex-direction:column;gap:4px}
.wb-field-label{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}
.wb-check{display:flex;align-items:flex-start;gap:8px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary);cursor:pointer}
.wb-check input{margin:2px 0 0}
.wb-notice{padding:8px 10px;border-radius:var(--dsw-radius-md);font:var(--dsw-font-xs-13)}
.wb-notice[data-tone=ok]{background:var(--dsw-alias-state-success-secondary);color:var(--dsw-alias-label-primary)}
.wb-notice[data-tone=error]{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-error-primary)}
.wb-filters{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px}
.wb-filter{display:flex;align-items:center;gap:4px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.wb-timeline-count{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);margin-bottom:6px}
.wb-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.wb-pm-badge{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}
.wb-pm-badge .wb-badge{max-width:160px;overflow:hidden}
.wb-pm-slice{max-width:140px}
@media (width<=900px){.wb-pm-slice{display:none}}
.wb-dock-summary{display:inline-flex;align-items:center;gap:6px;max-width:min(520px,60vw);padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);cursor:pointer}
.wb-dock-summary:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.wb-dock-summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.wb-dock-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (width<=1100px){.wb-tree-pane{flex-basis:280px}.wb-doc-layout{flex-direction:column}.wb-doc-list{flex:1 1 auto;max-width:none;width:100%}.wb-doc-preview{width:100%}}
`
    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return
      if (document.querySelector('style[data-wb-style=' + JSON.stringify(STYLE_KEY) + ']') !== null) return
      const tag = document.createElement('style')
      tag.setAttribute('data-wb-style', STYLE_KEY)
      tag.dataset.plugin = '@local/dsh-project-workbench'
      tag.textContent = WB_CSS
      document.head.appendChild(tag)
    }
    ensureStyle()


    
    // ---------------------------------------------------------------------------------------------
    // Copy. zh is the key source of truth; en mirrors every key (parity checked by the self-test).
    // ---------------------------------------------------------------------------------------------
    const ZH = {
      'panel.title': '项目工作台',
      'panel.subtitle': '工作区 → 项目 → PM：树状驾驶舱（只读）',
      'panel.loading': '正在加载项目…',
      'panel.loadingSnapshot': '正在加载项目快照…',
      'panel.emptyProjects': '没有已注册的工作区。请先在 DSH 中添加工作区。',
      'panel.errorProjects': '项目列表加载失败',
      'panel.errorSnapshot': '项目快照加载失败',
      'panel.retry': '重试',
      'panel.refresh': '刷新',
      'panel.switchProject': '切换项目',
      'panel.noProject': '选择一个项目',
      'panel.project': '项目',
      'panel.notInitialized': '未初始化',
      'panel.initialized': '已初始化',
      'panel.workspaceMissing': '工作区目录不存在，请确认工作区仍在。',
      'panel.init.title': '初始化项目',
      'panel.init.description': '在该工作区创建 .project/ 项目库（SQLite 唯一事实源）与 7 阶段模板（S1 产品 … S7 复盘）。',
      'panel.init.action': '初始化项目',
      'panel.init.busy': '初始化中…',
      'panel.init.success': '项目已初始化',
      'panel.init.error': '初始化失败',
      'panel.header.stage': '阶段',
      'panel.header.period': '周期',
      'panel.header.health': '健康',
      'panel.header.pending': '待决策',
      'panel.header.enterPM': '进入 PM 对话',
      'panel.header.createPM': '创建 PM 会话',
      'panel.header.enterPMBusy': '正在打开 PM 会话…',
      'panel.header.enterPMError': 'PM 会话打开失败',
      'panel.header.degraded': '实时更新不可用，已降级为手动刷新。',
      'panel.header.reconnect': '重新连接',
      'health.ok': '正常',
      'health.warn': '注意',
      'health.risk': '风险',
      'health.blocked': '阻塞',
      'health.degraded': '降级',
      'health.unknown': '未知',
      'tree.title': '项目树',
      'tree.label': '项目结构树',
      'tree.empty': '项目还没有阶段或切片。进入 PM 对话开始项目。',
      'tree.section.tasks': '任务',
      'tree.section.sessions': '会话',
      'tree.section.documents': '文档',
      'tree.section.decisions': '决策',
      'tree.section.evidence': '证据',
      'tree.stageGate': '门禁 {gate}',
      'tree.expand': '展开',
      'tree.collapse': '收起',
      'tree.truncated': '节点过多，仅显示部分对象（可进入 PM 查询）。',
      'tabs.overview': '概览',
      'tabs.sessions': '会话',
      'tabs.documents': '文档',
      'tabs.decisions': '决策',
      'tabs.timeline': '时间线',
      'overview.project': '项目概览',
      'overview.counts.slices': '切片',
      'overview.counts.tasks': '任务',
      'overview.counts.sessions': '会话',
      'overview.counts.documents': '文档',
      'overview.counts.pendingDecisions': '待决策',
      'overview.stages': '阶段与门禁',
      'overview.pm': '项目办公室（PM）',
      'overview.pmNone': '尚未创建 PM 会话',
      'overview.pmHint': '进入 PM 对话开始项目；指令、验收与拍板都在 PM 会话中完成。',
      'overview.recent': '最近事件',
      'overview.noSelection': '单击左侧树节点查看详情。',
      'overview.currentSlice': '当前切片',
      'overview.openTimeline': '查看完整时间线',
      'overview.pendingInbox': '待拍板决策',
      'overview.noPending': '当前没有待拍板的决策。',
      'node.detail': '节点详情',
      'node.fields.id': 'ID',
      'node.fields.status': '状态',
      'node.fields.owner': '负责人',
      'node.fields.ownerRole': '负责角色',
      'node.fields.ownerSession': '负责会话',
      'node.fields.created': '创建时间',
      'node.fields.updated': '更新时间',
      'node.fields.acceptance': '验收标准',
      'node.fields.type': '类型',
      'node.fields.currentVersion': '当前版本',
      'node.fields.logicalKey': '逻辑键',
      'node.fields.author': '作者',
      'node.fields.role': '角色',
      'node.fields.kind': '类型',
      'node.fields.provider': '提供方',
      'node.fields.model': '模型',
      'node.fields.started': '开始时间',
      'node.fields.ended': '结束时间',
      'node.fields.dshSession': 'DSH 会话',
      'node.fields.irreversible': '不可逆',
      'node.fields.recommended': '推荐',
      'node.fields.consequences': '不返工的后果',
      'node.fields.command': '命令',
      'node.fields.result': '结果',
      'node.fields.uri': '位置',
      'node.fields.hash': '内容哈希',
      'node.fields.reasoningEffort': '推理强度',
      'node.fields.handoff': '交接',
      'node.openDoc': '打开文档预览',
      'node.openSession': '打开会话',
      'node.viewTimeline': '查看相关时间线',
      'node.children': '关联对象',
      'node.noChildren': '没有关联对象。',
      'sessions.title': '会话',
      'sessions.readonlyNotice': '用户只和 PM 对话；任务会话对用户只读。',
      'sessions.teamDeferred': 'Team 只读转录暂缓：这里只列会话与产物，不打开转录。',
      'sessions.empty': '还没有会话。进入 PM 对话开始项目。',
      'sessions.emptySlice': '该切片还没有会话。',
      'sessions.filterSlice': '只看切片：{slice}',
      'sessions.allSlices': '显示全部切片',
      'sessions.kind.pm': 'PM',
      'sessions.kind.task': '任务',
      'sessions.kind.subagent': '子 agent',
      'sessions.kind.other': '会话',
      'sessions.enterPM': '进入 PM 对话',
      'sessions.open': '打开原始会话（兜底）',
      'sessions.openHint': '平台不提供会话级只读；原始会话仍可输入。请在 PM 中指挥，不要让任务会话直接向你提问。',
      'sessions.noDshSession': '未绑定 DSH 会话',
      'sessions.handoff': '交接文档',
      'sessions.started': '开始 {time}',
      'sessions.ended': '结束 {time}',
      'sessions.emptyHint': '会话由 PM 在项目内拉起，用户不直接新建任务会话。',
      'documents.title': '文档',
      'documents.empty': '还没有文档。任务会话写入文档后在这里预览。',
      'documents.emptySlice': '该切片还没有文档。',
      'documents.select': '选择左侧文档查看 DB 中的内容（不打开仓库文件）。',
      'documents.frozen': '已冻结',
      'documents.version': '版本 v{version}',
      'documents.versionLabel': '版本',
      'documents.versionSelect': '选择版本（只读）',
      'documents.author': '作者',
      'documents.created': '生成时间',
      'documents.noContent': '该版本没有内容。',
      'documents.loading': '正在加载文档…',
      'documents.error': '文档加载失败',
      'documents.back': '返回文档列表',
      'documents.filterSlice': '只看切片：{slice}',
      'documents.filterClear': '显示全部文档',
      'documents.type.prd': '产品需求',
      'documents.type.ux': 'UX 设计',
      'documents.type.adr': '架构决策',
      'documents.type.design': '设计',
      'documents.type.spec': '规格',
      'documents.type.report': '报告',
      'documents.type.handoff': '交接',
      'documents.type.retro': '复盘',
      'decisions.title': '决策收件箱',
      'decisions.pending': '待拍板',
      'decisions.resolved': '已拍板',
      'decisions.empty': '没有待拍板的决策。',
      'decisions.emptyResolved': '还没有已拍板的决策。',
      'decisions.approve': '批准',
      'decisions.reject': '驳回',
      'decisions.confirmTitle': '确认{action}此决策？',
      'decisions.actionApprove': '批准',
      'decisions.actionReject': '驳回',
      'decisions.confirmIrreversible': '不可逆操作：批准后将冻结相关文档、推进阶段并写入门禁审计，且无法撤销。',
      'decisions.confirmIrreversibleReject': '不可逆决策：驳回同样会写入门禁审计且无法撤销，请确认。',
      'decisions.confirmCheckbox': '我了解此操作不可撤销，确认继续',
      'decisions.rationale': '理由（可选）',
      'decisions.rationaleReject': '驳回理由（建议填写）',
      'decisions.confirmApprove': '确认批准',
      'decisions.confirmReject': '确认驳回',
      'decisions.cancel': '取消',
      'decisions.submitting': '提交中…',
      'decisions.question': '问题',
      'decisions.options': '选项',
      'decisions.recommended': '推荐',
      'decisions.consequences': '不返工的后果',
      'decisions.irreversible': '不可逆',
      'decisions.gate': '门禁 {gate}',
      'decisions.kind.gate': '门禁',
      'decisions.kind.decision': '决策',
      'decisions.statusApproved': '已批准',
      'decisions.statusRejected': '已驳回',
      'decisions.pendingBadge': '待拍板',
      'decisions.success': '决策已提交，时间线与门禁已更新。',
      'decisions.error': '决策提交失败',
      'decisions.confirmRequired': '不可逆操作需要二次确认（confirmed=true）。',
      'decisions.slice': '切片',
      'decisions.noSlice': '项目级',
      'decisions.emptyHint': '决策由 PM 汇总问题后生成；批准/驳回是人的身份操作。',
      'decisions.resolvedBy': '拍板人',
      'decisions.decidedAt': '拍板时间',
      'timeline.title': '时间线',
      'timeline.empty': '还没有事件。所有写操作都会进入时间线。',
      'timeline.filterKinds': '事件类型',
      'timeline.filterRole': '角色',
      'timeline.filterStage': '阶段',
      'timeline.all': '全部',
      'timeline.refresh': '刷新时间线',
      'timeline.loading': '正在加载事件…',
      'timeline.count': '共 {count} 条事件（当前显示 {shown} 条）',
      'timeline.noMatch': '没有符合过滤条件的事件。',
      'timeline.actor': '操作者',
      'timeline.target': '对象',
      'timeline.slice': '切片',
      'timeline.raw': '原始事件',
      'timeline.openPanel': '进入项目面板',
      'composer.summary': '项目：{name} · 阶段 {stage} · 活跃切片 {slices} · 待决策 {decisions} · 最近：{event}',
      'composer.summaryShort': '项目：{name} · 阶段 {stage} · 待决策 {decisions}',
      'composer.noEvent': '暂无事件',
      'composer.aria': '项目摘要：{text}',
      'badge.aria': '项目阶段与待决策',
      'badge.stage': '阶段 {stage}',
      'badge.slice': '切片 {slice}',
      'badge.pending': '待决策 {count}',
      'badge.back': '回到项目',
      'badge.noSlice': '无当前切片',
      'badge.loading': '项目加载中',
      'status.active': '进行中',
      'status.pending': '待处理',
      'status.open': '进行中',
      'status.in_progress': '进行中',
      'status.done': '完成',
      'status.completed': '完成',
      'status.complete': '完成',
      'status.blocked': '阻塞',
      'status.review': '待验收',
      'status.draft': '草稿',
      'status.frozen': '已冻结',
      'status.exported': '已导出',
      'status.approved': '已批准',
      'status.rejected': '已驳回',
      'status.ended': '已结束',
      'status.interrupted': '已中断',
      'status.ready': '就绪',
      'status.waiting': '等待中',
      'status.degraded': '降级',
      'status.unknown': '未知',
      'status.archived': '已归档',
      'status.paused': '已暂停',
      'status.claimed': '已认领',
      'status.running': '运行中',
      'status.failed': '失败',
      'status.error': '错误',
      'status.risk': '风险',
      'status.ok': '正常',
      'event.category.project': '项目',
      'event.category.stage': '阶段',
      'event.category.slice': '切片',
      'event.category.task': '任务',
      'event.category.session': '会话',
      'event.category.doc': '文档',
      'event.category.decision': '决策',
      'event.category.gate': '门禁',
      'event.category.evidence': '证据',
      'event.category.artifact': '产物',
      'event.category.lease': '租约',
      'event.category.import': '导入',
      'event.category.export': '导出',
      'event.category.context': '上下文',
      'event.category.other': '其他',
      'event.kind.project/init': '项目初始化',
      'event.kind.stage/change': '阶段变更',
      'event.kind.slice/create': '切片创建',
      'event.kind.slice/status': '切片状态',
      'event.kind.task/create': '任务创建',
      'event.kind.task/status': '任务状态',
      'event.kind.session/create': '会话创建',
      'event.kind.session/end': '会话结束',
      'event.kind.doc/create': '文档创建',
      'event.kind.doc/version': '文档新版本',
      'event.kind.doc/freeze': '文档冻结',
      'event.kind.doc/export': '文档导出',
      'event.kind.decision/create': '决策创建',
      'event.kind.decision/resolve': '决策拍板',
      'event.kind.gate/submit': '门禁提交',
      'event.kind.gate/approve': '门禁通过',
      'event.kind.gate/reject': '门禁驳回',
      'event.kind.evidence/add': '证据新增',
      'event.kind.artifact/add': '产物新增',
      'event.kind.lease/acquire': '获取租约',
      'event.kind.lease/release': '释放租约',
      'event.kind.import/inbox': '收件箱导入',
      'event.kind.export/snapshot': '导出快照',
      'event.kind.context/downgrade': '上下文降级',
      'error.unauthorized': '未认证或没有访问权限，请刷新页面后重试。',
      'error.forbidden': '没有权限执行该操作。',
      'error.network': '网络请求失败，请稍后重试。',
      'error.notFound': '目标不存在。',
      'error.generic': '操作失败',
      'error.code': '错误码 {code}',
      'common.loading': '加载中…',
      'common.refresh': '刷新',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.none': '无',
      'common.yes': '是',
      'common.no': '否',
      'common.unknown': '未知',
      'common.copy': '复制 ID',
      'common.copied': '已复制',
      'common.id': 'ID',
      'common.all': '全部',
    }

        const EN = {
      'panel.title': 'Project workbench',
      'panel.subtitle': 'Workspace → project → PM: tree cockpit (read-only)',
      'panel.loading': 'Loading projects…',
      'panel.loadingSnapshot': 'Loading project snapshot…',
      'panel.emptyProjects': 'No registered workspaces. Add a workspace in DSH first.',
      'panel.errorProjects': 'Failed to load projects',
      'panel.errorSnapshot': 'Failed to load project snapshot',
      'panel.retry': 'Retry',
      'panel.refresh': 'Refresh',
      'panel.switchProject': 'Switch project',
      'panel.noProject': 'Select a project',
      'panel.project': 'Project',
      'panel.notInitialized': 'Not initialized',
      'panel.initialized': 'Initialized',
      'panel.workspaceMissing': 'The workspace directory is gone; check that the workspace still exists.',
      'panel.init.title': 'Initialize project',
      'panel.init.description': 'Create the .project/ project store (SQLite, single source of truth) and the 7-stage template (S1 product … S7 retrospective) in this workspace.',
      'panel.init.action': 'Initialize project',
      'panel.init.busy': 'Initializing…',
      'panel.init.success': 'Project initialized',
      'panel.init.error': 'Initialization failed',
      'panel.header.stage': 'Stage',
      'panel.header.period': 'Period',
      'panel.header.health': 'Health',
      'panel.header.pending': 'Pending',
      'panel.header.enterPM': 'Enter PM chat',
      'panel.header.createPM': 'Create PM session',
      'panel.header.enterPMBusy': 'Opening PM session…',
      'panel.header.enterPMError': 'Failed to open the PM session',
      'panel.header.degraded': 'Live updates are unavailable; the panel fell back to manual refresh.',
      'panel.header.reconnect': 'Reconnect',
      'health.ok': 'Healthy',
      'health.warn': 'Attention',
      'health.risk': 'At risk',
      'health.blocked': 'Blocked',
      'health.degraded': 'Degraded',
      'health.unknown': 'Unknown',
      'tree.title': 'Project tree',
      'tree.label': 'Project structure tree',
      'tree.empty': 'No stages or slices yet. Start the project from the PM chat.',
      'tree.section.tasks': 'Tasks',
      'tree.section.sessions': 'Sessions',
      'tree.section.documents': 'Documents',
      'tree.section.decisions': 'Decisions',
      'tree.section.evidence': 'Evidence',
      'tree.stageGate': 'Gate {gate}',
      'tree.expand': 'Expand',
      'tree.collapse': 'Collapse',
      'tree.truncated': 'Too many nodes; only some objects are shown (ask the PM to query).',
      'tabs.overview': 'Overview',
      'tabs.sessions': 'Sessions',
      'tabs.documents': 'Documents',
      'tabs.decisions': 'Decisions',
      'tabs.timeline': 'Timeline',
      'overview.project': 'Project overview',
      'overview.counts.slices': 'Slices',
      'overview.counts.tasks': 'Tasks',
      'overview.counts.sessions': 'Sessions',
      'overview.counts.documents': 'Documents',
      'overview.counts.pendingDecisions': 'Pending decisions',
      'overview.stages': 'Stages and gates',
      'overview.pm': 'Project office (PM)',
      'overview.pmNone': 'No PM session yet',
      'overview.pmHint': 'Enter the PM chat to start the project; instructions, acceptance and sign-off all happen in the PM session.',
      'overview.recent': 'Recent events',
      'overview.noSelection': 'Click a tree node to see its details.',
      'overview.currentSlice': 'Current slice',
      'overview.openTimeline': 'Open full timeline',
      'overview.pendingInbox': 'Decisions awaiting sign-off',
      'overview.noPending': 'No decisions are awaiting sign-off.',
      'node.detail': 'Node detail',
      'node.fields.id': 'ID',
      'node.fields.status': 'Status',
      'node.fields.owner': 'Owner',
      'node.fields.ownerRole': 'Owner role',
      'node.fields.ownerSession': 'Owner session',
      'node.fields.created': 'Created',
      'node.fields.updated': 'Updated',
      'node.fields.acceptance': 'Acceptance',
      'node.fields.type': 'Type',
      'node.fields.currentVersion': 'Current version',
      'node.fields.logicalKey': 'Logical key',
      'node.fields.author': 'Author',
      'node.fields.role': 'Role',
      'node.fields.kind': 'Kind',
      'node.fields.provider': 'Provider',
      'node.fields.model': 'Model',
      'node.fields.started': 'Started',
      'node.fields.ended': 'Ended',
      'node.fields.dshSession': 'DSH session',
      'node.fields.irreversible': 'Irreversible',
      'node.fields.recommended': 'Recommended',
      'node.fields.consequences': 'Cost of not reworking',
      'node.fields.command': 'Command',
      'node.fields.result': 'Result',
      'node.fields.uri': 'Location',
      'node.fields.hash': 'Content hash',
      'node.fields.reasoningEffort': 'Reasoning effort',
      'node.fields.handoff': 'Handoff',
      'node.openDoc': 'Open document preview',
      'node.openSession': 'Open session',
      'node.viewTimeline': 'View related timeline',
      'node.children': 'Related objects',
      'node.noChildren': 'No related objects.',
      'sessions.title': 'Sessions',
      'sessions.readonlyNotice': 'The user talks only to the PM; task sessions are read-only for the user.',
      'sessions.teamDeferred': 'Team read-only transcript is deferred: sessions and artifacts are listed, transcripts are not opened.',
      'sessions.empty': 'No sessions yet. Enter the PM chat to start the project.',
      'sessions.emptySlice': 'This slice has no sessions yet.',
      'sessions.filterSlice': 'Slice filter: {slice}',
      'sessions.allSlices': 'Show all slices',
      'sessions.kind.pm': 'PM',
      'sessions.kind.task': 'Task',
      'sessions.kind.subagent': 'Subagent',
      'sessions.kind.other': 'Session',
      'sessions.enterPM': 'Enter PM chat',
      'sessions.open': 'Open original session (fallback)',
      'sessions.openHint': 'The platform has no per-session read-only mode; original sessions still accept input. Command through the PM instead of instructing task sessions directly.',
      'sessions.noDshSession': 'No DSH session bound',
      'sessions.handoff': 'Handoff doc',
      'sessions.started': 'Started {time}',
      'sessions.ended': 'Ended {time}',
      'sessions.emptyHint': 'The PM creates sessions inside the project; users never create task sessions directly.',
      'documents.title': 'Documents',
      'documents.empty': 'No documents yet. Documents written by task sessions appear here.',
      'documents.emptySlice': 'This slice has no documents yet.',
      'documents.select': 'Pick a document on the left to read its DB content (repository files are never opened).',
      'documents.frozen': 'Frozen',
      'documents.version': 'Version v{version}',
      'documents.versionLabel': 'Version',
      'documents.versionSelect': 'Select version (read-only)',
      'documents.author': 'Author',
      'documents.created': 'Created',
      'documents.noContent': 'This version has no content.',
      'documents.loading': 'Loading document…',
      'documents.error': 'Failed to load the document',
      'documents.back': 'Back to document list',
      'documents.filterSlice': 'Slice filter: {slice}',
      'documents.filterClear': 'Show all documents',
      'documents.type.prd': 'PRD',
      'documents.type.ux': 'UX design',
      'documents.type.adr': 'ADR',
      'documents.type.design': 'Design',
      'documents.type.spec': 'Spec',
      'documents.type.report': 'Report',
      'documents.type.handoff': 'Handoff',
      'documents.type.retro': 'Retrospective',
      'decisions.title': 'Decision inbox',
      'decisions.pending': 'Awaiting sign-off',
      'decisions.resolved': 'Settled',
      'decisions.empty': 'No decisions are awaiting sign-off.',
      'decisions.emptyResolved': 'No decisions have been settled yet.',
      'decisions.approve': 'Approve',
      'decisions.reject': 'Reject',
      'decisions.confirmTitle': 'Confirm {action} for this decision?',
      'decisions.actionApprove': 'approval',
      'decisions.actionReject': 'rejection',
      'decisions.confirmIrreversible': 'Irreversible action: approving freezes related documents, advances the stage and writes gate audit rows; it cannot be undone.',
      'decisions.confirmIrreversibleReject': 'Irreversible decision: rejecting it also writes gate audit rows and cannot be undone. Please confirm.',
      'decisions.confirmCheckbox': 'I understand this action is irreversible and want to continue',
      'decisions.rationale': 'Rationale (optional)',
      'decisions.rationaleReject': 'Rejection rationale (recommended)',
      'decisions.confirmApprove': 'Confirm approval',
      'decisions.confirmReject': 'Confirm rejection',
      'decisions.cancel': 'Cancel',
      'decisions.submitting': 'Submitting…',
      'decisions.question': 'Question',
      'decisions.options': 'Options',
      'decisions.recommended': 'Recommended',
      'decisions.consequences': 'Cost of not reworking',
      'decisions.irreversible': 'Irreversible',
      'decisions.gate': 'Gate {gate}',
      'decisions.kind.gate': 'Gate',
      'decisions.kind.decision': 'Decision',
      'decisions.statusApproved': 'Approved',
      'decisions.statusRejected': 'Rejected',
      'decisions.pendingBadge': 'Awaiting sign-off',
      'decisions.success': 'Decision submitted; timeline and gate are updated.',
      'decisions.error': 'Failed to submit the decision',
      'decisions.confirmRequired': 'Irreversible actions need a second confirmation (confirmed=true).',
      'decisions.slice': 'Slice',
      'decisions.noSlice': 'Project level',
      'decisions.emptyHint': 'The PM aggregates questions into decisions; approving or rejecting is a human action.',
      'decisions.resolvedBy': 'Decided by',
      'decisions.decidedAt': 'Decided at',
          'timeline.title': 'Timeline',
      'timeline.empty': 'No events yet. Every write lands on the timeline.',
      'timeline.filterKinds': 'Event type',
      'timeline.filterRole': 'Role',
      'timeline.filterStage': 'Stage',
      'timeline.all': 'All',
      'timeline.refresh': 'Refresh timeline',
      'timeline.loading': 'Loading events…',
      'timeline.count': '{count} events in total ({shown} shown)',
      'timeline.noMatch': 'No events match the filters.',
      'timeline.actor': 'Actor',
      'timeline.target': 'Object',
      'timeline.slice': 'Slice',
      'timeline.raw': 'Raw event',
      'timeline.openPanel': 'Open project panel',
      'composer.summary': 'Project: {name} · stage {stage} · active slices {slices} · pending {decisions} · latest: {event}',
      'composer.summaryShort': 'Project: {name} · stage {stage} · pending {decisions}',
      'composer.noEvent': 'no events yet',
      'composer.aria': 'Project summary: {text}',
      'badge.aria': 'Project stage and pending decisions',
      'badge.stage': 'Stage {stage}',
      'badge.slice': 'Slice {slice}',
      'badge.pending': 'Pending {count}',
      'badge.back': 'Back to project',
      'badge.noSlice': 'No current slice',
      'badge.loading': 'Loading project',
      'status.active': 'Active',
      'status.pending': 'Pending',
      'status.open': 'Open',
      'status.in_progress': 'In progress',
      'status.done': 'Done',
      'status.completed': 'Completed',
      'status.complete': 'Complete',
      'status.blocked': 'Blocked',
      'status.review': 'In review',
      'status.draft': 'Draft',
      'status.frozen': 'Frozen',
      'status.exported': 'Exported',
      'status.approved': 'Approved',
      'status.rejected': 'Rejected',
      'status.ended': 'Ended',
      'status.interrupted': 'Interrupted',
      'status.ready': 'Ready',
      'status.waiting': 'Waiting',
      'status.degraded': 'Degraded',
      'status.unknown': 'Unknown',
      'status.archived': 'Archived',
      'status.paused': 'Paused',
      'status.claimed': 'Claimed',
      'status.running': 'Running',
      'status.failed': 'Failed',
      'status.error': 'Error',
      'status.risk': 'At risk',
      'status.ok': 'Healthy',
      'event.category.project': 'Project',
      'event.category.stage': 'Stage',
      'event.category.slice': 'Slice',
      'event.category.task': 'Task',
      'event.category.session': 'Session',
      'event.category.doc': 'Document',
      'event.category.decision': 'Decision',
      'event.category.gate': 'Gate',
      'event.category.evidence': 'Evidence',
      'event.category.artifact': 'Artifact',
      'event.category.lease': 'Lease',
      'event.category.import': 'Import',
      'event.category.export': 'Export',
      'event.category.context': 'Context',
      'event.category.other': 'Other',
      'event.kind.project/init': 'Project initialized',
      'event.kind.stage/change': 'Stage changed',
      'event.kind.slice/create': 'Slice created',
      'event.kind.slice/status': 'Slice status',
      'event.kind.task/create': 'Task created',
      'event.kind.task/status': 'Task status',
      'event.kind.session/create': 'Session created',
      'event.kind.session/end': 'Session ended',
      'event.kind.doc/create': 'Document created',
      'event.kind.doc/version': 'Document version',
      'event.kind.doc/freeze': 'Document frozen',
      'event.kind.doc/export': 'Document exported',
      'event.kind.decision/create': 'Decision created',
      'event.kind.decision/resolve': 'Decision settled',
      'event.kind.gate/submit': 'Gate submitted',
      'event.kind.gate/approve': 'Gate approved',
      'event.kind.gate/reject': 'Gate rejected',
      'event.kind.evidence/add': 'Evidence added',
      'event.kind.artifact/add': 'Artifact added',
      'event.kind.lease/acquire': 'Lease acquired',
      'event.kind.lease/release': 'Lease released',
      'event.kind.import/inbox': 'Inbox imported',
      'event.kind.export/snapshot': 'Snapshot exported',
      'event.kind.context/downgrade': 'Context downgraded',
      'error.unauthorized': 'Not authenticated or not allowed. Refresh the page and try again.',
      'error.forbidden': 'You do not have permission to do that.',
      'error.network': 'Network request failed. Try again shortly.',
      'error.notFound': 'The target does not exist.',
      'error.generic': 'The operation failed',
      'error.code': 'Error code {code}',
      'common.loading': 'Loading…',
      'common.refresh': 'Refresh',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.none': 'None',
      'common.yes': 'Yes',
      'common.no': 'No',
      'common.unknown': 'Unknown',
      'common.copy': 'Copy ID',
      'common.copied': 'Copied',
      'common.id': 'ID',
      'common.all': 'All',
    }

    const ZH_KEYS = new Set(Object.keys(ZH))
    const EN_KEYS = new Set(Object.keys(EN))
    function hasCopy(key) {
      return ZH_KEYS.has(key)
    }
    function statusKey(status) {
      if (typeof status !== 'string' || status === '') return null
      const key = 'status.' + status
      return hasCopy(key) ? key : null
    }
    function eventKindKey(kind) {
      if (typeof kind !== 'string' || kind === '') return null
      const key = 'event.kind.' + kind
      return hasCopy(key) ? key : null
    }
    function docTypeKey(type) {
      const key = 'documents.type.' + type
      return hasCopy(key) ? key : null
    }
    function categoryKey(category) {
      const key = EVENT_CATEGORY_LABELS[category]
      return key && hasCopy(key) ? key : null
    }
    function healthKey(health) {
      return HEALTH_KEYS[String(health || '').toLowerCase()] || null
    }
    // Fallback translator used only if the slot framework does not hand us a t seat (e.g. node tests).
    function fallbackTranslate(key, params) {
      const localeIsEnglish =
        typeof document !== 'undefined' &&
        document.documentElement &&
        /^en/i.test(String(document.documentElement.lang || ''))
      const dict = localeIsEnglish ? EN : ZH
      const text = Object.prototype.hasOwnProperty.call(dict, key)
        ? dict[key]
        : Object.prototype.hasOwnProperty.call(ZH, key)
          ? ZH[key]
          : key
      return interpolate(text, params)
    }



    
    // =============================================================================================
    // Pure data transforms (no React / DOM / ctx). Exported through __pure for node self-tests.
    // =============================================================================================

    /** Replace {name} placeholders in a localized string; unknown placeholders are kept verbatim. */
    function interpolate(text, params) {
      if (params === undefined || params === null) return String(text)
      return String(text).replace(/\{(\w+)\}/g, (match, key) =>
        params[key] === undefined || params[key] === null ? match : String(params[key]),
      )
    }

    /** Normalize a filesystem path for comparison: forward slashes, no trailing slash, Windows cased. */
    function normalizePath(value) {
      if (typeof value !== 'string' || value === '') return ''
      let path = value.replace(/\\/g, '/')
      if (/^[a-zA-Z]:\//.test(path)) path = path.toLowerCase()
      while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
      return path
    }

    /** Whether two paths name the same location (case-insensitive on Windows drive paths). */
    function samePath(left, right) {
      const a = normalizePath(left)
      const b = normalizePath(right)
      return a !== '' && a === b
    }

    /** Match a session cwd to a project: exact root first, then the longest containing root. */
    function matchProjectByCwd(projects, cwd) {
      const target = normalizePath(cwd)
      if (target === '' || !Array.isArray(projects)) return undefined
      let best
      for (const project of projects) {
        const root = normalizePath(project && project.root)
        if (root === '') continue
        if (target === root) return project
        if (target.startsWith(root + '/') && (best === undefined || root.length > normalizePath(best.root).length)) {
          best = project
        }
      }
      return best
    }

    /** Match a project to the DSH workspace registry id (fallback when cwd is unavailable). */
    function matchProjectByWorkspace(projects, workspaceId) {
      if (!Array.isArray(projects) || typeof workspaceId !== 'string') return undefined
      return projects.find((project) => project && project.workspaceId === workspaceId)
    }

    /** User-facing project name: DB project name first, workspace title second. */
    function projectDisplayName(project) {
      if (!project) return ''
      return project.name || project.title || project.root || ''
    }

    /** Find the active PM session row in a normalized snapshot. */
    function findPMSession(snapshot) {
      if (snapshot && snapshot.pm && typeof snapshot.pm === 'object') return snapshot.pm
      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : []
      return sessions.find((row) => row && row.kind === PM_ROLE && row.status === 'active')
        || sessions.find((row) => row && row.kind === PM_ROLE)
    }

    /** Whether one sessions-table row is the PM row for a DSH session id. */
    function isPMSessionRow(row, sessionId) {
      return !!row && row.kind === PM_ROLE && typeof sessionId === 'string' && row.dshSessionId === sessionId
    }

    /** Agent preset recorded by a DSH session summary (projectionValues.agentPreset). */
    function sessionPreset(summary) {
      if (!summary) return undefined
      const values = summary.projectionValues
      return values && typeof values.agentPreset === 'string' ? values.agentPreset : undefined
    }

    /** Normalize the snapshot payload defensively; missing arrays become empty arrays. */
    function normalizeSnapshot(data) {
      const value = data && typeof data === 'object' ? data : {}
      return {
        initialized: value.initialized !== false,
        revision: Number.isFinite(value.revision) ? value.revision : null,
        project: value.project && typeof value.project === 'object' ? value.project : null,
        stages: Array.isArray(value.stages) ? value.stages : [],
        tree: Array.isArray(value.tree) ? value.tree : [],
        timeline: Array.isArray(value.timeline) ? value.timeline : [],
        sessions: Array.isArray(value.sessions) ? value.sessions : [],
        pm: value.pm && typeof value.pm === 'object' ? value.pm : null,
        root: typeof value.root === 'string' ? value.root : null,
        workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : null,
        pendingDecisions: Array.isArray(value.pendingDecisions) ? value.pendingDecisions : [],
        recentTimeline: Array.isArray(value.recentTimeline) ? value.recentTimeline : [],
        truncated: value.truncated === true,
        degraded: value.degraded === true,
        counts: value.counts && typeof value.counts === 'object' ? value.counts : null,
      }
    }

    /** Normalize the /projects payload into a stable list. */
    function normalizeProjects(data) {
      const value = data && typeof data === 'object' ? data : {}
      const list = Array.isArray(value.projects) ? value.projects : []
      return list
        .filter((item) => item && typeof item === 'object' && typeof item.root === 'string')
        .map((item) => ({
          workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : '',
          root: item.root,
          title: typeof item.title === 'string' ? item.title : item.root,
          exists: item.exists !== false,
          initialized: item.initialized === true,
          projectId: typeof item.projectId === 'string' ? item.projectId : null,
          name: typeof item.name === 'string' ? item.name : '',
          stage: item.stage === undefined ? null : item.stage,
          pendingDecisions: Number.isFinite(item.pendingDecisions) ? item.pendingDecisions : 0,
        }))
    }

    /** Event category derived from the kind prefix (doc/version -> doc). */
    function eventCategory(kind) {
      if (typeof kind !== 'string' || kind === '') return 'other'
      const prefix = kind.split('/')[0]
      return Object.prototype.hasOwnProperty.call(EVENT_CATEGORY_LABELS, prefix) ? prefix : 'other'
    }

    /** Locate the stage record a project/project.stage value points at (id, key or name). */
    function findStage(stages, projectStage) {
      if (!Array.isArray(stages) || stages.length === 0) return undefined
      if (projectStage === undefined || projectStage === null || projectStage === '') return undefined
      return stages.find((stage) => stage && (stage.id === projectStage || stage.key === projectStage || stage.name === projectStage))
    }

    /** The currently active stage: project.stage pointer first, else the row whose status is active. */
    function currentStage(stages, projectStage) {
      return findStage(stages, projectStage)
        || (Array.isArray(stages) ? stages.find((stage) => stage && stage.status === 'active') : undefined)
    }

    /** Stable stage label: "S1 产品" when both parts exist. */
    function stageLabel(stage) {
      if (!stage) return ''
      const key = stage.key || stage.id || ''
      const name = stage.name || ''
      if (key && name) return key + ' ' + name
      return name || key
    }

    /** Status tone used by badges/dots (busy/success/warn/danger/neutral). */
    function toneOfStatus(status) {
      const value = String(status || '').toLowerCase()
      return STATUS_TONES[value] || 'neutral'
    }

    /** Localized status label with a raw-value fallback. */
    function statusLabel(status, t) {
      if (status === undefined || status === null || status === '') return ''
      const key = statusKey(String(status))
      return key ? t(key) : String(status)
    }

    /** Localized event-kind label with a raw-value fallback. */
    function eventLabel(kind, t) {
      const key = eventKindKey(kind)
      return key ? t(key) : String(kind || '')
    }

    /** Localized document-type label with a raw-value fallback. */
    function docTypeLabel(type, t) {
      const key = docTypeKey(type)
      return key ? t(key) : String(type || '')
    }

    /** Localized health label with a raw-value fallback. */
    function healthLabel(health, t) {
      if (health === undefined || health === null || health === '') return t('common.unknown')
      const raw = typeof health === 'string' ? health : health.status || health.level || health.kind
      const key = healthKey(raw)
      return key ? t(key) : String(raw === undefined ? health : raw)
    }

    /** Flatten the snapshot tree into per-kind collections (the tree carries the child arrays). */
    function collectTreeData(tree) {
      const out = { stages: [], slices: [], tasks: [], sessions: [], documents: [], decisions: [], evidence: [] }
      if (!Array.isArray(tree)) return out
      for (const branch of tree) {
        if (!branch || typeof branch !== 'object') continue
        if (branch.stage) out.stages.push(branch.stage)
        const slices = Array.isArray(branch.slices) ? branch.slices : []
        for (const entry of slices) {
          if (!entry || typeof entry !== 'object') continue
          if (entry.slice) out.slices.push(entry.slice)
          for (const group of TREE_GROUPS) {
            const items = Array.isArray(entry[group.key]) ? entry[group.key] : []
            for (const item of items) {
              if (item && typeof item === 'object') out[group.key].push(item)
            }
          }
        }
      }
      return out
    }

    /** Map sliceId -> stage key (S1..S7) from the snapshot tree. */
    function stageBySliceMap(tree) {
      const map = new Map()
      if (!Array.isArray(tree)) return map
      for (const branch of tree) {
        const stage = branch && branch.stage
        if (!stage) continue
        const key = stage.key || stage.id
        const slices = Array.isArray(branch.slices) ? branch.slices : []
        for (const entry of slices) {
          const slice = entry && entry.slice
          if (slice && slice.id) map.set(slice.id, key)
        }
      }
      return map
    }

    /** Map sliceId -> slice title from the snapshot tree. */
    function sliceTitleMap(tree) {
      const map = new Map()
      if (!Array.isArray(tree)) return map
      for (const branch of tree) {
        const slices = branch && Array.isArray(branch.slices) ? branch.slices : []
        for (const entry of slices) {
          const slice = entry && entry.slice
          if (slice && slice.id) map.set(slice.id, slice.title || slice.key || slice.id)
        }
      }
      return map
    }

    /** Map sessions-table id and dshSessionId -> display name. */
    function sessionTitleMap(sessions) {
      const map = new Map()
      if (!Array.isArray(sessions)) return map
      for (const row of sessions) {
        if (!row || typeof row !== 'object') continue
        if (row.id) map.set(row.id, row.name || row.id)
        if (row.dshSessionId) map.set(row.dshSessionId, row.name || row.dshSessionId)
      }
      return map
    }

    /**
     * Flatten the stage -> slice -> group -> item tree into visible rows for the left navigation.
     * expanded may be a Set or a plain object keyed by row key.
     */
    function flattenTree(tree, expanded) {
      const rows = []
      const isOpen = (key) => {
        if (!expanded) return false
        if (typeof expanded.has === 'function') return expanded.has(key)
        return expanded[key] === true
      }
      const stages = Array.isArray(tree) ? tree : []
      for (const branch of stages) {
        const stage = branch && branch.stage
        if (!stage) continue
        const stageKey = 'stage:' + (stage.id || stage.key)
        const slices = Array.isArray(branch.slices) ? branch.slices : []
        rows.push({
          key: stageKey, kind: 'stage', depth: 0, stage, slice: null, node: stage,
          expandable: slices.length > 0, expanded: isOpen(stageKey), count: slices.length,
        })
        if (!isOpen(stageKey)) continue
        for (const entry of slices) {
          const slice = entry && entry.slice
          if (!slice) continue
          const sliceKey = 'slice:' + slice.id
          const counts = entry.counts && typeof entry.counts === 'object' ? entry.counts : {}
          rows.push({
            key: sliceKey, kind: 'slice', depth: 1, stage, slice, node: slice,
            expandable: true, expanded: isOpen(sliceKey), counts,
          })
          if (!isOpen(sliceKey)) continue
          for (const group of TREE_GROUPS) {
            const items = Array.isArray(entry[group.key]) ? entry[group.key] : []
            const groupKey = sliceKey + ':' + group.key
            rows.push({
              key: groupKey, kind: 'group', group: group.key, depth: 2, stage, slice, node: null,
              expandable: items.length > 0, expanded: isOpen(groupKey), count: items.length,
            })
            if (!isOpen(groupKey)) continue
            for (const item of items) {
              if (!item || typeof item !== 'object') continue
              rows.push({
                key: group.key + ':' + (item.id || item.dshSessionId || 'row'),
                kind: group.type, depth: 3, stage, slice, node: item, group: group.key,
              })
            }
          }
        }
      }
      return rows
    }

    /** Default expansion: the current stage. */
    function defaultExpandedKeys(tree, stages, projectStage) {
      const keys = new Set()
      const stage = currentStage(stages, projectStage) || (Array.isArray(tree) && tree[0] && tree[0].stage)
      if (stage) keys.add('stage:' + (stage.id || stage.key))
      return keys
    }

    /** Project headline counts: declared counts first, otherwise derived from the tree. */
    function projectCounts(snapshot) {
      const data = normalizeSnapshot(snapshot)
      const counted = collectTreeData(data.tree)
      const declared = data.counts || (data.project && data.project.counts) || {}
      if (declared.documents === undefined && declared.docs !== undefined) declared.documents = declared.docs
      const number = (value, fallback) => (Number.isFinite(value) ? value : fallback)
      const sliceCounts = data.tree.reduce((sum, branch) => {
        const slices = branch && Array.isArray(branch.slices) ? branch.slices : []
        return sum + slices.length
      }, 0)
      return {
        slices: number(declared.slices, sliceCounts),
        tasks: number(declared.tasks, counted.tasks.length),
        sessions: number(declared.sessions, data.sessions.length || counted.sessions.length),
        documents: number(declared.documents, counted.documents.length),
        pendingDecisions: number(declared.pendingDecisions, data.pendingDecisions.length),
        decisions: number(declared.decisions, counted.decisions.length),
        evidence: number(declared.evidence, counted.evidence.length),
      }
    }

    /** Slices treated as currently in flight (open / active / in_progress). */
    function activeSlices(snapshot) {
      const data = normalizeSnapshot(snapshot)
      return collectTreeData(data.tree).slices.filter((slice) => {
        const status = String(slice.status || '').toLowerCase()
        return status === 'active' || status === 'open' || status === 'in_progress' || status === 'ongoing'
      })
    }

    /** Slice to show on the PM badge: the PM row slice first, else the first active slice. */
    function currentSliceOf(snapshot, pmRow) {
      const data = normalizeSnapshot(snapshot)
      const collected = collectTreeData(data.tree)
      const wanted = pmRow && pmRow.sliceId
      if (wanted) {
        const found = collected.slices.find((slice) => slice.id === wanted)
        if (found) return found
      }
      return activeSlices(data)[0]
    }

    /** Highest-seq event of a list, or undefined. */
    function latestEvent(events) {
      if (!Array.isArray(events) || events.length === 0) return undefined
      let best
      for (const event of events) {
        if (!event) continue
        if (best === undefined || Number(event.seq || 0) > Number(best.seq || 0)) best = event
      }
      return best
    }

    /** Merge event lists by seq (deduplicated), sorted ascending by seq. */
    function mergeEvents() {
      const bySeq = new Map()
      for (let index = 0; index < arguments.length; index += 1) {
        const list = arguments[index]
        if (!Array.isArray(list)) continue
        for (const event of list) {
          if (!event || !Number.isFinite(Number(event.seq))) continue
          const seq = Number(event.seq)
          if (!bySeq.has(seq)) bySeq.set(seq, event)
        }
      }
      return Array.from(bySeq.values()).sort((left, right) => Number(left.seq) - Number(right.seq))
    }

    /** Distinct roles present in events, for the timeline role filter. */
    function timelineRoleOptions(events) {
      const seen = new Set()
      if (Array.isArray(events)) {
        for (const event of events) {
          if (event && typeof event.role === 'string' && event.role !== '') seen.add(event.role)
        }
      }
      return Array.from(seen).sort()
    }

    /** Filter events by event category, role and stage (slice -> stage mapping). */
    function filterTimeline(events, filters, maps) {
      const list = Array.isArray(events) ? events : []
      const settings = filters || {}
      const stageMap = (maps && maps.stageBySlice) || new Map()
      return list.filter((event) => {
        if (!event) return false
        if (settings.category && settings.category !== 'all' && eventCategory(event.kind) !== settings.category) return false
        if (settings.role && settings.role !== 'all' && (event.role || '') !== settings.role) return false
        if (settings.stage && settings.stage !== 'all') {
          let stageKey = event.stage
          if (!stageKey && event.sliceId) stageKey = stageMap.get(event.sliceId)
          if (!stageKey && event.payload && typeof event.payload === 'object') stageKey = event.payload.stage
          if (stageKey !== settings.stage) return false
        }
        return true
      })
    }

    /** Detail line for one event: first useful payload field, else the subject id. */
    function eventDetail(event) {
      if (!event) return ''
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : {}
      const fields = [
        'title', 'name', 'question', 'summary', 'reason', 'message', 'status', 'stage', 'gate',
        'kind', 'role', 'version', 'path', 'uri', 'command', 'resultSummary', 'to', 'from',
      ]
      for (const field of fields) {
        const value = payload[field]
        if (value === undefined || value === null || value === '') continue
        if (typeof value === 'object') return JSON.stringify(value)
        return String(value)
      }
      if (event.subjectType || event.subjectId) {
        return String(event.subjectType || '') + (event.subjectId ? ':' + String(event.subjectId) : '')
      }
      return ''
    }

    /** Actor label for one event: role, else session name (from the session map), else the raw id. */
    function eventActor(event, maps) {
      if (!event) return ''
      if (typeof event.role === 'string' && event.role !== '') return event.role
      const titles = (maps && maps.sessionTitles) || new Map()
      if (event.actorSession && titles.has(event.actorSession)) return titles.get(event.actorSession)
      return event.actorSession || ''
    }

    /** Localized date-time for UI (locale passed in so the function stays pure/testable). */
    function formatTime(value, lang) {
      if (value === undefined || value === null || value === '') return ''
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return new Intl.DateTimeFormat(lang || 'zh-CN', {
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(date)
      } catch (error) {
        return date.toISOString()
      }
    }

    /** Localized full date-time (with year) for detail panes. */
    function formatFullTime(value, lang) {
      if (value === undefined || value === null || value === '') return ''
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      try {
        return new Intl.DateTimeFormat(lang || 'zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }).format(date)
      } catch (error) {
        return date.toISOString()
      }
    }

    /** Bounded single-line text for tables/cards. */
    function truncate(value, max) {
      const text = value === undefined || value === null ? '' : String(value)
      const limit = Number.isFinite(max) ? max : 120
      return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…'
    }

    /** Normalize decision.options (array/object/JSON-string) into {value,label,description}. */
    function decisionOptions(decision) {
      if (!decision) return []
      let raw = decision.options
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw)
        } catch (error) {
          raw = []
        }
      }
      if (!Array.isArray(raw)) return []
      const letter = (index) => String.fromCharCode(65 + (index % 26))
      return raw.map((option, index) => {
        if (typeof option === 'string') return { value: letter(index), label: option, description: '' }
        if (option && typeof option === 'object') {
          const value = option.value !== undefined ? option.value : option.id !== undefined ? option.id : letter(index)
          const label = option.label !== undefined ? option.label
            : option.title !== undefined ? option.title
              : option.value !== undefined ? option.value
                : option.text !== undefined ? option.text : ''
          const description = option.description !== undefined ? option.description
            : option.detail !== undefined ? option.detail : ''
          return { value: String(value), label: String(label), description: String(description) }
        }
        return { value: String(index + 1), label: String(option), description: '' }
      })
    }

    /** Does this decision option equal the recommendation field? */
    function isRecommendedOption(option, recommended) {
      if (!option || recommended === undefined || recommended === null || recommended === '') return false
      const value = typeof recommended === 'object' ? JSON.stringify(recommended) : String(recommended)
      return option.value === value || option.label === value
    }

    /** Sessions order: PM first, then active, then newest first. */
    function sortSessions(sessions) {
      const list = Array.isArray(sessions) ? sessions.slice() : []
      const rank = (row) => (row && row.kind === PM_ROLE ? 0 : row && row.status === 'active' ? 1 : 2)
      return list.sort((left, right) => {
        const byRank = rank(left) - rank(right)
        if (byRank !== 0) return byRank
        return String((right && right.startedAt) || '').localeCompare(String((left && left.startedAt) || ''))
      })
    }

    /** Stage dropdown options for timeline filtering. */
    function timelineStageOptions(stages) {
      const list = Array.isArray(stages) ? stages : []
      return list
        .filter((stage) => stage && (stage.key || stage.id))
        .map((stage) => ({ value: stage.key || stage.id, label: stageLabel(stage) }))
    }

    /** Normalize an unknown error into {code,status,message}. */
    function errorInfo(error) {
      if (!error) return { code: 'UNKNOWN', status: 0, message: '' }
      const code = (error.code || (error.error && error.error.code) || 'UNKNOWN')
      const status = Number.isFinite(error.status) ? error.status : 0
      const message = error.message || (error.error && error.error.message) || ''
      return { code: String(code), status, message: String(message) }
    }

    /** Localized error copy; never renders raw keys. */
    function errorText(error, t) {
      const info = errorInfo(error)
      if (info.status === 401) return t('error.unauthorized')
      if (info.status === 403) return t('error.forbidden')
      if (info.code === 'NETWORK') return t('error.network')
      if (info.status === 404 || info.code === 'NOT_FOUND') return t('error.notFound')
      const base = info.message || t('error.generic')
      return info.code && info.code !== 'UNKNOWN' && info.code !== 'HTTP' ? base + ' (' + t('error.code', { code: info.code }) + ')' : base
    }

    /** Project choice list for the switcher: initialized projects first, then by title. */
    function projectChoices(projects) {
      const list = Array.isArray(projects) ? projects.slice() : []
      return list.sort((left, right) => {
        if (!!left.initialized !== !!right.initialized) return left.initialized ? -1 : 1
        return String(projectDisplayName(left)).localeCompare(String(projectDisplayName(right)))
      })
    }

    /** Pick a default project: current selection, session cwd, an initialized project, else the first. */
    function pickDefaultProject(projects, selectedRoot, cwd) {
      if (!Array.isArray(projects) || projects.length === 0) return undefined
      if (selectedRoot) {
        const current = projects.find((project) => samePath(project.root, selectedRoot))
        if (current) return current
      }
      const byCwd = matchProjectByCwd(projects, cwd)
      if (byCwd) return byCwd
      return projects.find((project) => project.exists && project.initialized)
        || projects.find((project) => project.exists)
        || projects[0]
    }

    /**
     * Parse DB document content into safe render blocks (never HTML): headings, paragraphs,
     * list items, quote lines, fenced code and horizontal rules. Long inputs are capped.
     */
    function parseDocContent(content) {
      const source = String(content === undefined || content === null ? '' : content)
      const text = source.length > MAX_DOC_BLOCK * 50 ? source.slice(0, MAX_DOC_BLOCK * 50) : source
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      const paragraph = []
      let code = null
      const flushParagraph = () => {
        if (paragraph.length > 0) {
          blocks.push({ type: 'p', text: paragraph.join('\n') })
          paragraph.length = 0
        }
      }
      for (const line of lines) {
        if (code !== null) {
          if (/^\s*```/.test(line)) {
            blocks.push({ type: 'code', text: code.lines.join('\n'), lang: code.lang })
            code = null
          } else {
            code.lines.push(line)
          }
          continue
        }
        const fence = line.match(/^\s*```\s*([A-Za-z0-9_+#.-]*)\s*$/)
        if (fence) {
          flushParagraph()
          code = { lang: fence[1] || '', lines: [] }
          continue
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/)
        if (heading) {
          flushParagraph()
          blocks.push({ type: 'h' + Math.min(3, heading[1].length), text: heading[2] })
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          flushParagraph()
          blocks.push({ type: 'quote', text: line.replace(/^\s*>\s?/, '') })
          continue
        }
        const listItem = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)
        if (listItem) {
          flushParagraph()
          blocks.push({ type: 'li', text: listItem[1] })
          continue
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          flushParagraph()
          blocks.push({ type: 'hr' })
          continue
        }
        if (line.trim() === '') {
          flushParagraph()
          continue
        }
        paragraph.push(line)
      }
      if (code !== null) blocks.push({ type: 'code', text: code.lines.join('\n'), lang: code.lang })
      flushParagraph()
      if (blocks.length === 0) blocks.push({ type: 'p', text: '' })
      return blocks
    }

    /** Session kind -> copy key (PM / task / subagent / other). */
    function sessionKindKey(kind) {
      if (kind === 'pm') return 'sessions.kind.pm'
      if (kind === 'task') return 'sessions.kind.task'
      if (kind === 'subagent') return 'sessions.kind.subagent'
      return 'sessions.kind.other'
    }

    /** Find the first document referenced by a session handoff id. */
    function findDocumentById(tree, documentId) {
      if (!documentId) return undefined
      return collectTreeData(tree).documents.find((doc) => doc.id === documentId)
    }

    /** Aggregate stage counts for the overview: slices and open slices per stage key. */
    function stageProgress(tree) {
      const result = new Map()
      const stages = Array.isArray(tree) ? tree : []
      for (const branch of stages) {
        const stage = branch && branch.stage
        if (!stage) continue
        const key = stage.key || stage.id
        const slices = Array.isArray(branch.slices) ? branch.slices : []
        const active = slices.filter((entry) => {
          const slice = entry && entry.slice
          const status = String((slice && slice.status) || '').toLowerCase()
          return status === 'active' || status === 'open' || status === 'in_progress'
        }).length
        result.set(key, { total: slices.length, active })
      }
      return result
    }

    /** Test seam: every pure transform worth exercising without a browser. */
    const PURE = {
      interpolate, normalizePath, samePath, matchProjectByCwd, matchProjectByWorkspace,
      projectDisplayName, findPMSession, isPMSessionRow, sessionPreset, normalizeSnapshot,
      normalizeProjects, eventCategory, findStage, currentStage, stageLabel, toneOfStatus,
      statusLabel, eventLabel, docTypeLabel, healthLabel, collectTreeData, stageBySliceMap,
      sliceTitleMap, sessionTitleMap, flattenTree, defaultExpandedKeys, projectCounts,
      activeSlices, currentSliceOf, latestEvent, mergeEvents, timelineRoleOptions, filterTimeline,
      eventDetail, eventActor, formatTime, formatFullTime, truncate, decisionOptions,
      isRecommendedOption, sortSessions, timelineStageOptions, errorInfo, errorText,
      projectChoices, pickDefaultProject, parseDocContent, sessionKindKey, findDocumentById,
      stageProgress, statusKey, eventKindKey, docTypeKey, hasCopy,
    }





    
    // =============================================================================================
    // HTTP client for /project-workbench/api (same-origin cookies; JSON errors normalized).
    // =============================================================================================
    class ApiError extends Error {
      constructor(code, message, status) {
        super(message || code)
        this.name = 'ApiError'
        this.code = code || 'UNKNOWN'
        this.status = Number.isFinite(status) ? status : 0
      }
    }

    function queryString(params) {
      const parts = []
      const source = params || {}
      for (const key of Object.keys(source)) {
        const value = source[key]
        if (value === undefined || value === null || value === '') continue
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      }
      return parts.length > 0 ? '?' + parts.join('&') : ''
    }

    async function requestJson(path, options) {
      const settings = options || {}
      let response
      try {
        response = await fetch(API_BASE + path, {
          method: settings.method || 'GET',
          credentials: 'same-origin',
          headers: settings.body === undefined ? undefined : { 'content-type': 'application/json' },
          body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
          signal: settings.signal,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') throw error
        throw new ApiError('NETWORK', error && error.message ? error.message : 'network request failed')
      }
      let text = ''
      try {
        text = await response.text()
      } catch (error) {
        text = ''
      }
      let data = null
      if (text !== '') {
        try {
          data = JSON.parse(text)
        } catch (error) {
          data = null
        }
      }
      if (!response.ok || (data && data.error)) {
        const payload = data && data.error && typeof data.error === 'object' ? data.error : {}
        const code = payload.code || 'HTTP_' + String(response.status)
        const message = payload.message || response.statusText || ('HTTP ' + String(response.status))
        throw new ApiError(code, message, response.status)
      }
      return data === null ? {} : data
    }

    /** One API client per plugin instance; every call names the project root explicitly. */
    function createApi() {
      return {
        projects: () => requestJson('/projects'),
        snapshot: (root) => requestJson('/snapshot' + queryString({ root })),
        slice: (root, id) => requestJson('/slice' + queryString({ root, id })),
        doc: (root, id, version) => requestJson('/doc' + queryString({ root, id, version })),
        timeline: (root, options) => requestJson('/timeline' + queryString({
          root,
          after: options && options.after,
          limit: options && options.limit,
          kinds: options && options.kinds,
        })),
        init: (root) => requestJson('/init', { method: 'POST', body: { root } }),
        decision: (payload) => requestJson('/decision', { method: 'POST', body: payload }),
        pm: (root, dshSessionId) => requestJson('/pm', { method: 'POST', body: { root, dshSessionId } }),
      }
    }

    // =============================================================================================
    // Observable hub shared by the panel and the two PM session seats. One snapshot fetch and one
    // EventSource per project root, reference counted; SSE 'change' reloads the snapshot (no polling).
    // =============================================================================================
    const SSE_CLOSE_LINGER_MS = 1500
    const SSE_REFRESH_DEBOUNCE_MS = 120

    function createHub(api) {
      let state = {
        version: 0,
        projects: { phase: 'idle', items: [], error: null },
        selectedRoot: null,
        snapshots: {},
        roots: {},
      }
      const listeners = new Set()
      const snapshotRequests = new Map()
      const closeTimers = new Map()
      const changeTimers = new Map()
      let projectsRequest = null
      let disposed = false

      function publish(patch) {
        if (disposed) return
        state = Object.assign({}, state, patch, { version: state.version + 1 })
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch (error) {
            // A listener owns its own render errors; never let one block the others.
          }
        }
      }
      function subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
      function getState() {
        return state
      }
      function mergeSnapshot(root, patch) {
        const previous = state.snapshots[root]
        publish({
          snapshots: Object.assign({}, state.snapshots, {
            [root]: Object.assign({ phase: 'idle', data: null, error: null, revision: null, updatedAt: 0 }, previous, patch),
          }),
        })
      }
      function updateRoot(root, patch) {
        const previous = state.roots[root] || { refs: 0, status: 'idle' }
        publish({ roots: Object.assign({}, state.roots, { [root]: Object.assign({}, previous, patch) }) })
      }

      async function ensureProjects(force) {
        if (disposed) return undefined
        if (projectsRequest !== null) return projectsRequest
        if (!force && state.projects.phase === 'ready') return undefined
        publish({ projects: Object.assign({}, state.projects, { phase: 'loading', error: null }) })
        projectsRequest = (async () => {
          try {
            const data = await api.projects()
            if (disposed) return
            publish({ projects: { phase: 'ready', items: normalizeProjects(data), error: null } })
          } catch (error) {
            if (disposed) return
            publish({ projects: { phase: 'error', items: state.projects.items, error: errorInfo(error) } })
          } finally {
            projectsRequest = null
          }
        })()
        return projectsRequest
      }

      async function ensureSnapshot(root, force) {
        if (disposed || !root) return undefined
        const pending = snapshotRequests.get(root)
        if (pending !== undefined) return pending
        const current = state.snapshots[root]
        if (!force && current && current.phase === 'ready') return undefined
        mergeSnapshot(root, { phase: 'loading', data: current ? current.data : null, error: null })
        const request = (async () => {
          try {
            const data = await api.snapshot(root)
            if (disposed) return
            mergeSnapshot(root, {
              phase: 'ready',
              data: normalizeSnapshot(data),
              revision: data && Number.isFinite(data.revision) ? data.revision : null,
              error: null,
              updatedAt: Date.now(),
            })
          } catch (error) {
            if (disposed) return
            const latest = state.snapshots[root]
            mergeSnapshot(root, { phase: 'error', data: latest ? latest.data : null, error: errorInfo(error) })
          } finally {
            snapshotRequests.delete(root)
          }
        })()
        snapshotRequests.set(root, request)
        return request
      }

      function scheduleSnapshotRefresh(root, revision) {
        const existing = changeTimers.get(root)
        if (existing !== undefined) clearTimeout(existing)
        changeTimers.set(root, setTimeout(() => {
          changeTimers.delete(root)
          if (disposed) return
          const current = state.snapshots[root]
          if (revision !== undefined && revision !== null && current && current.revision !== null
            && Number(revision) <= Number(current.revision)) {
            return
          }
          ensureSnapshot(root, true)
          if (state.projects.phase === 'ready') ensureProjects(true)
        }, SSE_REFRESH_DEBOUNCE_MS))
      }

      function closeEventSource(root) {
        const entry = state.roots[root]
        if (entry && entry.sse && typeof entry.sse.close === 'function') {
          try {
            entry.sse.close()
          } catch (error) {
            // already closed
          }
        }
        if (entry) updateRoot(root, { sse: null, status: 'idle' })
      }

      function openEventSource(root) {
        if (disposed) return
        closeEventSource(root)
        if (typeof EventSource !== 'function') {
          updateRoot(root, { status: 'unsupported', sse: null })
          return
        }
        let source
        try {
          source = new EventSource(API_BASE + '/events' + queryString({ root }))
        } catch (error) {
          updateRoot(root, { status: 'error', sse: null })
          return
        }
        updateRoot(root, { sse: source, status: 'connecting' })
        source.addEventListener('open', () => updateRoot(root, { status: 'live' }))
        source.addEventListener('error', () => updateRoot(root, { status: 'error' }))
        const onEvent = (event) => {
          let revision
          try {
            const parsed = JSON.parse(event.data)
            revision = parsed && parsed.revision !== undefined ? Number(parsed.revision) : undefined
          } catch (error) {
            revision = undefined
          }
          scheduleSnapshotRefresh(root, revision)
        }
        source.addEventListener('change', onEvent)
        source.addEventListener('message', onEvent)
      }

      function cancelScheduledClose(root) {
        const timer = closeTimers.get(root)
        if (timer !== undefined) {
          clearTimeout(timer)
          closeTimers.delete(root)
        }
      }

      function releaseRoot(root) {
        const entry = state.roots[root]
        if (!entry) return
        const refs = Math.max(0, (entry.refs || 1) - 1)
        if (refs > 0) {
          updateRoot(root, { refs })
          return
        }
        updateRoot(root, { refs: 0 })
        cancelScheduledClose(root)
        closeTimers.set(root, setTimeout(() => {
          closeTimers.delete(root)
          if (disposed) return
          const latest = state.roots[root]
          if (latest && latest.refs > 0) return
          closeEventSource(root)
          const roots = Object.assign({}, state.roots)
          delete roots[root]
          publish({ roots })
        }, SSE_CLOSE_LINGER_MS))
      }

      function acquire(root) {
        if (disposed || !root) return function releaseNoop() {}
        ensureProjects()
        cancelScheduledClose(root)
        const entry = state.roots[root] || { refs: 0, status: 'idle' }
        const refs = (entry.refs || 0) + 1
        updateRoot(root, { refs })
        ensureSnapshot(root)
        if (refs === 1 || !entry.sse) openEventSource(root)
        let released = false
        return function release() {
          if (released) return
          released = true
          releaseRoot(root)
        }
      }

      function reconnect(root) {
        if (disposed || !root) return
        cancelScheduledClose(root)
        openEventSource(root)
      }

      function selectProject(root) {
        if (disposed) return
        publish({ selectedRoot: root === undefined ? null : root })
        if (root) ensureSnapshot(root)
      }

      function dispose() {
        if (disposed) return
        disposed = true
        for (const timer of Array.from(changeTimers.values())) clearTimeout(timer)
        for (const timer of Array.from(closeTimers.values())) clearTimeout(timer)
        changeTimers.clear()
        closeTimers.clear()
        for (const root of Object.keys(state.roots)) {
          const entry = state.roots[root]
          if (entry && entry.sse && typeof entry.sse.close === 'function') {
            try {
              entry.sse.close()
            } catch (error) {
              // already closed
            }
          }
        }
        listeners.clear()
      }

      return {
        getState, subscribe,
        ensureProjects,
        ensureSnapshot,
        refreshSnapshot: (root, force) => ensureSnapshot(root, force !== false),
        refreshProjects: (force) => ensureProjects(force !== false),
        selectProject,
        acquire,
        reconnect,
        dispose,
      }
    }

    // =============================================================================================
    // Runtime: thin, defensive wrappers over the client services the plugin declares in inject.
    // The panel/PM seats never touch ctx directly, so components stay render-only.
    // =============================================================================================
    function createRuntime(ctx) {
      const getService = (name) => {
        if (typeof ctx.get === 'function') {
          try {
            const value = ctx.get(name)
            if (value !== undefined) return value
          } catch (error) {
            // service not present in this composition
          }
        }
        return ctx[name]
      }
      const getSessions = () => getService('sessions')
      const getWorkspaces = () => getService('workspaces')

      function sessionList() {
        const sessions = getSessions()
        return sessions && sessions.list
      }
      function sessionSummary(sessionId) {
        const list = sessionList()
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        const byId = snapshot && snapshot.byId
        return byId && Object.prototype.hasOwnProperty.call(byId, sessionId) ? byId[sessionId] : undefined
      }
      function subscribeSessions(listener) {
        const list = sessionList()
        if (!list || typeof list.subscribe !== 'function') return function unsubscribeNoop() {}
        return list.subscribe(listener)
      }
      function workspaceIdForSession(sessionId) {
        const workspaces = getWorkspaces()
        const snapshot = workspaces && workspaces.list && typeof workspaces.list.getSnapshot === 'function'
          ? workspaces.list.getSnapshot()
          : undefined
        const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
        const owner = items.find((item) => item && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
        return owner && owner.workspaceId
      }
      function currentSessionCwd() {
        const list = sessionList()
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        const byId = snapshot && snapshot.byId ? snapshot.byId : {}
        const current = Object.keys(byId)
          .map((id) => byId[id])
          .find((row) => row && row.retainedBy && row.retainedBy.mainView > 0)
        return current && typeof current.cwd === 'string' ? current.cwd : undefined
      }
      function sessionExists(sessionId) {
        const list = sessionList()
        const snapshot = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : undefined
        if (!snapshot || !snapshot.byId) return undefined
        if (snapshot.phase !== undefined && snapshot.phase !== 'ready') return undefined
        return Object.prototype.hasOwnProperty.call(snapshot.byId, sessionId)
      }
      function openSession(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          ctx.uiWorkspace.openSession(sessionId)
        } catch (error) {
          console.warn('project-workbench: openSession failed', error)
        }
      }
      function openPanel() {
        try {
          ctx.layout.selectPanel(PANEL_KEY)
        } catch (error) {
          console.warn('project-workbench: selectPanel failed', error)
        }
      }
      function uiLang() {
        if (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) {
          return String(document.documentElement.lang)
        }
        return 'zh-CN'
      }
      function notify(message) {
        try {
          if (typeof window !== 'undefined' && window.console) console.warn('project-workbench: ' + message)
        } catch (error) {
          // ignore
        }
      }

      async function waitForNewPMSession(sessions, workspaceId) {
        const list = sessions && sessions.list
        if (!list || typeof list.getSnapshot !== 'function' || typeof ctx.uiWorkspace.startSession !== 'function') {
          throw new ApiError('PM_UNAVAILABLE', 'no client API can create a PM session')
        }
        const before = list.getSnapshot()
        const known = new Set((before && before.ids) || [])
        const ui = ctx.uiWorkspace
        return new Promise((resolve, reject) => {
          let unsubscribe = function unsubscribeNoop() {}
          const timer = setTimeout(() => {
            unsubscribe()
            reject(new ApiError('PM_TIMEOUT', 'the PM session was not created in time'))
          }, 15000)
          const check = () => {
            const snapshot = list.getSnapshot()
            const ids = (snapshot && snapshot.ids) || []
            const byId = (snapshot && snapshot.byId) || {}
            const found = ids.find((id) => !known.has(id) && byId[id] && byId[id].blank && sessionPreset(byId[id]) === PM_PRESET)
            if (found !== undefined) {
              clearTimeout(timer)
              unsubscribe()
              resolve(found)
            }
          }
          if (typeof list.subscribe === 'function') unsubscribe = list.subscribe(check)
          ui.startSession(workspaceId, { agentPreset: PM_PRESET })
          check()
        })
      }

      /**
       * Create (or reuse) the blank PM session for a project.
       * uiWorkspace.startSession is fire-and-forget; connectWorkspace is the documented API that
       * returns the new Session id, which the client needs in order to POST /pm.
       */
      async function createPMSession(workspaceId) {
        if (typeof workspaceId !== 'string' || workspaceId === '') {
          throw new ApiError('PM_WORKSPACE_MISSING', 'the project workspace id is missing')
        }
        const ui = ctx.uiWorkspace
        if (ui && typeof ui.connectWorkspace === 'function') {
          const sessionId = await ui.connectWorkspace(workspaceId, { agentPreset: PM_PRESET })
          if (typeof sessionId === 'string' && sessionId !== '') return sessionId
        }
        const sessions = getSessions()
        if (sessions && typeof sessions.create === 'function') {
          const sessionId = await sessions.create({ workspaceId, agentPreset: PM_PRESET })
          if (typeof sessionId === 'string' && sessionId !== '') return sessionId
        }
        return waitForNewPMSession(sessions, workspaceId)
      }

      return {
        getSessions, getWorkspaces,
        sessionSummary, subscribeSessions, workspaceIdForSession, currentSessionCwd, sessionExists,
        openSession, openPanel, uiLang, notify, createPMSession,
      }
    }

    /**
     * Open the project PM session: reuse the active PM row when its DSH session still exists,
     * otherwise create a blank project-office session, register it through POST /pm and open it.
     */
    async function enterProjectPM(ctx, api, hub, runtime, options) {
      const settings = options || {}
      const root = settings.root
      const workspaceId = settings.workspaceId
      const snapshot = normalizeSnapshot(settings.snapshot)
      const pm = findPMSession(snapshot)
      if (pm && pm.dshSessionId) {
        const exists = runtime.sessionExists(pm.dshSessionId)
        if (exists !== false) {
          runtime.openSession(pm.dshSessionId)
          return { sessionId: pm.dshSessionId, created: false }
        }
      }
      const sessionId = await runtime.createPMSession(workspaceId)
      let registrationError = null
      try {
        await api.pm(root, sessionId)
      } catch (error) {
        registrationError = error
      }
      if (root) {
        hub.selectProject(root)
        hub.refreshSnapshot(root, true)
      }
      runtime.openSession(sessionId)
      if (registrationError !== null) throw registrationError
      return { sessionId, created: true }
    }

    // =============================================================================================
    // Shared React plumbing: observable subscription, async action state, small presentational atoms.
    // =============================================================================================
    function useHubState(hub) {
      return React.useSyncExternalStore(hub.subscribe, hub.getState, hub.getState)
    }

    /** Re-render when the DSH Session list changes (cwd / preset for the PM seats). */
    function useSessionReactive(runtime) {
      const [, force] = React.useReducer((count) => count + 1, 0)
      React.useEffect(() => runtime.subscribeSessions(force), [runtime])
      return force
    }

    /** Local busy/error/ok around one async user action. */
    function useAsyncAction() {
      const [state, setState] = React.useState({ busy: false, error: null, ok: false })
      const run = React.useCallback(async (task) => {
        setState({ busy: true, error: null, ok: false })
        try {
          const result = await task()
          setState({ busy: false, error: null, ok: true })
          return result
        } catch (error) {
          setState({ busy: false, error, ok: false })
          return undefined
        }
      }, [])
      const reset = React.useCallback(() => setState({ busy: false, error: null, ok: false }), [])
      return { busy: state.busy, error: state.error, ok: state.ok, run, reset }
    }

    /** Slot components receive the framework t seat; fall back to the plugin dictionary in tests. */
    function pickT(props) {
      if (props && typeof props.t === 'function') return props.t
      if (props && typeof props.fallbackT === 'function') return props.fallbackT
      return fallbackTranslate
    }

    /** Resolve the project a DSH Session belongs to (cwd first, workspace registry second). */
    function resolveProjectForSession(projects, summary, sessionId, runtime) {
      if (!Array.isArray(projects) || projects.length === 0) return undefined
      if (summary) {
        const byCwd = matchProjectByCwd(projects, summary.cwd)
        if (byCwd) return byCwd
      }
      const workspaceId = runtime && typeof runtime.workspaceIdForSession === 'function'
        ? runtime.workspaceIdForSession(sessionId)
        : undefined
      return matchProjectByWorkspace(projects, workspaceId)
    }

    /** Shared context for the two PM session seats (badge + composer dock). */
    function useSessionProjectContext(hub, runtime, sessionId) {
      const state = useHubState(hub)
      useSessionReactive(runtime)
      React.useEffect(() => {
        if (state.projects.phase === 'idle') hub.ensureProjects()
      }, [state.projects.phase, hub])
      const summary = runtime.sessionSummary(sessionId)
      const project = resolveProjectForSession(state.projects.items, summary, sessionId, runtime)
      const root = project && project.exists !== false ? project.root : undefined
      React.useEffect(() => {
        if (!root) return undefined
        return hub.acquire(root)
      }, [root, hub])
      const entry = root ? state.snapshots[root] : undefined
      const snapshot = entry && entry.data ? normalizeSnapshot(entry.data) : null
      const pm = snapshot ? findPMSession(snapshot) : undefined
      const isPM = (pm !== undefined && isPMSessionRow(pm, sessionId)) || sessionPreset(summary) === PM_PRESET
      return { state, summary, project, root, entry, snapshot, pm, isPM }
    }

    function Badge(props) {
      const className = props.className ? 'wb-badge ' + props.className : 'wb-badge'
      return h('span', { className, 'data-tone': props.tone || undefined, title: props.title }, props.children)
    }

    function Dot(props) {
      return h('span', { className: 'wb-dot', 'data-tone': props.tone || undefined, 'aria-hidden': 'true' })
    }

    function StatusBadge(props) {
      const t = props.t
      if (props.status === undefined || props.status === null || props.status === '') return null
      return h(Badge, { tone: toneOfStatus(props.status), title: String(props.status) }, statusLabel(props.status, t))
    }

    function KindBadge(props) {
      return h(Badge, { tone: props.tone || 'neutral' }, props.children)
    }

    function Spinner() {
      return h('span', { className: 'wb-spinner', 'aria-hidden': 'true' })
    }

    function LoadingRow(props) {
      return h('div', { className: 'wb-loading', role: 'status' }, h(Spinner), h('span', null, props.label))
    }

    function EmptyState(props) {
      return h('div', { className: 'wb-empty', role: 'status' },
        props.title ? h('p', { className: 'wb-empty-title' }, props.title) : null,
        props.detail ? h('p', { className: 'wb-muted' }, props.detail) : null,
        props.children || null,
      )
    }

    function ErrorBanner(props) {
      const t = props.t
      const message = errorText(props.error, t)
      return h('div', { className: 'wb-banner', 'data-tone': 'error', role: 'alert' },
        h('span', { className: 'wb-banner-grow' }, (props.title ? props.title + ': ' : '') + message),
        props.onRetry ? h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: props.onRetry }, t('panel.retry')) : null,
      )
    }

    function Notice(props) {
      return h('p', { className: 'wb-notice', 'data-tone': props.tone || 'ok', role: props.tone === 'error' ? 'alert' : 'status' }, props.children)
    }

    function SectionCard(props) {
      return h('section', { className: 'wb-card' },
        h('div', { className: 'wb-card-head' },
          h('div', null,
            h('h3', { className: 'wb-card-title' }, props.title),
            props.subtitle ? h('p', { className: 'wb-card-sub' }, props.subtitle) : null,
          ),
          props.actions ? h('div', { className: 'wb-card-actions' }, props.actions) : null,
        ),
        props.children,
      )
    }

    function Field(props) {
      return h(Fragment, null,
        h('dt', null, props.label),
        h('dd', null, props.children === undefined || props.children === null || props.children === '' ? '—' : props.children),
      )
    }

    function CountCard(props) {
      return h('div', { className: 'wb-count' },
        h('div', { className: 'wb-count-value' }, String(props.value === undefined ? 0 : props.value)),
        h('div', { className: 'wb-count-label' }, props.label),
      )
    }

    function Chevron(props) {
      const glyph = props.open ? '\u2304' : '\u203A'
      return h('svg', {
        viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': 'true',
        style: { transform: props.open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease' },
      }, h('path', { d: 'M5.5 3.5 10 8l-4.5 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function ProjectIcon(props) {
      const size = props.size || 18
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h4l2 2h5A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
        h('path', { d: 'M8 12h3M8 15h6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function RefreshIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7M13 3v3h-3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function BackIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': 'true' },
        h('path', { d: 'M10 3 5 8l5 5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** Localized language tag for Intl formatting (document lang owned by the locale runtime). */
    function uiLang(runtime) {
      return runtime && typeof runtime.uiLang === 'function' ? runtime.uiLang() : 'zh-CN'
    }

    // =============================================================================================
    // Main keyed panel (key = project-workbench): project switcher, header, tree navigation, tabs.
    // =============================================================================================
    function toggleSet(set, key) {
      const next = new Set(set)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    }

    function activeProjectOf(projects, selectedRoot, runtime) {
      return projects.find((project) => samePath(project.root, selectedRoot))
        || pickDefaultProject(projects, selectedRoot, runtime.currentSessionCwd())
    }

    function WorkbenchPanel(props) {
      const t = pickT(props)
      const { hub, actions, runtime } = props
      const state = useHubState(hub)
      const [expanded, setExpanded] = React.useState(() => new Set())
      const [selected, setSelected] = React.useState(null)
      const [tab, setTab] = React.useState('overview')
      const [docState, setDocState] = React.useState({ id: null, version: null, phase: 'idle', data: null, error: null })
      const enterAction = useAsyncAction()
      const initAction = useAsyncAction()

      const projects = state.projects.items
      const project = React.useMemo(() => activeProjectOf(projects, state.selectedRoot, runtime), [projects, state.selectedRoot, runtime])
      const defaultRoot = project ? project.root : undefined
      const root = project ? project.root : undefined
      const live = !!(project && project.exists && project.initialized)

      React.useEffect(() => {
        hub.ensureProjects()
      }, [hub])
      React.useEffect(() => {
        if (defaultRoot && !samePath(defaultRoot, state.selectedRoot || '')) hub.selectProject(defaultRoot)
      }, [defaultRoot, state.selectedRoot, hub])
      React.useEffect(() => {
        if (!root || !live) return undefined
        return hub.acquire(root)
      }, [root, live, hub])

      const entry = root ? state.snapshots[root] : undefined
      const snapshotData = entry ? entry.data : null
      const norm = React.useMemo(() => normalizeSnapshot(snapshotData), [snapshotData])
      const treeData = React.useMemo(() => collectTreeData(norm.tree), [norm])
      const maps = React.useMemo(() => ({
        stageBySlice: stageBySliceMap(norm.tree),
        sliceTitles: sliceTitleMap(norm.tree),
        sessionTitles: sessionTitleMap(norm.sessions.length > 0 ? norm.sessions : treeData.sessions),
      }), [norm, treeData])
      const rows = React.useMemo(() => flattenTree(norm.tree, expanded), [norm.tree, expanded])

      React.useEffect(() => {
        if (!snapshotData || norm.tree.length === 0) return
        setExpanded((previous) => (previous.size > 0 ? previous : defaultExpandedKeys(norm.tree, norm.stages, norm.project && norm.project.stage)))
      }, [snapshotData, norm])

      const loadDoc = React.useCallback(async (docId, version) => {
        if (!root || !docId) return
        setDocState({ id: docId, version: version === undefined ? null : version, phase: 'loading', data: null, error: null })
        try {
          const data = await actions.loadDoc(root, docId, version)
          setDocState({
            id: docId,
            version: data && data.version !== undefined ? data.version : version,
            phase: 'ready',
            data,
            error: null,
          })
        } catch (error) {
          setDocState({ id: docId, version: version === undefined ? null : version, phase: 'error', data: null, error })
        }
      }, [root, actions])

      const openDocument = React.useCallback((docId, version) => {
        setTab('documents')
        loadDoc(docId, version)
      }, [loadDoc])

      const selectRow = React.useCallback((row) => {
        if (!row) return
        if (row.kind === 'group') {
          setExpanded((previous) => toggleSet(previous, row.key))
          return
        }
        setSelected(row)
        if (row.kind === 'document') openDocument(row.node.id)
        else if (row.kind === 'decision') setTab('decisions')
        else if (row.kind === 'session') setTab('sessions')
        else setTab('overview')
      }, [openDocument])

      const toggleRow = React.useCallback((row) => {
        setExpanded((previous) => toggleSet(previous, row.key))
      }, [])

      const onEnterPM = React.useCallback(() => {
        if (!project) return
        enterAction.run(() => actions.enterPM({
          root: project.root,
          workspaceId: project.workspaceId,
          snapshot: norm,
        }))
      }, [project, norm, enterAction.run, actions])

      const onInit = React.useCallback(() => {
        if (!project) return
        initAction.run(() => actions.initProject(project.root))
      }, [project, initAction.run, actions])

      const onRefresh = React.useCallback(() => {
        hub.refreshProjects(true)
        if (root) hub.refreshSnapshot(root, true)
      }, [hub, root])

      const pendingCount = norm.pendingDecisions.length || (project ? project.pendingDecisions || 0 : 0)
      const stageRecord = currentStage(norm.stages, norm.project && norm.project.stage)
      const headTitle = project ? projectDisplayName(project) : t('panel.title')
      const lang = uiLang(runtime)

      const header = h('header', { className: 'wb-header' },
        h('div', { className: 'wb-title-block' },
          h('h1', { className: 'wb-title' }, headTitle || t('panel.title')),
          h('p', { className: 'wb-subtitle' }, t('panel.subtitle')),
        ),
        h('div', { className: 'wb-controls' },
          projects.length > 1
            ? h('label', { className: 'wb-filter' },
                h('span', { className: 'wb-sr-only' }, t('panel.switchProject')),
                h('select', {
                  className: 'wb-select',
                  value: state.selectedRoot || defaultRoot || '',
                  'aria-label': t('panel.switchProject'),
                  onChange: (event) => {
                    setSelected(null)
                    setDocState({ id: null, version: null, phase: 'idle', data: null, error: null })
                    hub.selectProject(event.target.value)
                  },
                }, projectChoices(projects).map((item) => h('option', { key: item.root, value: item.root },
                  projectDisplayName(item) + (item.initialized ? '' : ' · ' + t('panel.notInitialized')),
                ))),
              )
            : null,
          project
            ? h(Badge, { tone: 'busy', title: t('panel.header.stage') }, stageLabel(stageRecord) || (norm.project && norm.project.stage) || '—')
            : null,
          project && norm.project
            ? h(Badge, { tone: toneOfStatus((norm.project.health && typeof norm.project.health === 'object') ? norm.project.health.status : norm.project.health) },
                t('panel.header.health') + ': ' + healthLabel(norm.project.health, t))
            : null,
          norm.project && norm.project.period ? h(Badge, null, t('panel.header.period') + ': ' + truncate(norm.project.period, 40)) : null,
          pendingCount > 0 ? h(Badge, { tone: 'warn' }, t('panel.header.pending') + ' ' + String(pendingCount)) : null,
          entry && entry.phase === 'loading' ? h(Spinner) : null,
          h('button', { type: 'button', className: 'wb-btn', 'data-variant': 'ghost', onClick: onRefresh, title: t('panel.refresh') },
            h(RefreshIcon), h('span', null, t('panel.refresh'))),
          live
            ? h('button', {
                type: 'button', className: 'wb-btn', 'data-variant': 'primary',
                onClick: onEnterPM, disabled: enterAction.busy,
                title: t('panel.header.enterPM'),
              }, enterAction.busy ? h(Spinner) : null, t(enterAction.busy ? 'panel.header.enterPMBusy' : 'panel.header.enterPM'))
            : project
              ? h('button', {
                  type: 'button', className: 'wb-btn', 'data-variant': 'primary',
                  onClick: onInit, disabled: initAction.busy,
                }, initAction.busy ? h(Spinner) : null, t(initAction.busy ? 'panel.init.busy' : 'panel.init.action'))
              : null,
        ),
      )

      const body = (() => {
        if (state.projects.phase === 'loading' && projects.length === 0) {
          return h(LoadingRow, { label: t('panel.loading') })
        }
        if (state.projects.phase === 'error' && projects.length === 0) {
          return h('div', { className: 'wb-stack', style: { padding: '24px 20px' } },
            h(ErrorBanner, { t, error: state.projects.error, title: t('panel.errorProjects'), onRetry: () => hub.refreshProjects(true) }))
        }
        if (projects.length === 0) {
          return h(EmptyState, { title: t('panel.emptyProjects') })
        }
        if (!project) return h(LoadingRow, { label: t('panel.loading') })
        if (!project.exists) {
          return h('div', { className: 'wb-init' },
            h('div', { className: 'wb-init-icon' }, h(ProjectIcon, { size: 22 })),
            h('h2', null, projectDisplayName(project)),
            h('p', null, t('panel.workspaceMissing')),
          )
        }
        if (!project.initialized) {
          return h('div', { className: 'wb-init' },
            h('div', { className: 'wb-init-icon' }, h(ProjectIcon, { size: 22 })),
            h('h2', null, t('panel.init.title')),
            h('p', null, t('panel.init.description')),
            h('div', { className: 'wb-controls' },
              h('button', {
                type: 'button', className: 'wb-btn', 'data-variant': 'primary',
                onClick: onInit, disabled: initAction.busy,
              }, initAction.busy ? h(Spinner) : null, t(initAction.busy ? 'panel.init.busy' : 'panel.init.action')),
            ),
            initAction.error ? h(ErrorBanner, { t, error: initAction.error, title: t('panel.init.error') }) : null,
            initAction.ok ? h(Notice, { tone: 'ok' }, t('panel.init.success')) : null,
          )
        }
        const loadingFirst = entry && entry.phase === 'loading' && !entry.data
        const failedFirst = entry && entry.phase === 'error' && !entry.data
        if (loadingFirst) return h(LoadingRow, { label: t('panel.loadingSnapshot') })
        if (failedFirst) {
          return h('div', { className: 'wb-stack', style: { padding: '24px 20px' } },
            h(ErrorBanner, { t, error: entry.error, title: t('panel.errorSnapshot'), onRetry: () => hub.refreshSnapshot(root, true) }))
        }
        const connection = state.roots[root]
        const disconnected = connection && (connection.status === 'error' || connection.status === 'unsupported')
        const staleError = entry && entry.error && entry.data
        const degradedBanner = disconnected || staleError || norm.degraded
          ? h('div', { className: 'wb-banner', 'data-tone': 'warn' },
              h('span', { className: 'wb-banner-grow' }, t('panel.header.degraded')),
              h('button', {
                type: 'button', className: 'wb-btn', 'data-size': 'sm',
                onClick: () => {
                  hub.refreshSnapshot(root, true)
                  hub.reconnect(root)
                },
              }, t('panel.header.reconnect')))
          : null
        const activeTab = (() => {
          if (tab === 'sessions') {
            return h(SessionsTab, { t, runtime, norm, treeData, maps, selected, onOpenDocument: openDocument, project, root, lang })
          }
          if (tab === 'documents') {
            return h(DocumentsTab, {
              t, norm, treeData, maps, selected, docState, loadDoc, lang,
              onBackToList: () => setDocState({ id: null, version: null, phase: 'idle', data: null, error: null }),
            })
          }
          if (tab === 'decisions') {
            return h(DecisionsTab, { t, actions, hub, runtime, norm, treeData, maps, selected, root, project, lang })
          }
          if (tab === 'timeline') {
            return h(TimelineTab, { t, actions, hub, norm, treeData, maps, root, selected, lang })
          }
          return h(OverviewTab, {
            t, hub, runtime, norm, treeData, maps, rows, selected, setSelected, setTab, project, root, lang,
            onEnterPM, enterBusy: enterAction.busy, enterError: enterAction.error,
            onOpenDocument: openDocument, onSelectRow: selectRow, pendingCount,
          })
        })()
        return h(Fragment, null,
          degradedBanner,
          h('div', { className: 'wb-cockpit' },
            h('aside', { className: 'wb-tree-pane' },
              h('div', { className: 'wb-tree-head' },
                h('span', { className: 'wb-tree-title' }, t('tree.title')),
                norm.truncated ? h('span', { className: 'wb-muted', title: t('tree.truncated') }, '…') : null,
              ),
              h('div', { className: 'wb-tree-scroll', role: 'tree', 'aria-label': t('tree.label') },
                rows.length === 0
                  ? h(EmptyState, { title: t('tree.empty') })
                  : rows.map((row) => h(TreeRow, {
                      key: row.key, row, t, selected, lang,
                      onSelect: selectRow, onToggle: toggleRow,
                    })),
              ),
              h('div', { className: 'wb-tree-footer' },
                h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setTab('timeline') }, t('tabs.timeline')),
                h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setTab('decisions') },
                  t('decisions.title') + (pendingCount > 0 ? ' (' + String(pendingCount) + ')' : '')),
              ),
            ),
            h('section', { className: 'wb-detail' },
              h('div', { className: 'wb-tabs', role: 'tablist', 'aria-label': t('panel.title') },
                TABS.map((item) => h('button', {
                  key: item.id, type: 'button', role: 'tab',
                  className: 'wb-tab', 'data-active': tab === item.id ? 'true' : 'false',
                  'aria-selected': tab === item.id,
                  onClick: () => setTab(item.id),
                }, t(item.label),
                  item.id === 'decisions' && pendingCount > 0 ? h('span', { className: 'wb-tab-count' }, String(pendingCount)) : null,
                )),
              ),
              h('div', { className: 'wb-detail-scroll' }, activeTab),
            ),
          ),
          enterAction.error ? h(ErrorBanner, { t, error: enterAction.error, title: t('panel.header.enterPMError') }) : null,
        )
      })()

      return h('div', { className: 'wb-root' }, header, body)
    }

    /** Compact "T3 · S1 · D2" count summary for a slice row. */
    function countsSummary(counts) {
      const source = counts || {}
      const parts = []
      if (source.tasks) parts.push('T' + source.tasks)
      if (source.sessions) parts.push('S' + source.sessions)
      if (source.documents) parts.push('D' + source.documents)
      if (source.decisions) parts.push('Q' + source.decisions)
      if (source.evidence) parts.push('E' + source.evidence)
      return parts.join(' · ')
    }

    function TreeRow(props) {
      const { t, row, selected, lang } = props
      const isSelected = !!selected && selected.key === row.key
      const indent = { paddingLeft: String(4 + row.depth * 14) + 'px' }
      const chevron = row.expandable
        ? h('button', {
            type: 'button', className: 'wb-tree-chevron',
            'aria-label': row.expanded ? t('tree.collapse') : t('tree.expand'),
            'aria-expanded': row.expanded,
            onClick: (event) => {
              event.stopPropagation()
              props.onToggle(row)
            },
          }, h(Chevron, { open: row.expanded }))
        : h('span', { className: 'wb-tree-chevron', 'aria-hidden': 'true' })
      const labelStyle = {
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        border: 0, background: 'transparent', color: 'inherit', font: 'inherit', padding: 0,
        textAlign: 'left', cursor: 'pointer',
      }
      let label = ''
      let meta = null
      if (row.kind === 'stage') {
        label = stageLabel(row.stage)
        meta = h('span', { className: 'wb-tree-meta' },
          row.stage.gate ? h(Badge, null, t('tree.stageGate', { gate: row.stage.gate })) : null,
          h(StatusBadge, { t, status: row.stage.status }),
          h('span', { className: 'wb-tree-count' }, String(row.count)),
        )
      } else if (row.kind === 'slice') {
        label = row.slice.title || row.slice.key || row.slice.id
        meta = h('span', { className: 'wb-tree-meta' },
          row.slice.ownerRole ? h(Badge, null, row.slice.ownerRole) : null,
          h(StatusBadge, { t, status: row.slice.status }),
          countsSummary(row.counts) ? h('span', { className: 'wb-tree-count' }, countsSummary(row.counts)) : null,
        )
      } else if (row.kind === 'group') {
        const group = TREE_GROUPS.find((item) => item.key === row.group)
        label = t(group ? group.label : row.group)
        meta = h('span', { className: 'wb-tree-count' }, String(row.count))
      } else if (row.kind === 'task') {
        label = row.node.title || row.node.id
        meta = h('span', { className: 'wb-tree-meta' },
          h(StatusBadge, { t, status: row.node.status }),
        )
      } else if (row.kind === 'session') {
        label = row.node.name || row.node.id
        meta = h('span', { className: 'wb-tree-meta' },
          row.node.role ? h(Badge, null, row.node.role) : null,
          h(StatusBadge, { t, status: row.node.status }),
        )
      } else if (row.kind === 'document') {
        label = row.node.title || row.node.logicalKey || row.node.id
        meta = h('span', { className: 'wb-tree-meta' },
          docTypeKey(row.node.type) ? h(Badge, null, docTypeLabel(row.node.type, t)) : null,
          row.node.currentVersion ? h(Badge, { tone: 'success' }, 'v' + String(row.node.currentVersion)) : null,
          h(StatusBadge, { t, status: row.node.status }),
        )
      } else if (row.kind === 'decision') {
        label = row.node.title || row.node.question || row.node.id
        meta = h('span', { className: 'wb-tree-meta' },
          row.node.irreversible ? h(Badge, { tone: 'warn' }, t('decisions.irreversible')) : null,
          h(StatusBadge, { t, status: row.node.status }),
        )
      } else if (row.kind === 'evidence') {
        label = truncate(row.node.resultSummary || row.node.uri || row.node.id, 48)
        meta = h('span', { className: 'wb-tree-meta' },
          row.node.kind ? h(Badge, null, String(row.node.kind)) : null,
        )
      }

      const kindLabel = label

      return h('div', {
        className: 'wb-tree-row',
        'data-kind': row.kind,
        'data-selected': isSelected ? 'true' : 'false',
        role: 'treeitem',
        'aria-level': row.depth + 1,
        'aria-expanded': row.expandable ? row.expanded : undefined,
        style: indent,
        title: kindLabel,
      }, chevron, h('button', {
        type: 'button', className: 'wb-tree-label', style: labelStyle,
        onClick: () => props.onSelect(row),
      }, label), meta)
    }

    /** One timeline row: time, kind, actor, slice, target and an expandable raw payload. */
    function EventRowItem(props) {
      const { t, event, maps, lang } = props
      if (!event) return null
      const slices = (maps && maps.sliceTitles) || new Map()
      const sliceTitle = event.sliceId && slices.has(event.sliceId) ? slices.get(event.sliceId) : ''
      const detail = eventDetail(event)
      return h('li', { className: 'wb-event' },
        h('time', { className: 'wb-event-time', dateTime: event.at || undefined }, formatTime(event.at, lang)),
        h('div', { className: 'wb-event-body' },
          h('div', { className: 'wb-event-main' },
            h('span', { className: 'wb-mono wb-muted' }, '#' + String(event.seq === undefined ? '?' : event.seq)),
            h(Badge, { tone: 'neutral' }, eventLabel(event.kind, t)),
            sliceTitle ? h(Badge, null, sliceTitle) : null,
            eventActor(event, maps) ? h('span', { className: 'wb-secondary' }, eventActor(event, maps)) : null,
          ),
          detail ? h('span', { className: 'wb-event-detail' }, detail) : null,
          props.raw === false
            ? null
            : h('details', null,
                h('summary', { className: 'wb-event-detail' }, t('timeline.raw')),
                h('pre', { className: 'wb-event-raw' }, JSON.stringify(event.payload === undefined ? {} : event.payload, null, 2)),
              ),
        ),
      )
    }

    /** Stage rows with gate and slice progress; a row click selects that stage in the overview. */
    function StageList(props) {
      const { t, norm, treeData, onSelectRow } = props
      const stages = norm.stages.length > 0 ? norm.stages : treeData.stages
      const progress = stageProgress(norm.tree)
      if (stages.length === 0) return h(EmptyState, { title: t('tree.empty') })
      return h('div', null, stages.map((stage) => {
        const key = stage.key || stage.id
        const p = progress.get(key) || { total: 0, active: 0 }
        return h('div', { key: key, className: 'wb-stage-row' },
          h('span', { className: 'wb-stage-key' }, key || '—'),
          h('span', { className: 'wb-stage-name' }, stage.name || ''),
          stage.gate ? h(Badge, null, t('tree.stageGate', { gate: stage.gate })) : null,
          p.total > 0 ? h('span', { className: 'wb-muted' }, String(p.active) + '/' + String(p.total)) : null,
          h(StatusBadge, { t, status: stage.status }),
          onSelectRow
            ? h('button', {
                type: 'button', className: 'wb-btn', 'data-size': 'sm', 'data-variant': 'ghost',
                onClick: () => onSelectRow({ key: 'stage:' + (stage.id || key), kind: 'stage', node: stage, stage, slice: null }),
              }, t('node.detail'))
            : null,
        )
      }))
    }

    /** Project overview + selected-node detail. */
    function OverviewTab(props) {
      const {
        t, runtime, norm, treeData, maps, selected, setSelected, setTab, project, root, lang,
        onEnterPM, enterBusy, enterError, onOpenDocument, onSelectRow, pendingCount,
      } = props
      const counts = projectCounts(norm)
      const pm = findPMSession(norm)
      const slices = maps && maps.sliceTitles ? maps.sliceTitles : new Map()
      const recent = norm.recentTimeline.slice().sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0)).slice(0, 8)
      return h('div', { className: 'wb-stack' },
        enterError ? h(ErrorBanner, { t, error: enterError, title: t('panel.header.enterPMError') }) : null,
        selected ? h(NodeDetail, {
          t, runtime, norm, treeData, maps, selected, setSelected, setTab, language: lang,
          onEnterPM, enterBusy, onOpenDocument, onSelectRow,
        }) : h('p', { className: 'wb-muted' }, t('overview.noSelection')),
        h(SectionCard, {
          title: t('overview.project'),
          subtitle: project ? projectDisplayName(project) : undefined,
          actions: h('button', {
            type: 'button', className: 'wb-btn', 'data-size': 'sm', 'data-variant': 'primary',
            onClick: onEnterPM, disabled: enterBusy,
          }, enterBusy ? h(Spinner) : null, t('panel.header.enterPM')),
        },
          h('div', { className: 'wb-counts' },
            h(CountCard, { value: counts.slices, label: t('overview.counts.slices') }),
            h(CountCard, { value: counts.tasks, label: t('overview.counts.tasks') }),
            h(CountCard, { value: counts.sessions, label: t('overview.counts.sessions') }),
            h(CountCard, { value: counts.documents, label: t('overview.counts.documents') }),
            h(CountCard, { value: counts.pendingDecisions, label: t('overview.counts.pendingDecisions') }),
          ),
          h('hr', { className: 'wb-sep' }),
          h('h4', { className: 'wb-section-title' }, t('overview.stages')),
          h(StageList, { t, norm, treeData, onSelectRow }),
        ),
        h(SectionCard, {
          title: t('overview.pm'),
          actions: pm && pm.dshSessionId
            ? h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: onEnterPM, disabled: enterBusy }, t('sessions.enterPM'))
            : h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', 'data-variant': 'primary', onClick: onEnterPM, disabled: enterBusy }, t('panel.header.createPM')),
        },
          pm
            ? h('dl', { className: 'wb-kv' },
                h(Field, { label: t('node.fields.kind') }, t('sessions.kind.pm')),
                h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: pm.status })),
                h(Field, { label: t('node.fields.provider') }, pm.provider),
                h(Field, { label: t('node.fields.model') }, pm.model),
                h(Field, { label: t('node.fields.created') }, formatFullTime(pm.startedAt, lang)),
              )
            : h(Fragment, null,
                h('p', { className: 'wb-muted' }, t('overview.pmNone')),
                h('p', { className: 'wb-muted' }, t('overview.pmHint')),
              ),
        ),
        h(SectionCard, {
          title: t('overview.pendingInbox'),
          actions: h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setTab('decisions') }, t('tabs.decisions')),
        },
          norm.pendingDecisions.length === 0
            ? h('p', { className: 'wb-muted' }, t('overview.noPending'))
            : h('ul', { className: 'wb-list' }, norm.pendingDecisions.slice(0, 5).map((decision) => h('li', { key: decision.id },
                h('button', {
                  type: 'button', className: 'wb-linkrow',
                  onClick: () => setTab('decisions'),
                },
                  h('span', { className: 'wb-list-main' },
                    h('span', { className: 'wb-list-title' }, decision.title || decision.id),
                    h('span', { className: 'wb-list-sub' }, truncate(decision.question, 120)),
                  ),
                  decision.irreversible ? h(Badge, { tone: 'warn' }, t('decisions.irreversible')) : null,
                  h(Badge, { tone: 'warn' }, t('decisions.pendingBadge')),
                ),
              ))),
        ),
        h(SectionCard, {
          title: t('overview.recent'),
          actions: h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setTab('timeline') }, t('tabs.timeline')),
        },
          recent.length === 0
            ? h('p', { className: 'wb-muted' }, t('timeline.empty'))
            : h('ul', { className: 'wb-events' }, recent.map((event) => h(EventRowItem, {
                key: String(event.seq), t, event, maps, lang, raw: false,
              }))),
        ),
      )
    }

    /** Human label for a selected tree node kind, reusing the shipped view labels. */
    function nodeKindLabel(kind, t) {
      if (kind === 'stage') return t('panel.header.stage')
      if (kind === 'slice') return t('overview.counts.slices')
      if (kind === 'task') return t('overview.counts.tasks')
      if (kind === 'session') return t('overview.counts.sessions')
      if (kind === 'document') return t('overview.counts.documents')
      if (kind === 'decision') return t('tabs.decisions')
      if (kind === 'evidence') return t('tree.section.evidence')
      return kind
    }

    /** Related objects of one slice, grouped for the node detail card. */
    function relatedObjects(treeData, sliceId) {
      const of = (list) => (Array.isArray(list) ? list.filter((item) => item && item.sliceId === sliceId) : [])
      return {
        tasks: of(treeData.tasks),
        sessions: of(treeData.sessions),
        documents: of(treeData.documents),
        decisions: of(treeData.decisions),
        evidence: of(treeData.evidence),
      }
    }

    /** Detail card for the node selected in the tree (or opened from a tab). */
    function NodeDetail(props) {
      const {
        t, norm, treeData, maps, selected, setTab, language, onEnterPM, enterBusy,
        onOpenDocument, onSelectRow, runtime,
      } = props
      if (!selected || !selected.kind) return null
      const kind = selected.kind
      const node = selected.node || {}
      const stage = selected.stage
      const slice = selected.slice
      const sliceId = slice ? slice.id : node.sliceId
      const sliceTitle = sliceId && maps.sliceTitles.get(sliceId) ? maps.sliceTitles.get(sliceId) : ''
      const sessionTitles = maps.sessionTitles || new Map()
      const relatedEvents = norm.recentTimeline
        .filter((event) => (node.id && event.subjectId === node.id) || (sliceId && event.sliceId === sliceId))
        .sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))
        .slice(0, 6)
      const title = node.title || node.name || node.key || node.question || node.id || ''
      const actions = []
      if (kind === 'document' && node.id) {
        actions.push(h('button', {
          type: 'button', className: 'wb-btn', 'data-size': 'sm', 'data-variant': 'primary',
          onClick: () => onOpenDocument(node.id),
        }, t('node.openDoc')))
      }
      if (kind === 'session') {
        if (node.kind === 'pm') {
          actions.push(h('button', {
            type: 'button', className: 'wb-btn', 'data-size': 'sm', 'data-variant': 'primary',
            onClick: onEnterPM, disabled: enterBusy,
          }, t('sessions.enterPM')))
        } else if (node.dshSessionId && runtime) {
          actions.push(h('button', {
            type: 'button', className: 'wb-btn', 'data-size': 'sm',
            title: t('sessions.openHint'),
            onClick: () => runtime.openSession(node.dshSessionId),
          }, t('node.openSession')))
        }
        if (node.handoffId) {
          const handoff = findDocumentById(norm.tree, node.handoffId)
          if (handoff) {
            actions.push(h('button', {
              type: 'button', className: 'wb-btn', 'data-size': 'sm',
              onClick: () => onOpenDocument(handoff.id),
            }, t('sessions.handoff')))
          }
        }
      }
      if (kind === 'decision') {
        actions.push(h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setTab('decisions') }, t('decisions.title')))
      }
      if (kind === 'stage' && onSelectRow) {
        actions.push(h('button', {
          type: 'button', className: 'wb-btn', 'data-size': 'sm',
          onClick: () => onSelectRow({ key: 'stage:' + (stage.id || stage.key), kind: 'stage', node: stage, stage, slice: null }),
        }, t('node.detail')))
      }

      let fields = null
      if (kind === 'stage' && stage) {
        fields = h('dl', { className: 'wb-kv' },
          h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, stage.id)),
          h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: stage.status })),
          h(Field, { label: 'gate' }, stage.gate || '—'),
          h(Field, { label: t('node.fields.started') }, formatFullTime(stage.startedAt, language)),
          h(Field, { label: t('node.fields.ended') }, formatFullTime(stage.endedAt, language)),
        )
      } else if (kind === 'slice' && slice) {
        fields = h(Fragment, null,
          h('dl', { className: 'wb-kv' },
            h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, slice.id)),
            h(Field, { label: t('node.fields.type') }, slice.type),
            h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: slice.status })),
            h(Field, { label: t('node.fields.ownerRole') }, slice.ownerRole),
            h(Field, { label: t('node.fields.ownerSession') }, slice.ownerSession ? (sessionTitles.get(slice.ownerSession) || slice.ownerSession) : ''),
            h(Field, { label: t('node.fields.acceptance') }, slice.acceptance ? JSON.stringify(slice.acceptance) : ''),
            h(Field, { label: t('node.fields.handoff') }, slice.currentHandoff),
            h(Field, { label: t('node.fields.updated') }, formatFullTime(slice.updatedAt, language)),
          ),
          h('hr', { className: 'wb-sep' }),
          h('h4', { className: 'wb-section-title' }, t('node.children')),
          renderRelated({
            t, treeData, sliceId, slice: selected.slice, stage: selected.stage,
            related: relatedObjects(treeData, sliceId), onOpenDocument, onSelectRow, setTab, maps, language,
          }),
        )
      } else if (kind === 'task' && node) {
        fields = h('dl', { className: 'wb-kv' },
          h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, node.id)),
          h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: node.status })),
          h(Field, { label: t('sessions.slice') }, sliceTitle || sliceId),
          h(Field, { label: t('node.fields.ownerSession') }, node.assigneeSession ? (sessionTitles.get(node.assigneeSession) || node.assigneeSession) : ''),
          h(Field, { label: t('node.fields.acceptance') }, node.acceptance ? JSON.stringify(node.acceptance) : ''),
          h(Field, { label: t('node.fields.created') }, formatFullTime(node.createdAt, language)),
          h(Field, { label: t('node.fields.updated') }, formatFullTime(node.updatedAt, language)),
        )
      } else if (kind === 'session' && node) {
        fields = h('dl', { className: 'wb-kv' },
          h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, node.id)),
          h(Field, { label: t('node.fields.kind') }, t(sessionKindKey(node.kind))),
          h(Field, { label: t('node.fields.role') }, node.role),
          h(Field, { label: t('sessions.slice') }, sliceTitle || sliceId),
          h(Field, { label: t('node.fields.provider') }, node.provider),
          h(Field, { label: t('node.fields.model') }, node.model),
          h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: node.status })),
          h(Field, { label: t('node.fields.started') }, formatFullTime(node.startedAt, language)),
          h(Field, { label: t('node.fields.ended') }, formatFullTime(node.endedAt, language)),
          h(Field, { label: t('node.fields.dshSession') }, node.dshSessionId ? h('span', { className: 'wb-mono' }, node.dshSessionId) : t('sessions.noDshSession')),
        )
      } else if (kind === 'document' && node) {
        fields = h('dl', { className: 'wb-kv' },
          h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, node.id)),
          h(Field, { label: t('node.fields.type') }, docTypeLabel(node.type, t)),
          h(Field, { label: t('node.fields.logicalKey') }, h('span', { className: 'wb-mono' }, node.logicalKey)),
          h(Field, { label: t('sessions.slice') }, sliceTitle || sliceId),
          h(Field, { label: t('node.fields.currentVersion') }, 'v' + String(node.currentVersion === undefined ? 0 : node.currentVersion)),
          h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: node.status })),
          h(Field, { label: t('node.fields.ownerSession') }, node.ownerSession ? (sessionTitles.get(node.ownerSession) || node.ownerSession) : ''),
          h(Field, { label: t('node.fields.updated') }, formatFullTime(node.updatedAt, language)),
        )
      } else if (kind === 'decision' && node) {
        fields = h(Fragment, null,
          h('dl', { className: 'wb-kv' },
            h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, node.id)),
            h(Field, { label: t('decisions.kind.decision') }, node.kind === 'gate' ? t('decisions.kind.gate') : t('decisions.kind.decision')),
            h(Field, { label: t('node.fields.status') }, h(StatusBadge, { t, status: node.status })),
            h(Field, { label: t('node.fields.irreversible') }, node.irreversible ? t('common.yes') : t('common.no')),
            h(Field, { label: t('node.fields.recommended') }, node.recommended),
            h(Field, { label: t('node.fields.consequences') }, node.consequences),
            h(Field, { label: t('decisions.resolvedBy') }, node.decidedBy),
            h(Field, { label: t('decisions.decidedAt') }, formatFullTime(node.decidedAt, language)),
            h(Field, { label: t('node.fields.created') }, formatFullTime(node.createdAt, language)),
          ),
          h('hr', { className: 'wb-sep' }),
          h('p', { className: 'wb-decision-question' }, node.question || ''),
        )
      } else if (kind === 'evidence' && node) {
        fields = h('dl', { className: 'wb-kv' },
          h(Field, { label: t('node.fields.id') }, h('span', { className: 'wb-mono' }, node.id)),
          h(Field, { label: t('node.fields.kind') }, node.kind),
          h(Field, { label: t('sessions.slice') }, sliceTitle || sliceId),
          h(Field, { label: t('node.fields.uri') }, node.uri),
          h(Field, { label: t('node.fields.command') }, node.command ? h('span', { className: 'wb-mono' }, node.command) : ''),
          h(Field, { label: t('node.fields.result') }, node.resultSummary),
          h(Field, { label: t('node.fields.hash') }, node.contentHash ? h('span', { className: 'wb-mono' }, node.contentHash) : ''),
          h(Field, { label: t('node.fields.created') }, formatFullTime(node.createdAt, language)),
        )
      }

      return h(SectionCard, {
        title: t('node.detail'),
        subtitle: nodeKindLabel(kind, t) + (title ? ' · ' + truncate(title, 80) : ''),
        actions: actions.length > 0 ? actions : null,
      },
        fields,
        relatedEvents.length > 0
          ? h(Fragment, null,
              h('hr', { className: 'wb-sep' }),
              h('h4', { className: 'wb-section-title' }, t('timeline.title')),
              h('ul', { className: 'wb-events' }, relatedEvents.map((event) => h(EventRowItem, {
                key: String(event.seq), t, event, maps, lang: language, raw: false,
              }))),
            )
          : null,
      )
    }

    /** Compact related-object sections used by the slice node detail. */
    function renderRelated(props) {
      const { t, related, onOpenDocument, onSelectRow, setTab, maps } = props
      const groups = [
        { key: 'tasks', label: 'tree.section.tasks', kind: 'task' },
        { key: 'sessions', label: 'tree.section.sessions', kind: 'session' },
        { key: 'documents', label: 'tree.section.documents', kind: 'document' },
        { key: 'decisions', label: 'tree.section.decisions', kind: 'decision' },
        { key: 'evidence', label: 'tree.section.evidence', kind: 'evidence' },
      ]
      const sections = groups
        .map((group) => ({ group, items: related[group.key] || [] }))
        .filter((entry) => entry.items.length > 0)
      if (sections.length === 0) return h('p', { className: 'wb-muted' }, t('node.noChildren'))
      const sessionTitles = (maps && maps.sessionTitles) || new Map()
      return h('div', { className: 'wb-stack' }, sections.map(({ group, items }) => h('div', { key: group.key },
        h('h4', { className: 'wb-section-title' }, t(group.label) + ' (' + String(items.length) + ')'),
        h('ul', { className: 'wb-list' }, items.slice(0, 12).map((item) => {
          const label = item.title || item.name || item.resultSummary || item.logicalKey || item.id
          const sub = group.kind === 'session'
            ? [item.role, item.model, item.status].filter(Boolean).join(' · ')
            : group.kind === 'document'
              ? [docTypeLabel(item.type, t), 'v' + String(item.currentVersion === undefined ? 0 : item.currentVersion), item.status].filter(Boolean).join(' · ')
              : [item.status, item.kind].filter(Boolean).join(' · ')
          const onClick = () => {
            if (group.kind === 'document') onOpenDocument(item.id)
            else if (group.kind === 'decision') setTab('decisions')
            else if (group.kind === 'session') setTab('sessions')
            else onSelectRow({
              key: group.kind + ':' + item.id, kind: group.kind, node: item,
              slice: props.slice, stage: props.stage, group: group.key,
            })
          }
          return h('li', { key: item.id }, h('button', { type: 'button', className: 'wb-linkrow', onClick },
            h('span', { className: 'wb-list-main' },
              h('span', { className: 'wb-list-title' }, truncate(label, 90)),
              sub ? h('span', { className: 'wb-list-sub' }, sub) : null,
            ),
          ))
        })),
      )))
    }

    /** Read-only session roster (Team transcript is deliberately deferred by the UI architecture). */
    function SessionsTab(props) {
      const { t, runtime, norm, treeData, maps, selected, onOpenDocument, project, lang } = props
      const [sliceOnly, setSliceOnly] = React.useState(true)
      const selectedSliceId = selected && selected.slice
        ? selected.slice.id
        : selected && selected.node && selected.node.sliceId
          ? selected.node.sliceId
          : undefined
      const filterId = sliceOnly && selectedSliceId ? selectedSliceId : undefined
      const all = norm.sessions.length > 0 ? norm.sessions : treeData.sessions
      const rows = sortSessions(all.filter((row) => !filterId || row.sliceId === filterId))
      const sliceTitles = (maps && maps.sliceTitles) || new Map()
      const pm = findPMSession(norm)
      const openRow = (row) => {
        if (!row || !row.dshSessionId) return
        if (row.kind === 'pm' || row.kind === 'task') runtime.openSession(row.dshSessionId)
      }
      return h('div', { className: 'wb-stack' },
        h('div', { className: 'wb-banner' },
          h('span', { className: 'wb-banner-grow' },
            t('sessions.readonlyNotice') + ' ' + t('sessions.teamDeferred')),
          h('button', {
            type: 'button', className: 'wb-btn', 'data-size': 'sm',
            onClick: () => pm && pm.dshSessionId ? runtime.openSession(pm.dshSessionId) : undefined,
            disabled: !pm || !pm.dshSessionId,
          }, t('sessions.enterPM')),
        ),
        h('div', { className: 'wb-filters' },
          filterId
            ? h(Fragment, null,
                h('span', { className: 'wb-muted' }, t('sessions.filterSlice', { slice: sliceTitles.get(filterId) || filterId })),
                h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setSliceOnly(false) }, t('sessions.allSlices')),
              )
            : selectedSliceId
              ? h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setSliceOnly(true) }, t('sessions.filterSlice', { slice: sliceTitles.get(selectedSliceId) || selectedSliceId }))
              : null,
          h('span', { className: 'wb-muted' }, t('sessions.emptyHint')),
        ),
        rows.length === 0
          ? h(EmptyState, { title: filterId ? t('sessions.emptySlice') : t('sessions.empty') })
          : h('ul', { className: 'wb-list' }, rows.map((row) => {
              const isPm = row.kind === 'pm'
              const handoff = row.handoffId ? findDocumentById(norm.tree, row.handoffId) : undefined
              const started = row.startedAt ? formatTime(row.startedAt, lang) : ''
              return h('li', { key: row.id, className: 'wb-list-row' },
                h('div', { className: 'wb-list-main' },
                  h('span', { className: 'wb-list-title' },
                    row.name || row.id,
                    ' ',
                    h(Badge, { tone: isPm ? 'busy' : 'neutral' }, t(sessionKindKey(row.kind))),
                    row.role ? h(Badge, null, row.role) : null,
                  ),
                  h('span', { className: 'wb-list-sub' },
                    [
                      row.sliceId ? (sliceTitles.get(row.sliceId) || row.sliceId) : '',
                      row.provider || row.model ? [row.provider, row.model].filter(Boolean).join('/') : '',
                      statusLabel(row.status, t),
                      started ? t('sessions.started', { time: started }) : '',
                    ].filter(Boolean).join(' · '),
                  ),
                  h('span', { className: 'wb-list-sub' },
                    row.dshSessionId ? h('span', { className: 'wb-mono' }, row.dshSessionId) : t('sessions.noDshSession'),
                  ),
                ),
                h('div', { className: 'wb-list-actions' },
                  row.dshSessionId
                    ? h('button', {
                        type: 'button', className: 'wb-btn', 'data-size': 'sm',
                        title: t('sessions.openHint'),
                        onClick: () => openRow(row),
                      }, isPm ? t('sessions.enterPM') : t('sessions.open'))
                    : null,
                  handoff
                    ? h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => onOpenDocument(handoff.id) }, t('sessions.handoff'))
                    : null,
                ),
              )
            })),
      )
    }

    /** Render parsed DB document blocks without HTML injection. */
    function DocumentBody(props) {
      const blocks = props.blocks || []
      return h('div', { className: 'wb-doc-body' }, blocks.map((block, index) => {
        if (block.type === 'hr') return h('hr', { key: index, className: 'wb-doc-block', 'data-type': 'hr' })
        return h('p', {
          key: index,
          className: 'wb-doc-block',
          'data-type': block.type,
        }, block.text === '' ? '\u00a0' : block.text)
      }))
    }

    /** Documents list + DB-only preview with read-only version switching. */
    function DocumentsTab(props) {
      const { t, norm, treeData, maps, selected, docState, loadDoc, lang, onBackToList, filterSelected } = props
      const [sliceOnly, setSliceOnly] = React.useState(true)
      const selectedSliceId = selected && selected.slice
        ? selected.slice.id
        : selected && selected.node && selected.node.sliceId
          ? selected.node.sliceId
          : undefined
      const filterId = filterSelected === false ? undefined : (sliceOnly && selectedSliceId ? selectedSliceId : undefined)
      const sliceTitles = (maps && maps.sliceTitles) || new Map()
      const docs = treeData.documents
        .filter((doc) => !filterId || doc.sliceId === filterId)
        .slice()
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))

      if (docState && docState.id && docState.phase !== 'idle') {
        return h(DocumentPreview, { t, docState, loadDoc, onBackToList, lang })
      }
      return h('div', { className: 'wb-stack' },
        h('div', { className: 'wb-doc-filter' },
          filterId
            ? h(Fragment, null,
                h('span', { className: 'wb-muted' }, t('documents.filterSlice', { slice: sliceTitles.get(filterId) || filterId })),
                h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setSliceOnly(false) }, t('documents.filterClear')),
              )
            : selectedSliceId
              ? h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: () => setSliceOnly(true) }, t('documents.filterSlice', { slice: sliceTitles.get(selectedSliceId) || selectedSliceId }))
              : null,
          h('span', { className: 'wb-muted' }, t('documents.select')),
        ),
        docs.length === 0
          ? h(EmptyState, { title: filterId ? t('documents.emptySlice') : t('documents.empty') })
          : h('ul', { className: 'wb-list' }, docs.map((doc) => h('li', { key: doc.id, className: 'wb-list-row' },
              h('button', {
                type: 'button', className: 'wb-linkrow',
                onClick: () => loadDoc(doc.id),
              },
                h('span', { className: 'wb-list-main' },
                  h('span', { className: 'wb-list-title' }, doc.title || doc.logicalKey || doc.id),
                  h('span', { className: 'wb-list-sub' },
                    [
                      docTypeLabel(doc.type, t),
                      doc.sliceId ? (sliceTitles.get(doc.sliceId) || doc.sliceId) : '',
                      'v' + String(doc.currentVersion === undefined ? 0 : doc.currentVersion),
                      statusLabel(doc.status, t),
                    ].filter(Boolean).join(' · '),
                  ),
                ),
                doc.status === 'frozen' ? h(Badge, { tone: 'success' }, t('documents.frozen')) : null,
              ),
            ))),
      )
    }

    /** DB document preview: metadata, version switcher, safe block rendering. */
    function DocumentPreview(props) {
      const { t, docState, loadDoc, onBackToList, lang } = props
      const data = docState.data || {}
      const doc = data.doc || {}
      const versions = Array.isArray(data.versions) ? data.versions : []
      const version = data.version !== undefined ? data.version : docState.version
      const frozen = data.frozen === true || doc.status === 'frozen'
      const blocks = React.useMemo(() => parseDocContent(data.content), [data.content])
      return h('div', { className: 'wb-stack' },
        h('div', { className: 'wb-controls' },
          h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: onBackToList },
            h(BackIcon), h('span', null, t('documents.back'))),
          h('span', { className: 'wb-muted' }, t('documents.title')),
        ),
        h('section', { className: 'wb-doc-preview' },
          h('div', { className: 'wb-doc-header' },
            h('h3', { className: 'wb-card-title' }, doc.title || doc.logicalKey || String(docState.id || '')),
            h('span', { className: 'wb-badges' },
              h(Badge, null, docTypeLabel(doc.type, t)),
              h(Badge, { tone: frozen ? 'success' : 'warn' }, frozen ? t('documents.frozen') : t('documents.version', { version: String(version === undefined ? 0 : version) })),
              h(StatusBadge, { t, status: doc.status }),
            ),
          ),
          h('div', { className: 'wb-doc-meta' },
            h('span', null, t('node.fields.logicalKey') + ': ' + String(doc.logicalKey || '—')),
            h('span', null, t('documents.author') + ': ' + String(doc.ownerSession || '—')),
            h('span', null, t('documents.created') + ': ' + (formatFullTime(doc.updatedAt || doc.createdAt, lang) || '—')),
          ),
          versions.length > 0
            ? h('div', { className: 'wb-doc-filter' },
                h('label', { className: 'wb-filter' },
                  h('span', null, t('documents.versionLabel')),
                  h('select', {
                    className: 'wb-select',
                    'aria-label': t('documents.versionSelect'),
                    value: String(version === undefined ? '' : version),
                    onChange: (event) => {
                      const next = Number(event.target.value)
                      loadDoc(docState.id, Number.isFinite(next) ? next : undefined)
                    },
                  }, versions.map((item) => h('option', { key: String(item.version), value: String(item.version) },
                    'v' + String(item.version)
                      + (item.frozen ? ' · ' + t('documents.frozen') : '')
                      + (item.createdAt ? ' · ' + formatTime(item.createdAt, lang) : ''),
                  ))),
                ),
                h('span', { className: 'wb-muted' }, t('documents.versionSelect')),
              )
            : null,
          docState.phase === 'loading'
            ? h(LoadingRow, { label: t('documents.loading') })
            : docState.phase === 'error'
              ? h(ErrorBanner, {
                  t, error: docState.error, title: t('documents.error'),
                  onRetry: () => loadDoc(docState.id, docState.version),
                })
              : blocks.length === 1 && blocks[0].type === 'p' && blocks[0].text === ''
                ? h('p', { className: 'wb-muted' }, t('documents.noContent'))
                : h(DocumentBody, { blocks }),
        ),
      )
    }

    /** One pending decision card: question, options, recommendation, consequences, human actions. */
    function DecisionCard(props) {
      const { t, decision, onApprove, onReject, lang, sliceTitle } = props
      const options = decisionOptions(decision)
      return h('article', { className: 'wb-decision', 'data-irreversible': decision.irreversible ? 'true' : 'false' },
        h('div', { className: 'wb-decision-title' },
          h('span', null, decision.title || decision.id),
          h(Badge, { tone: decision.kind === 'gate' ? 'busy' : 'neutral' },
            decision.kind === 'gate' ? t('decisions.kind.gate') : t('decisions.kind.decision')),
          decision.gate ? h(Badge, null, t('decisions.gate', { gate: decision.gate })) : null,
          sliceTitle ? h(Badge, null, sliceTitle) : null,
          decision.irreversible ? h(Badge, { tone: 'warn' }, t('decisions.irreversible')) : null,
          h(StatusBadge, { t, status: decision.status }),
        ),
        decision.question ? h('p', { className: 'wb-decision-question' }, decision.question) : null,
        options.length > 0
          ? h('ul', { className: 'wb-options' }, options.map((option) => h('li', {
              key: option.value,
              className: 'wb-option',
              'data-recommended': isRecommendedOption(option, decision.recommended) ? 'true' : 'false',
            },
              h('span', { className: 'wb-option-value' }, option.value),
              h('span', { className: 'wb-option-body' },
                h('span', null, option.label),
                option.description ? h('span', { className: 'wb-list-sub' }, option.description) : null,
              ),
              isRecommendedOption(option, decision.recommended) ? h(Badge, { tone: 'busy' }, t('decisions.recommended')) : null,
            )))
          : null,
        decision.recommended && options.length === 0
          ? h('p', { className: 'wb-muted' }, t('decisions.recommended') + ': ' + String(decision.recommended))
          : null,
        decision.consequences
          ? h('p', { className: 'wb-decision-question' }, t('decisions.consequences') + ': ' + String(decision.consequences))
          : null,
        h('div', { className: 'wb-card-actions' },
          h('button', { type: 'button', className: 'wb-btn', 'data-variant': 'primary', onClick: () => onApprove(decision) }, t('decisions.approve')),
          h('button', { type: 'button', className: 'wb-btn', 'data-variant': 'danger', onClick: () => onReject(decision) }, t('decisions.reject')),
          h('span', { className: 'wb-muted' }, formatTime(decision.createdAt, lang)),
        ),
      )
    }

    /** Decision inbox: pending cards with approve/reject (irreversible needs a second confirmation). */
    function DecisionsTab(props) {
      const { t, actions, hub, norm, treeData, maps, selected, root, lang } = props
      const [confirm, setConfirm] = React.useState(null)
      const [rationale, setRationale] = React.useState('')
      const [irreversibleChecked, setIrreversibleChecked] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const sliceTitles = (maps && maps.sliceTitles) || new Map()
      const selectedSliceId = selected && selected.slice
        ? selected.slice.id
        : selected && selected.node && selected.node.sliceId
          ? selected.node.sliceId
          : undefined
      const pending = norm.pendingDecisions.filter((decision) => !selectedSliceId || !decision.sliceId || decision.sliceId === selectedSliceId)
      const allDecisions = treeData.decisions.length > 0 ? treeData.decisions : []
      const resolved = allDecisions
        .filter((decision) => decision.status === 'approved' || decision.status === 'rejected')
        .filter((decision) => !selectedSliceId || !decision.sliceId || decision.sliceId === selectedSliceId)
        .slice()
        .sort((left, right) => String(right.decidedAt || right.createdAt || '').localeCompare(String(left.decidedAt || left.createdAt || '')))

      const startConfirm = (decision, action) => {
        setConfirm({ decision, action })
        setRationale('')
        setIrreversibleChecked(false)
        setFailure(null)
        setNotice(null)
      }
      const closeConfirm = () => {
        if (busy) return
        setConfirm(null)
        setFailure(null)
      }
      const submit = async () => {
        if (!confirm) return
        setBusy(true)
        setFailure(null)
        try {
          await actions.submitDecision({
            root,
            id: confirm.decision.id,
            status: confirm.action,
            rationale: rationale.trim(),
            confirmed: confirm.decision.irreversible ? irreversibleChecked : false,
          })
          setConfirm(null)
          setNotice(t('decisions.success'))
          if (root) hub.refreshSnapshot(root, true)
        } catch (error) {
          const info = errorInfo(error)
          if (info.code === 'CONFIRM_REQUIRED') setFailure({ code: 'CONFIRM_REQUIRED', message: t('decisions.confirmRequired'), status: info.status })
          else setFailure(error)
        } finally {
          setBusy(false)
        }
      }
      const actionLabel = confirm
        ? t(confirm.action === 'approved' ? 'decisions.actionApprove' : 'decisions.actionReject')
        : ''
      const irreversibleBlocked = !!(confirm && confirm.decision.irreversible && !irreversibleChecked)

      const dialog = confirm
        ? h('div', { className: 'wb-overlay', role: 'presentation' },
            h('div', { className: 'wb-modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('decisions.confirmTitle', { action: actionLabel }) },
              h('h3', { className: 'wb-modal-title' }, t('decisions.confirmTitle', { action: actionLabel })),
              h('p', { className: 'wb-modal-desc' },
                (confirm.decision.title || '') + '\n' + (confirm.decision.question || '')),
              h('div', { className: 'wb-modal-body' },
                confirm.decision.irreversible
                  ? h('div', { className: 'wb-warnbox' },
                      h(Dot, { tone: 'warn' }),
                      h('span', null, t(confirm.action === 'approved'
                        ? 'decisions.confirmIrreversible'
                        : 'decisions.confirmIrreversibleReject')),
                    )
                  : null,
                confirm.decision.irreversible
                  ? h('label', { className: 'wb-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: irreversibleChecked,
                        onChange: (event) => setIrreversibleChecked(event.target.checked),
                      }),
                      h('span', null, t('decisions.confirmCheckbox')),
                    )
                  : null,
                h('div', { className: 'wb-field' },
                  h('span', { className: 'wb-field-label' }, t(confirm.action === 'rejected' ? 'decisions.rationaleReject' : 'decisions.rationale')),
                  h('textarea', {
                    className: 'wb-textarea',
                    value: rationale,
                    onChange: (event) => setRationale(event.target.value),
                    disabled: busy,
                  }),
                ),
                failure ? h(ErrorBanner, { t, error: failure }) : null,
              ),
              h('div', { className: 'wb-modal-footer' },
                h('button', { type: 'button', className: 'wb-btn', onClick: closeConfirm, disabled: busy }, t('decisions.cancel')),
                h('button', {
                  type: 'button',
                  className: 'wb-btn',
                  'data-variant': confirm.action === 'approved' ? 'primary' : 'danger',
                  onClick: submit,
                  disabled: busy || irreversibleBlocked,
                }, busy ? h(Spinner) : null,
                  t(busy ? 'decisions.submitting' : confirm.action === 'approved' ? 'decisions.confirmApprove' : 'decisions.confirmReject')),
              ),
            ),
          )
        : null

      return h('div', { className: 'wb-stack' },
        h('div', { className: 'wb-card-head' },
          h('h3', { className: 'wb-card-title' }, t('decisions.title')),
          h('span', { className: 'wb-muted' }, t('decisions.pending') + ' ' + String(pending.length)),
        ),
        notice ? h(Notice, { tone: 'ok' }, notice) : null,
        h('p', { className: 'wb-muted' }, t('decisions.emptyHint')),
        h('h4', { className: 'wb-section-title' }, t('decisions.pending') + ' (' + String(pending.length) + ')'),
        pending.length === 0
          ? h(EmptyState, { title: t('decisions.empty') })
          : h('div', { className: 'wb-stack' }, pending.map((decision) => h(DecisionCard, {
              key: decision.id, t, decision, lang,
              sliceTitle: decision.sliceTitle || (decision.sliceId ? sliceTitles.get(decision.sliceId) : undefined),
              onApprove: (item) => startConfirm(item, 'approved'),
              onReject: (item) => startConfirm(item, 'rejected'),
            }))),
        h('hr', { className: 'wb-sep' }),
        h('h4', { className: 'wb-section-title' }, t('decisions.resolved') + ' (' + String(resolved.length) + ')'),
        resolved.length === 0
          ? h(EmptyState, { title: t('decisions.emptyResolved') })
          : h('ul', { className: 'wb-list' }, resolved.map((decision) => h('li', { key: decision.id, className: 'wb-list-row' },
              h('div', { className: 'wb-list-main' },
                h('span', { className: 'wb-list-title' }, decision.title || decision.id),
                h('span', { className: 'wb-list-sub' },
                  [
                    decision.sliceTitle || (decision.sliceId ? sliceTitles.get(decision.sliceId) : ''),
                    decision.decidedBy ? t('decisions.resolvedBy') + ': ' + decision.decidedBy : '',
                    formatTime(decision.decidedAt, lang),
                  ].filter(Boolean).join(' · ')),
              ),
              h(StatusBadge, { t, status: decision.status }),
            ))),
        dialog,
      )
    }

    /** Timeline view with category/role/stage filters and a refresh that appends newer events. */
    function TimelineTab(props) {
      const { t, actions, hub, norm, maps, root, lang } = props
      const [filters, setFilters] = React.useState({ category: 'all', role: 'all', stage: 'all' })
      const [extra, setExtra] = React.useState([])
      const [loading, setLoading] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const events = React.useMemo(() => mergeEvents(norm.recentTimeline, extra), [norm.recentTimeline, extra])
      const filtered = React.useMemo(
        () => filterTimeline(events, filters, { stageBySlice: maps.stageBySlice }),
        [events, filters, maps],
      )
      const ordered = filtered.slice().sort((left, right) => Number(right.seq || 0) - Number(left.seq || 0))
      const roles = timelineRoleOptions(events)
      const stageOptions = timelineStageOptions(norm.stages)
      const refresh = async () => {
        if (!root) return
        setLoading(true)
        setFailure(null)
        try {
          const last = latestEvent(events)
          const after = last ? Number(last.seq) : undefined
          const data = await actions.loadTimeline(root, { after, limit: 200 })
          const fresh = data && Array.isArray(data.events) ? data.events : []
          setExtra((previous) => mergeEvents(previous, fresh))
          hub.refreshSnapshot(root, true)
        } catch (error) {
          setFailure(error)
        } finally {
          setLoading(false)
        }
      }
      const categorySelect = h('label', { className: 'wb-filter' },
        h('span', null, t('timeline.filterKinds')),
        h('select', {
          className: 'wb-select',
          value: filters.category,
          onChange: (event) => setFilters(Object.assign({}, filters, { category: event.target.value })),
        }, [{ value: 'all', label: t('timeline.all') }]
          .concat(EVENT_CATEGORY_ORDER.map((category) => ({ value: category, label: t(EVENT_CATEGORY_LABELS[category]) })))
          .map((option) => h('option', { key: option.value, value: option.value }, option.label))),
      )
      const roleSelect = h('label', { className: 'wb-filter' },
        h('span', null, t('timeline.filterRole')),
        h('select', {
          className: 'wb-select',
          value: filters.role,
          onChange: (event) => setFilters(Object.assign({}, filters, { role: event.target.value })),
        }, [{ value: 'all', label: t('timeline.all') }]
          .concat(roles.map((role) => ({ value: role, label: role })))
          .map((option) => h('option', { key: option.value, value: option.value }, option.label))),
      )
      const stageSelect = h('label', { className: 'wb-filter' },
        h('span', null, t('timeline.filterStage')),
        h('select', {
          className: 'wb-select',
          value: filters.stage,
          onChange: (event) => setFilters(Object.assign({}, filters, { stage: event.target.value })),
        }, [{ value: 'all', label: t('timeline.all') }]
          .concat(stageOptions)
          .map((option) => h('option', { key: option.value, value: option.value }, option.label))),
      )
      const recentEvents = ordered.slice(0, 200)
      return h('div', { className: 'wb-stack' },
        failure ? h(ErrorBanner, { t, error: failure, title: t('timeline.title'), onRetry: refresh }) : null,
        h('div', { className: 'wb-filters' },
          categorySelect,
          roleSelect,
          stageSelect,
          h('button', { type: 'button', className: 'wb-btn', 'data-size': 'sm', onClick: refresh, disabled: loading },
            loading ? h(Spinner) : h(RefreshIcon), h('span', null, t('timeline.refresh'))),
        ),
        h('div', { className: 'wb-timeline-count' },
          t('timeline.count', { count: events.length, shown: recentEvents.length })),
        events.length === 0
          ? h(EmptyState, { title: t('timeline.empty') })
          : recentEvents.length === 0
            ? h(EmptyState, { title: t('timeline.noMatch') })
            : h('ul', { className: 'wb-events' }, recentEvents.map((event) => h(EventRowItem, {
                key: String(event.seq), t, event, maps, lang,
              }))),
      )
    }

    /** Sidebar entry glyph (registered in sidebar.panellist under the panel key). */
    function WorkbenchIcon(props) {
      const size = props && props.size ? props.size : 18
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'currentColor' },
        'aria-hidden': 'true',
      }, h(ProjectIcon, { size }))
    }

    /** PM session header utilities: stage, current slice, pending decision count, back-to-project. */
    function PMSessionBadge(props) {
      const t = pickT(props)
      const { hub, runtime, sessionId } = props
      const context = useSessionProjectContext(hub, runtime, sessionId)
      if (!context.isPM) return null
      const snapshot = context.snapshot
      if (!snapshot) {
        return h('span', { className: 'wb-pm-badge' }, h('span', { className: 'wb-muted' }, t('badge.loading')))
      }
      const stage = currentStage(snapshot.stages, snapshot.project && snapshot.project.stage)
      const slice = currentSliceOf(snapshot, context.pm)
      const pending = snapshot.pendingDecisions.length
      return h('span', { className: 'wb-pm-badge', role: 'group', 'aria-label': t('badge.aria') },
        h(Badge, { tone: 'busy', className: 'wb-badge-label' },
          t('badge.stage', { stage: stageLabel(stage) || String((snapshot.project && snapshot.project.stage) || '—') })),
        slice
          ? h(Badge, { tone: 'neutral', className: 'wb-pm-slice' },
              t('badge.slice', { slice: slice.title || slice.key || '' }))
          : h(Badge, { tone: 'neutral', className: 'wb-pm-slice' }, t('badge.noSlice')),
        pending > 0 ? h(Badge, { tone: 'warn' }, t('badge.pending', { count: pending })) : null,
        h('button', {
          type: 'button', className: 'wb-btn', 'data-size': 'sm',
          title: t('badge.back'),
          onClick: () => runtime.openPanel(),
        }, t('badge.back')),
      )
    }

    /** PM composer dock: one-line project summary (active slices, pending decisions, latest event). */
    function PMComposerSummary(props) {
      const t = pickT(props)
      const { hub, runtime, sessionId } = props
      const context = useSessionProjectContext(hub, runtime, sessionId)
      if (!context.isPM) return null
      const snapshot = context.snapshot
      if (!snapshot) return null
      const counts = projectCounts(snapshot)
      const stage = currentStage(snapshot.stages, snapshot.project && snapshot.project.stage)
      const latest = latestEvent(snapshot.recentTimeline)
      const name = projectDisplayName(context.project || snapshot.project)
      const text = latest
        ? t('composer.summary', {
            name,
            stage: stageLabel(stage) || '—',
            slices: activeSlices(snapshot).length,
            decisions: counts.pendingDecisions,
            event: eventLabel(latest.kind, t),
          })
        : t('composer.summaryShort', {
            name,
            stage: stageLabel(stage) || '—',
            decisions: counts.pendingDecisions,
          })
      return h('button', {
        type: 'button',
        className: 'wb-dock-summary',
        title: text,
        'aria-label': t('composer.aria', { text }),
        onClick: () => runtime.openPanel(),
      }, h(ProjectIcon, { size: 13 }), h('span', { className: 'wb-dock-text' }, text))
    }

    // =============================================================================================
    // Plugin body: dictionaries, one hub/api/runtime per plugin instance, slot registrations.
    // =============================================================================================
    const inject = ['slots', 'locale', 'layout', 'uiWorkspace', 'sessions', 'workspaces']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'workbench: dictionaries')
      const t = ctx.locale.bind(NS)
      const api = createApi()
      const hub = createHub(api)
      const runtime = createRuntime(ctx)
      ctx.effect(() => () => hub.dispose(), 'workbench: dispose hub')

      const actions = {
        ensureProjects: () => hub.ensureProjects(),
        refresh: (root) => {
          hub.refreshProjects(true)
          if (root) hub.refreshSnapshot(root, true)
        },
        initProject: async (root) => {
          const result = await api.init(root)
          hub.refreshProjects(true)
          hub.refreshSnapshot(root, true)
          return result
        },
        enterPM: (options) => enterProjectPM(ctx, api, hub, runtime, options),
        submitDecision: async (payload) => {
          const result = await api.decision(payload)
          if (payload && payload.root) hub.refreshSnapshot(payload.root, true)
          return result
        },
        loadDoc: (root, id, version) => api.doc(root, id, version),
        loadSlice: (root, id) => api.slice(root, id),
        loadTimeline: (root, options) => api.timeline(root, options),
      }

      const injected = () => ({ hub, actions, runtime, fallbackT: t })

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_KEY,
        locale: NS,
        inject: injected,
      }, WorkbenchPanel))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_KEY,
        order: 6,
        locale: NS,
        label: () => t('panel.title'),
      }, WorkbenchIcon))

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'wb-pm-badge',
        order: 6,
        locale: NS,
        inject: (sessionId) => Object.assign(injected(), { sessionId }),
      }, PMSessionBadge))

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'wb-pm-summary',
        order: 10,
        locale: NS,
        inject: (sessionId) => Object.assign(injected(), { sessionId }),
      }, PMComposerSummary))
    }

    // Test seam for node self-tests: pure transforms, dictionaries and the render-only components.
    return {
      inject,
      apply,
      __pure: PURE,
      __dictionaries: { zh: ZH, en: EN },
      __components: {
        WorkbenchPanel, PMSessionBadge, PMComposerSummary, WorkbenchIcon,
        OverviewTab, NodeDetail, StageList, TreeRow, EventRowItem, SessionsTab,
        DocumentsTab, DocumentPreview, DecisionCard, DecisionsTab, TimelineTab,
      },
    }












  },
})
