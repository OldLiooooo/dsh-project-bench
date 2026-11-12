// research/bench/lib.mjs — shared vocabulary + deterministic RNG for the benchmark.
// No external dependencies; Node >= 22 (node:sqlite enough).

export const MODULES = [
  "payments", "auth", "notifications", "search", "billing",
  "onboarding", "reporting", "admin", "mobile", "api-gateway",
  "inventory", "shipping", "refunds", "analytics", "infra",
];

export const ROLES = ["design", "api", "data", "ops", "security", "qa"];
export const STAGES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];

export const AUTHORS = [
  "陈晓", "李萌", "王一帆", "张若彤", "刘子涵", "赵启明",
  "周雨桐", "吴嘉豪", "郑可欣", "孙博文", "Alice Chen", "Marco Li",
];

// Chinese phrases that the benchmark queries by. Each doc gets 3 of them.
export const ZH_PHRASES = [
  "会话保持", "验收标准", "回滚", "灰度发布", "数据一致性",
  "幂等设计", "限流策略", "缓存失效", "错误码约定", "审计日志",
  "权限模型", "迁移脚本", "监控告警", "容量评估", "故障演练",
  "回滚预案", "兼容性", "超时重试", "降级策略", "状态机",
];

// English identifiers (camelCase / SCREAMING_CASE) queried by the benchmark.
export const IDENTIFIERS = [
  "sessionId", "userId", "tenantId", "requestId", "traceId",
  "loadModule", "retryPolicy", "tokenRefresh", "paymentsRetry", "cacheInvalidate",
  "rateLimiter", "normalizePath", "fetchDocuments", "parseFrontmatter", "buildIndex",
  "errorCode", "ERR_401", "ERR_503", "E_TIMEOUT", "SQLITE_BUSY",
  "HTTP_429", "invalid_grant", "idempotencyKey", "writeAheadLog", "segmentSize",
];

// Relative-looking repo paths used in doc bodies.
export const FILE_PATHS = [
  "src/payments/retry-policy.ts", "services/auth/session-store.ts",
  "services/auth/token-refresh.ts", "src/api/middleware/rate-limiter.ts",
  "src/search/index-builder.ts", "src/search/query-parser.ts",
  "packages/core/utils/normalize-path.ts", "packages/db/migrations/0007_docs.sql",
  "services/notifications/queue-consumer.ts", "infra/terraform/modules/redis/main.tf",
  "src/admin/audit-log.ts", "services/billing/invoice-renderer.ts",
  "app/mobile/session-keepalive.ts", "scripts/bench/build-index.mjs",
  "services/shipping/carrier-adapter.ts", "src/common/errors.ts",
];

export const ERROR_CODES = [
  "ERR_401", "ERR_503", "E_TIMEOUT", "SQLITE_BUSY", "HTTP_429",
  "invalid_grant", "E_CONFLICT", "E_NOT_FOUND", "E_RATE_LIMITED", "E_DEGRADED",
];

export const TOPICS_ZH = [
  "接口契约与重试策略", "会话保持与超时设置", "数据迁移与回滚预案",
  "灰度发布检查清单", "错误码与可观测性", "缓存一致性与失效策略",
  "权限模型与审计要求", "容量评估与压测结论", "故障演练复盘", "验收标准细化",
];

export const TOPICS_EN = [
  "Retry Policy", "Session Keep-alive", "Migration Rollback",
  "Canary Checklist", "Error Taxonomy", "Cache Invalidation",
];

export const EN_SENTENCES = [
  "The {id} field is validated by {fn} before the request reaches {path}.",
  "Callers must set {id} and {id2}; otherwise {fn} rejects the payload with {code}.",
  "See {path} for the canonical implementation of {fn}.",
  "A missing {id} used to surface as {code}; the fix is covered by {path}.",
  "{fn} wraps {fn2} and retries once when {code} is observed.",
  "Benchmarks live in scripts/bench; {fn} is the hot path for {id}.",
  "We cache {id} per tenant and invalidate via {fn}.",
  "The {fn} helper normalises {path} and strips the {id} prefix.",
];

