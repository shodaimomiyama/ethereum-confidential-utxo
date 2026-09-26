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

## Issue #60: Sepolia公開RPCの読取検査

Issue #60のローカル資産単体環境は、Node 24.21.0、pnpm 10.34.5、Foundry 1.8.3で追試する。`pnpm install --frozen-lockfile` 後、`pnpm artifact:uniswap`、`pnpm check:uniswap`、`pnpm build`、`pnpm test`、`pnpm check`、`node --test tests/environment/uniswap-*.test.mjs` を実行する。Uniswapのソースは `vendor/uniswap-v2/source-lock.json` のcommit/hash、生成ABIとbytecodeは `packages/ethereum/generated/uniswap-v2.json` に固定する。

別端末で `anvil --host 127.0.0.1 --port 8545 --chain-id 31337` を起動し、この一時チェーンの管理アカウントを `--holder` と `--lp-recipient` に指定する。以下の `LOCAL_HOLDER` はAnvil上の公開アドレスのみであり、秘密鍵をファイルやコマンドに渡さない。`LOCAL_MANIFEST` と `LOCAL_SNAPSHOT` は新しい一時ファイルのパスにする。

```sh
pnpm uniswap:local:deploy -- --rpc-url http://127.0.0.1:8545 --chain-id 31337 --manifest "$LOCAL_MANIFEST" --generation local-demo --holder "$LOCAL_HOLDER" --lp-recipient "$LOCAL_HOLDER"
pnpm uniswap:local:verify -- --rpc-url http://127.0.0.1:8545 --chain-id 31337 --manifest "$LOCAL_MANIFEST"
pnpm uniswap:local:snapshot -- --rpc-url http://127.0.0.1:8545 --chain-id 31337 --manifest "$LOCAL_MANIFEST" --snapshot "$LOCAL_SNAPSHOT"
pnpm uniswap:local:reset -- --rpc-url http://127.0.0.1:8545 --chain-id 31337 --manifest "$LOCAL_MANIFEST" --snapshot "$LOCAL_SNAPSHOT"
```

deployはdUSD、WETH、Uniswap v2 Factory/Router/Pairと初期流動性を作り、manifestを照合する。同じmanifestでの再deployは新しい流動性を投入せず照合に切り替わる。送信結果が不明な場合は `.attempt.json` を残して自動再送を拒否するため、nonce、receipt、code、Pair reserveを調べてから復旧する。snapshot/resetは資産単体に限り、reset後にはsnapshot IDが更新される。正式Pool/Adapter、配布サービス、サイトを含む環境のresetは、それぞれの成果物とDO停止・世代管理が揃ってから有効化する。

