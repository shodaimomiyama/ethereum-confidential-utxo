# ethereum-confidential-utxo

[English](README.md) | 日本語

## 概要（Short description）

機密ETH UTXOと、Uniswapを利用した公開支払いを提供する研究プロトタイプ。

## プロジェクトの目的（Description）

Ethereum上で、UTXOの消費と生成の関係を公開しながら、ETHの金額を秘匿する送金の仕組みを研究するプロジェクトです。研究用プロトタイプでは、ETHの入金、機密送金、公開出金を扱います。Uniswap接続では、固定額のETHを公開トークンへ交換して指定した最終受取人に全量を渡し、支払者が残りの機密UTXOを使い続けられます。開発者と研究者が機能、コスト、安全性、金額の機密性の限界を評価し、将来の標準化を議論するための根拠を提供します。公開された取引グラフと既知の金額から、送金額や残額が判明する場合があります。

## 対象範囲と利用の流れ

本体は、[本体PRD](docs/PRD.md)に記載したETH専用の公開グラフ型UTXOを提供します。[Uniswap接続](docs/integration/uniswap/PRD.md)では、機密ETHで受け取った金額の一部を、公開流動性を使った支払いに利用できます。

1. テスト用ETHを所有者のUTXOへ入金し、別の所有者へ機密送金します。
2. 受取人がUTXOを発見し、金額と確定状態を照合して、送信者の追加協力なしに使用できる状態にします。
3. 受取人が支払者となり、使用ETH額、交換先トークン、最低受取額、最終受取人、有効期限を認可します。接続では固定ETH額を全額交換し、最低受取額を満たす場合に交換出力の全量を最終受取人へ渡します。
4. 支払者は未使用のETHを機密UTXOとして保持し、その残額を再送金できます。

接続が扱うのは、単一UTXOから一種類の公開トークンへの部分支払いです。失敗した支払いでは、その試行による入力消費、残額生成、出金、交換、着金を一体に取り消します。先に確定した送金や外側のトランザクションのgas費用は、取消の対象に含めません。

テスト用資産を使い、ローカルEthereumと公開テストネットで検証する研究を対象とします。[接続仕様](docs/integration/uniswap/specification.md)では、デモ報酬、支払い、入金、全額出金を扱う公開デモサイトを必須としています。仕様の存在は実装・公開の完了を意味しません。実資金での本番運用、汎用的な機密ウォレットGUI、ERC-20の機密資産一般への対応、取引グラフの秘匿、厳密な請求額決済は初期範囲外です。標準としての採用や先行方式より低いコストは、今後検証する研究の目標です。

## 仕組み（How it's made）

[本体仕様](docs/specification.md)に従い、入力の存在と未使用を判定する状態をコントラクトストレージで管理し、UTXOの消費と生成の関係を公開します。各操作には、意図した資産効果と実行文脈に結び付いた、有効な所有者認可を要求します。入金では実受領ETH額に一致するUTXOを生成し、送金では入力総額を保存し、出金では公開出金額と機密残額の和を入力総額に一致させます。無断使用、二重使用、成功済み操作の再使用を拒否し、gasは別途公開ETHで支払います。

受取人は、自分の鍵と公開履歴から受領データを発見・復号し、整合性を確認します。CLIでは、受領成立と未確定・失敗・確認不能を区別し、再同期を行えます。Uniswap接続では、[接続要件](docs/integration/uniswap/requirements.md)に従い、交換条件を所有者の出金認可に結び付け、交換や着金が失敗した場合に支払いの資産効果を一体に取り消します。

[先行EIPのベンチマーク](benchmarks/prior-eips/)では、EIP-8182を別途測定します。BashとJavaScriptのスクリプトで、固定したEIP-8182参照実装をビルドし、snarkjsでpoolとdemo認可のGroth16証明を生成して、FoundryのツールとローカルAnvil上で検証します。参照demoのML-KEM-768/X25519による受領データ暗号化と公開ログからの復元も確認します。[比較調査](docs/research/prior-eip-comparison.md)に、参照コード、測定条件、開発用鍵の前提と限界を記録しています。

## 機密性の限界

秘匿の対象は金額であり、取引のつながりは公開します。入出金額に加え、Uniswap接続では使用ETH額、交換後のトークンと金額、最終受取人が公開されます。所有者やトランザクション送信者の秘匿も保証しません。例えば、入力額が既知なら公開出金額との差から残額が分かり、後続の全額出金から過去の送金額が判明する場合もあります。残額を機密UTXOで保持することだけでは、推論を防げません。