export const ZH_TEMPLATES = [
  "本模块在 {stage} 阶段的核心约束是{phrase}：{id} 必须由调用方显式传入，缺失时返回 {code}。",
  "关于{phrase}，当前实现见 {path}，其中 {fn} 负责合并重试与超时逻辑。",
  "评审结论：{phrase}需要补一条断言，覆盖 {code} 与 {id} 同时缺失的路径。",
  "线上问题复盘的根因是 {fn} 未校验 {id}，导致{phrase}在高峰时段失效。",
  "迁移期间保持{phrase}，{path} 中的 {fn} 在旧版本下返回 {code}。",
  "设计取舍：把{phrase}收敛到网关层，业务侧仅依赖 {id} 与 {code}。",
  "压测显示 {fn} 在 {stage} 阶段出现抖动，需要复核{phrase}与{phrase2}。",
  "运维要求：{phrase}必须有可回滚的开关，相关脚本在 {path}。",
  "待办：为{phrase}补充监控告警，指标名统一使用 {id}_count。",
  "兼容性说明：{path} 在 {stage} 前仍返回 {code}，请按{phrase}处理。",
];

export const CHECK_ITEMS = [
  "验收标准：{id} 缺省时返回 {code}，且不产生副作用。",
  "验收标准：{phrase}在 {stage} 环境通过压测，P95 小于 200ms。",
  "验收标准：{path} 的改动有对应单测，覆盖 {code} 分支。",
  "验收标准：回滚脚本可在 5 分钟内完成，参考 {path}。",
];

export const RISK_ITEMS = [
  "风险：{phrase}依赖单实例状态，扩容后需要复核 {id} 的分布。",
  "回滚预案：切回上一版本并关闭 {fn}，观察 {id} 指标 30 分钟。",
  "降级策略：{fn} 失败时降级为同步调用，错误码统一为 {code}。",
  "监控告警：{id} 异常比例超过 1% 触发告警，看板见 {path}。",
];

export const HEADING_POOL = [
  "背景", "设计要点", "错误码与路径", "验收标准", "变更记录",
  "风险与回滚", "监控与告警", "迁移步骤", "附录", "接口契约",
  "性能与容量", "待办事项",
];

// ---- deterministic RNG (mulberry32) -----------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const randInt = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));

export function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Time range covered by the synthetic corpus timeline.
export const DATE_MIN = "2025-12-01";
export const DATE_MAX = "2026-11-10";
export const DATE_SPAN_DAYS = 344;

export function randomDate(rng) {
  return addDays(DATE_MIN, randInt(rng, 0, DATE_SPAN_DAYS));
}

// Fill {placeholders} in a template with the supplied values.
export function fill(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] !== undefined ? String(ctx[k]) : "{" + k + "}"));
}

// ---- doc generation ---------------------------------------------------------
function frontmatter(doc) {
  return [
    "---",
    "id: " + doc.id,
    "module: " + doc.module,
    "role: " + doc.role,
    "stage: " + doc.stage,
    "date: " + doc.date,
    "author: " + doc.author,
    "ticket: " + doc.ticket,
    "tags: " + doc.tags.join(", "),
    "---",
  ];
}

