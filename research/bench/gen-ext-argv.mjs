#!/usr/bin/env node
// research/bench/gen-ext-argv.mjs — emit a TSV manifest of rg / grep invocations
// for ext-bench.sh. Node cannot spawn child processes under the DSH sandbox, so
// the external tools are driven from Bash instead.
//
// Manifest line: backend \t category \t queryIndex \t argc \t arg1 \t ... \t argN
// Paths are relative to research/bench, so rg output starts with "corpus/...".

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAllQuerySets, rgArgsForQuery, grepArgsForQuery } from "./queries.mjs";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tiers = args.all ? Object.keys(TIERS) : [args.tier];
  await mkdir(path.join(HERE, "results"), { recursive: true });
  for (const tier of tiers) {
    const corpusRoot = "corpus/" + tier + "/docs";
    const sets = makeAllQuerySets();
    const lines = [];
    for (const [cat, queries] of Object.entries(sets)) {
      queries.forEach((q, i) => {
        for (const backend of ["rg", "grep"]) {
          const argv = backend === "rg" ? rgArgsForQuery(corpusRoot, q) : grepArgsForQuery(corpusRoot, q);
          lines.push([backend, cat, String(i), String(argv.length), ...argv].join("\t"));
        }
      });
    }
    const file = path.join(HERE, "results", "ext-argv-" + tier + ".tsv");
    await writeFile(file, lines.join("\n") + "\n");
    console.log("[ext-argv] " + tier + ": " + lines.length + " commands -> " + path.relative(HERE, file));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
