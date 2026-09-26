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

### 主測定の送金

ウォームアップ1回の後、状態を毎回リセットして正式に3回測った。
次の表は[生データ](../../benchmarks/prior-eips/raw/repeated/)から[集計コード](../../benchmarks/prior-eips/aggregate.mjs)で再計算した中央値である。

| 対象 | 中央値 | どこまで測ったか |
| --- | ---: | --- |
| 暗号化送金のgas | **3,708,117 gas** | 実取引のreceipt全体 |
| pool証明生成 | 3,946 ms | `snarkjs.groth16.prove`。witness生成とローカル検証は含まない |
| demo認可証明生成 | 245 ms | 同じく証明生成のみ |
| 3出力の暗号化 | 20.05 ms | 暗号文は計7,044 byte |
| 公開履歴からの同期 | 72.98 ms | RPC取得、試行復号、indexer処理の壁時計時間。3ログ、5出力、12復号試行 |

3回の値も[集計結果](../../benchmarks/prior-eips/raw/repeated/aggregate.json)に残した。
gasのばらつきは12 gasだった一方、pool証明生成は3,307〜5,652 msだった。

| 正式試行 | 送金gas | pool証明生成 | 認可証明生成 | 暗号化 | 同期 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 3,708,117 | 3,307 ms | 230 ms | 19.32 ms | 86.71 ms |
| 2 | 3,708,105 | 5,652 ms | 288 ms | 20.50 ms | 72.79 ms |
| 3 | 3,708,117 | 3,946 ms | 245 ms | 20.05 ms | 72.98 ms |

送金gasには21,000 gasのintrinsicと130,360 gasのcalldataが含まれる。
暗号文のABI末尾に相当するcalldataはその内数の113,400 gasである。
残る3,556,757 gasはEVM実行と返金の純額であり、暗号文掲載だけの限界費用ではない。
空の暗号文との比較で算出したABI末尾の増分は113,016 gasで、ABI headの変化はこの値に含まない。

### 初回費用と準備時間

送金に先立つ登録と入金は別取引である。
次のgasを送金receiptへ足すかどうかは、比較対象が「1回の送金」か「利用開始からの総費用」かで決める。

| 初回操作 | gas | 測定対象 |
| --- | ---: | --- |
| 認可検証器の配備 | 364,338 | 主測定の[receipt](../../benchmarks/prior-eips/raw/repeated/trial-1/receipts.json) |
| demo認可wrapperの配備 | 266,947 | 同上 |
| 所有者policy登録 | 2,014,817 | 同上 |
| MockERC20の1回目の入金 | 1,836,074 | 10のnoteを作成 |
| MockERC20の2回目の入金 | 1,227,713 | 5のnoteを作成 |
| ETHの入金 | 1,798,919 | [S-01を含む単発ケース](../../benchmarks/prior-eips/cases/summary.json)で10のnoteを作成 |

次の時間は[追加の単発測定](../../benchmarks/prior-eips/raw/setup-timing/)または[追加の試行](../../benchmarks/prior-eips/status.json)であり、正式3試行の送金時間には含めない。

| 準備 | 時間 | 含む処理 |
| --- | ---: | --- |
| 新しいcheckoutからのセットアップ | 64.6秒 | 取得、依存関係導入、回路コンパイル、開発用認可鍵生成、ビルド。ダウンロードキャッシュの影響を受ける |
| pool witness生成 | 150 ms | 別プロセスの起動、WASM読込、witness計算、ファイル出力 |
| demo認可witness生成 | 55 ms | 同上 |
| 証明処理の壁時計時間 | 4,425 ms | 入力準備、witness生成、pool証明3,698 ms、認可証明228 ms、ローカル検証、ファイル出力 |
| 暗号化準備プロセスの壁時計時間 | 172 ms | 暗号化準備とプロセス起動を含む |

