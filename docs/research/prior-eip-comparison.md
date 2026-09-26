# 先行EIP/ERCの比較とEIP-8182の実測

この資料は、[Issue #10](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/10)で調べた先行方式と、後続の設計・評価に使える測定値を記録する。
本体の要求と正しい振る舞いは[PRD](../PRD.md)、[要件定義](../requirements.md)、[仕様](../specification.md)を正本とする。

## 今回分かったこと

3方式を調べ、実際に証明を生成してオンチェーンで検証・測定したのはEIP-8182の1方式である。
EIP-7503とERC-8086は資料比較にとどまり、3方式を数値で順位付けできる状態ではない。
以下のnoteは、金額と所有者を秘匿して扱うUTXOを指す。

| 方式 | 資産移転と公開情報 | 今回の判断 |
| --- | --- | --- |
| [EIP-8182](https://github.com/ethereum/EIPs/blob/59454e9b9f577c8b9ed1246714f44990711e5751/EIPS/eip-8182.md) | ETHと対応ERC-20を同じシールドプールで扱う。2入力・3出力固定の証明で送金、合算、全額・部分出金ができる。私的送金の金額と資産種別は隠れるが、入金元・資産・額と出金先・資産・額は公開される。 | **実測**。著者の[参照実装 `639baaf`](https://github.com/0xFacet/eip-8182-reference-implementation/tree/639baaf7b29c22eb43ba6150140902ea8dbbbc46)を固定した。受領データの暗号化と復号には参照実装のSepolia demo方式を組み合わせた。 |
| [EIP-7503](https://github.com/ethereum/EIPs/blob/676604927b316a44195008e632778d4ca1101deb/EIPS/eip-7503.md) | 公開ETHを使用不能アドレスへ送り、後で証明付きで再発行する。再発行額と宛先は公開される。プール内のnote送金や2入力合算は同じ操作として定義されない。 | **資料比較のみ**。透明セットアップを意図するが[参照実装とSNARK実装がTBD](https://eips.ethereum.org/EIPS/eip-7503#reference-implementation)で、EIP-7708、SSZ receipt変更、新取引種別に対応するクライアントも必要になる。今回のローカルコントラクトでは提案どおりの実測ができない。 |
| [ERC-8086](https://github.com/ethereum/ERCs/blob/84e5d9fba8b1ee31352bb67e515d3a5ab5662eba/ERCS/erc-8086.md) | 機密トークンのインターフェース。commitment、nullifier、暗号化noteを使うが、証明方式と木構成は実装ごとに選ぶ。通常ETHの出金や公開トークンとの変換はインターフェースだけでは定まらない。 | **資料比較のみ**。[公式参照資産](https://eips.ethereum.org/assets/eip-8086/)にはSolidityとGroth16検証器があるが、回路ソース、証明鍵、証明生成SDKがない。対応する証明生成を再現できない。 |

確認日は2026-09-26で、上表の仕様はリンク先のコミットに固定した。
公式表示ページで確認した状態は、順にReview / Core、Stagnant / Core、Draft / ERCである。
提案の状態と公開資産は今後変わり得る。

EIP-8182のpoolはnoteの存在、所有、資産保存、nullifierを証明し、利用者が登録した別の検証器で操作意図を認可する。
1入力にはphantom入力、少ない出力にはdummy出力を使う。
nullifier、出力commitment、提出者とタイミングは観測でき、[受領データの内容と長さ](https://eips.ethereum.org/EIPS/eip-8182#metadata-leakage)も追加情報を漏らし得る。
EIP本文は受領データを証明と結び付けるが、暗号化と受取人への配送方法は規定しない。
poolの更新はforkで管理され、管理者によるpauseやupgradeはない。
ERC-8086の機密性と信頼前提は採用する回路と暗号化に依存し、EIP-7503の公開再発行とも保証が異なる。

## EIP-8182で測った値

主測定ではMockERC20のnoteを2つ（10と5）消費し、受取人8、送信者の釣銭5、私的手数料note2を生成した。
値はトークンの最小単位であり、ETHのweiではない。
poolと認可には参照実装のGroth16証明を使い、3つの実出力は[Sepolia demo](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/sepolia-demo/README.md)のML-KEM-768/X25519方式で証明生成前に暗号化した。
暗号文のhashを証明と結び付け、同じ取引で両証明をオンチェーン検証した。

ウォームアップ1回の後、状態を毎回リセットして正式に3回測った。
次の表は[生データ](../../benchmarks/prior-eips/raw/repeated/)から[集計コード](../../benchmarks/prior-eips/aggregate.mjs)で再計算した中央値である。

| 対象 | 中央値 | どこまで測ったか |
| --- | ---: | --- |
| 暗号化送金のgas | **3,708,117 gas** | 実取引のreceipt全体。3回の値は3,708,117 / 3,708,105 / 3,708,117 gas |
| pool証明生成 | 3,946 ms | `snarkjs.groth16.prove`。witness生成とローカル検証は含まない |
| demo認可証明生成 | 245 ms | 同じく証明生成のみ |
| 3出力の暗号化 | 20.05 ms | 暗号文は計7,044 byte |
| 公開履歴からの同期 | 72.98 ms | RPC取得、試行復号、indexer処理の壁時計時間。3ログ、5出力、12復号試行 |

送金gasには21,000 gasのintrinsicと130,360 gasのcalldataが含まれる。
暗号文のABI末尾に相当するcalldataはその内数の113,400 gasである。
残る3,556,757 gasはEVM実行と返金の純額であり、暗号文掲載だけの限界費用ではない。

初回の別取引では、所有者policy登録に2,014,817 gas、MockERC20の2回の入金に1,836,074 / 1,227,713 gasを使った。
認可検証器とwrapperの配備gasは364,338 / 266,947で、[receipt](../../benchmarks/prior-eips/raw/repeated/trial-1/receipts.json)に分けて保存した。
セットアップ64.6秒とwitness生成のpool 150 ms・認可55 msは[別の単発測定](../../benchmarks/prior-eips/raw/setup-timing/)であり、上表の正式3試行の証明時間に足して一つの操作時間とは扱わない。

### 操作と受領の確認範囲

[操作別の条件](../../benchmarks/prior-eips/cases/manifest.json)で実入力、phantom、実出力、dummy、公開出金額を固定した。
平文と暗号化の[17ケースの集計](../../benchmarks/prior-eips/cases/encrypted-summary.json)は、各ケース1回の成功receiptと公開ログからの実出力の復号を記録している。
各値と対応する[平文結果](../../benchmarks/prior-eips/cases/summary.json)も保存した。

| 本体仕様との対応 | 今回確認した操作 |
| --- | --- |
| S-01 入金 | ETHを10入金し、生成したnoteを後続の出金で消費した |
| S-02〜S-04 送金と合算 | ETHとMockERC20の両方で、10→10、10→3+7、2+3→4+1を確認した。ETHの2+3→4+1は[追加3試行](../../benchmarks/prior-eips/cases/eth-repeat-summary.json)で送金gas中央値3,650,301 |
| S-05 自己宛て操作 | MockERC20で10+5→15の合算、10→3+7の分割、10→新しい10の再作成を確認した |
| S-06 出金 | ETHで全額・部分出金と2入力の出金を、MockERC20でも全額・部分出金を確認した |
| S-07 受領後の使用 | 送信者の生成済み入力を削除した後、受取人が公開履歴と事前保持した試験鍵から8のnoteを復号し、[公開トークンへ出金](../../benchmarks/prior-eips/recipient/reuse-result.json)した |

主測定では、改ざんした認可対象の取引が3試行とも失敗し、正しい取引では2つのnullifierとreplay IDが消費された。
受取人による後続出金は成功したが、再送金は試していない。
本体のS-07が要求する再送金と出金の両経路を確認した結果とは扱わない。

### 外部資料の数値

[参照実装READMEの例示値](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/README.md#benchmarks)は、Apple M5 Maxとnative `rapidsnark`による別の条件の値である。
送金と出金の表示gasは、[集計コード](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/scripts/bench/render.js#L84)がHonk認可の実行gasからdemo認可の検証費用へ置き換えた**算出値**で、今回のreceipt実測値ではない。
[元のベンチマーク](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/contracts/test/Bench.t.sol)は固定の平文bytesを受領データとし、呼出し前後の`gasleft()`で実行gasを測る。
表示されるpool 0.12秒とdemo認可0.03秒の証明時間は送金用で、出金にも流用される。

| 操作 | READMEの例示gas |
| --- | ---: |
| 認可登録 | 2,019,847 |
| ETH / ERC-20入金 | 1,811,441 / 1,836,602 |
| 送金 | 3,306,055 |
| ETH / ERC-20出金 | 3,340,785 / 3,332,563 |

EIP-7503とERC-8086の公式本文・参照資産には、今回と同じ条件で使えるgas、証明生成、配送時間の実測値を確認できなかった。

## 数値の適用範囲

- **認可と信頼前提**：実測したdemo認可は固定の試験用秘密の知識を示す。ECDSAウォレット署名の安全性や費用を示さない。固定した参照実装のNoir/Honk認可は、[署名生成側](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/scripts/noir/gen_prover_toml.js)の16項目と[回路](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/circuits-noir/auth/src/main.nr)の旧7項目が一致せず、`signature invalid`で停止した。poolの開発用証明鍵とdemo認可鍵は単独参加者のセットアップに依存する。[失敗と対処の記録](../../benchmarks/prior-eips/status.json)を残した。
- **実行環境**：Anvil 1.7.1、Cancun、30,000,000 gasのブロック、code size制限解除で測った。[EIP用の初期状態](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/assets/eip-8182/shielded-pool-state.json)をRPCで設置し、fork導入費用は測っていない。通常のEthereumでの配置可能性は未確認である。
- **資産と配送**：試験用MockERC20の`transferFrom`はallowanceを検査しないため、一般的なERC-20のapprove費用は含まれない。受取公開鍵は事前共有し、demoのオンチェーン鍵registryは使っていない。公開される暗号文の長さや`kid`、取引提出者は観測できる。
- **未実行の経路**：ETH受領コントラクトの成功・拒否と、受取人による再送金は試していない。witness生成や準備まで含む一取引の壁時計時間も、正式3試行の一つの値としては測っていない。

測定の[固定設定](../../benchmarks/prior-eips/config.json)と生データは同じGitコミットで公開した。
この履歴だけでは、設定を正式測定より前に固定した時点を第三者が独立に確認できない。
再集計と別checkoutでの再測定は可能だが、事前登録済みの測定計画の証拠とは扱わない。

## 再現と本体との比較

[README](../../README.md)に、参照実装の取得、ローカルノードの起動、正式3試行、操作別ケース、受取人の後続出金のコマンドを載せた。
[構成と各試行の記録](../../benchmarks/prior-eips/config.json)から、使用した版、鍵と回路のhash、入力、状態、反復数、集計範囲を追跡できる。
別のクリーンcheckoutでもセットアップ、証明生成、暗号文の復号、ウォームアップと正式3試行、再集計を実行し、[receipt gas中央値3,708,093](../../benchmarks/prior-eips/raw/clean-replay-repeated/aggregate.json)を得た。

本体の実装後は、資産、入出力数、dummy、私的手数料note、認可、暗号配送、初回登録、EVM設定を揃えてから数値を比較する。
条件が違う場合はEIP-8182を再測定するか、差を明示して比較範囲を限定する。
今回のMockERC20主測定値だけから本体のETH取引との優劣は判断できない。
本体固有の方式と最終的な評価条件は[設計Issue #7](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/7)で決める。
