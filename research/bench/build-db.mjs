#!/usr/bin/env node
// research/bench/build-db.mjs — parse the synthetic corpus and build several SQLite
// layouts so we can separate storage / index / build costs.
//
// Usage:
//   node research/bench/build-db.mjs --tier 1k
//   node research/bench/build-db.mjs --all
//
// Variants (all on the same parsed documents):
//   meta              docs metadata only + B-tree indexes (no full text)
//   full              meta + full body stored in the docs table
//   full_uni          full + FTS5 unicode61 (external content)
//   full_uni_tri      full_uni + FTS5 trigram (external content)  <- main query DB
//   idxonly_uni_tri   meta + FTS5 unicode61 contentless + FTS5 trigram contentless
//                     (full text stays in .md files; index-only layout)

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { statSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

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

async function walkMarkdown(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkMarkdown(p, out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return meta;
}

function parseDoc(absPath) {
  const raw = readFileSyncText(absPath);
  const text = raw.text;
  const meta = parseFrontmatter(text);
  const titleM = text.match(/^# (.*)$/m);
  const changes = [];
  const re = /^- (\d{4}-\d{2}-\d{2})\s+([^：:\n]{1,40})[：:](.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    changes.push({ date: m[1], author: m[2].trim(), summary: m[3].trim() });
  }
  return {
    id: Number(String(meta.id || "").replace(/\D/g, "")) + 1,
    path: absPath,
    title: titleM ? titleM[1].trim() : path.basename(absPath),
    module: meta.module || "",
    role: meta.role || "",
    stage: meta.stage || "",
    date: meta.date || "",
    author: meta.author || "",
    ticket: meta.ticket || "",
    tags: meta.tags || "",
    bytes: raw.bytes,
    lines: raw.lines,
    body: text,
    changes,
  };
}

// small helper so we can measure bytes without importing fs twice
import { readFileSync } from "node:fs";
function readFileSyncText(p) {
  const buf = readFileSync(p);
  return { text: buf.toString("utf8"), bytes: buf.length, lines: buf.toString("utf8").split("\n").length - 1 };
}

function dbstatBreakdown(db) {
  try {
    const rows = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all();
    const out = {};
    for (const r of rows) out[r.name] = Number(r.bytes);
    return out;
  } catch {
    return null;
  }
}

const SCHEMA = {
  docs: (withBody) => "CREATE TABLE docs (" +
    "id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL, " +
    "module TEXT NOT NULL, role TEXT NOT NULL, stage TEXT NOT NULL, date TEXT NOT NULL, " +
    "author TEXT NOT NULL, ticket TEXT NOT NULL, tags TEXT, bytes INTEGER NOT NULL, lines INTEGER NOT NULL" +
    (withBody ? ", body TEXT NOT NULL" : "") + ")",
  changes: "CREATE TABLE changes (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL, " +
    "change_date TEXT NOT NULL, module TEXT NOT NULL, stage TEXT NOT NULL, " +
    "author TEXT NOT NULL, summary TEXT NOT NULL)",
  indexes: [
    "CREATE INDEX idx_docs_module_stage ON docs(module, stage)",
    "CREATE INDEX idx_docs_date ON docs(date)",
    "CREATE INDEX idx_docs_module_date ON docs(module, date)",
    "CREATE INDEX idx_docs_author ON docs(author)",
    "CREATE INDEX idx_docs_ticket ON docs(ticket)",
    "CREATE INDEX idx_changes_date ON changes(change_date)",
    "CREATE INDEX idx_changes_module_date ON changes(module, change_date)",
    "CREATE INDEX idx_changes_doc ON changes(doc_id)",
  ],
  ftsUni: "CREATE VIRTUAL TABLE fts_uni USING fts5(title, body, content='docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2')",
  ftsTri: "CREATE VIRTUAL TABLE fts_tri USING fts5(title, body, content='docs', content_rowid='id', tokenize='trigram')",
  ftsUniC: "CREATE VIRTUAL TABLE fts_uni_c USING fts5(title, body, content='', tokenize='unicode61 remove_diacritics 2')",
  ftsTriC: "CREATE VIRTUAL TABLE fts_tri_c USING fts5(title, body, content='', tokenize='trigram')",
};

function nowMs() { return performance.now(); }

async function buildVariant({ file, docs, withBody, uni, tri, contentless }) {
  if (existsSync(file)) rmSync(file);
  const db = new DatabaseSync(file);
  const phases = {};
  const total0 = nowMs();
  db.exec("PRAGMA journal_mode = OFF");
  db.exec("PRAGMA synchronous = OFF");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA cache_size = -65536"); // 64 MiB page cache while building
  db.exec(SCHEMA.docs(withBody));
  db.exec(SCHEMA.changes);

  // --- insert docs -----------------------------------------------------------
  phases.insertDocsMs = 0;
  {
    const t = nowMs();
    const cols = withBody
      ? "(id, path, title, module, role, stage, date, author, ticket, tags, bytes, lines, body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      : "(id, path, title, module, role, stage, date, author, ticket, tags, bytes, lines) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";
    const stmt = db.prepare("INSERT INTO docs " + cols);
    db.exec("BEGIN");
    for (const d of docs) {
      if (withBody) stmt.run(d.id, d.path, d.title, d.module, d.role, d.stage, d.date, d.author, d.ticket, d.tags, d.bytes, d.lines, d.body);
      else stmt.run(d.id, d.path, d.title, d.module, d.role, d.stage, d.date, d.author, d.ticket, d.tags, d.bytes, d.lines);
    }
    db.exec("COMMIT");
    phases.insertDocsMs = nowMs() - t;
  }

  // --- insert changes --------------------------------------------------------
  phases.insertChangesMs = 0;
  {
    const t = nowMs();
    const stmt = db.prepare("INSERT INTO changes (doc_id, change_date, module, stage, author, summary) VALUES (?,?,?,?,?,?)");
    db.exec("BEGIN");
    for (const d of docs) for (const c of d.changes) stmt.run(d.id, c.date, d.module, d.stage, c.author, c.summary);
    db.exec("COMMIT");
    phases.insertChangesMs = nowMs() - t;
  }

  // --- FTS -------------------------------------------------------------------
  phases.ftsUniMs = 0;
  phases.ftsTriMs = 0;
  if (uni) {
    db.exec(contentless ? SCHEMA.ftsUniC : SCHEMA.ftsUni);
    const t = nowMs();
    if (contentless) {
      const stmt = db.prepare("INSERT INTO fts_uni_c(rowid, title, body) VALUES (?,?,?)");
      db.exec("BEGIN");
      for (const d of docs) stmt.run(d.id, d.title, d.body);
      db.exec("COMMIT");
    } else {
      db.exec("INSERT INTO fts_uni(fts_uni) VALUES('rebuild')");
    }
    phases.ftsUniMs = nowMs() - t;
  }
  if (tri) {
    db.exec(contentless ? SCHEMA.ftsTriC : SCHEMA.ftsTri);
    const t = nowMs();
    if (contentless) {
      const stmt = db.prepare("INSERT INTO fts_tri_c(rowid, title, body) VALUES (?,?,?)");
      db.exec("BEGIN");
      for (const d of docs) stmt.run(d.id, d.title, d.body);
      db.exec("COMMIT");
    } else {
      db.exec("INSERT INTO fts_tri(fts_tri) VALUES('rebuild')");
    }
    phases.ftsTriMs = nowMs() - t;
  }

  // --- indexes ---------------------------------------------------------------
  {
    const t = nowMs();
    for (const sql of SCHEMA.indexes) db.exec(sql);
    phases.indexesMs = nowMs() - t;
  }

  const buildMs = nowMs() - total0;
  const tVac = nowMs();
  db.exec("VACUUM");
  phases.vacuumMs = nowMs() - tVac;
  db.exec("PRAGMA journal_mode = DELETE");

  const dbstat = dbstatBreakdown(db);
  let ftsRows = null;
  try {
    if (uni) ftsRows = Number(db.prepare("SELECT count(*) c FROM " + (contentless ? "fts_uni_c" : "fts_uni")).get().c);
  } catch {}
  db.close();

  const sizeBytes = statSync(file).size;
  return {
    file,
    sizeBytes,
    buildMs,
    totalMs: buildMs + phases.vacuumMs,
    phases,
    dbstat,
    ftsRows,
    tables: {
      docs: docs.length,
      changes: docs.reduce((a, d) => a + d.changes.length, 0),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tiers = args.all ? Object.keys(TIERS) : [args.tier];
  await mkdir(path.join(HERE, "db"), { recursive: true });
  await mkdir(path.join(HERE, "results"), { recursive: true });
  for (const tier of tiers) {
    const corpusDir = path.join(HERE, "corpus", tier);
    if (!existsSync(path.join(corpusDir, "docs"))) {
      console.log("[db] corpus missing for " + tier + ", run gen-corpus.mjs first");
      continue;
    }
    const t0 = nowMs();
    const files = await walkMarkdown(path.join(corpusDir, "docs"));
    const read0 = nowMs();
    const docs = [];
    for (const f of files) docs.push(parseDoc(f));
    const parseMs = nowMs() - read0;
    docs.sort((a, b) => a.id - b.id);
    const corpusBytes = docs.reduce((a, d) => a + d.bytes, 0);
    console.log("[db] " + tier + ": parsed " + docs.length + " docs in " + ((nowMs() - t0) / 1000).toFixed(2) + "s");

    const mk = (name) => path.join(HERE, "db", name + "-" + tier + ".db");
    const variants = {};
    variants.meta = await buildVariant({ file: mk("meta"), docs, withBody: false, uni: false, tri: false });
    variants.full = await buildVariant({ file: mk("full"), docs, withBody: true, uni: false, tri: false });
    variants.full_uni = await buildVariant({ file: mk("full_uni"), docs, withBody: true, uni: true, tri: false });
    variants.full_uni_tri = await buildVariant({ file: mk("full_uni_tri"), docs, withBody: true, uni: true, tri: true });
    variants.idxonly_uni_tri = await buildVariant({ file: mk("idxonly_uni_tri"), docs, withBody: false, uni: true, tri: true, contentless: true });

    const result = {
      tier,
      docs: docs.length,
      changes: variants.meta.tables.changes,
      corpusBytes,
      corpusBytesPerDoc: corpusBytes / docs.length,
      parseMs,
      walkMs: read0 - t0,
      variants,
    };
    await writeFile(path.join(HERE, "results", "db-" + tier + ".json"), JSON.stringify(result, null, 2));
    const f = (n) => (n / 1048576).toFixed(1) + " MiB";
    console.log("[db] " + tier + " sizes: meta=" + f(variants.meta.sizeBytes) + " full=" + f(variants.full.sizeBytes) +
      " full_uni=" + f(variants.full_uni.sizeBytes) + " full_uni_tri=" + f(variants.full_uni_tri.sizeBytes) +
      " idxonly_uni_tri=" + f(variants.idxonly_uni_tri.sizeBytes));
    console.log("[db] " + tier + " build: full_uni_tri=" + (variants.full_uni_tri.buildMs / 1000).toFixed(2) + "s" +
      " idxonly_uni_tri=" + (variants.idxonly_uni_tri.buildMs / 1000).toFixed(2) + "s");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