// Build one synthetic markdown document, exactly doc.targetLines lines.
export function makeDocContent(doc) {
  const rng = doc.rng;
  const lines = frontmatter(doc);
  lines.push("", "# " + doc.title, "");

  // Guaranteed phrase / identifier injections (so every query has hits).
  const phrases = [doc.anchors[0], doc.anchors[1], doc.anchors[2]];
  const ids = [doc.identifiers[0], doc.identifiers[1], doc.identifiers[2]];
  let phraseCursor = 0;
  let idCursor = 0;
  const nextPhrase = () => phrases[phraseCursor++ % phrases.length];
  const nextId = () => ids[idCursor++ % ids.length];

  const mkCtx = (opts = {}) => {
    const id = opts.id ?? nextId();
    return {
      id,
      id2: opts.id2 ?? nextId(),
      fn: opts.fn ?? pick(rng, IDENTIFIERS.filter((x) => /^[a-z]/.test(x))),
      fn2: opts.fn2 ?? pick(rng, IDENTIFIERS.filter((x) => /^[a-z]/.test(x))),
      path: opts.path ?? pick(rng, FILE_PATHS),
      code: opts.code ?? pick(rng, ERROR_CODES),
      phrase: opts.phrase ?? nextPhrase(),
      phrase2: opts.phrase2 ?? nextPhrase(),
      stage: doc.stage,
    };
  };

  const target = doc.targetLines;
  while (lines.length < target) {
    const remaining = target - lines.length;
    // Insert a heading block when there is room.
    if (remaining >= 6 && rng() < 0.28) {
      lines.push("## " + pick(rng, HEADING_POOL), "");
      continue;
    }
    const roll = rng();
    let line;
    if (roll < 0.34) {
      line = fill(pick(rng, ZH_TEMPLATES), mkCtx());
    } else if (roll < 0.52) {
      line = fill(pick(rng, EN_SENTENCES), mkCtx());
    } else if (roll < 0.63) {
      line = "- " + fill(pick(rng, ZH_TEMPLATES), mkCtx());
    } else if (roll < 0.72) {
      line = "- `" + pick(rng, IDENTIFIERS.filter((x) => /^[a-z]/.test(x))) + "`" + "：" + fill(pick(rng, ZH_TEMPLATES), mkCtx());
    } else if (roll < 0.79) {
      line = "- [ ] " + fill(pick(rng, CHECK_ITEMS), mkCtx());
    } else if (roll < 0.86) {
      line = "- " + fill(pick(rng, RISK_ITEMS), mkCtx());
    } else if (roll < 0.96) {
      line = "- " + randomDate(rng) + " " + pick(rng, AUTHORS) + "：" + fill(pick(rng, ZH_TEMPLATES), mkCtx());
    } else if (roll < 0.97) {
      line = "  const " + pick(rng, ["sessionId", "traceId", "requestId", "tenantId", "errorCode"]) + " = " + pick(rng, ["req.headers", "ctx.meta", "input.payload", "res.body"]) + "[" + pick(rng, ["'x-session-id'", "'x-request-id'", "'x-tenant'", "'code'"]) + "];";
    } else {
      line = "| " + nextId() + " | " + pick(rng, ["string", "number", "boolean"]) + " | " + pick(rng, ZH_PHRASES) + " |";
    }
    lines.push(line);
  }
  return lines.join("\n") + "\n";
}

export function makeDoc(tierRank, index) {
  const key = "doc-" + String(index).padStart(7, "0");
  const rng = mulberry32(hash32(key + ":v1"));
  const module = pick(rng, MODULES);
  const role = pick(rng, ROLES);
  const stage = STAGES[Math.min(Math.floor(rng() * STAGES.length), STAGES.length - 1)];
  const date = randomDate(rng);
  const author = pick(rng, AUTHORS);
  const ticket = module.slice(0, 3).toUpperCase() + "-" + randInt(rng, 1000, 9999);
  const tags = [pick(rng, ["retry", "timeout", "cache", "migration", "audit", "session", "index", "rate-limit"]), pick(rng, ["p0", "p1", "p2", "draft", "reviewed"])];
  const zhTopic = pick(rng, TOPICS_ZH);
  const enTopic = pick(rng, TOPICS_EN);
  const title = module + " · " + role + " · " + stage + "：" + zhTopic + " / " + enTopic;
  const slug = enTopic.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const anchors = [pick(rng, ZH_PHRASES), pick(rng, ZH_PHRASES), pick(rng, ZH_PHRASES)];
  const identifiers = [pick(rng, IDENTIFIERS), pick(rng, IDENTIFIERS), pick(rng, IDENTIFIERS)];
  const targetLines = randInt(rng, 30, 80);
  const relPath = "docs/" + module + "/" + stage + "/" + slug + "-" + String(index).padStart(7, "0") + ".md";
  return { id: key, index, module, role, stage, date, author, ticket, tags, title, anchors, identifiers, targetLines, relPath, rng };
}
