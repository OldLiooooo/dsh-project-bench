// research/bench/queries.mjs — deterministic query sets shared by all backends.
// 20 queries per category, so p50/p95 are meaningful.

import { MODULES, STAGES, IDENTIFIERS, ZH_PHRASES, AUTHORS, mulberry32, hash32, pick, randInt, addDays, DATE_MIN, DATE_SPAN_DAYS } from "./lib.mjs";

export const CATEGORY_DEFS = {
  kw_en: "英文标识符关键词（sessionId / ERR_401 …）",
  zh_phrase: "中文短语（会话保持 / 验收标准 / 回滚 …）",
  meta_kw: "元数据过滤 + 关键词（module + stage + 关键词）",
  timeline: "时间线（某日 / 某周 + 模块的变更记录）",
};

// 20 keyword queries: use the identifiers with mixed casing families.
export function makeKeywordQueries() {
  return IDENTIFIERS.slice(0, 20).map((q) => ({ q, kind: "kw_en" }));
}

export function makeZhQueries() {
  return ZH_PHRASES.map((q) => ({ q, kind: "zh_phrase" }));
}

// 20 metadata+keyword queries: deterministic pseudo-random module/stage pairs,
// keyword drawn from the English identifier pool.
export function makeMetaQueries() {
  const rng = mulberry32(hash32("meta-queries:v1"));
  const out = [];
  for (let i = 0; i < 20; i++) {
    out.push({
      module: pick(rng, MODULES),
      stage: pick(rng, STAGES),
      q: pick(rng, IDENTIFIERS),
      kind: "meta_kw",
    });
  }
  return out;
}

// 20 timeline queries:
//   - 10 x "one day, whole corpus"   : change_date = day (global index)
//   - 10 x "one week, one module"    : change_date BETWEEN mon..sun AND module = ?
// Both shapes are what people actually ask: "what changed on the 3rd?" and
// "what changed in payments this week?".
export function makeTimelineQueries() {
  const rng = mulberry32(hash32("timeline-queries:v1"));
  const out = [];
  for (let i = 0; i < 10; i++) {
    const day = addDays(DATE_MIN, randInt(rng, 10, DATE_SPAN_DAYS - 10));
    out.push({ kind: "timeline", mode: "day", date: day, module: null });
  }
  for (let i = 0; i < 10; i++) {
    const day = addDays(DATE_MIN, randInt(rng, 10, DATE_SPAN_DAYS - 10));
    const d = new Date(day + "T00:00:00Z");
    const dow = d.getUTCDay(); // 0=Sun
    const monday = addDays(day, -((dow + 6) % 7));
    out.push({ kind: "timeline", mode: "week", weekStart: monday, weekEnd: addDays(monday, 6), module: pick(rng, MODULES) });
  }
  return out;
}

export function makeAllQuerySets() {
  return {
    kw_en: makeKeywordQueries(),
    zh_phrase: makeZhQueries(),
    meta_kw: makeMetaQueries(),
    timeline: makeTimelineQueries(),
  };
}

// rg / grep representations of each query. Metadata filters are expressed as
// path prefixes (the directory layout encodes module/stage).
// rg order: [flags] PATTERN PATH. Metadata filters are expressed as path prefixes
// (the directory layout encodes module/stage); that is what a human would do too.
const RG_FLAGS = ["-n", "--with-filename", "--no-heading", "--no-messages", "--no-ignore", "--no-config"];

export function rgArgsForQuery(corpusRoot, query) {
  switch (query.kind) {
    case "kw_en":
    case "zh_phrase":
      return [...RG_FLAGS, "-F", query.q, corpusRoot];
    case "meta_kw":
      return [...RG_FLAGS, "-F", query.q, corpusRoot + "/docs/" + query.module + "/" + query.stage];
    case "timeline": {
      const dir = query.module ? corpusRoot + "/docs/" + query.module : corpusRoot;
      if (query.mode === "day") return [...RG_FLAGS, "-F", query.date, dir];
      const dates = [];
      for (let i = 0; i < 7; i++) dates.push(addDays(query.weekStart, i));
      return [...RG_FLAGS, "-e", dates.join("|"), dir];
    }
    default:
      throw new Error("bad kind " + query.kind);
  }
}

export function grepArgsForQuery(corpusRoot, query) {
  const base = ["-r", "-n", "-I", "--no-messages"];
  switch (query.kind) {
    case "kw_en":
    case "zh_phrase":
      return [...base, "-F", query.q, corpusRoot];
    case "meta_kw":
      return [...base, "-F", query.q, corpusRoot + "/docs/" + query.module + "/" + query.stage];
    case "timeline": {
      const dir = query.module ? corpusRoot + "/docs/" + query.module : corpusRoot;
      if (query.mode === "day") return [...base, "-F", query.date, dir];
      const dates = [];
      for (let i = 0; i < 7; i++) dates.push(addDays(query.weekStart, i));
      return [...base, "-E", dates.join("|"), dir];
    }
    default:
      throw new Error("bad kind " + query.kind);
  }
}