`.github/workflows/uniswap-environment.yml` はmacOS 15 arm64上で同じ固定版、ソース/Artifact照合、build/test/check、Anvilへの資産単体配置・再照合・snapshot/resetを実行する。公開RPC、Secrets、実資金は使わない。2026-09-27にcommit `10d2fcf` の[GitHub Actions実run](https://github.com/shodaimomiyama/ethereum-confidential-utxo/actions/runs/36267663500)で全工程が成功した。手元のmacOS 26.5 arm64での結果とは区別し、第三者の独立追試は別途確認する。

2026-09-27に [Uniswap公式のv2配置一覧](https://developers.uniswap.org/docs/protocols/v2/deployments) のSepolia Factory `0xF62c03E08ada871A0bEb309762E260a7a6a880E6` とRouter02 `0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3` を確認した。Routerの `WETH()` を実チェーンで読み、`0xfff9976782d46cc05630d1f6ebab18b2324d6b14` を得た。[PublicNode](https://ethereum.publicnode.com/)を候補にし、`https://ethereum-sepolia-rpc.publicnode.com` のread-only検査を実行した。これは実行時点の観測結果であり、公開配置時にも再検査する。

```sh
export UNISWAP_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
export UNISWAP_BROWSER_ORIGIN=https://demo.example
export UNISWAP_SEPOLIA_BLOCK=11788121
pnpm uniswap:sepolia:probe
```

この検査はchain ID 11155111、finalizedに含まれる指定blockのhashとcanonical照合、block hash指定の過去残高・code、指定blockのlogs、ブラウザのCORS preflight/POST、Factory・Router・WETHのcodeとRouterの参照先を確認する。結果にはRPC URLを含めない。2026-09-27の上記block hashは `0x51592207abe7ff93a65cfb5c7ed1d7393194508ddab2372f2833cf0994838e7c` で、検査は成功した。RPCの可用性と制限時の挙動は継続保証ではない。

専用の新規walletによるfaucetの実受取、受取tx、必要gasは未実施。署名者とfaucetの条件が揃った時点で別途検査し、未実施を成功と扱わない。SepoliaへのdUSD/Pool/Adapterの配置も未実施である。

### #60受入証拠の現状（2026-09-27）

以下の「成功」は記載した範囲だけを指す。局所Anvilの資産試験を実Pool・実暗号・公開取引の合格へ読み替えない。各コマンドはこの節の固定版セットアップを前提とする。

| 受入 | 対象commit・artifactと実行証拠 | 期待と実結果・状態 | 引渡し先 |
| --- | --- | --- | --- |
| A-01 資産 | `1b1af6d`、`DemoUSD.sol`、`forge test --root contracts` | 固定供給・名称・桁数・送付/承認のテスト成功。発行先・残余/LP先はローカルmanifestで照合済み | #56 |
| A-02 Uniswap | `673c26d`・`4efb68c`、`vendor/uniswap-v2/source-lock.json`、`packages/ethereum/generated/uniswap-v2.json`、`pnpm artifact:uniswap && pnpm check:uniswap` | ソースhash、compiler、Pair init code hash、ローカル配置tx入力・receiptと固定artifactの照合成功。Sepolia公式コードは下記A-06の別検査 | #56・#55 |
| A-03 ローカル初期状態 | `92923a9`・`4607647`・`4efb68c`、`node --test tests/environment/uniswap-local.test.mjs`、上記Anvilコマンド | forkなし配置・初期reserve・実Router交換・資産snapshot復元とcheckpointでの余剰dUSD/LP残高照合に成功。正式Poolの結合は未実施 | #56・#45 |
| A-04 再実行 | `92923a9`・`4607647`、同じローカルテストとdeploy→verify→deploy、snapshot→reset | 二重流動性投入を防ぎ、結果不明の再送を停止する局所試験は成功。DOを含む全体resetは #57 interface待ち | #57・#48 |
| A-05 正式構成 | #27 Pool配置成果と #56 Adapter artifactを入力とする | 未実施。正式ABI・manifestを受領してから専用PoolとAdapterを配置・code/参照先を照合する | #27・#56・#45 |
| A-06 公開準備 | `b74a3a5`、`pnpm uniswap:sepolia:probe`、checkpoint 11788121 | 公式Factory/Router/WETH、RPC履歴・logs・finalized・CORSは成功。faucet実受取、制限時挙動、公開配置は未実施 | #45〜#50 |
| A-07 配信・保存設定 | #53/#54/#57/#58/#59 のbuild・DO・Worker interfaceが入力 | 未実施。受領後に同一origin、migration、Secrets欠落停止をローカルruntimeと実配置で照合する | #47・#50 |
| A-08 復旧引渡し | #57/#58 の停止・保存・配布interfaceが入力 | 未実施。手動補充、DB巻戻り、停止/再開、バックアップ/復元を局所試験して #48へ渡す | #48 |
| A-09 CI・追試 | `209792b`・`10d2fcf`、`.github/workflows/uniswap-environment.yml`、`pnpm build/test/check`と20件のUniswap環境テスト、[CI実run](https://github.com/shodaimomiyama/ethereum-confidential-utxo/actions/runs/36267663500) | macOS 26.5 arm64とGitHub macos-15 arm64で成功。第三者の独立追試は未実施 | #19・#20 |
| A-10 証拠・引渡し | 本節、各commit・manifest・ローカル試験 | 進行中。公開URL/txと正式統合結果は存在せず、受領後に各検証Issueへ追加する | #45〜#50・#19・#20 |

## Uniswap支払いAdapterの成果物（Issue #56）

`pnpm artifact:uniswap-payment` はSolidityコンパイラの `UniswapPaymentAdapter.json` からABI、生成・実行bytecode、immutable参照、AST、storage layout、metadataと入力ソースhashを `packages/ethereum/generated/uniswap-payment-v1.json` へ出力する。`pnpm check:uniswap-payment` は現在のコンパイル結果とソースに完全照合する。`pnpm build/test/check` にもこの生成・検査を組み込んでいる。公開ABIはこの生成物を正本とし、別に手書きしない。

#60の資産manifestへAdapterを追加する際は、同じ配置世代とchain IDに属するPool、Router02、Factory、WETH、dUSD、Pairの6アドレスをこの順でconstructorへ渡す。デプロイ取引の入力から6引数を再取得し、配置後の6 getter、各アドレスのcode、Routerの `factory()` / `WETH()`、Factoryの `getPair(WETH,dUSD)`、Pairの `factory()` / `token0()` / `token1()` を再読する。Adapterの実行bytecodeはimmutable埋込み後の値を取得してhashを保存・照合し、固定artifactの `immutableReferences` を使って埋込み以外の差分がないことも確認する。Pool・dUSD・Uniswap各契約はそれぞれの正式artifact/manifestのruntimeと照合する。constructorの関係検査だけでは、同じ返値を装う別コードを排除できない。失敗時には資産manifestを正式な全体配置成功へ昇格させない。#60の `deployConnection({ poolManifest, poolManifestPath, adapterArtifact, assetManifest, signer, publicClient, excludedPoolAddress })` は #27の配置経路で保存した専用Pool manifestを読み、Adapterを配置して資産manifestへ接続情報を追加する。`verifyConnection(manifest, publicClient)` は保存Pool manifestのパス・内容hash、Pool/Verifier配置、Adapterの生成取引・固定参照・実行codeを再照合する。ローカル実証は `node --test tests/environment/uniswap-integration.test.mjs` で再現する。`uniswap:local:*` は引き続き資産単体を扱い、公開テストネットの全体配置CLIは別途用意する。

### #56の局所受入記録

2026-09-27、#56の実装commitは `d25b08f`・`107f389`・`1da9841`・`558b991`・`4e7b2fd`・`9f5d115`・`e346cc2`。#60は確定commit `5e2bc99` をmerge `4ff2422` で受領した。使用版はmacOS arm64、Node 24.21.0、pnpm 10.34.5、Foundry 1.8.3、solc 0.8.37、optimizer 200、viaIR=false、Cancun。`vendor/uniswap-v2/source-lock.json` のSHA-256は `b79877dc7e39d52fbec7dd44933bb176fde1e8d855c560bfcd8cfd0ecf8bb5b9`、`uniswap-v2.json` は `15f59154adb078eb6e7acd64f499a40ff7f0df11a2f24f9baaf0c33ce8aeee46`、Pair init code hashは `0x730b60d8659dba7089b26ec3c5b93e948a9e179fd7a2db2d3c15732d610c2061`。Pool runtime SHA-256は `3fe229dd1351eb85e1d409457c37032651c03248520f2b7a8b1294b3e62077f8`、dUSD runtimeは `bb8e1f57ad35ffde78f29ecd191695bb4624c87ec4e06c560bbd36f33487f50d`、Adapterのimmutable埋込み前runtimeは `debea6b9655182a65f3f3ee5cd6f201e16660f117fe47a8e0b0704805b80b4a2`。実配置ごとのAdapter runtime hashは6アドレスで変わるため、上記template hashとそのまま比較しない。

署名ベクトル `tests/vectors/cases/uniswap-payment.json` のSHA-256は `4454703116158b55568476803ea2d815500ba81688938e2a3fe69918ffda12fa`、実証明の専用ケースは `9eb25969aff1c72119e32cbc924f7693a766a6217f23d53436c7cbb65b2da866`、Foundry calldataは `967d4f697d9d28a7b3243d02245b6cc5053660f30e2491bd7aa8468147c320e2`。結合harnessはchain ID 31337、Pool `0x1111111111111111111111111111111111111111`、Adapter `0x2222222222222222222222222222222222222222`、初期流動性0.1 ETHと10,000 dUSD、入力UTXO `6×10^15 wei`、使用額 `3×10^15 wei` と `6×10^15−1 wei` を用いる。Router/Factory/WETH/dUSD/Pairは各試験で新規配置し、アドレスを公開配置の値とみなさない。

次の表の `Auth` は `AdapterAuthorization.t.sol`、`Pay` は `AdapterPayment.t.sol`、`Rollback` は `AdapterRollback.t.sol`、`Real` は `AdapterRealFlow.t.sol` を指す。いずれも `forge test --root contracts --match-path 'test/integration/uniswap/<ファイル名>'` で再実行できる。`Auth/Pay/Rollback` の外部先は制御stub、`Real` は実Pool・Verifier・固定Uniswap/dUSDである。仕様のS番号全体が完了したという意味ではなく、記載した局所分岐の結果である。

| 仕様 | 局所試験名と層 | 結果と残る分岐 |
| --- | --- | --- |
| S-03 | `Auth.test_allForbiddenRecipientsAndZeroMinimum`、`Real.test_realOneWeiRemainder` | 正の額は実結合で成功。UIの負値・精度超過、直接呼出しの全範囲外は未検証 |
| S-04 | `Auth.test_requestMutationAndDirectWithdrawalAreRejected`、`Real.test_realOneWeiRemainder` | 形と正残額の代表例。`w=V`・`w>V`・複数入力の個別実結合は未検証 |
| S-05 | `Real.test_realOneWeiRemainder` | `r=1 wei` の実証明と交換が成功 |
| S-06 | `Rollback.test_failedAttemptCanRetryAndSuccessfulPaymentCannotRepeat`、`Real.test_realCompetingOperationConsumesInputFirst` | 使用済み入力の再提出を拒否。不存在・他ownerの実結合は未検証 |
| S-07 | `Auth.test_allForbiddenRecipientsAndZeroMinimum` | `m=0` を拒否。UIの負値・端数・上限と境界一致は未検証 |
| S-08 | `Real.test_realMinimumFailureRollsBackPoolAndPair`、`Real.test_realPaymentConsumesInputAndDeliversAllTokens` | 未達を取消、超過を全量着金。`q=m` の一致境界は未検証 |
| S-09 | `Pay.test_existingEthIsNotSpent`、`Pay.test_rejectsSwapReturnAndDeliveryMismatch` | 残留・返値不一致をstubで拒否。実Routerの部分交換経路は固定APIでは利用しない |
| S-10 | `Pay.test_rejectsSwapReturnAndDeliveryMismatch`、`Rollback.test_swapAndDeliveryFailuresRollbackEvenWhenOuterCallerCatches` | 不足着金をstubで拒否。別token/中間先の敵対的経路は固定dUSDの対象外 |
| S-11 | `Pay.test_payTransfersAllOutputAndRecordsPayment`、`Real.test_realPaymentConsumesInputAndDeliversAllTokens` | recipient既存残高を交換分へ算入しない。処理中の無関係入金との競合は未検証 |
| S-12 | `Pay.test_rejectsSwapReturnAndDeliveryMismatch` | 処理中の残高不足を拒否。成功後の受取人による転送は未検証 |
| S-13 | `Real.test_realPaymentConsumesInputAndDeliversAllTokens` | Poolの残額生成と入力消費まで確認。受領・再送金・同期は #46 |
| S-14 | `Auth.test_eachPaymentFieldMutationInvalidatesSignature` | `w,T,m,R,d` の各改変を拒否 |
| S-15 | `Auth.test_requestMutationAndDirectWithdrawalAreRejected`・`test_wrongDomainAndPoolAreRejectedForOtherwiseValidTerms`、`Real.test_changedWithdrawalDestinationRejectsSignedPoolRequest` | 入力・残額・出金先、EIP-712のchain/Adapter domain、別Pool操作ID、非正規署名を拒否。別Poolでの実取引は未検証 |
| S-16 | `Auth.test_deadlineBoundaryAndForbiddenRecipient` | `τ=d` を受理し `τ>d` を拒否。`τ<d` は通常成功経路で確認 |
| S-17 | `Auth.test_deadlineBoundaryAndForbiddenRecipient` | 実行時刻で再判定。事前見積りからの経時UIは未検証 |
| S-18 | `Rollback.test_poolFailuresRollbackEvenWhenOuterCallerCatches`、`Real.test_realMinimumFailureRollsBackPoolAndPair` | Pool/Router失敗と実Pair未達の取消。実取引の資源不足は未検証 |
| S-19 | `Rollback.test_swapAndDeliveryFailuresRollbackEvenWhenOuterCallerCatches` | swap後の不足着金をstubで取消。実dUSDでは不足着金挙動を作れない |
| S-20 | `Auth.test_requestMutationAndDirectWithdrawalAreRejected`、`Rollback.test_swapAndDeliveryFailuresRollbackEvenWhenOuterCallerCatches` | 切出し要求と外側catch後の内部状態を検査 |
| S-21 | `Rollback.test_sameSignedPaymentOnlyFirstSubmitterSucceeds`・`test_failedAttemptCanRetryAndSuccessfulPaymentCannotRepeat` | 同一署名を異なる提出者から出し、初回のみ成功。別経路の公開取引履歴は #45 |
| S-22 | `Rollback.test_differentOperationConsumesInputBeforePayment`、`Real.test_realCompetingOperationConsumesInputFirst` | 異なる認可済み操作による入力先行消費後、後続支払いを拒否し先行成功を維持。認可後の並行取引競合は未検証 |
| S-23 | `Rollback.test_reentryIsRejectedWhileOuterPaymentCanSucceed`・`test_propagatedReentryRollsBackOuterPayment` | 内側拒否をcatchした外側成功と伝播取消を検査 |
| S-24 | `Rollback.test_propagatedReentryRollsBackOuterPayment` | この実装は全pay再入を拒否するため「内側受理」分岐は適用不能。伝播時の外側取消を確認 |

実行結果は `pnpm build`、`pnpm test`（Foundry 102/102、環境・暗号テスト成功）、`pnpm check`、`pnpm check:uniswap-payment`、`pnpm check:uniswap`、`pnpm check:pool`、`forge test --root contracts`、`node tests/vectors/tools/oracle-uniswap-payment.mjs`、`POOL_VECTOR_PYTHON=<venvのPython> node scripts/generate-pool-fixtures.mjs --uniswap` が成功。`Real` は5/5で、正常支払い、1 wei残額、最低額未達のPool/Pair/recipient/Adapter取消、Pool出金先書換え拒否を確認した。#55へ生成ABIと独立ベクトル、#60へ6参照のconstructor/getter・artifact/manifest条件、#45へ局所harnessと未検証分岐を渡す。独立Anvil全体配置、manifestによる実Adapter runtime照合、Sepolia実取引、UI/受領・同期、形式証明、第三者の独立追試は未実施。

## Poolと検証器の配置（Issue #27）

`pnpm artifact:pool` は `contracts/out/Pool.sol/Pool.json` から公開ABI、bytecode、AST、storage layoutと入力hashを `packages/ethereum/generated/pool-v1.json` に出力する。`pnpm check:pool` は現在のソースとコンパイル結果に照合する。`pnpm fixture:pool` は公開seedから25件の操作、署名、実範囲証明を一時ディレクトリに再生成し、固定ケースとFoundry calldataをbyte単位で比較する。Python依存は `tests/vectors/README.md` に従って導入し、`POOL_VECTOR_PYTHON` にそのvenvのPythonを指定する。

通常のコードサイズ・gas制限で動くAnvilを起動した後、次のように**明示したRPC、chain ID、fork名、署名鍵**で金額検証器とPoolを配置する。`--chain-id 11155111` とSepolia RPC、対象ブロックのfork名を指定しても同じ経路を使う。fork名はmanifestへ申告値として記録し、RPCから自動判定した値として扱わない。実際のSepolia取引と確認記録はIssue #36の対象である。

```sh
anvil --host 127.0.0.1 --port 18546 --chain-id 31337 --hardfork cancun --gas-limit 30000000
export POOL_DEPLOY_PRIVATE_KEY=<ローカル開発用鍵>
pnpm deploy:pool -- --rpc http://127.0.0.1:18546 --chain-id 31337 --hardfork cancun --out /tmp/ecu-pool-local.json
pnpm verify:pool -- --rpc http://127.0.0.1:18546 --manifest /tmp/ecu-pool-local.json
```

manifestには両コントラクトのアドレス、デプロイ取引とブロック、constructor引数のhash、runtime hash、検証器の固定パラメータhash、artifactの識別子を保存し、鍵やRPC認証情報は保存しない。再検査は実チェーンからruntime、検証器の全生成点・基底点、Pool内の検証器参照、取引入力とreceiptを読み直す。再起動で状態が消えるAnvilのmanifestは、その実行中のチェーンに対してのみ有効である。`node --test tests/environment/pool-deployment.test.mjs` は新しいAnvil上で配置と改変拒否を再現する。
出力先の既存ファイルと作成不能なディレクトリは送信前に拒否する。送信後の照合などで失敗した場合は `<manifest>.pending.jsonl` に採掘済み取引hashとアドレスを残す。成功時はその記録を削除する。

### #27 の受入証拠

| 条件 | ローカルで確認する対象 |
| --- | --- |
| A-01 操作成功 | `contracts/test/PoolFlow.t.sol` の入金、全額・部分送金、統合、自己操作、送金先・釣銭・出金残額の再使用、全額・部分出金、本人EOAへの出金。第三者EOAと受領可能コントラクトへの出金も固定ケース `VEC-07-POOL-*` で確認 |
| A-02 形と上限 | `PoolAuthorization.t.sol` の3入力、過剰出力、証明件数、入力順、packet、非正規点、公開額 `M`・`W` の拒否。`PoolFlow.t.sol` の実検証器による非正規scalar・金額0出力の拒否と `M+M`・`W` 正常例 |
| A-03 ゼロアドレス | `PoolAuthorization.t.sol` の出力所有者・出金先拒否、`PoolWithdrawal.t.sol` のPool自己宛て正常例、`VEC-01-ZERO-*` |
| A-04 認可と文脈 | `PoolBinding.t.sol` のID、`PoolAuthorization.t.sol` の署名境界と有効形の入力・出力・packet・公開額・宛先・salt改変拒否、`PoolFlow.t.sol` のchain/Pool変更拒否と第三者提出 |
| A-05 再使用と競合 | `PoolFlow.t.sol` の成功済み操作・消費済み入力の拒否、署名・証明変更後の再提出、同額別認可入金、独立入金の逆順実行。`PoolAuthorization.t.sol` の不存在入力、別owner入力と出力ID衝突はストレージを人工設定したケースを含む |
| A-06 証明器境界 | `PoolProofBoundary.t.sol` のfalse・revert・空・短長・2の戻り値、`PoolFlow.t.sol` の実v3検証器による変更後の非単位元X・出力位置・古いoperationIdの範囲証明の拒否、非ゼロblindingの正常例 |
| A-07 出金と再入 | `PoolWithdrawal.t.sol` の3資産入口への再入拒否、再入捕捉・伝播・受領拒否・大きい戻り値 |
| A-08 原子性と会計 | `PoolWithdrawal.t.sol` と `PoolInvariant.t.sol` の失敗後状態、通常・強制・返却ETH、`B=L+E` |
| A-09 観測ABI | `PoolFlow.t.sol` の実event topic/data/順序、`PoolState.t.sol` の照会、`test-pool-abi.mjs` のselector |
| A-10 不変条件 | `PoolInvariant.t.sol` の未使用額合計と帳簿、`PoolState.t.sol` の消費済み記録保持 |
| A-11 配置とartifact | `pool-artifact-guard.test.mjs`、`pool-deployment.test.mjs`、`pnpm check:pool`、保存manifestの再検査 |

通常のPool操作は実 verifier・公開試験鍵・固定のローカルchain ID/Poolアドレスで確認する。異常なverifier返値だけは合成コントラクトを使う。Pool専用packetの復号可能性、実Sepoliaの取引確定、実コードの形式証明はそれぞれ #36 と #33 に引き渡す。

## Issue #28: 暗号ライブラリの検証入口

`packages/crypto` は `@confidential-utxo/crypto` として、BN254コミットメント、v3範囲証明、Schnorr収支証明、HPKE受領packetを提供する。ルートの `pnpm build`、`pnpm test`、`pnpm check` はそれぞれライブラリのビルド、Vitest、型検査も実行する。個別確認は `pnpm --filter @confidential-utxo/crypto build`、`pnpm --filter @confidential-utxo/crypto test`、`pnpm --filter @confidential-utxo/crypto check` を使う。Node.js 24.21.0とlockfileの固定依存を使い、`pnpm install --frozen-lockfile` の後に実行する。

公開入口は `commit`、`randomBlinding`、`generateRangeProof`、`computeBalancePoint`、`balanceWitness`、`generateBalanceProof`、`encryptReceipt`、`decryptReceipt`、定数 `M/P/Q`、対応する型、`CryptoFailure` に限る。内部の乱数源と固定seedは公開しない。生成順は、出力ごとに開示値 `(v,r)` とコミットメントを作り、受信者鍵とcoreが計算した32 byteの `info` で受領packetを暗号化し、操作ID確定後に出力番号を付けて範囲証明を生成し、入出力のコミットメントと公開入出金額から `X` を計算して収支証明を生成する。操作ID・出力番号・`info`・Poolアドレス・chain IDは後から差し替えず、再生成時は対応する証明を作り直す。`RangeProof` の `coords/scalars/ls/rs` は公開ABI語列、`BalanceProof` の `Rx/Ry/s` と `X` も公開値である。開示値、blinding、受領秘密鍵、収支witnessは秘密として扱い、検証器・ログ・例外causeへ渡さない。

`CryptoFailure` のコードは `INPUT`、`RANDOM`、`SCALAR_EXHAUSTED`、`CHALLENGE_EXHAUSTED`、`DECRYPT`、`PLAINTEXT`、`COMMITMENT`、`INTERNAL`。メッセージはコードと公開stageのみを含む。HPKEはX25519/HKDF-SHA256/ChaCha20-Poly1305、packetは32 byteのencと80 byteの暗号文を連結した112 byteで、空AADを1回だけ使用する。復号後は64 byteの開示値を検査し、コミットメントを再計算して照合する。受信者鍵の保管、所有者認可、UTXO状態の確定は本ライブラリの責務外である。

固定値と移植元は [v3 profile](../../experiments/design/crypto-profile-v3/exp08/profile.json)、[Javaの範囲証明実装](../../experiments/design/crypto-profile-v3/exp08/java/RevisedRangeProver.java)、[旧EVM検証器](../../experiments/design/crypto-profile-v3/exp08/solidity/RangeProofVerifier.sol)、[#35ベクトル](../../tests/vectors/README.md) を参照する。BN254固定パラメータhashは `0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae`。独立ベクトルの再検証には、`tests/vectors` で `pnpm install --ignore-workspace --frozen-lockfile` を実行し、ルートで `python3 -m venv tests/vectors/.cache/venv`、`tests/vectors/.cache/venv/bin/python -m pip install -r tests/vectors/tools/requirements.txt`、同READMEの読み取り専用コマンドを使う。実験・oracleのライセンスや生成根拠はそれぞれの元ファイルとベクトルmanifestで確認する。

移植元の固定版は `5d9e378ed9d1e970723a198b244e74aa868d6c74` の `RevisedRangeProver.java`、`RevisedProtocol.java`、`RevisedRangeProof.java` とEXP-08の生成点である。これらは同一リポジトリ内の実験資料で、各ファイルに独立したSPDX/license表示はない。実装ではJavaの曲線演算をnobleのBN254アダプタへ置き換え、公開入力の正規性検査、256候補上限の乱数採取、v3 full-prefix、秘密を含まないエラー分類を加えた。Javaの試験用強制分岐と詳細な秘密traceは移植していない。採用した `@noble/curves`、`@noble/hashes` と4件の `@hpke/*` パッケージは、固定版のpackage manifest上いずれもMIT表記である。再配布条件の確認には各依存パッケージのライセンス原文を使う。

検証器との相互運用では、#26の確定した `packages/ethereum/generated/verifier-v3.json` のcreation/runtime SHA-256をmanifestに照合してから一時Anvilへデプロイし、`verify(operationId,outputIndex,coords,scalars,ls,rs)` と `verifyBalance(operationId,Xx,Xy,Rx,Ry,s)` を呼ぶ。ライブラリをビルドしてから、ルートで `pnpm interop:crypto packages/ethereum/generated/verifier-v3.json` を実行する。このコマンドは秘密を保存せず、実行時に作る証明の受理と公開文脈の改変拒否を検査する。収支challengeのPoolアドレスには検証器への**呼出元**アドレス（Solidity側の `msg.sender`）を渡す。`X=(0,0),x=0` の有効な収支証明では `sG=R` となり、challengeの変更だけで式は破れない。operation ID・chain ID・Poolの改変拒否は `X≠(0,0)` のケースで試験し、単位元ケースは受理と非退化ケースの試験を分ける。この数学的限界を、操作認可や受領の検証へ読み替えない。

実行環境、入力artifactのhash、ケース別結果、未実施範囲は [相互運用記録](../../packages/crypto/interop-result.json) に残す。macOSでの成功はUbuntuでの成功を意味しない。Ubuntuの判定には同じ固定版で `build/test/check` と独立oracleを実行し、OS/CPU/RAM、依存・artifactのhashと結果を別記録する。

## Issue #29: 共通クライアント処理の検証入口

`packages/core` の公開入口は `@confidential-utxo/core`。実行コードも型もこのルートからimportする。`recipientInfoTypedData(context, unsignedInfo, expectedOwner)` が返す検証済みの署名対象を `RecipientInfoSignerPort.signTypedData` へ渡し、署名を付けた情報を `verifyRecipientInfo` で照合する。操作認可用の `SignerPort` とはprimary typeが異なる。`buildOperation` で入力選択・受取情報照合・実暗号の出力と証明を作り、`authorizeOperation` に `SignerPort` を渡して署名する。署名済みの `LocalDraft` は秘密の開示値を含むため、公開要求や通常ログへ出さない。`prepareSubmission` は復元状態を同期し直し、`StoragePort.saveDraft` の保存確認後に最新履歴を照合し、`ready` のときだけ公開 `submission` を返す。初回と明示的な再提出の両方で呼ぶ。`preflightSubmission` は `{ status, latest: { number, hash } }` を返し、`prepareSubmission` も最新照合後の結果へ同じ `latest` を付ける。`latest` は確定を主張せず、同期の確定点 `checkpoint` と区別する。確認不能でも最新点を取得済みなら、その点を返す。実際の送信は呼出側が行う。`preflightSubmission` 単独では保存を保証せず、`toPublicSubmission` 単独では保存・同期・最新状態の照合を保証しない。

`inspectReceipt` は送信者の作成状態を受け取らず、公開履歴と `ReceiptKeyPort` で受領を確認する。`synchronize` は `HistoryPort` から採用した確定点の全履歴を再構築し、本人の利用可能残高を返す。履歴・状態が整合していてもpacketを復号・検証できない出力は、出力ID付きの `receiptFailures` に残し、`utxos` と利用可能残高から除外する。他の正常な資金の同期や提出準備は続けられる。履歴に欠落や不整合がある場合は `unconfirmed` とし、以前の状態は利用可能残高を持たない `stale` として保持する。履歴adapterは範囲全体の取得、ブロックhashへの固定、正準祖先の照合を保証する必要がある。`trackAttempt` では外側transactionの結果、論理操作の成功、受領を区別する。初回は第三引数に `[]`、次回からは前回の `OperationTracking` 全体を渡す。採用済みの `successEvidence` は別試行の失敗では消さず、再編成を検出したら `historyStatus: "reorg"`、採用履歴を確認できなければ `historyStatus: "uncertain"` を明示して成功判定を撤回する。

Node.js 24.21.0 / pnpm 10.34.5で、ルートから次を実行する。coreのテストと型検査は公開パッケージを検証するため、実行前に自身をビルドする。

```sh
pnpm install --frozen-lockfile
pnpm --filter @confidential-utxo/crypto build
pnpm --filter @confidential-utxo/core build
pnpm --filter @confidential-utxo/core test
pnpm --filter @confidential-utxo/core check
pnpm --filter @confidential-utxo/core test public-api
pnpm build
pnpm test
pnpm check
rg 'from .*packages/(ethereum|cli)|node:fs|tests/vectors/tools|experiments/' packages/core/src
```

最後の検索は一致なし（終了コード1）が期待値。[公開APIの受入テスト](../../packages/core/test/public-api.test.ts) はcore内部をimportせず、実暗号と偽の署名・鍵取得・保存・履歴境界を組み合わせる。公開試験鍵で実署名し、入金、送金と釣銭、独立した受領、再同期、出金要求の保存からの復元を確認する。出金の再準備は、生成・消費イベントと状態を揃えた履歴で、実行済みと競合の両方を区別する。

| 受入条件 | テストと独立ベクトルの関係 |
| --- | --- |
| AC-01 | `encoding` のVEC-01、`authorization` のVEC-02で符号化・EIP-712固定値を照合 |
| AC-02 | `operation` のVEC-07-APPLICATION各ケースと実暗号の操作生成・境界試験 |
| AC-03 | `selection` の合成状態で明示選択・自動選択・上限を検査（固定ベクトルの対象外） |
| AC-04 | `encoding` の結合変更ベクトル、署名拒否・変更検出、VEC-02受取情報を使う実証明再生成 |
| AC-05 | `receipt` のVEC-07-APPLICATION受領、VEC-06ログ拒否、他者出力・鍵の不一致 |
| AC-06 | `sync` の反復・欠落試験。VEC-07-APPLICATION-DEPOSITの公開試験鍵から合成履歴を作成 |
| AC-07 | `sync` の生成・消費を取り消す再編成試験（履歴adapterは偽物） |
| AC-08 | `tracking` と `public-api` の外側結果・論理成功・最新状態照合（履歴adapterは偽物） |
| AC-09 | `tracking` の保存応答不明・改変復元、`public-api` の保存済み出金再準備（保存adapterは偽物） |
| AC-10 | `public-api` の公開ルートの実行・型importとbuild/test/check |

これらはNode上の共通処理の検証である。実PoolのABI・RPC接続は#30/#36、CLIの暗号化保存と永続化は#31、ブラウザ実行は#46/#59で検証する。ここでの保存成功は偽adapterの応答に基づき、ディスク耐久性や実送信の成功を示さない。
