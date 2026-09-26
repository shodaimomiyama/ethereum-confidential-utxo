#!/usr/bin/env bash
set -euo pipefail

CASES_DIR="$(cd "$(dirname "$0")" && pwd)"
REFERENCE="${1:-/tmp/eip-8182-cases-issue10}"
RPC_URL="${2:-http://127.0.0.1:18556}"
SELECTED="${3:-all}"

if [ "$SELECTED" = all ]; then
  CASE_NAMES=(eth_withdraw_partial eth_withdraw_full erc20_withdraw_partial erc20_withdraw_full transfer_partial transfer_full merge s02_transfer_full_10 s03_transfer_partial_3 s04_transfer_2_plus_3 s05_self_split_10 s05_self_recreate_10 s06_eth_withdraw_full_10 s06_eth_withdraw_partial_3 s02_eth_transfer_full_10 s03_eth_transfer_partial_3 s04_eth_transfer_2_plus_3)
else
  CASE_NAMES=("$SELECTED")
fi
RUN_FAILED=0

for CASE_NAME in "${CASE_NAMES[@]}"; do
  CASE_OUT="$CASES_DIR/raw/$CASE_NAME"
  mkdir -p "$CASE_OUT"
  cast rpc anvil_reset --rpc-url "$RPC_URL" >"$CASE_OUT/reset.log"
  cast block 0 --rpc-url "$RPC_URL" --json >"$CASE_OUT/genesis.json"
  if {
    node "$CASES_DIR/generate.mjs" "$REFERENCE" "$CASE_NAME" &&
    node "$CASES_DIR/prove.mjs" "$REFERENCE" "$CASE_OUT" &&
    node "$CASES_DIR/receipt.mjs" "$REFERENCE" "$RPC_URL" "$CASE_OUT"
  } >"$CASE_OUT/run.log" 2>&1; then
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({case:process.argv[2],status:"passed",evidence:"receipts.json"},null,2)+"\n")' "$CASE_OUT/status.json" "$CASE_NAME"
    printf 'PASS %s\n' "$CASE_NAME"
  else
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({case:process.argv[2],status:"failed",evidence:"run.log"},null,2)+"\n")' "$CASE_OUT/status.json" "$CASE_NAME"
    printf 'FAIL %s (see %s)\n' "$CASE_NAME" "$CASE_OUT/run.log"
    RUN_FAILED=1
  fi
done
node "$CASES_DIR/summarize.mjs"
node -e 'const x=require(process.argv[1]);if(x.successful!==x.cases.length)process.exit(1)' "$CASES_DIR/summary.json"
exit "$RUN_FAILED"
