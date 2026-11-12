#!/usr/bin/env node
// research/bench/gen-corpus.mjs — generate deterministic synthetic project docs.
//
// Usage:
//   node research/bench/gen-corpus.mjs --tier 1k
//   node research/bench/gen-corpus.mjs --tier 5k --force
//   node research/bench/gen-corpus.mjs --all
//
// Output layout (per tier):
//   research/bench/corpus/<tier>/docs/<module>/<stage>/<slug>-<id>.md
//
// The corpus is a *synthetic* mixture of Chinese prose, English prose, camelCase
// identifiers, repo paths, error codes and changelog dates. It is designed to be
// reproducible and to exercise recall/precision, not to mimic a real doc corpus.

import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDoc, makeDocContent } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIERS = { "1k": 1000, "5k": 5000, "20k": 20000 };

function parseArgs(argv) {
  const out = { tier: "1k", force: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tier") out.tier = argv[++i];
    else if (argv[i] === "--force") out.force = true;
    else if (argv[i] === "--all") out.all = true;
  }
  return out;
}

async function dirBytes(dir) {
  let total = 0;
  let files = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirBytes(p);
      total += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      total += (await stat(p)).size;
      files += 1;
    }
  }
  return { bytes: total, files };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tiers = args.all ? Object.keys(TIERS) : [args.tier];
  for (const tier of tiers) {
    const n = TIERS[tier];
    if (!n) throw new Error("unknown tier: " + tier);
    const outDir = path.join(HERE, "corpus", tier);
    if (existsSync(outDir) && !args.force) {
      const existing = await dirBytes(path.join(outDir, "docs"));
      if (existing.files === n) {
        console.log("[corpus] " + tier + " already has " + existing.files + " files, skip (use --force)");
        continue;
      }
    }
    const started = performance.now();
    let minLines = Infinity;
    let maxLines = 0;
    let totalLines = 0;
    let totalBytes = 0;
    let done = 0;
    const dirs = new Set();
    const batch = [];
    for (let i = 0; i < n; i++) {
      const doc = makeDoc(0, i);
      const content = makeDocContent(doc);
      const abs = path.join(outDir, doc.relPath);
      const lines = doc.targetLines;
      minLines = Math.min(minLines, lines);
      maxLines = Math.max(maxLines, lines);
      totalLines += lines;
      totalBytes += Buffer.byteLength(content);
      const dir = path.dirname(abs);
      if (!dirs.has(dir)) {
        dirs.add(dir);
        await mkdir(dir, { recursive: true });
      }
      batch.push(writeFile(abs, content));
      if (batch.length >= 128) {
        await Promise.all(batch);
        batch.length = 0;
      }
      done++;
      if (done % 5000 === 0) console.log("[corpus] " + tier + " " + done + "/" + n);
    }
    await Promise.all(batch);
    const elapsedMs = performance.now() - started;
    const disk = await dirBytes(outDir);
    const result = {
      tier,
      docs: n,
      dirs: dirs.size,
      lines: { min: minLines, max: maxLines, total: totalLines, avg: totalLines / n },
      bytes: disk.bytes,
      bytesPerDoc: disk.bytes / n,
      elapsedMs,
      docsPerSec: (n / elapsedMs) * 1000,
      generatedAt: new Date().toISOString(),
    };
    await mkdir(path.join(HERE, "results"), { recursive: true });
    await writeFile(path.join(HERE, "results", "corpus-" + tier + ".json"), JSON.stringify(result, null, 2));
    console.log("[corpus] " + tier + ": " + n + " docs, " + (disk.bytes / 1048576).toFixed(1) + " MiB, " + (elapsedMs / 1000).toFixed(2) + "s (" + Math.round(result.docsPerSec) + " docs/s), lines " + minLines + "-" + maxLines);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
