#!/usr/bin/env node
// research/bench/merge-results.mjs — join the Node-side SQLite measurements with
// the Bash-side rg/grep measurements into results/combined-<tier>.json.
//
// Usage: node research/bench/merge-results.mjs --tier 1k   (or --all)

import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIERS = { "1k": 1000, "5k": 5000, "20k": 20000 };

function parseArgs(argv) {
  const out = { tier: "1k", all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier") out.tier = argv[++i];
    else if (argv[i] === "--all") out.all = true;
  }
  return out;
}

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

function estimateTokens(str) {
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    if (ch.codePointAt(0) >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 3.6);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tiers = args.all ? Object.keys(TIERS) : [args.tier];
  for (const tier of tiers) {
    const dbPath = path.join(HERE, "results", "queries-" + tier + ".json");
    const extPath = path.join(HERE, "results", "ext-" + tier + ".tsv");
    const first20Dir = path.join(HERE, "results", "extfirst20-" + tier);
    if (!existsSync(dbPath) || !existsSync(extPath)) {
      console.log("[merge] " + tier + ": missing " + dbPath + " or " + extPath + ", skip");
      continue;
    }
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    const tsv = await readFile(extPath, "utf8");
    const rows = [];
    for (const line of tsv.split("\n")) {
      if (!line.trim()) continue;
      const f = line.split("\t");
      if (f.length < 11) continue;
      rows.push({
        backend: f[0], cat: f[1], qidx: Number(f[2]), pass: Number(f[3]),
        ms: Number(f[4]), bytes: Number(f[5]), lines: Number(f[6]), files: Number(f[7]),
        first20: Number(f[8]), status: Number(f[9]), hit5: f[10] ? f[10].split("|").filter(Boolean) : [],
      });
    }

    // spawn overhead
    const spawn = {};
    for (const b of ["rg", "grep"]) {
      const xs = rows.filter((r) => r.backend === b && r.cat === "spawn" && r.pass > 1).map((r) => r.ms);
      if (xs.length) spawn[b] = agg(xs);
    }

    // external backends per category
    const first20Files = new Set(await readdir(first20Dir).catch(() => []));
    for (const [cat, catRes] of Object.entries(db.categories)) {
      for (const backend of ["rg", "grep"]) {
        const mine = rows.filter((r) => r.backend === backend && r.cat === cat);
        if (mine.length === 0) continue;
        const cold = mine.filter((r) => r.pass === 1).sort((a, b) => a.qidx - b.qidx);
        const warm = mine.filter((r) => r.pass >= 2).map((r) => r.ms);
        const payloadBytes = [];
        const payloadTokens = [];
        const payloadRows = [];
        const payloadFirst20Bytes = [];
        const filesCounts = [];
        for (const r of cold) {
          payloadBytes.push(r.bytes);
          payloadFirst20Bytes.push(r.first20);
          payloadRows.push(r.lines);
          filesCounts.push(r.files);
          const fname = backend + "-" + cat + "-" + r.qidx + ".txt";
          let ratio = 0.28; // fallback chars/token
          if (first20Files.has(fname)) {
            const txt = await readFile(path.join(first20Dir, fname), "utf8");
            if (r.first20 > 0) ratio = estimateTokens(txt) / r.first20;
          }
          payloadTokens.push(Math.ceil(r.bytes * ratio));
        }
        catRes.backends[backend] = {
          cold: agg(cold.map((r) => r.ms)),
          warm: agg(warm),
          payloadBytes: agg(payloadBytes),
          payloadTokens: agg(payloadTokens),
          payloadRows: agg(payloadRows),
          payloadFirst20Bytes: agg(payloadFirst20Bytes),
          files: agg(filesCounts),
          hitCounts: cold.map((r) => r.lines),
          hitCountMedian: agg(cold.map((r) => r.lines)).p50,
          errors: cold.filter((r) => r.status > 1).map((r) => "status " + r.status).slice(0, 5),
        };
      }
    }

    // follow-up: read the first five distinct hit files that rg reported
    const followup = { rg_file: { ms: [], bytes: [] } };
    for (const cat of ["kw_en", "zh_phrase"]) {
      const mine = rows.filter((r) => r.backend === "rg" && r.cat === cat && r.pass === 1).sort((a, b) => a.qidx - b.qidx);
      for (const r of mine) {
        if (!r.hit5.length) continue;
        const t0 = performance.now();
        let bytes = 0;
        const bufs = await Promise.all(r.hit5.map((p) => readFile(path.resolve(HERE, p))));
        for (const b of bufs) bytes += b.length;
        followup.rg_file.ms.push(performance.now() - t0);
        followup.rg_file.bytes.push(bytes);
      }
    }
    db.followup.rg_file = { ms: agg(followup.rg_file.ms), bytes: agg(followup.rg_file.bytes) };

    // end-to-end for the two realistic agent flows
    const e2e = {};
    for (const cat of ["kw_en", "zh_phrase", "meta_kw", "timeline"]) {
      const b = db.categories[cat].backends;
      const pick = (name, key) => (b[name] && b[name][key] ? b[name][key].p50 : null);
      const add = (a, c) => (a === null || c === null ? null : a + c);
      e2e[cat] = {
        rg_lookup_ms: pick("rg", "cold"),
        rg_payload_bytes: pick("rg", "payloadBytes"),
        rg_followup_ms: cat === "kw_en" || cat === "zh_phrase" ? db.followup.rg_file.ms.p50 : null,
        rg_followup_bytes: cat === "kw_en" || cat === "zh_phrase" ? db.followup.rg_file.bytes.p50 : null,
        rg_total_ms: add(pick("rg", "cold"), cat === "kw_en" || cat === "zh_phrase" ? db.followup.rg_file.ms.p50 : 0),
        db_snippet_ms: pick("fts_tri", "cold") ?? pick("fts_tri_join", "cold") ?? pick("db_timeline", "cold"),
        db_snippet_payload_bytes: pick("fts_tri", "payloadBytes") ?? pick("fts_tri_join", "payloadBytes") ?? pick("db_timeline", "payloadBytes"),
        db_full_ms: add(pick("fts_tri", "cold") ?? pick("fts_tri_join", "cold"), db.followup.db_body.ms.p50),
        db_full_bytes: db.followup.db_body.bytes.p50,
        db_idxonly_ms: add(pick("fts_uni", "cold") ?? pick("fts_uni_join", "cold"), db.followup.idxonly_file.ms.p50),
        db_idxonly_bytes: db.followup.idxonly_file.bytes.p50,
        like_ms: pick("sqlite_like", "cold"),
      };
    }
    db.endToEnd = e2e;
    db.spawn = spawn;

    await writeFile(path.join(HERE, "results", "combined-" + tier + ".json"), JSON.stringify(db, null, 2));

    const f = (x, d = 2) => (x === null ? "-" : x.toFixed(d));
    const kb = (x) => (x === null ? "-" : (x / 1024).toFixed(1));
    console.log("==== " + tier + " merged (cold p50 ms | payload bytes | hit rows) ====");
    for (const [cat, catRes] of Object.entries(db.categories)) {
      console.log("-- " + cat);
      for (const [b, v] of Object.entries(catRes.backends)) {
        console.log("   " + b.padEnd(12) + " cold " + f(v.cold.p50) + "  warm " + f(v.warm.p50) + "  payload " + kb(v.payloadBytes.p50) + "KiB  rows " + f(v.payloadRows.p50, 0));
      }
    }
    console.log("   spawn overhead rg=" + f(spawn.rg ? spawn.rg.p50 : null) + "ms grep=" + f(spawn.grep ? spawn.grep.p50 : null) + "ms");
    console.log("   e2e kw_en: rg=" + f(e2e.kw_en.rg_total_ms) + "ms/" + kb(e2e.kw_en.rg_payload_bytes) + "KiB  db_snippet=" + f(e2e.kw_en.db_snippet_ms) + "ms/" + kb(e2e.kw_en.db_snippet_payload_bytes) + "KiB  db_full=" + f(e2e.kw_en.db_full_ms) + "ms/" + kb(e2e.kw_en.db_full_bytes) + "KiB");
    await writeFile(path.join(HERE, "results", "combined-" + tier + ".json"), JSON.stringify(db, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
