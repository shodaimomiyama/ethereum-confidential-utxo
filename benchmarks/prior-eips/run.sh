#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REF_DIR="${1:-/tmp/eip-8182-reference-implementation}"
RPC_URL="${2:-http://127.0.0.1:18545}"
OUT_DIR="${3:-$BENCH_DIR/raw}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
cd "$REF_DIR"
node scripts/witness/gen_pool_witness_input.js
delivery_start_ms="$(node -p 'Date.now()')"
node "$BENCH_DIR/delivery/prepare.mjs" \
  --reference "$REF_DIR" \
  --witness "$REF_DIR/build/pool/input.json" \
  --chain-id 1 \
  --pool-address 0x0000000000000000000000000000000000081820 \
  --output "$OUT_DIR/delivery.json" >/dev/null
delivery_end_ms="$(node -p 'Date.now()')"
printf '{"wallMs":%s,"scope":"delivery/prepare process, including keypair derivation, three envelope encryptions, and file write"}\n' "$((delivery_end_ms-delivery_start_ms))" >"$OUT_DIR/delivery-wall.json"
session_start_ms="$(node -p 'Date.now()')"
ISSUE10_DELIVERY_JSON="$OUT_DIR/delivery.json" node scripts/integration/build_session.js >"$OUT_DIR/session.log" 2>&1
session_end_ms="$(node -p 'Date.now()')"
printf '{"wallMs":%s,"scope":"complete upstream build_session process, including input preparation, both witnesses, both proof generations, local verification, and output write"}\n' "$((session_end_ms-session_start_ms))" >"$OUT_DIR/session-wall.json"
cp build/integration/session.json "$OUT_DIR/session.json"
cp build/integration/timings.json "$OUT_DIR/timings.json"
cp build/pool/input.json "$OUT_DIR/pool-input.json"
cp build/auth_demo/input.json "$OUT_DIR/auth-input.json"
shasum -a 256 build/pool/pool_final.zkey build/pool/pool_js/pool.wasm build/auth_demo/auth_demo_final.zkey build/auth_demo/auth_demo_vkey.json >"$OUT_DIR/asset-hashes.txt"
node "$BENCH_DIR/receipt.mjs" "$REF_DIR" "$RPC_URL" "$OUT_DIR/receipts.json" "$OUT_DIR/delivery.json"
node "$BENCH_DIR/delivery/sync.mjs" \
  --reference "$REF_DIR" \
  --delivery "$OUT_DIR/delivery.json" \
  --rpc-url "$RPC_URL" \
  --from-block 0 \
  --output "$OUT_DIR/sync.json" >"$OUT_DIR/sync.log" 2>&1
