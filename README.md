# ethereum-confidential-utxo

[要件定義書](docs/requirements.md): Confidential UTXO本体の機能、安全性、機密性、形式証明、評価と再現性の受入条件。

[仕様書](docs/specification.md): 方式に依存しない状態遷移、認可、資産保存、受領と同期の規則。

[Uniswap接続の要件定義書](docs/integration/uniswap/requirements.md): 機密ETHからの部分支払い、認可と取消、機密性、コストと追試の受入条件。

[先行EIP/ERCの比較調査](docs/research/prior-eip-comparison.md): 比較対象の選定、公開値の読み方、実測条件と結果。

先行方式の実測を再現するには、Node.js 22、Foundry、`jq` が使える環境で次を実行する。固定した参照実装を取得し、開発用の証明鍵と計測用コードを準備する。

```bash
bash benchmarks/prior-eips/setup.sh /tmp/eip8182-clean
```

別の端末でローカルノードを起動し、最初の端末で測定と生データの再集計を行う。

```bash
anvil --silent --host 127.0.0.1 --port 18545 --chain-id 1 --hardfork cancun --timestamp 1735689000 --gas-limit 30000000 --disable-code-size-limit
```

```bash
bash benchmarks/prior-eips/repeat.sh /tmp/eip8182-clean http://127.0.0.1:18545 benchmarks/prior-eips/raw/new-run
node benchmarks/prior-eips/aggregate.mjs benchmarks/prior-eips/raw/new-run
```

同じローカルノードで操作別の暗号化ケースと、受取人による後続出金も再実行できる。各スクリプトは実行前にノード状態をリセットする。

```bash
bash benchmarks/prior-eips/cases/run-encrypted.sh /tmp/eip8182-clean http://127.0.0.1:18545 all
bash benchmarks/prior-eips/cases/repeat-eth.sh /tmp/eip8182-clean http://127.0.0.1:18545
bash benchmarks/prior-eips/recipient/run.sh /tmp/eip8182-clean http://127.0.0.1:18545
```

測定構成と既知の未達項目は[比較調査](docs/research/prior-eip-comparison.md)に記録する。測定には実資金を使わず、試験専用の鍵を使う。