証明処理の壁時計時間から二つの証明生成時間を引いた値は、witness生成だけの時間ではない。
起動や入出力なども含まれるためである。

### 操作と受領の確認範囲

[操作別の条件](../../benchmarks/prior-eips/cases/manifest.json)で実入力、phantom、実出力、dummy、公開出金額を固定した。
平文と暗号化をそれぞれ17ケース実行し、全ケースで取引が成功した。
以下の操作別の値は**各条件1回**の結果であり、主測定の3試行中央値と同じ精度の代表値ではない。
入力と出力は実在するnoteの額だけを示す。
回路は2入力・3出力固定で、足りない欄にはphantom入力やdummy出力を入れた。
ETHの額はwei、MockERC20の額は試験トークンの最小単位である。
「公開」はnoteからETHまたはMockERC20を外へ出した額である。

| 操作 | 資産 | note入力 → note出力 | 公開 | 平文gas | 暗号化gas |
| --- | --- | --- | ---: | ---: | ---: |
| S-02 全額送金 | ETH | 10 → 10 | 0 | 3,536,615 | 3,592,526 |
| S-02 全額送金 | MockERC20 | 10 → 10 | 0 | 3,536,615 | 3,592,550 |
| S-03 部分送金 | ETH | 10 → 3+7 | 0 | 3,536,603 | 3,650,325 |
| S-03 部分送金 | MockERC20 | 10 → 3+7 | 0 | 3,536,639 | 3,650,313 |
| S-04 2入力送金 | ETH | 2+3 → 4+1 | 0 | 3,536,615 | 3,650,313 |
| S-04 2入力送金 | MockERC20 | 2+3 → 4+1 | 0 | 3,536,603 | 3,650,313 |
| S-05 自己合算 | MockERC20 | 10+5 → 15 | 0 | 3,536,627 | 3,592,526 |
| S-05 自己分割 | MockERC20 | 10 → 3+7 | 0 | 3,536,591 | 3,650,301 |
| S-05 自己再作成 | MockERC20 | 10 → 新しい10 | 0 | 3,536,615 | 3,592,550 |
| 2入力全額送金 | MockERC20 | 10+5 → 15 | 0 | 3,536,603 | 3,592,562 |
| 2入力部分送金 | MockERC20 | 10+5 → 8+5+2 | 0 | 3,536,615 | 3,708,105 |
| S-06 全額出金 | ETH | 10 → なし | 10 | 3,571,309 | 3,569,490 |
| S-06 部分出金 | ETH | 10 → 7 | 3 | 3,571,345 | 3,627,268 |
| 2入力全額出金 | ETH | 10+5 → なし | 15 | 3,571,321 | 3,569,442 |
| 2入力部分出金 | ETH | 10+5 → 5+2 | 8 | 3,571,309 | 3,684,955 |
| 2入力全額出金 | MockERC20 | 10+5 → なし | 15 | 3,563,664 | 3,561,797 |
| 2入力部分出金 | MockERC20 | 10+5 → 5+2 | 8 | 3,568,464 | 3,682,173 |

平文gasと暗号化gasの差には、暗号文の掲載以外にcalldataの形や実行経路の違いも含まれる。
全額出金のように暗号化版のgasが小さいケースもあるため、この差を暗号化だけの追加費用とは扱わない。
暗号化版は公開ログから実出力を復号し、全額出金では受取人の公開残高を確認した。
[暗号化版の全結果](../../benchmarks/prior-eips/cases/encrypted-summary.json)と[平文版の全結果](../../benchmarks/prior-eips/cases/summary.json)には、入出力の実在フラグ、残高、receiptへのパスも記録した。
平文版の証明生成時間も後者にある。

次の表では、同じ17ケースの暗号化版について、証明生成、暗号化、受領の時間を示す。
「暗号文」は全出力の合計byte数で、出力のない全額出金では0である。
「同期」は公開ログの取得、復号試行、indexer処理を含む壁時計時間である。
時刻は見やすいよう整数msに丸めたため、正確な小数値は[集計JSON](../../benchmarks/prior-eips/cases/encrypted-summary.json)を参照する。

