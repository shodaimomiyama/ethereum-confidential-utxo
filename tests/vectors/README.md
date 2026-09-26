# 独立した符号化・暗号テストベクトル

Issue [#35](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/35) の固定データです。実装担当は `coverage.json` のケース ID から `cases/*.json` を探し、対象の `input` と `expected` を比較してください。`stage` は判定する処理、`expected.decision` はその処理での受理・拒否です。点の表現、証明、Pool 操作、受領後の資産計上は別の判定として扱います。

`schema.json` はケース形式 v1、`manifest.json` は出典・SHA-256・生成器・独立照合器・依存版、`coverage.json` は VEC-01〜08 と必須規則の対応表です。金額・scalar・座標は精度を失わない十進文字列です。`0x` 付き文字列は生 bytes を小文字 hex で表し、完全な preimage・calldata・topic・data は各ケースに保存します。EXP-07A の `xHex`/`yHex` は元資料の 64 桁 hex をそのまま示します。各ケースの `consumers` は引渡し先 Issue です。

## 新規 clone での準備

macOS ARM64 で Node.js 24.21.0、pnpm 10.34.5、Python 3.13.7 を使用します。Node は #4 の固定版を有効化してください。この branch では #4 の workspace 設定が未マージなので、依存を `tests/vectors/package.json` と lockfile に局所化しています。

```sh
cd tests/vectors
corepack pnpm install --ignore-workspace --frozen-lockfile
cd ../..
python3 -m venv tests/vectors/.cache/venv
tests/vectors/.cache/venv/bin/python -m pip install -r tests/vectors/tools/requirements.txt
```

## 読み取り専用の検証

リポジトリルートから実行します。すべて非ゼロ終了を失敗とし、fixture は書き換えません。

```sh
tests/vectors/.cache/venv/bin/python -m unittest discover -s tests/vectors/tools -p 'test_*.py' -v
node --test tests/vectors/tools/test-*.mjs
tests/vectors/.cache/venv/bin/python tests/vectors/tools/check.py
tests/vectors/.cache/venv/bin/python tests/vectors/tools/check_coverage.py
tests/vectors/.cache/venv/bin/python tests/vectors/tools/verify_storage.py
```

`check.py` は schema、重複 ID、参照、coverage、ケースファイルの SHA-256 を検査します。`check_coverage.py` は必須規則に対応するケース、出典・生成器・schema・coverage・lockfile の hash、独立照合の記録を検査します。個別 oracle テストは保存済みの期待値を再計算します。保存済み値を改変した場合、生成器が期待値を追随更新する動作はありません。

## 再生成と再検証の区別

新規ベクトルは公開された試験用 seed・鍵・nonce・金額から別ディレクトリへ同じ bytes を再生成し、保存済みケースと差分比較します。次の例では出力先を `.cache/regenerated/` にします。

```sh
mkdir -p tests/vectors/.cache/regenerated/base tests/vectors/.cache/regenerated/final
node tests/vectors/tools/oracle-abi.mjs --out tests/vectors/.cache/regenerated/base
node tests/vectors/tools/oracle-operation-binding.mjs --out tests/vectors/.cache/regenerated/base
node tests/vectors/tools/oracle-hpke.mjs --out tests/vectors/.cache/regenerated/base
tests/vectors/.cache/venv/bin/python tests/vectors/tools/oracle_application.py --in-base tests/vectors/.cache/regenerated/base/application-operation.json --out tests/vectors/.cache/regenerated/final/application-operation.json
tests/vectors/.cache/venv/bin/python tests/vectors/tools/oracle_v3.py --out tests/vectors/.cache/regenerated/base
tests/vectors/.cache/venv/bin/python tests/vectors/tools/oracle_range_prover.py --out tests/vectors/.cache/regenerated/base
tests/vectors/.cache/venv/bin/python tests/vectors/tools/oracle_balance.py --out tests/vectors/.cache/regenerated/base
node tests/vectors/tools/oracle-verifier-abi.mjs --out tests/vectors/.cache/regenerated/base
node tests/vectors/tools/oracle-storage.mjs --out tests/vectors/.cache/regenerated/base
```

各 JSON の差分は `cmp` 等で確認します。`application-operation.json` は JS が HPKE packet・操作・収支証明を固定した後、Python が同じ operationId へ v3 範囲証明 2 件を結び付けます。旧 EXP-08 の証明は内部乱数が残っていないため **同一 bytes の再生成対象ではありません**。`oracle_v3.py` は EXP-07A/08 の出典 hash と既存証明の full-prefix transcript、候補列、座標・scalar を再検証します。新規の `range-deterministic.json` と送金の範囲証明は公開 seed を固定し、同一 bytes で再生成します。

## 独立性と限界

- VEC-01/02/06 と検証器 ABI は viem で生成し、ethers で ABI・署名・ログを照合します。共通の Keccak 規則と設計文書を前提とします。
- VEC-03/04 は試験専用 Python BN254 群演算、Keccak、独立の v3 検証式を使い、EXP-07A の点と EXP-08 の Java/EVM 記録と照合します。130 生成点の HashToG1 導出を Python 側で再実装した証拠ではありません。内部 proof 点が単位元になる*有効*証明の相互運用は未確認です。
- VEC-05 は Python の群演算・challenge を ethers による ABI/Keccak と照合します。候補枯渇は採取 predicate の固定入力で確認し、自然発生の確率を測ったものではありません。
- VEC-07 は [RFC 9180 Appendix A.2.1](https://www.rfc-editor.org/rfc/rfc9180.html#appendix-A.2.1) の既知値を基準に、別経路の HPKE 復号で packet を検査します。入金、釣銭付き送金、全額出金は同じ操作内で公開入力、packet、operationId、署名、必要な証明、イベントを追跡できます。公開試験用秘密は fixture 内だけで使います。
- VEC-08 は [RFC 7914](https://www.rfc-editor.org/rfc/rfc7914.html) の scrypt 既知値と、Python `hashlib.scrypt`/PyCryptodome AES-GCM を独立照合に使います。生 header bytes を AAD に使います。内側 wallet schema と運用上の保存保証は #31 の責務です。

Pool の `deposit`・`transfer`・`withdraw` の具体的な Solidity 宣言と selector は #27 の `IPool.sol` で固定し、`test-pool-abi.mjs` が独立したethers ABI宣言と比較します。`pool-operations.json` の20件は固定のローカルchain ID・Poolアドレスに対して、公開試験鍵による実署名とv3範囲証明を持ちます。非ゼロblindingによる収支証明、受取人による再使用、出金callbackとPool自己宛ても含みます。`POOL_VECTOR_PYTHON=tests/vectors/.cache/venv/bin/python pnpm fixture:pool` で全ケースを一時再生成し、保存済みJSONと `contracts/test/fixtures/pool-calldata.json` に照合します。Pool専用の追加packetは112 byteの公開試験データであり、HPKE復号可能性の証拠は既存の `application-operation.json` と #36 の結合試験で扱います。

## 引渡し

#26 は v3・収支証明と Pool からの公開入力、#27 は要求・認可・イベント・エラー、#28 は証明生成と HPKE、#29 は操作構成と受領照合、#30 は ABI・署名・RPC 接続、#31 は保存 envelope と内側 schema を各自の実装で照合してください。#36 は実暗号による結合、停止後の受領と再使用、再編成を検証します。新しい実装出力が固定値と違う場合、まず入力・profile・preimage を比較し、根拠となる仕様や版の変更を確認してから fixture 更新を判断します。

## 実行記録

2026-09-27、Darwin arm64、Node.js 24.21.0、pnpm 10.34.5、Python 3.13.7、pycryptodome 3.23.0。依存版・ライセンス・取得元と生成器の hash は `manifest.json` にあります。#35 の初期記録では185 ケース・13 ファイルを対象に、Python の一括テスト 38 件、Node の一括テスト 31 件、`check.py`、`check_coverage.py`、`verify_storage.py`、上記の別出力再生成と全 13 ファイルの byte 比較を実施し、すべて終了コード 0・差分なしでした。#27 の追加後は209ケースとなり、Poolの20操作は `test_oracle_pool_proofs.py`、`test-pool-operation-fixtures.mjs`、`test-pool-abi.mjs` と `pnpm fixture:pool` で照合します。Ubuntu と CI は未実行です。
