#!/usr/bin/env bash
# research/bench/ext-bench.sh — run the rg / grep matrix and record per-command
# wall time, output size and the first-five distinct hit files.
#
# Usage: bash ext-bench.sh <tier> [warmRounds]
# Output: research/bench/results/ext-<tier>.tsv  (+ extfirst20-<tier>/ text files)
#
# Why Bash: the DSH sandbox blocks child_process spawning from Node, so external
# tools must be launched by the shell. EPOCHREALTIME (bash >= 5) gives us a
# microsecond clock without spawning anything extra.
# NOTE: no 'set -u' here — this MSYS/bash build errors on 'read -a' with it.
export LC_ALL=C
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

TIER="${1:-1k}"
ROUNDS="${2:-2}"
MANIFEST="results/ext-argv-${TIER}.tsv"
OUT="results/ext-${TIER}.tsv"
FIRST20_DIR="results/extfirst20-${TIER}"
TMP="${TMPDIR:-/tmp}/ext-bench-${TIER}-$$"

[ -f "$MANIFEST" ] || { echo "missing $MANIFEST -- run: node gen-ext-argv.mjs --tier $TIER" >&2; exit 1; }

rm -rf "$TMP" "$FIRST20_DIR"
mkdir -p "$TMP" "$FIRST20_DIR"
mapfile -t LINES <"$MANIFEST"
echo "[ext] $TIER: ${#LINES[@]} commands per pass"

TIMEOUT_BIN="$(command -v timeout || true)"

run_one() {
  # args: backend cat qidx pass cmd...
  local backend="$1" cat="$2" qidx="$3" pass="$4"
  shift 4
  local outfile="$TMP/out"
  local t0 t1 ms bytes lines files first20 hit5 status
  t0="${EPOCHREALTIME}"
  "$@" </dev/null >"$outfile" 2>/dev/null
  status=$?
  t1="${EPOCHREALTIME}"
  ms="$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.3f", (b - a) * 1000 }' </dev/null)"
  read -r bytes lines files first20 hit5 <<<"$(LC_ALL=C awk -F: -v lim=20 -v ff="$FIRST20_DIR/${backend}-${cat}-${qidx}.txt" '
    { lines++; bytes += length($0) + 1;
      if (lines <= lim) { first20 = bytes; print > ff }
      if (!($1 in seen)) { seen[$1] = 1; files++; if (files <= 5) hit5 = (files == 1 ? $1 : hit5 "|" $1) } }
    END { close(ff); printf "%d %d %d %d %s\n", bytes, lines, files, first20, hit5 }' "$outfile")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$backend" "$cat" "$qidx" "$pass" "$ms" "$bytes" "$lines" "$files" "$first20" "$status" "$hit5" >>"$OUT"
}

printf 'backend\tcat\tqueryIdx\tpass\tms\tbytes\tlines\tfiles\tfirst20\tstatus\thit5\n' >"$OUT"

# spawn-overhead baseline (7 runs each; first discarded in analysis)
for i in $(seq 1 7); do
  for b in rg grep; do
    if command -v "$b" >/dev/null 2>&1; then
      run_one "$b" spawn -1 "$i" "$b" --version
    fi
  done
done

run_pass() {
  local pass="$1"
  local line backend cat qidx argc
  local -a F ARGS
  for line in "${LINES[@]}"; do
    IFS=$'\t' read -r -a F <<<"$line"
    [ "${#F[@]}" -ge 4 ] || continue
    backend="${F[0]}"; cat="${F[1]}"; qidx="${F[2]}"; argc="${F[3]}"
    ARGS=("${F[@]:4}")
    if [ "${#ARGS[@]}" -ne "$argc" ]; then
      echo "bad argc: $backend $cat $qidx" >&2
      continue
    fi
    run_one "$backend" "$cat" "$qidx" "$pass" "$backend" "${ARGS[@]}"
  done
}

# pass 1 = cold-ish (fresh process for every command)
run_pass 1
echo "[ext] $TIER cold pass done"

# passes 2..ROUNDS+1 = warm repetitions (still a fresh process each time)
for ((r = 0; r < ROUNDS; r++)); do
  run_pass $((r + 2))
  echo "[ext] $TIER warm round $((r + 1)) done"
done

rm -rf "$TMP"
echo "[ext] $TIER -> $OUT ($(wc -l <"$OUT" | tr -d ' ') rows)"
