#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")" && pwd)"
REF_DIR="${1:-/tmp/eip-8182-reference-implementation}"
COMMIT=639baaf7b29c22eb43ba6150140902ea8dbbbc46

if [ ! -d "$REF_DIR/.git" ]; then
  git clone https://github.com/0xFacet/eip-8182-reference-implementation.git "$REF_DIR"
fi
cd "$REF_DIR"
git checkout --detach "$COMMIT"
git submodule update --init --recursive
npm ci
# The upstream package manifest omits a package imported by its witness scripts.
npm install --no-save ethereum-cryptography@2.2.1
mkdir -p build/pool
node scripts/circom/gen_domain_tags.js
vendor/circom circuits/pool/pool.circom -l circuits/common -l circuits/pool --r1cs --wasm --sym --O2 -o build/pool
cp sepolia-demo/prover-assets/pool_final.zkey build/pool/pool_final.zkey
cp sepolia-demo/prover-assets/pool_vkey.json build/pool/pool_vkey.json
./node_modules/.bin/snarkjs powersoftau new bn128 12 build/pot12_0000.ptau
./node_modules/.bin/snarkjs powersoftau contribute build/pot12_0000.ptau build/pot12_0001.ptau --name=issue10-local-dev -e=issue10-local-dev
./node_modules/.bin/snarkjs powersoftau prepare phase2 build/pot12_0001.ptau build/pot12_final.ptau
bash scripts/circuit/build_auth_demo.sh
if git apply --check "$BENCH_DIR/output-note-data.patch"; then
  git apply "$BENCH_DIR/output-note-data.patch"
else
  git apply --reverse --check "$BENCH_DIR/output-note-data.patch"
fi
forge build
(cd sepolia-demo && npm ci --ignore-scripts && npm run build:sdk)
printf 'upstream_commit=%s\n' "$(git rev-parse HEAD)"
shasum -a 256 build/pool/pool_final.zkey build/pool/pool_js/pool.wasm build/auth_demo/auth_demo_final.zkey