詳細は[本体の公開情報と秘密の範囲](docs/specification.md#公開情報と秘密の範囲)、[必要な検証成果物](docs/requirements.md#検証結果として提供する成果物)、[接続の機密性の限界](docs/integration/uniswap/PRD.md#公開情報と機密性の限界)を参照してください。

## 先行EIPベンチマークの再現

以下はEIP-8182参照実装のローカル測定手順です。

Git、Bash、Node.js 22とnpm、Foundry（`forge`、`cast`、`anvil`）、`jq`、`shasum`、参照実装と依存関係を取得するネットワーク接続が必要です。[記録済みの環境](benchmarks/prior-eips/config.json)はmacOS arm64、Node.js 22.22.0、npm 10.9.4、Foundry 1.7.1です。機器とツールの版も記録していますが、最低必要資源や他OSへの対応を示すものではありません。

追加ケースのスクリプトはclone内の測定出力を上書きするため、新規の作業用cloneで実行してください。コマンドはリポジトリのルートで実行します。新規セットアップでは、以下の参照実装の取得先を未使用のパスにしてください。

```bash
git clone https://github.com/shodaimomiyama/ethereum-confidential-utxo.git
cd ethereum-confidential-utxo
bash benchmarks/prior-eips/setup.sh /tmp/eip8182-clean
```

セットアップは参照実装を`639baaf7b29c22eb43ba6150140902ea8dbbbc46`に固定し、依存関係の導入、回路とコントラクトのコンパイル、開発用証明鍵の準備を行います。成功すると参照コミットと証明用資産のhashを表示します。試験専用の鍵とローカルで用意するテスト用資産を使い、個人の認証情報や実資金は必要ありません。

別の端末で、この測定専用のローカルノードを起動します。

```bash
anvil --silent --host 127.0.0.1 --port 18545 --chain-id 1 --hardfork cancun --timestamp 1735689000 --gas-limit 30000000 --disable-code-size-limit
```

最初の端末へ戻り、ウォームアップ1回と正式3試行を実行し、生データから再集計します。

```bash
bash benchmarks/prior-eips/repeat.sh /tmp/eip8182-clean http://127.0.0.1:18545 benchmarks/prior-eips/raw/new-run
node benchmarks/prior-eips/aggregate.mjs benchmarks/prior-eips/raw/new-run
```

各試行はノードをリセットします。集計では、送金receipt、改ざんした認可対象の拒否、受領データの復元、記録した状態フラグを確認します。成功すると`raw/new-run`へ`aggregate.json`を書き出し、gasと時間の中央値を表示します。時間やgasの厳密な値は実行ごとに変わり得ます。

同じ専用ノードで、暗号化した操作別の全17ケース、ETH送金の追加3試行、受取人による後続出金を再現できます。

```bash
bash benchmarks/prior-eips/cases/run-encrypted.sh /tmp/eip8182-clean http://127.0.0.1:18545 all
bash benchmarks/prior-eips/cases/repeat-eth.sh /tmp/eip8182-clean http://127.0.0.1:18545
bash benchmarks/prior-eips/recipient/run.sh /tmp/eip8182-clean http://127.0.0.1:18545
```

これらもノードをリセットします。期待結果は、[暗号化ケースの集計](benchmarks/prior-eips/cases/encrypted-summary.json)で17ケース成功、[ETHの集計](benchmarks/prior-eips/cases/eth-repeat-summary.json)で3試行、[受取人の結果](benchmarks/prior-eips/recipient/reuse-result.json)で受領したnoteの出金成功です。終了後は専用ノードを停止してください。

[比較調査](docs/research/prior-eip-comparison.md)から、[記録済みの生データ](benchmarks/prior-eips/raw/repeated/)と[既存のクリーンcheckoutでの追試](benchmarks/prior-eips/raw/clean-replay-repeated/aggregate.json)へ移動できます。同文書に、試験用トークン、demo認可、開発用セットアップ、code size制限解除の条件も記載しています。この測定だけでは、本体の性能、本番での安全性、通常のEthereumネットワークへの配置可能性は判断できません。

## 文書索引

技術文書の正本は日本語です。両READMEから同じ正本を参照します。

| 文書 | 内容 |
| --- | --- |
| [本体PRD](docs/PRD.md) | 課題、対象者、初期範囲、標準化の目的 |
| [本体要件定義](docs/requirements.md) | 機能、安全性、機密性、形式証明、評価と再現性の受入条件 |
| [本体仕様](docs/specification.md) | 状態遷移、認可、資産保存、受領と同期の規則 |
| [本体アーキテクチャ](docs/architecture.md) | 本体の構成、実装基盤、クライアントの境界、リポジトリと検証環境の構成方針 |
| [本体設計（草案）](docs/design.md) | 方式、認可、受領と同期、検証計画、採用判断の根拠 |
| [Uniswap接続PRD](docs/integration/uniswap/PRD.md) | 機密ETHからの公開部分支払いと残額の再利用 |
| [Uniswap接続要件定義](docs/integration/uniswap/requirements.md) | 認可、取消、機密性、コストと追試の受入条件 |
| [Uniswap接続仕様](docs/integration/uniswap/specification.md) | 支払いの受理、全量着金、取消、同期、公開サイトとデモ報酬要求の規則 |
| [先行EIPの比較調査](docs/research/prior-eip-comparison.md) | 比較範囲、測定条件、生データと限界 |
