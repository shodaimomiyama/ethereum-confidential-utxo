# ローカル開発環境（Issue #4）

この手順は [Issue #38](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/38) 以降の本体実装に先立ち、ビルド、テスト、ローカルRPC、K/Kontrolの入口が動くことを確かめる。スモーク対象は小さな `EnvironmentSmoke` であり、機密UTXO本体の正しさや安全性を証明しない。CIと公開ネットワークは対象外。

## 確認済みの環境と固定版

2026-09-27にmacOS 26.5 / Apple Silicon arm64 / ホストRAM 32 GiBで確認した。Node.js 24.21.0、pnpm 10.34.5、Foundry（forge、cast、anvil）1.8.3、Solidity 0.8.37を使う。`package.json` と `pnpm-lock.yaml` がJS依存の固定値で、`contracts/foundry.toml` がSolidity設定である。別のmacOS版、Intel Mac、Ubuntuは未確認。

形式検証にはDocker Desktopの `linux/amd64` エミュレーションを使う。確認時のDocker Engineは28.3.0、VMメモリ16 GiB、ディスク上限100 GiB。Kontrol公式イメージは `runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204` に固定され、Kontrol 1.0.255とK v7.1.337を含む。初回取得と定義生成には大きな空き容量と時間が必要である。Docker DesktopのResourcesでメモリとディスクを設定し、Engineが起動することを確認する。

KontrolのNixパッケージを先に試したが、[上流Kontrolの固定commitのflake](https://github.com/runtimeverification/kontrol/blob/98fdebb7fce26b8764705a625cd2fbb01f27d6be/flake.nix)に対する `packages.x86_64-linux.kontrol.drvPath` 評価が `stack overflow (possible infinite recursion)` で停止した。評価コマンドは `nix --extra-experimental-features 'nix-command flakes' eval --raw 'github:runtimeverification/kontrol/98fdebb7fce26b8764705a625cd2fbb01f27d6be#packages.x86_64-linux.kontrol.drvPath'`。これは2026-09-27のローカル調査結果であり、上流が一般に利用不能だという主張ではない。この結果を受けた[Issue #4の採用基準](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/4)に従い、[Runtime Verificationのコンテナ配布元](https://hub.docker.com/r/runtimeverificationinc/kontrol)のイメージを上記digestで固定する。

版と設定の正本は[Architecture](../architecture.md)、[pnpm依存lock](../../pnpm-lock.yaml)、[Foundry設定](../../contracts/foundry.toml)である。形式検証の実際のコマンドと判定は[スモーク実行スクリプト](../../formal/environment/run-smoke.sh)と[結果検査コード](../../scripts/verify-formal-result.mjs)で確認できる。確認時の結果は下記のコマンドで `formal/environment/out/result.json` に再生成する。

## 初回セットアップ

Git、Xcode Command Line Tools、Docker Desktop、Nodeの版管理ツール（例: nvm）、`foundryup` を用意する。リポジトリをcloneしてルートで実行する。

```sh
nvm install 24.21.0
nvm use 24.21.0
corepack enable pnpm
corepack prepare pnpm@10.34.5 --activate
foundryup -i v1.8.3
node --version
pnpm --version
forge --version
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check
pnpm smoke:rpc
pnpm smoke:formal
```

`pnpm build` は `scripts/check-tools.mjs` でOS、CPUとツール版を検査してからSolidityをコンパイルし、正式artifactからABIとhash manifestを生成する。export時にコンパイラmetadataのソースhash、対象contract、設定と現在の入力を照合する。`pnpm test` は小さなFoundryテストとartifact整合性を検査する。`pnpm check` はTypeScriptとSolidityの形式チェックを行う。`pnpm smoke:rpc` はローカルAnvilを一時起動し、生成ABIとcreation bytecodeをartifactに照合した上でdeploy・`answer() == 42`・runtime bytecode一致を確認して停止する。公開RPC、実鍵、資金は不要。

`pnpm smoke:formal` はイメージをdigestで取得し、Kの `tick 0 => 1` が `#Top` になることを確認する。macOSのFoundryが生成した正式artifactをコンテナへ共有し、Kontrolには `--no-forge-build` を渡す。実行前後のartifact hashが変わった場合は失敗する。Kontrolの対象命題は `test_provesAnswer()` で、Cancun・worker 1で走る。終了時には `PASSED`、`admitted: False`、pending/failing/vacuous/stuck/bounded が全て0であることを検査する。Kの期待値を1→2、Kontrolの期待値を42→43に変えた検査では、それぞれ失敗することを確認済み。

生成物は `contracts/out/`、`contracts/cache/`、`packages/ethereum/generated/environment-smoke.json`、`formal/environment/out/` に置く。`formal/environment/out/result.json` にはイメージdigest、対象artifact/runtime、K/Kontrol定義とproofのSHA-256、schedule、node数と判定が残る。これらはGit管理せず、消した場合は上記コマンドで再生成する。

artifact全体のSHA-256はコンパイル対象の集合やAST採番によって変わり得るため、別clone間で同一値を要求しない。各実行内でmanifestとの一致と、形式検証前後にartifactが不変であることを検査する。runtime bytecodeのSHA-256はクリーンcloneでも `335a34830484ae2c637f1e8a149a4a925bb5217fc25e4dd84f292e775170cdbe` だった。

版違いのエラーが出たら `node --version`、`pnpm --version`、`forge --version` を確認する。Dockerのメモリ不足、ディスク不足、アーキテクチャ不一致では形式検証を成功とみなさず、Docker DesktopのResources、`docker info`、`docker image inspect` を確認して再実行する。タイムアウト、OOM、compiler mismatch、未解決proofも成功ではない。Kontrolの証明は1命題60分、RAM 16 GiB、worker 1を上限目安とする。

Anvilの初期アカウントと鍵はローカルテスト専用。実鍵、RPC認証情報、秘密の環境変数をコミットしたり、ログ・manifestに記録したりしない。既存の[先行EIPベンチマーク](../../benchmarks/prior-eips/)はNode.js 22 / Foundry 1.7.1の独立した経路であり、この開発入口の検証結果には含めない。
