#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH_DIR="$(cd "$HERE/.." && pwd)"
REF_DIR="${1:?usage: run.sh INDEPENDENT_REFERENCE_CLONE RPC_URL}"
RPC_URL="${2:?usage: run.sh INDEPENDENT_REFERENCE_CLONE RPC_URL}"

mkdir -p "$HERE/raw"
cast rpc anvil_reset --rpc-url "$RPC_URL" > "$HERE/reset.log"

# The sender transaction runs and exits before the recipient process starts.
bash "$BENCH_DIR/run.sh" "$REF_DIR" "$RPC_URL" "$HERE/raw" > "$HERE/initial-run.log" 2>&1

# Remove the sender's generated private session; reuse.mjs only reads public
# events, the recipient's deterministic test keys, and immutable proving assets.
rm -f "$REF_DIR/build/integration/session.json" "$REF_DIR/build/pool/input.json" "$REF_DIR/build/auth_demo/input.json"
node "$HERE/reuse.mjs" "$REF_DIR" "$RPC_URL" "$HERE/reuse-result.json" > "$HERE/reuse.log" 2>&1
