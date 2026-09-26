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

## Poolと検証器の配置（Issue #27）

`pnpm artifact:pool` は `contracts/out/Pool.sol/Pool.json` から公開ABI、bytecode、AST、storage layoutと入力hashを `packages/ethereum/generated/pool-v1.json` に出力する。`pnpm check:pool` は現在のソースとコンパイル結果に照合する。`pnpm fixture:pool` は公開seedから20件の操作、署名、実範囲証明を一時ディレクトリに再生成し、固定ケースとFoundry calldataをbyte単位で比較する。Python依存は `tests/vectors/README.md` に従って導入し、`POOL_VECTOR_PYTHON` にそのvenvのPythonを指定する。

通常のコードサイズ・gas制限で動くAnvilを起動した後、次のように**明示したRPC、chain ID、fork名、署名鍵**で金額検証器とPoolを配置する。`--chain-id 11155111` とSepolia RPC、対象ブロックのfork名を指定しても同じ経路を使う。fork名はmanifestへ申告値として記録し、RPCから自動判定した値として扱わない。実際のSepolia取引と確認記録はIssue #36の対象である。

```sh
anvil --host 127.0.0.1 --port 18546 --chain-id 31337 --hardfork cancun --gas-limit 30000000
export POOL_DEPLOY_PRIVATE_KEY=<ローカル開発用鍵>
pnpm deploy:pool -- --rpc http://127.0.0.1:18546 --chain-id 31337 --hardfork cancun --out /tmp/ecu-pool-local.json
pnpm verify:pool -- --rpc http://127.0.0.1:18546 --manifest /tmp/ecu-pool-local.json
```

manifestには両コントラクトのアドレス、デプロイ取引とブロック、constructor引数のhash、runtime hash、検証器の固定パラメータhash、artifactの識別子を保存し、鍵やRPC認証情報は保存しない。再検査は実チェーンからruntime、検証器の全生成点・基底点、Pool内の検証器参照、取引入力とreceiptを読み直す。再起動で状態が消えるAnvilのmanifestは、その実行中のチェーンに対してのみ有効である。`node --test tests/environment/pool-deployment.test.mjs` は新しいAnvil上で配置と改変拒否を再現する。

### #27 の受入証拠

| 条件 | ローカルで確認する対象 |
| --- | --- |
| A-01 操作成功 | `contracts/test/PoolFlow.t.sol` の入金、全額・部分送金、統合、自己操作、受取人による再使用、全額・部分出金。固定ケースは `tests/vectors/cases/pool-operations.json` の `VEC-07-POOL-*` |
| A-02 形と上限 | `PoolAuthorization.t.sol` の個数、入力順、packet、公開額 `M`・`W` の拒否と `PoolFlow.t.sol` の `M+M`・`W` 正常例 |
| A-03 ゼロアドレス | `PoolAuthorization.t.sol` の出力所有者・出金先拒否、`PoolWithdrawal.t.sol` のPool自己宛て正常例、`VEC-01-ZERO-*` |
| A-04 認可と文脈 | `PoolBinding.t.sol` のID、`PoolAuthorization.t.sol` の署名境界、`PoolFlow.t.sol` のchain/Pool変更拒否と第三者提出 |
| A-05 再使用と競合 | `PoolFlow.t.sol` の成功済み操作・消費済み入力の拒否 |
| A-06 証明器境界 | `PoolProofBoundary.t.sol` のfalse・revert・空・短長・2の戻り値、`PoolFlow.t.sol` の実v3検証器と非ゼロblinding |
| A-07 出金と再入 | `PoolWithdrawal.t.sol` の再入捕捉・伝播・受領拒否・大きい戻り値 |
| A-08 原子性と会計 | `PoolWithdrawal.t.sol` と `PoolInvariant.t.sol` の失敗後状態、通常・強制・返却ETH、`B=L+E` |
| A-09 観測ABI | `PoolFlow.t.sol` の実event topic/data/順序、`PoolState.t.sol` の照会、`test-pool-abi.mjs` のselector |
| A-10 不変条件 | `PoolInvariant.t.sol` の未使用額合計と帳簿、`PoolState.t.sol` の消費済み記録保持 |
| A-11 配置とartifact | `pool-artifact-guard.test.mjs`、`pool-deployment.test.mjs`、`pnpm check:pool`、保存manifestの再検査 |

通常のPool操作は実 verifier・公開試験鍵・固定のローカルchain ID/Poolアドレスで確認する。異常なverifier返値だけは合成コントラクトを使う。Pool専用packetの復号可能性、実Sepoliaの取引確定、実コードの形式証明はそれぞれ #36 と #33 に引き渡す。
