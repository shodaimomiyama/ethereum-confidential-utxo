#!/usr/bin/env bash
set -euo pipefail

CASES_DIR="$(cd "$(dirname "$0")" && pwd)"
REFERENCE="${1:-/tmp/eip-8182-cases-issue10}"
RPC_URL="${2:-http://127.0.0.1:18556}"
CASE_NAME=s04_eth_transfer_2_plus_3

for trial in 1 2 3; do
  bash "$CASES_DIR/run-encrypted.sh" "$REFERENCE" "$RPC_URL" "$CASE_NAME"
  TRIAL_DIR="$CASES_DIR/eth-repeat/trial-$trial"
  mkdir -p "$TRIAL_DIR"
  cp -R "$CASES_DIR/encrypted/$CASE_NAME/." "$TRIAL_DIR/"
done
node "$CASES_DIR/summarize-eth-repeat.mjs"
cp -R "$CASES_DIR/eth-repeat/trial-1/." "$CASES_DIR/encrypted/$CASE_NAME/"
node "$CASES_DIR/summarize-encrypted.mjs"
