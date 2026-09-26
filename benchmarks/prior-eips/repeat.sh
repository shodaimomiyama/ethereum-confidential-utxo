#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REF_DIR="${1:-/tmp/eip-8182-reference-implementation}"
RPC_URL="${2:-http://127.0.0.1:18545}"
OUT_DIR="${3:-$BENCH_DIR/raw/repeated}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
for trial in warmup trial-1 trial-2 trial-3; do
  cast rpc anvil_reset --rpc-url "$RPC_URL" >"$OUT_DIR/$trial-reset.log"
  cast block 0 --rpc-url "$RPC_URL" --json >"$OUT_DIR/$trial-genesis.json"
  node "$BENCH_DIR/timeout.mjs" 120 bash "$BENCH_DIR/run.sh" "$REF_DIR" "$RPC_URL" "$OUT_DIR/$trial" >"$OUT_DIR/$trial-run.log" 2>&1
done
node "$BENCH_DIR/aggregate.mjs" "$OUT_DIR"
