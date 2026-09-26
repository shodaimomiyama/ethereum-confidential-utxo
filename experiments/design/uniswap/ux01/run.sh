#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p outputs
forge clean
forge build vendor/v2-core/contracts/UniswapV2Factory.sol --use 0.5.16 > outputs/build-core.log 2>&1
forge build vendor/v2-periphery/contracts/UniswapV2Router02.sol vendor/v2-periphery/contracts/test/WETH9.sol --use 0.6.6 > outputs/build-periphery.log 2>&1
forge test --via-ir -vvv > outputs/forge-test.log 2>&1
anvil --port 18545 --chain-id 31337 --silent > outputs/anvil.log 2>&1 &
anvil_pid=$!
trap 'kill "$anvil_pid" 2>/dev/null || true' EXIT
ready=0
for _ in $(seq 1 40); do
  if cast block-number --rpc-url http://127.0.0.1:18545 > /dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [ "$ready" != 1 ]; then echo 'Anvil did not start' >&2; exit 1; fi
forge test --via-ir --fork-url http://127.0.0.1:18545 -vvv > outputs/anvil-fork-test.log 2>&1