| 操作 | 資産 | pool証明 | 認可証明 | 暗号化 | 暗号文 | 同期 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| S-02 全額送金 | ETH | 1,692 ms | 117 ms | 5 ms | 2,348 byte | 26 ms |
| S-02 全額送金 | MockERC20 | 3,808 ms | 296 ms | 11 ms | 2,349 byte | 43 ms |
| S-03 部分送金 | ETH | 1,675 ms | 128 ms | 8 ms | 4,696 byte | 32 ms |
| S-03 部分送金 | MockERC20 | 4,276 ms | 261 ms | 16 ms | 4,695 byte | 64 ms |
| S-04 2入力送金 | ETH | 1,584 ms | 149 ms | 8 ms | 4,697 byte | 33 ms |
| S-04 2入力送金 | MockERC20 | 5,252 ms | 332 ms | 20 ms | 4,696 byte | 59 ms |
| S-05 自己合算 | MockERC20 | 3,557 ms | 258 ms | 10 ms | 2,348 byte | 43 ms |
| S-05 自己分割 | MockERC20 | 1,959 ms | 120 ms | 9 ms | 4,696 byte | 35 ms |
| S-05 自己再作成 | MockERC20 | 1,742 ms | 119 ms | 5 ms | 2,348 byte | 27 ms |
| 2入力全額送金 | MockERC20 | 3,986 ms | 393 ms | 10 ms | 2,349 byte | 44 ms |
| 2入力部分送金 | MockERC20 | 4,597 ms | 356 ms | 21 ms | 7,044 byte | 77 ms |
| S-06 全額出金 | ETH | 3,654 ms | 240 ms | 0 ms | 0 byte | 22 ms |
| S-06 部分出金 | ETH | 3,244 ms | 236 ms | 10 ms | 2,347 byte | 41 ms |
| 2入力全額出金 | ETH | 5,682 ms | 314 ms | 0 ms | 0 byte | 26 ms |
| 2入力部分出金 | ETH | 4,247 ms | 364 ms | 18 ms | 4,692 byte | 57 ms |
| 2入力全額出金 | MockERC20 | 4,859 ms | 368 ms | 0 ms | 0 byte | 22 ms |
| 2入力部分出金 | MockERC20 | 5,354 ms | 558 ms | 34 ms | 4,695 byte | 67 ms |

実出力が0個の全額出金では暗号文がなく、3個の2入力部分送金では7,044 byteになった。
この17ケースの暗号化gasは3,561,797〜3,708,105だが、操作条件も違うため幅を性能のばらつきとは解釈しない。

S-01ではETHを10入金し、そのnoteを後続の出金で消費した。
ETHのS-04は[追加の3試行](../../benchmarks/prior-eips/cases/eth-repeat-summary.json)でも測り、gasは3,650,313 / 3,650,301 / 3,650,277、中央値は3,650,301だった。

### 受取人による後続出金

S-07では、送信者の生成済み入力を削除した後、受取人が公開履歴と事前保持した試験鍵から8のnoteを復号した。
受取人は自分のpolicyを1,465,480 gasで登録し、新たにpool証明と認可証明を生成して、この8を[公開MockERC20へ出金](../../benchmarks/prior-eips/recipient/reuse-result.json)した。
この単発出金のwitness生成は201 ms、pool証明生成は4,213 ms、認可証明生成は515 msだった。
出金receiptは成功、3,561,214 gasで、受取人の公開残高は0から8になり、nullifierとreplay IDも消費された。
受取人による再送金は試していないため、本体のS-07が要求する再送金と出金の両経路を確認した結果とは扱わない。

主測定では、改ざんした認可対象の取引が3試行とも失敗し、正しい取引では2つのnullifierとreplay IDが消費された。

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
