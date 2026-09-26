# 先行EIP/ERCの比較と実測計画

この資料は[Issue #10](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/10)における比較対象の選定と、後続の設計・評価に再利用するための調査記録である。要求と本体の正しい振る舞いは[PRD](../PRD.md)、[要件定義](../requirements.md)、[仕様](../specification.md)を正本とする。以下の採用判断は調査段階の判断であり、測定構成の実行可能性や本体の設計を確定しない。

確認日: 2026-09-26。対象版は、[EIP-8182 `59454e9`](https://github.com/ethereum/EIPs/blob/59454e9b9f577c8b9ed1246714f44990711e5751/EIPS/eip-8182.md)、[EIP-7503 `6766049`](https://github.com/ethereum/EIPs/blob/676604927b316a44195008e632778d4ca1101deb/EIPS/eip-7503.md)、[ERC-8086 `84e5d9f`](https://github.com/ethereum/ERCs/blob/84e5d9fba8b1ee31352bb67e515d3a5ab5662eba/ERCS/erc-8086.md)で固定する。各公式表示ページの状態はそれぞれ **Review / Core**、**Stagnant / Core**、**Draft / ERC**。参照実装の版は各行に記す。これらの状態、公開先、実装内容は確認後に変わり得る。

## 候補の選定

| 提案 | 資産と状態遷移 | 入金・送金・合算・出金・受領 | 実測の可用性と判断 |
| --- | --- | --- | --- |
| [EIP-8182](https://eips.ethereum.org/EIPS/eip-8182) | ETHと対応ERC-20を共通のシールドプールのnoteとして保持するCore提案。入金は証明不要、消費は2入力・3出力固定のpool証明と、登録済み認可方式の別証明を検証する。システムコントラクトの設置にはforkが必要。 | ETH入金、1または2実入力の私的送金、2入力の合算、公開ETH/トークンへの全額・部分出金に対応。`outputNoteData`を公開イベントに載せるが、配送の暗号化と受取人による復元はEIPの規定外。 | **第一実測候補**。[著者の参照実装 `639baaf`](https://github.com/0xFacet/eip-8182-reference-implementation/tree/639baaf7b29c22eb43ba6150140902ea8dbbbc46)にpool回路、実証明生成、検証器、統合テストがある。認可と受領は同じ構成で別途固定・実行確認が必要。 |
| [EIP-7503](https://eips.ethereum.org/EIPS/eip-7503) | 秘密から作る使用不能アドレスへの公開ETH送付を後から証明し、別アドレスにETHを再発行する新取引種別。changeを次の秘密入金として作る。 | 公開ETHのburnと証明付きremint、部分remintを記述する。私的UTXOの受取人note配送、プール内送金、指定した2入力の合算送金は同じ操作として定義されない。remint先と額は公開取引から観測できる。 | **資料比較のみ**。本文の取引種別番号、nullifier先、receipt prefixはTBD。[参照実装とSNARK実装もTBD](https://eips.ethereum.org/EIPS/eip-7503#reference-implementation)。EIP-7708とSSZ receipt変更、対応クライアントを要し、今回のローカルコントラクト経路に置き換えても提案の実測にならない。 |
| [ERC-8086](https://eips.ethereum.org/EIPS/eip-8086) | `IZRC20`の機密トークンインターフェース。commitment、nullifier、暗号化noteのイベントを定義し、証明方式や木構成は実装ごとに選ぶ。ETHプール規格ではない。 | `mint`と`transfer`を定義。通常トークンからの預入、全額・部分出金、2入力合算の具体的経路は上位wrapperまたは個別実装次第。イベントからの復号を意図するが暗号方式も個別設定。 | **資料比較のみ**。[公式参照資産](https://eips.ethereum.org/assets/eip-8086/)にはSolidity・Groth16検証器がある一方、回路ソース、`.zkey`・`.wasm`、証明生成SDKがないと明記。提案と結び付く公開資産から証明生成を再現できないため、現時点で実測代替としない。 |

### EIP-8182の機能、公開情報、信頼前提

[仕様のoverview](https://eips.ethereum.org/EIPS/eip-8182#1-overview)では、pool証明がnote存在、所有、資産保存、nullifierなどを確認し、別の認可検証器が操作意図を認証する。1入力にはphantom入力、少ない出力にはdummy出力を使う。私的送金の金額とtoken種別は公開せず、消費noteと生成noteの直接の対応は公開しない。ただしnullifierと出力commitment、使用した認可検証器、トランザクション提出者とタイミングは観測できる。[機密性の説明](https://eips.ethereum.org/EIPS/eip-8182#metadata-leakage)によれば、入金は送信元・資産・金額、出金は公開宛先・資産・金額を示す。`outputNoteData`の長さと内容は追加情報を漏らし得る。

利用者の認可方式は登録された検証器に依存する。[認可検証器への信頼](https://eips.ethereum.org/EIPS/eip-8182#auth-verifier-trust)を含めて測定構成を記録する。poolのGroth16検証鍵は仕様に固定され、参照実装の開発用証明鍵は単独参加者のセットアップによるものと[README](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/README.md#trusted-setup)が説明する。研究用実行と本番の信頼条件は異なる。システムコントラクトに管理者pauseやupgradeはなく、変更はfork管理である。

[Output Note Data節](https://eips.ethereum.org/EIPS/eip-8182#12-output-note-data)は、受領データを不透明なbytesとしてイベントに載せ、送金時にはhashで証明と結ぶが、暗号化・配送形式・受取人の復元を定義しない。[Sepolia demo](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/sepolia-demo/README.md)には受取鍵の登録、ML-KEM-768とX25519による暗号化、イベント走査と試行復号、noteの整合性確認がある。ただしdemo独自のregistryと通常CREATEで配置したpoolを使う。これを利用する場合、EIPの基本処理とdemo固有の登録・配送・同期の費用を分け、実際のpool証明と認可証明が同じpoolで検証されることを確認する。demoは取引提出者の匿名性を提供しない。

### EIP-7503とERC-8086の限界

[EIP-7503仕様](https://eips.ethereum.org/EIPS/eip-7503#specification)はburnへの通常送金をプライバシー用途として識別しにくくする一方、remint取引の公開`withdraw_value`と宛先を用いる。所有者の受領noteを発行する方式ではなく、入出金の機能と公開情報がEIP-8182や本体仕様と異なる。transparent setupを意図するが、具体的な証明系と実装は未定である。公開gas・証明生成時間は本文にない。

[ERC-8086仕様](https://eips.ethereum.org/EIPS/eip-8086#core-interface)は送金時に暗号化noteと任意のview tagを公開する。金額、送信者、受信者の秘匿を実装に要求するが、実際の保証は選んだ回路・暗号化・メタデータ次第である。公開トークンのwrapperなら預入前のapproveと変換、出金時の逆変換を含む追加取引が必要になり得る。このインターフェースに通常ETHの出金関数はない。公式資産は実証明生成に必要な物を欠き、外部の別方式を仮に組み合わせて得る数値をERC-8086参照実装の測定値とは扱わない。公式本文と参照資産に、再現条件の揃ったgas・証明生成・配送時間の実測表は確認できなかった。

## 本体のケースとの対応

以下は比較可能性の調査であり、成功した試験の記録ではない。本体の[S-01〜S-07](../specification.md#必須の動作シナリオ)と同じ金額・実入力数・実出力数に揃えられるかを、採用した実装で確認する。

| 本体ケース | EIP-8182で試す経路 | 差と測定上の扱い |
| --- | --- | --- |
| S-01 入金10 | ETH `deposit`後に生成noteを消費 | 入金自体はpool証明不要。初回認可登録と受領データ掲載を分けて記録する。 |
| S-02 10の全額送金 | 1実入力、受取人note 1実出力 | phantom入力とdummy出力を使用する。 |
| S-03 10から3の部分送金 | 1実入力、受取人3と釣銭7 | 同じ送金経路で出力数の差を記録する。 |
| S-04 2と3を合算して4送金 | 2実入力、受取人4と釣銭1 | 2実入力の証明と両入力の同一所有を確認する。 |
| S-05 自己宛て合算・分割・再作成 | 2入力自己宛て合算、1入力2出力分割、1入力1出力再作成 | S-02〜S-04と共通の`transact`経路でも、自己宛て出力の回復と再使用を別途確認する。性能をS-02〜S-04の値から代表させる場合は、入力・出力・配送条件が同じことを示す。 |
| S-06 全額・部分出金 | ETH `transact`の出金モード。部分出金は釣銭noteを生成 | 公開宛先・出金額が見える。EOA、第三者、ETH受領コントラクトへの対応を別途確認する。 |
| S-07 停止中受領と再使用 | demo配送を採用するなら受取人停止後に送金し、公開履歴から同期、復号、再送金または出金 | EIP本文は配送形式を定めず、demo固有処理の検証が必要。本体S-07は**再送金と出金の両方**を要求するため、候補で一方だけ実行した結果を同等の保証としない。 |

## 公開値と今回の測定値

公開値は[参照実装READMEの例示表](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/README.md#benchmarks)から引用する。対象はApple M5 Max、native `rapidsnark`を使ったGroth16 pool・demo認可の表示であり、環境・入力・測定範囲が本Issueの正式条件と一致することは未確認。表のgasは`Berlin`の21,000 intrinsicとcalldataを含むと説明される。

| 操作 | README表示gas | README表示の証明生成 | 出典と性質 |
| --- | ---: | --- | --- |
| 認可登録 | 2,019,847 | 不要 | 外部資料の例示値 |
| ETH入金 | 1,811,441 | 不要 | 外部資料の例示値 |
| ERC-20入金 | 1,836,602 | 不要 | 外部資料の例示値。approve費用は別扱い |
| 送金 | 3,306,055 | pool 0.12秒、demo認可0.03秒 | 外部資料の**算出gas**と証明時間の表示 |
| ETH出金 | 3,340,785 | 表示はpool 0.12秒、demo認可0.03秒 | 外部資料の**算出gas**。時間は送金用値を流用 |
| ERC-20出金 | 3,332,563 | 表示はpool 0.12秒、demo認可0.03秒 | 外部資料の**算出gas**。時間は送金用値を流用 |

[Bench.t.sol](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/contracts/test/Bench.t.sol)の送金・出金は、実際のpool証明とHonk認可証明を検証する一方、呼出し前後の`gasleft()`で実行gasを測り、トランザクションreceiptのgasではない。`outputNoteData`には`eip-8182-output-0`等の固定平文bytesを渡し、暗号配送・同期・復号の実測ではない。[集計コード `render.js`](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/scripts/bench/render.js#L84)は、Honk認可で取得した実行gasからHonk検証費用を引き、Groth16 demo認可検証費用を足して表示gasを作る。証明時間は`build/integration/timings.json`の送金用値を各`transact`行に優先適用し、`wallet e2e`はpoolと認可の証明時間の単純和である。README本文にも、表示gasはGroth16 demo認可、別のproduction-shaped ECDSA認可はNoir/UltraHonkと説明される。したがって表示の組合せを、同一認可構成でreceiptまで実行した今回の値や、処理全体の壁時計時間として転記しない。READMEの例示表と内訳表には数十gasの差もあり、正式値は生データから再集計する。

今回取得した値と、その構成・限界を後述する。公開値の空欄や不要な処理は0に置き換えない。各値について「今回の実行／外部資料」と「直接計測／算出／未確認」を区別する。

## 実装・測定計画

作業範囲と完了条件は[Issue #10](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/10)に従う。実行用コード・固定設定・生データ・再集計は`benchmarks/prior-eips/`に置く。以下は作業時に用いた段階と受入条件であり、各段階の到達範囲は結果節で示す。

| 段階 | 目的と入力 | 編集対象・成果物 | 依存と受入条件 |
| --- | --- | --- | --- |
| 1. 候補調査 | 公式文書、著者資料、公開実装の版・保証・必要資産を確認 | 本資料の候補表と根拠 | 先行段階なし。EIPと実装の対応、欠落物、公開値の範囲を追跡可能にする。 |
| 2. 構成選定 | EIP-8182の認可方式・生成器・受領方式を一組として選ぶ | `benchmarks/prior-eips/`の固定設定と差分記録 | 段階1に依存。pool・認可・配送が同じ実行経路でつながること、回路・鍵・ツールの取得元とhashを確認する。できなければ失敗条件を記録して適格代替を再調査する。 |
| 3. 最小実行 | 固定した構成で証明を生成しローカルEthereumに送る | 最小実行スクリプト、receipt、成功・改ざん拒否・二重使用拒否の記録 | 段階2に依存。poolと選定認可の実検証、状態変化、受取人の後続使用を確認する。検証スキップのハーネスは根拠にしない。 |
| 4. 計測追加 | S-01〜S-07の対応操作と配送・同期・初回処理の境界を計測 | 計測コード、機械可読設定、試行出力形式 | 段階3に依存。intrinsic・calldata・実行・返金の定義、witnessと前処理、公開履歴の条件を固定し、値がreceiptや時計測定と対応する。 |
| 5. 反復測定 | 固定入力、環境、状態、反復数、統計量で成功・失敗を記録 | 全試行の生データ、ログ、集計コードと結果 | 段階4に依存。失敗や外れ値を隠さず、配送と証明を含む必要項目を同一構成で測る。初回費用と反復費用を混ぜない。 |
| 6. 再現確認 | クリーンな作業ディレクトリで取得、準備、最小実行、測定、再集計 | 再現スクリプト、環境記録、再実行ログ | 段階5に依存。公開ツール・CPU・実資金なしで表が生データから再生成され、差を説明できる。 |
| 7. 文書化 | 実測と機能・機密性・信頼前提を整理し#7へ引き継ぐ | 本資料の実測節、`README.md`の案内 | 段階6に依存。数値と出典、未達理由、再利用条件、ローカルリンクが確認できる。 |

正式測定前にはOS、CPU、メモリ、並列数、ツールと依存版、EVM fork、実行上限、資産・金額・入出力・ダミー、木と履歴の状態、登録状態、warm-up、キャッシュ、試行数・集計・タイムアウトを固定する。予備実行で変えた条件は正式測定から分けて残す。認可方式と配送方式を変えた場合は別の測定構成とする。システムコントラクトの特別なgenesis配置や本番と異なるgas制限を使う場合も、結果の適用範囲に明記する。

## 今回の実行構成と結果

参照実装は`639baaf7b29c22eb43ba6150140902ea8dbbbc46`に固定した。最初に試したNoir/UltraHonk認可は、[署名生成スクリプト](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/scripts/noir/gen_prover_toml.js)が16項目のEIP-712メッセージに署名する一方、同じコミットの[認可回路](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/circuits-noir/auth/src/main.nr)は旧7項目を検証するため、`nargo execute auth`で`signature invalid`となった。`nargo` beta.18とbeta.19で同じ失敗を確認した。[失敗記録](../../benchmarks/prior-eips/status.json)に試行経路を残した。回路やプロトコルを変更することは今回の許容範囲外である。

実測には参照実装のGroth16 pool証明とGroth16 demo認可証明を同時に生成・検証する構成を採用した。demo認可は固定の試験用秘密を知ることを示す回路であり、ECDSAウォレット署名の安全性や生成費用を示す値ではない。認可方式の違いは比較の条件であって、Honk認可の費用をこの実測値へ足し引きしない。詳細な版、ハッシュ、OS、CPU、Anvilと測定条件は[固定設定](../../benchmarks/prior-eips/config.json)に記録した。

主測定ではMockERC20の2入力`10 + 5`を消費し、受取人`8`、送信者の釣銭`5`、私的手数料note`2`の3実出力を作った。値はトークンの最小単位であり、ETHのweiとして扱わない。出力の受領データは[Sepolia demo](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/sepolia-demo/README.md)のML-KEM-768/X25519による方式で証明生成前に暗号化し、各暗号文のhashをpool witnessと認可対象に結び付けた。受取公開鍵は試験用に事前共有し、demoのオンチェーン受取鍵registryは使用していない。暗号文の公開`kid`と長さは観測可能である。

Anvil 1.7.1のchain ID 1、Cancun、gas limit 30,000,000、code size制限解除で実行した。EIPのシステムコントラクト用[初期状態](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/assets/eip-8182/shielded-pool-state.json)をAnvil RPCで設置したため、poolのfork導入gasは測定していない。通常のEthereumで同じ状態やgas limitが利用可能という証拠ではない。各正式試行では`anvil_reset`を行い、同じgenesis時刻と登録前状態から開始した。

ウォームアップ1回と正式3回を実行した。以下は[全試行の生データ](../../benchmarks/prior-eips/raw/repeated/)から[集計スクリプト](../../benchmarks/prior-eips/aggregate.mjs)で再生成した正式3回の中央値である。値は今回の実行によるものとし、gasと時間の計測範囲を区別する。

| 項目 | 中央値 | 取得方法と範囲 |
| --- | ---: | --- |
| 暗号化受領データを含む送金 | 3,708,117 gas | **直接計測**。実トランザクションの`eth_getTransactionReceipt.gasUsed`。3試行は3,708,117 / 3,708,105 / 3,708,117 gas |
| pool証明生成 | 3,946 ms | **直接計測**。`snarkjs.groth16.prove`のみ。入力作成・witness生成・ローカル検証は含まない |
| demo認可証明生成 | 245 ms | **直接計測**。同じく`snarkjs.groth16.prove`のみ。認可入力作成とwitness生成は含まない |
| 3出力の暗号化 | 20.05 ms | **直接計測**。各出力のenvelope作成時間の合計。3暗号文は合計7,044 byte |
| 公開履歴からの同期 | 72.98 ms | **直接計測**。RPC取得、試行復号、indexer処理を順に行った全体の壁時計時間。3ログ・5出力・12復号試行 |
| 送金calldata | 130,360 gas | **算出**。実送信calldataのゼロ/非ゼロbyteから4/16 gasで計算した取引全体gasの内数 |
| 暗号文のABI末尾 | 113,400 gas | **算出**。3暗号文、各長さ語、paddingのcalldata gas。取引全体gasと二重加算しない |
| 所有者policy登録 | 2,014,817 gas | **直接計測**。通常送金前に必要な別トランザクション |
| ERC-20入金1回目 / 2回目 | 1,836,074 / 1,227,713 gas | **直接計測**。各別トランザクション。MockERC20発行44,188 gasは試験準備として別扱い |

送金receiptの内訳は、21,000 intrinsic gas、130,360 calldata gas、残り3,556,757 gasが実行と返金の純額である。暗号文部分の113,400 gasはcalldataの内数であり、イベント掲載がEVM実行gasへ与える分はこの数字に含まれない。固定平文bytesを用いた同形の[補助ケース](../../benchmarks/prior-eips/cases/summary.json)の送金は3,536,615 gasだった。差171,502 gasは配送形式だけでなく、暗号文と証明byteの内容、実行時のデータ処理の差を含むため、暗号文掲載の厳密な限界費用とは扱わない。準備や証明の時間を足した値も、操作開始から受領までの壁時計時間とは区別する。

[初回費用のreceipt](../../benchmarks/prior-eips/raw/repeated/trial-1/receipts.json)にはdemo認可検証器の配備364,338 gasとwrapper配備266,947 gasも残した。pool用の開発証明鍵は参照実装から取得し、demo認可鍵はローカルの単独参加者セットアップで生成した。同期の`trialDecryptMs`と`indexMs`はindexerが内部で再度復号するため、両者の和を単一ウォレットの所要時間としない。

正式3試行とは別の単発の[初回準備測定](../../benchmarks/prior-eips/raw/setup-timing/setup-timing.json)では、Apple M4・32 GiBの新規checkoutでclone、依存取得、pool回路のコンパイル、demo認可鍵の開発用セットアップ、コントラクトと配送SDKのビルドを順に実行し、合計64.6秒だった。既存npmダウンロードキャッシュとネットワーク条件に依存する。単発の[witness生成測定](../../benchmarks/prior-eips/raw/setup-timing/witness-timing.json)はpool 150 ms、demo認可55 msで、Nodeプロセス起動、WASM読込、witness計算とファイル出力を含む。入力作成と証明生成は含まない。これらを正式3試行の証明時間と単純に足して、同一試行の処理全体時間と呼ばない。

改ざんした認可対象の実取引は3試行ともreceipt status `0`で拒否され、その後に正しい取引が成功した。成功後は2つのnullifierとreplay IDの使用、note rootの更新を確認した。[再現スクリプト](../../benchmarks/prior-eips/repeat.sh)と[README](../../README.md)の手順を別のクリーンcheckoutで再実行し、証明生成から公開履歴の復号まで確認した。同じcheckoutでウォームアップ1回と正式3回を再実行した[集計と全試行記録](../../benchmarks/prior-eips/raw/clean-replay-repeated/aggregate.json)では、receipt gasの中央値は3,708,093 gasだった。新たな開発用demo認可鍵は生成ごとにhashが異なるが、poolの鍵とWASMのhashは一致した。環境による時間の完全一致は要求せず、同じ手順と範囲で再計測できることを確認した。

### 操作別の補助ケース

論理シナリオとの対応は[ケース条件](../../benchmarks/prior-eips/cases/manifest.json)に記録した。参照実装の固定平文`outputNoteData`を使った[補助結果](../../benchmarks/prior-eips/cases/summary.json)と、実出力のみを同じSepolia demo方式で暗号化して公開履歴から復号した[補助結果](../../benchmarks/prior-eips/cases/encrypted-summary.json)を分けた。どちらも**各ケース1回の実receiptから直接計測したgas**であり、3回反復した主測定の中央値ではない。

| 仕様との対応 | 論理上の入力 → 結果 | 実入力・出力とdummy | 固定平文gas | 暗号配送gas |
| --- | --- | --- | ---: | ---: |
| S-01 ETH入金 | Aが10を入金し、後続で使用 | 入金は証明不要。受取本人がnoteを生成し、配送暗号文を使わない | 1,798,919 | 1,798,919 |
| S-02 全額送金 | 10 → Bの10 | 1実入力+phantom、1実出力+2 dummy、手数料0 | 3,536,615 | 3,592,550 |
| S-03 部分送金 | 10 → Bの3+Aの7 | 1実入力+phantom、2実出力+1 dummy、手数料0 | 3,536,639 | 3,650,313 |
| S-04 合算送金 | 2+3 → Bの4+Aの1 | 2実入力、2実出力+1 dummy、手数料0 | 3,536,603 | 3,650,313 |
| S-02 ETH全額送金 | 10 → BのETH note 10 | 1実入力+phantom、1実出力+2 dummy、手数料0 | 3,536,615 | 3,592,526 |
| S-03 ETH部分送金 | 10 → BのETH note 3+AのETH note 7 | 1実入力+phantom、2実出力+1 dummy、手数料0 | 3,536,603 | 3,650,325 |
| S-04 ETH合算送金 | 2+3 → BのETH note 4+AのETH note 1 | 2実入力、2実出力+1 dummy、手数料0 | 3,536,615 | 3,650,313 |
| S-05 自己宛て合算 | 10+5 → Aの15 | 2実入力、1実出力+2 dummy | 3,536,627 | 3,592,526 |
| S-05 自己宛て分割 | 10 → Aの3+Aの7 | 1実入力+phantom、2実出力+1 dummy | 3,536,591 | 3,650,301 |
| S-05 同額再作成 | 10 → Aの新しい10 | 1実入力+phantom、1実出力+2 dummy。新旧noteは別識別子 | 3,536,615 | 3,592,550 |
| S-06 ETH全額出金 | 10 → 公開ETH10 | 1実入力+phantom、3出力dummy、手数料0。暗号化不要 | 3,571,309 | 3,569,490 |
| S-06 ETH部分出金 | 10 → 公開ETH3+Aの7 | 1実入力+phantom、1実出力+2 dummy、手数料0 | 3,571,345 | 3,627,268 |
| ETH 2入力の全額出金 | 10+5 → 公開ETH15 | 2実入力、3出力dummy、手数料0 | 3,571,321 | 3,569,442 |
| ETH 2入力の部分出金 | 10+5 → 公開ETH8+Aの5+手数料note2 | 2実入力、2実出力+1 dummy | 3,571,309 | 3,684,955 |
| ERC-20全額出金 | 10+5 → 公開15 | 2実入力、3出力dummy、手数料0 | 3,563,664 | 3,561,797 |
| ERC-20部分出金 | 10+5 → 公開8+釣銭5+手数料note2 | 2実入力、2実出力+1 dummy | 3,568,464 | 3,682,173 |

入金10のnoteが後続出金で消費され、出金先の公開資産が増え、全額出金後は対象資産のpool残高が0となった。暗号化ケースでは実出力の暗号文だけを作り、dummy出力は空bytesを証明のhashへ結び付けた。公開ログから各実出力を取得・復号し、全額出金では実出力0件と記録した。[ケース別生データ](../../benchmarks/prior-eips/cases/encrypted/)には証明、receipt、配送、同期の記録を残した。S-02〜S-04はMockERC20とETHの両方で仕様例の金額と入出力数を合わせ、1入力のS-06も確認した。ETH受領先は通常アドレスのみ確認し、受領可能コントラクトや拒否する宛先は未実行である。

ETHのS-04合算送金は別途[3試行の生データと再集計結果](../../benchmarks/prior-eips/cases/eth-repeat-summary.json)を残した。各試行で状態をリセットして証明を作り直し、暗号化した受取人4と釣銭1を公開ログから復号した。receipt gasは3,650,313 / 3,650,301 / 3,650,277、中央値は**3,650,301 gas**である。[反復スクリプト](../../benchmarks/prior-eips/cases/repeat-eth.sh)と[再集計スクリプト](../../benchmarks/prior-eips/cases/summarize-eth-repeat.mjs)で再現できる。上表のETH S-04行は初回試行の値を示す。

トークン側は参照実装の[試験用MockERC20](https://github.com/0xFacet/eip-8182-reference-implementation/blob/639baaf7b29c22eb43ba6150140902ea8dbbbc46/contracts/test/MockERC20.sol)を用いた。この`transferFrom`はallowanceを検査しないため、approve取引のgasと一般的なERC-20のallowance処理費用は含まれない。トークン入金gasを一般的なERC-20利用費用の代表値とみなさず、ETHケースとの資産差と併せて示す。

### 受取人の独立使用

別の[受領後使用スクリプト](../../benchmarks/prior-eips/recipient/run.sh)では、暗号化送金を確定した後に送金者の生成済みsessionと入力を削除し、受取人を別プロセスで起動した。受取人は事前保持した試験用の所有鍵・認可秘密・復号鍵と公開履歴から、8の出力を発見・復号し、note treeと認可policy treeのrootをチェーン状態と照合した。受取人自身のpolicy登録後、新たなpool証明とdemo認可証明を生成して8を公開ERC-20へ出金した。

[試行記録](../../benchmarks/prior-eips/recipient/reuse-result.json)では、policy登録1,465,480 gas、pool証明生成4,213 ms、demo認可証明生成515 ms、出金receipt3,561,214 gasで、受取人の公開トークン残高は8増加した。両証明のローカル検証、nullifierとreplay IDの消費を確認した。これはS-07に対応する**出金による後続使用1経路**の直接計測である。再送金も行う本体S-07全体と同等の保証ではない。受取人の鍵は固定の試験用で、demo認可の安全性の限界も主測定と同じである。

## 設計と最終評価への引継ぎ

本体との比較では、資産、入出力数、dummy、私的手数料note、認可方式、暗号配送、初回policy登録、特別なgenesis状態とgas制限を揃えるか、違いを併記する。主測定のMockERC20 2入力・3実出力と、本体のETHを同等の取引として順位付けしない。今回のreceipt中央値だけから本体の性能優位は判断できない。条件が揃わない場合は先行方式を再測定する。

現時点で測定または保証できていないものは、実運用に近いECDSA/Honk認可構成、正式3試行と同じ回でのwitness生成・準備を含む操作全体の壁時計時間、通常Ethereumのブロックgas制限下での成立、ETH受領先コントラクトの成功・拒否、受取人による再送金である。操作別の暗号化ケースでは各実出力の復号まで確認したが、その各ケースで受取人が後続使用することは試していない。後続出金の実証は主測定と同じ2入力・3実出力の送金から受け取った8のnoteについてである。これらを実測構成の限界として残し、[設計Issue #7](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/7)では本体固有の認可・受領・評価構成と比較条件を決める際に参照する。
