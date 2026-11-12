#!/usr/bin/env node
// research/bench/query-bench.mjs — SQLite-side latency / payload / follow-up read
// measurements. The rg / grep side is driven by ext-bench.sh (the DSH sandbox
// blocks child processes from Node), and merge-results.mjs joins both.
//
// Usage:
//   node research/bench/query-bench.mjs --tier 1k --rounds 3
//   node research/bench/query-bench.mjs --all --rounds 2
//
// Output: research/bench/results/queries-<tier>.json
//
// Warm/cold definitions:
//   cold  = first execution of a query on a brand-new SQLite connection. The
//           Windows OS file cache cannot be dropped in user space, so it stays
//           warm; SQLite's page cache does not.
//   warm  = repeated executions on one persistent connection, pooled over
//           <rounds> rounds.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { makeAllQuerySets } from "./queries.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIERS = { "1k": 1000, "5k": 5000, "20k": 20000 };
const LIMIT = 20;

function parseArgs(argv) {
  const out = { tier: "1k", all: false, rounds: 3 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier") out.tier = argv[++i];
    else if (argv[i] === "--all") out.all = true;
    else if (argv[i] === "--rounds") out.rounds = Number(argv[++i]);
  }
  return out;
}

const now = () => performance.now();

function pct(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function agg(samples) {
  const xs = samples.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (xs.length === 0) return { n: 0, p50: null, p95: null, mean: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  return { n: xs.length, p50: pct(s, 50), p95: pct(s, 95), mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: s[0], max: s[s.length - 1] };
}

const median = (xs) => agg(xs).p50;

// rough token estimate: ~1 token per CJK char, ~3.6 ASCII chars per token
export function estimateTokens(str) {
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    if (ch.codePointAt(0) >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.6);
}

function payloadOfRows(rows) {
  const json = JSON.stringify(rows);
  return { bytes: Buffer.byteLength(json), tokens: estimateTokens(json), rows: rows.length };
}

// ---- SQL builders -----------------------------------------------------------
const SNIPPET = "snippet(%T, 1, '[', ']', '…', 16) AS ctx";

function dbQuery(backend, query) {
  switch (backend) {
    case "sqlite_like": {
      if (query.kind === "kw_en" || query.kind === "zh_phrase") {
        return {
          sql: "SELECT path, title, substr(body, max(1, instr(body, ?) - 30), 160) AS ctx FROM docs WHERE body LIKE ? LIMIT " + LIMIT,
          params: [query.q, "%" + query.q + "%"],
        };
      }
      return {
        sql: "SELECT path, title, substr(body, max(1, instr(body, ?) - 30), 160) AS ctx FROM docs WHERE module = ? AND stage = ? AND body LIKE ? LIMIT " + LIMIT,
        params: [query.q, query.module, query.stage, "%" + query.q + "%"],
      };
    }
    case "fts_uni":
    case "fts_tri": {
      const t = backend === "fts_uni" ? "fts_uni" : "fts_tri";
      return {
        sql: "SELECT d.id, d.path, d.title, " + SNIPPET.replace("%T", t) + " FROM " + t + " JOIN docs d ON d.id = " + t + ".rowid WHERE " + t + " MATCH ? ORDER BY rank LIMIT " + LIMIT,
        params: [query.q],
      };
    }
    case "fts_tri_like": {
      return {
        sql: "SELECT d.id, d.path, d.title, " + SNIPPET.replace("%T", "fts_tri") + " FROM fts_tri JOIN docs d ON d.id = fts_tri.rowid WHERE fts_tri.body LIKE ? LIMIT " + LIMIT,
        params: ["%" + query.q + "%"],
      };
    }
    case "fts_uni_join":
    case "fts_tri_join": {
      const t = backend === "fts_uni_join" ? "fts_uni" : "fts_tri";
      return {
        sql: "SELECT d.id, d.path, d.title, " + SNIPPET.replace("%T", t) + " FROM " + t + " JOIN docs d ON d.id = " + t + ".rowid WHERE " + t + " MATCH ? AND d.module = ? AND d.stage = ? ORDER BY rank LIMIT " + LIMIT,
        params: [query.q, query.module, query.stage],
      };
    }
    case "fts_uni_c_pathonly": {
      // index-only layout: contentless FTS returns the path, body stays in .md
      return {
        sql: "SELECT d.path FROM fts_uni_c JOIN docs d ON d.id = fts_uni_c.rowid WHERE fts_uni_c MATCH ? LIMIT " + LIMIT,
        params: [query.q],
      };
    }
    case "db_timeline": {
      if (query.mode === "day") {
        return {
          sql: "SELECT c.change_date, d.path, c.summary FROM changes c JOIN docs d ON d.id = c.doc_id WHERE c.change_date = ? LIMIT " + LIMIT,
          params: [query.date],
        };
      }
      return {
        sql: "SELECT c.change_date, d.path, c.summary FROM changes c JOIN docs d ON d.id = c.doc_id WHERE c.module = ? AND c.change_date BETWEEN ? AND ? LIMIT " + LIMIT,
        params: [query.module, query.weekStart, query.weekEnd],
      };
    }
    default:
      throw new Error("unknown backend " + backend);
  }
}

function countQuery(db, backend, query) {
  try {
    if (backend === "sqlite_like") {
      if (query.kind === "meta_kw") return db.prepare("SELECT count(*) c FROM docs WHERE module = ? AND stage = ? AND body LIKE ?").get(query.module, query.stage, "%" + query.q + "%").c;
      return db.prepare("SELECT count(*) c FROM docs WHERE body LIKE ?").get("%" + query.q + "%").c;
    }
    if (backend === "fts_uni") return db.prepare("SELECT count(*) c FROM fts_uni WHERE fts_uni MATCH ?").get(query.q).c;
    if (backend === "fts_tri") return db.prepare("SELECT count(*) c FROM fts_tri WHERE fts_tri MATCH ?").get(query.q).c;
    if (backend === "fts_tri_like") return db.prepare("SELECT count(*) c FROM fts_tri WHERE fts_tri.body LIKE ?").get("%" + query.q + "%").c;
    if (backend === "fts_uni_join") return db.prepare("SELECT count(*) c FROM fts_uni JOIN docs d ON d.id = fts_uni.rowid WHERE fts_uni MATCH ? AND d.module = ? AND d.stage = ?").get(query.q, query.module, query.stage).c;
    if (backend === "fts_tri_join") return db.prepare("SELECT count(*) c FROM fts_tri JOIN docs d ON d.id = fts_tri.rowid WHERE fts_tri MATCH ? AND d.module = ? AND d.stage = ?").get(query.q, query.module, query.stage).c;
    if (backend === "db_timeline") {
      if (query.mode === "day") return db.prepare("SELECT count(*) c FROM changes WHERE change_date = ?").get(query.date).c;
      return db.prepare("SELECT count(*) c FROM changes WHERE module = ? AND change_date BETWEEN ? AND ?").get(query.module, query.weekStart, query.weekEnd).c;
    }
  } catch {
    return null;
  }
  return null;
}

const CATEGORY_BACKENDS = {
  kw_en: ["sqlite_like", "fts_uni", "fts_tri", "fts_tri_like"],
  zh_phrase: ["sqlite_like", "fts_uni", "fts_tri", "fts_tri_like"],
  meta_kw: ["sqlite_like", "fts_uni_join", "fts_tri_join"],
  timeline: ["db_timeline"],
};

async function benchTier(tier, rounds) {
  const docs = TIERS[tier];
  const dbDir = path.join(HERE, "db");
  const mainDbPath = path.join(dbDir, "full_uni_tri-" + tier + ".db");
  const fullDbPath = path.join(dbDir, "full-" + tier + ".db");
  const idxDbPath = path.join(dbDir, "idxonly_uni_tri-" + tier + ".db");
  for (const p of [mainDbPath, fullDbPath, idxDbPath]) {
    if (!existsSync(p)) throw new Error("missing " + p + " — run build-db.mjs first");
  }
  const querySets = makeAllQuerySets();

  const warmDb = new DatabaseSync(mainDbPath);
  warmDb.exec("PRAGMA cache_size = -65536");
  warmDb.exec("PRAGMA mmap_size = 268435456");
  const pragma = {
    pageSize: warmDb.prepare("PRAGMA page_size").get().page_size,
    journalMode: warmDb.prepare("PRAGMA journal_mode").get().journal_mode,
    cacheSize: warmDb.prepare("PRAGMA cache_size").get().cache_size,
  };

  const results = { tier, docs, generatedAt: new Date().toISOString(), rounds, pragma, dbSizes: {}, categories: {}, recall: {}, followup: {}, plans: [] };

  // db sizes from the build results (single source of truth)
  const dbResPath = path.join(HERE, "results", "db-" + tier + ".json");
  if (existsSync(dbResPath)) {
    const dbRes = JSON.parse(await readFile(dbResPath, "utf8"));
    for (const [name, v] of Object.entries(dbRes.variants)) results.dbSizes[name] = { sizeBytes: v.sizeBytes, buildMs: v.buildMs, dbstat: v.dbstat };
    results.corpus = { bytes: dbRes.corpusBytes, bytesPerDoc: dbRes.corpusBytesPerDoc, changes: dbRes.changes, parseMs: dbRes.parseMs };
  }

  for (const [cat, queries] of Object.entries(querySets)) {
    const dbBackends = CATEGORY_BACKENDS[cat];
    const catRes = { queries: queries.map((q) => q.q || (q.mode === "day" ? "@" + q.date : q.module + "@" + q.weekStart)), backends: {} };
    const perBackend = {};
    for (const b of dbBackends) perBackend[b] = { cold: [], warm: [], payloadBytes: [], payloadTokens: [], payloadRows: [], hitCounts: [], errors: [] };

    // pass 1 — cold-ish: fresh SQLite connection per query
    for (const q of queries) {
      for (const b of dbBackends) {
        const spec = dbQuery(b, q);
        const t0 = now();
        let rows = [];
        try {
          const db = new DatabaseSync(mainDbPath);
          db.exec("PRAGMA cache_size = -8192");
          rows = db.prepare(spec.sql).all(...spec.params);
          db.close();
        } catch (e) {
          perBackend[b].errors.push(String(e.message).slice(0, 200));
        }
        perBackend[b].cold.push(now() - t0);
        if (rows.length) {
          const p = payloadOfRows(rows);
          perBackend[b].payloadBytes.push(p.bytes);
          perBackend[b].payloadTokens.push(p.tokens);
          perBackend[b].payloadRows.push(p.rows);
        }
      }
    }

    // pass 2 — warm: persistent connection, <rounds> rounds
    for (let r = 0; r < rounds; r++) {
      for (const q of queries) {
        for (const b of dbBackends) {
          const spec = dbQuery(b, q);
          const t0 = now();
          try {
            const rows = warmDb.prepare(spec.sql).all(...spec.params);
            perBackend[b].warm.push(now() - t0);
            if (r === 0 && rows.length) {
              const p = payloadOfRows(rows);
              perBackend[b].payloadBytes.push(p.bytes);
              perBackend[b].payloadTokens.push(p.tokens);
              perBackend[b].payloadRows.push(p.rows);
            }
          } catch (e) {
            perBackend[b].errors.push(String(e.message).slice(0, 200));
            perBackend[b].warm.push(now() - t0);
          }
        }
      }
    }

    // counts (untimed)
    for (const q of queries) for (const b of dbBackends) perBackend[b].hitCounts.push(countQuery(warmDb, b, q));

    for (const b of dbBackends) {
      const x = perBackend[b];
      catRes.backends[b] = {
        cold: agg(x.cold),
        warm: agg(x.warm),
        payloadBytes: agg(x.payloadBytes),
        payloadTokens: agg(x.payloadTokens),
        payloadRows: agg(x.payloadRows),
        hitCounts: x.hitCounts,
        hitCountMedian: median(x.hitCounts.filter((v) => v !== null)),
        errors: x.errors.slice(0, 5),
      };
    }
    results.categories[cat] = catRes;

    // capture one query plan per backend as evidence of index usage
    for (const b of dbBackends) {
      const spec = dbQuery(b, queries[0]);
      try {
        const plan = warmDb.prepare("EXPLAIN QUERY PLAN " + spec.sql).all(...spec.params).map((r) => r.detail);
        results.plans.push({ category: cat, backend: b, sql: spec.sql, plan });
      } catch (e) {
        results.plans.push({ category: cat, backend: b, sql: spec.sql, plan: ["ERR " + e.message] });
      }
    }
    console.log("[bench] " + tier + " " + cat + " done");
  }

  // ---- recall comparison (untimed) -----------------------------------------
  const recall = { kw_en: [], zh_phrase: [] };
  for (const cat of ["kw_en", "zh_phrase"]) {
    for (const q of querySets[cat]) {
      recall[cat].push({
        q: q.q,
        like: countQuery(warmDb, "sqlite_like", q),
        uni: countQuery(warmDb, "fts_uni", q),
        uniPrefix: (() => { try { return warmDb.prepare("SELECT count(*) c FROM fts_uni WHERE fts_uni MATCH ?").get(q.q + "*").c; } catch { return null; } })(),
        tri: countQuery(warmDb, "fts_tri", q),
        triLike: countQuery(warmDb, "fts_tri_like", q),
      });
    }
  }
  results.recall = recall;

  // ---- follow-up read cost --------------------------------------------------
  // (a) full-text DB: fetch bodies straight from docs.body
  // (b) index-only DB: query contentless FTS for paths, then read the .md files
  // (c) corpus files as a reference: read the same paths from disk
  const followup = { db_body: { ms: [], bytes: [] }, idxonly_file: { ms: [], bytes: [] }, file_only: { ms: [], bytes: [] } };
  const fullDb = new DatabaseSync(fullDbPath);
  const idxDb = new DatabaseSync(idxDbPath);
  fullDb.exec("PRAGMA cache_size = -65536");
  idxDb.exec("PRAGMA cache_size = -65536");
  for (const cat of ["kw_en", "zh_phrase"]) {
    for (const q of querySets[cat]) {
      const spec = dbQuery("fts_tri", q);
      const rows = warmDb.prepare(spec.sql).all(...spec.params).slice(0, 5);
      const ids = rows.map((r) => r.id).filter((x) => x !== undefined);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        let t0 = now();
        const bodies = fullDb.prepare("SELECT body FROM docs WHERE id IN (" + placeholders + ")").all(...ids);
        let bytes = 0;
        for (const b of bodies) bytes += Buffer.byteLength(b.body);
        followup.db_body.ms.push(now() - t0);
        followup.db_body.bytes.push(bytes);

        const paths = rows.map((r) => r.path);
        t0 = now();
        let fileBytes = 0;
        const bufs = await Promise.all(paths.map((p) => readFile(path.resolve(HERE, p))));
        for (const b of bufs) fileBytes += b.length;
        followup.file_only.ms.push(now() - t0);
        followup.file_only.bytes.push(fileBytes);
      }
      // index-only: contentless FTS -> path -> read file
      const idxSpec = dbQuery("fts_uni_c_pathonly", q);
      const idxRows = idxDb.prepare(idxSpec.sql).all(...idxSpec.params).slice(0, 5);
      if (idxRows.length) {
        const t0 = now();
        let bytes = 0;
        const bufs = await Promise.all(idxRows.map((r) => readFile(path.resolve(HERE, r.path))));
        for (const b of bufs) bytes += b.length;
        followup.idxonly_file.ms.push(now() - t0);
        followup.idxonly_file.bytes.push(bytes);
      }
    }
  }
  results.followup = {
    db_body: { ms: agg(followup.db_body.ms), bytes: agg(followup.db_body.bytes) },
    idxonly_file: { ms: agg(followup.idxonly_file.ms), bytes: agg(followup.idxonly_file.bytes) },
    file_only: { ms: agg(followup.file_only.ms), bytes: agg(followup.file_only.bytes) },
  };

  warmDb.close();
  fullDb.close();
  idxDb.close();

  await mkdir(path.join(HERE, "results"), { recursive: true });
  await writeFile(path.join(HERE, "results", "queries-" + tier + ".json"), JSON.stringify(results, null, 2));

  const f = (x) => (x === null ? "-" : x.toFixed(2));
  for (const cat of Object.keys(results.categories)) {
    console.log("---- " + tier + " / " + cat + " (ms p50 / p95 | payload bytes | rows | hits) ----");
    for (const [b, v] of Object.entries(results.categories[cat].backends)) {
      console.log("  " + b.padEnd(18) + " cold " + f(v.cold.p50) + "/" + f(v.cold.p95) +
        "  warm " + f(v.warm.p50) + "/" + f(v.warm.p95) +
        "  payload " + f(v.payloadBytes.p50) + "B  rows " + f(v.payloadRows.p50) +
        "  hits " + (v.hitCountMedian === null ? "-" : v.hitCountMedian));
    }
  }
  console.log("[bench] " + tier + " followup db_body=" + (results.followup.db_body.bytes.p50 / 1024).toFixed(1) + "KiB/" + f(results.followup.db_body.ms.p50) +
    "ms  idxonly_file=" + (results.followup.idxonly_file.bytes.p50 / 1024).toFixed(1) + "KiB/" + f(results.followup.idxonly_file.ms.p50) + "ms");
  console.log("[bench] " + tier + " saved results/queries-" + tier + ".json");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tiers = args.all ? Object.keys(TIERS) : [args.tier];
  for (const tier of tiers) await benchTier(tier, args.rounds);
}

main().catch((e) => { console.error(e); process.exit(1); });
