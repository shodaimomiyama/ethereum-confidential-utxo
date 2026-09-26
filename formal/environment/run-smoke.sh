#!/bin/sh
set -eu

cd "$(dirname "$0")/../.."

image='runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204'
output_dir='formal/environment/out'
mkdir -p "$output_dir"

pnpm build
before=$(shasum -a 256 contracts/out/EnvironmentSmoke.t.sol/EnvironmentSmoke.json | cut -d ' ' -f 1)

docker run --rm --platform linux/amd64 -e KPROFILE_TELEMETRY_DISABLED=true \
  -v "$PWD:/workspace" -w /workspace "$image" \
  kompile formal/environment/model-smoke.k --backend haskell \
  --output-definition formal/environment/out/model-smoke-kompiled
docker run --rm --platform linux/amd64 -e KPROFILE_TELEMETRY_DISABLED=true \
  -v "$PWD:/workspace" -w /workspace "$image" \
  kprove formal/environment/model-smoke-spec.k \
  --definition formal/environment/out/model-smoke-kompiled \
  | tee "$output_dir/kprove.txt"
grep -qx '#Top' "$output_dir/kprove.txt"

docker run --rm --platform linux/amd64 -e KPROFILE_TELEMETRY_DISABLED=true \
  -v "$PWD:/workspace" -w /workspace "$image" \
  kontrol build --foundry-project-root /workspace/contracts --no-forge-build
for proof in contracts/out/proofs/'test%EnvironmentProofTest.test_provesAnswer()':*; do
  if [ -d "$proof" ]; then rm -rf "$proof"; fi
done
docker run --rm --platform linux/amd64 -e KPROFILE_TELEMETRY_DISABLED=true \
  -v "$PWD:/workspace" -w /workspace "$image" \
  kontrol prove --foundry-project-root /workspace/contracts \
  --match-test test_provesAnswer --schedule CANCUN --workers 1
docker run --rm --platform linux/amd64 -e KPROFILE_TELEMETRY_DISABLED=true \
  -v "$PWD:/workspace" -w /workspace "$image" \
  kontrol list --foundry-project-root /workspace/contracts \
  | tee "$output_dir/kontrol-list.txt"

after=$(shasum -a 256 contracts/out/EnvironmentSmoke.t.sol/EnvironmentSmoke.json | cut -d ' ' -f 1)
test "$before" = "$after"
node scripts/verify-formal-result.mjs "$image"
