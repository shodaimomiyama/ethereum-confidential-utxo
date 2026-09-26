# Uniswap接続の方式・詳細設計

## 目的と文書の状態

[Issue #40](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/40)に基づき、[接続仕様](specification.md)を実現する初版の詳細規則と採用根拠を定める。本書を実装の基準とする。未実装部分の成立性は[#45〜#50](#実装後の検証と見直し条件)で検証し、不成立なら設計を改訂する。構成条件は[Architecture](architecture.md)を参照する。

参照開始コミットは `1fdaa062e2fc4a09de178cad23e478c3a862f785`。本体の規範は[本体設計](../../design.md)を参照し、接続文書だけで変更しない。

以下の規則は合意済みの構成条件を具体化した採用方式である。局所実験の部分結果は成立性を実証する範囲に限定し、実装後の受入結果と混同しない。

## 実装が従う詳細規則

以下の認可、ABI、資産移動、鍵、同期、配布の規則に実装を合わせる。環境固有の版・アドレスと実測値は対象の試験・配置前にmanifestへ固定する。

### 最終受取人の対応範囲

対応仕様: [支払い由来の資産と全量着金](specification.md#支払い由来の資産と全量着金)。

通常のウォレットに加えて、デモトークンを保持するコントラクトのアドレスも許容する。送付はトークン移転のみとし、受取先の任意処理を呼び出す機能を設けない。Adapterは受取先がゼロ、Adapter、Pool、Router02、Factory、WETH、dUSD、Pairのいずれでもないことを、固定配置アドレスとの比較で検査する。これらを初版の禁止集合とし、コントラクトであることだけを理由に拒否しない。

### デモ資産と初期状態

対応仕様: [金額と入力の境界](specification.md#金額と入力の境界)、[必須の推論履歴](specification.md#必須の推論履歴)。

名称は `Demo USD`、symbolは `dUSD`、decimalsは18。配置時に100万枚を発行し、その後のmint、転送手数料、rebase、upgradeを設けない方針を合意した。ドルへの償還と価格安定は保証しない。ETHとdUSDは別の資産であり、表示上の小数桁数が同じでも互換な単位として扱わない。

初期流動性は0.1テストETH相当のWETHと1万dUSD。流動性の準備と配布元への入金は別の操作・資金である。必須推論例は `u = 10^15 wei` とし、配布元の公開入金は `10u = 0.01 ETH`、報酬は `6u = 0.006 ETH`、支払いは `3u = 0.003 ETH`、残額は `3u` とする。流動性提供用の履歴を必須例のUTXOへ混ぜない。公開サイトの報酬額・支払額の初期値は空欄のままとし、この例の額で固定しない。

### 支払い認可と公開ABI

対応仕様: [認可対象と実行時の検査](specification.md#認可対象と実行時の検査)、[コピー提出・競合・再入](specification.md#コピー提出競合再入)。

接続コントラクトを `UniswapPaymentAdapter` と呼ぶ。Pool、Router02、Factory、WETH、dUSD、Pairは配置時に検査して固定し、管理者による差替え、upgrade、任意call、delegatecall、救済出金を設けない。異なる構成は別デプロイとして識別する。構成アドレス、runtime hash、配置ブロックhashと版は環境manifestに記録する。

Adapterのconstructorは、六つの参照先にコードが存在し、Router02の`factory()`/`WETH()`、Factoryの`getPair(WETH,dUSD)`、Pairの`factory()`/`token0()`/`token1()`が固定構成と一致することを検査する。ゼロ・コードなし・不一致・照会失敗では配置を拒否する。Pairの二つのtokenはアドレスの昇順で照合する。六つの固定アドレスは公開getterから読み出せる。constructor自身の構成不一致は`InvalidConfiguration()`で表す。採用した実コードのhashと配置取引の照合は環境manifestの検証が担当し、constructorの返答整合だけで実コードの真正性を主張しない。

本体の `OperationRequest`、`BalanceProof`、`RangeProofV3` は[本体のABI](../../design.md#操作の結合とabi)をそのまま使う。本体要求の `d` は公開入金額であり、接続仕様の期限 `d` と異なるため、接続ABIでは期限を `deadline` とする。本体のsaltは新しい32 byte乱数のままとし、接続条件hashへ置き換えない。

```solidity
struct PaymentTerms {
    bytes32 operationId;
    address owner;
    uint256 ethAmount;
    address token;
    uint256 minAmountOut;
    address recipient;
    uint64 deadline;
}

function pay(
    OperationRequest calldata withdrawal,
    BalanceProof calldata balanceProof,
    RangeProofV3[] calldata rangeProofs,
    bytes calldata poolSignature,
    PaymentTerms calldata terms,
    bytes calldata paymentSignature
) external returns (bytes32 paymentId, uint256 amountOut);

function isPaymentExecuted(bytes32 paymentId) external view returns (bool);
function paymentDigest(PaymentTerms calldata terms) external view returns (bytes32);

event PaymentSucceeded(
    bytes32 indexed paymentId,
    bytes32 indexed operationId,
    address indexed owner,
    uint256 ethAmount,
    address token,
    uint256 minAmountOut,
    address recipient,
    uint64 deadline,
    uint256 amountOut
);
```

`pay` はnonpayableとし、ETHはPoolからだけ受け取る。通常提出者はUIの接続ウォレット、CLIは任意の提出者を選択できる。`msg.sender`、`tx.origin`、サーバーの予約票を支払い認可の条件に含めない。Poolと接続の署名はどちらも `terms.owner` の署名とする。

EIP-712 domainのnameは `Ethereum Confidential UTXO Uniswap Payment`、versionは `1`、chainIdは実行チェーン、verifyingContractはAdapterとする。primary typeは次の文字列へ固定する。

```text
PaymentAuthorization(bytes32 operationId,address owner,uint256 ethAmount,address token,uint256 minAmountOut,address recipient,uint64 deadline)
```

型順は `PaymentTerms` と一致させる。`paymentId` はこのEIP-712 digestとし、署名のバイト列自体をIDにしない。ECDSAの正規性、low-s、非ゼロownerと復元一致は本体の署名規則を継承する。`operationId` はwithdrawalの実内容から本体規則で再計算し、提出者の値を信用しない。結合は `terms.operationId = operationId`、`terms.owner = withdrawal.owner`、`terms.ethAmount = withdrawal.w`、`withdrawal.destination = Adapter`、`terms.token = dUSD` とする。ABI符号化は `abi.encode` とし、独立したSolidity/TypeScriptベクトルで一致を検査する。

支払い入口の形は `kind=2`、本体公開入金額0、入力一件、残額出力一件、残額ownerは入力ownerと同じ、範囲証明一件に限定する。正の残額と保存式はPoolの実暗号検証で確認する。Adapterへ秘密入力額を渡して平文比較する構成にはしない。

`minAmountOut` は `1..2^256−1` の整数、`deadline` は `1..2^64−1` の整数秒とする。上限値は表現検査を通り得るが、流動性や期限の検査は別に行う。ETH額は本体の上限と部分支払い条件を継承する。ゼロ・未対応トークン・不正署名・未知の構成を拒否する。

### 交換と取消

対応仕様: [正常経路と不変条件](specification.md#正常経路と不変条件)、[失敗の伝播](specification.md#失敗の伝播)。

1. Adapterの実行ロックを取得し、認可・操作ID・固定経路・期限・未実行を検査する。recipientはゼロ、Adapter、Pool、Router、Factory、WETH、dUSD、Pairのいずれでもないことを検査する。コントラクトであるという理由だけでは拒否しない。
2. Adapterの既存ETH残高とrecipientのdUSD残高を保存する。実行中の期待受領額を `w` に固定し、受領済みフラグをfalseにする。
3. 本体の `withdraw` を呼ぶ。Adapterの `receive` は、実行中、呼出し元が固定Pool、未受領、`msg.value = w` の全条件を満たす一回だけ成功させる。通常時の直接出金や別のETH送付は拒否する。receiveで交換を始めず、Poolが戻るまで待つ。
4. 受領済みとETH増分 `w` を確認し、Router02の `swapExactETHForTokens{value:w}(m, [WETH,dUSD], R, deadline)` を呼ぶ。任意path、fee-on-transfer用入口、exact-output、multicallは提供しない。
5. Routerの返値が二件で、入力額 `w`、出力額 `q` が正かつ `q ≥ m` であることを検査する。recipientのdUSD増分が `q`、AdapterのETH残高が開始時と同じであることを確認する。Pairから直接recipientへ送るため、Adapterは出力トークンを預からない。
6. `executedPayments[paymentId] = true` とイベントを記録し、実行文脈をクリアしてロックを解除する。成功記録を先に外部へ委ねない。

全ての外部呼出し失敗と後段の不一致は `pay` 全体をrevertする。これによりPoolの入力消費、残額、出金、Pairの交換、recipientの移転とイベントが同じframe内で取り消される。外側提出コントラクトがrevertを処理しても、失敗したpayの資産効果は残らない。

全資産入口への再入を拒否する。`receive` は上記の受領専用の例外であり、再入payを許す入口ではない。fallbackは拒否し、読取関数を途中状態の確定根拠に使わない。本体の再入拒否も維持する。強制送付等で既存ETHがある場合は当該支払いの資金へ数えず、今回の増減だけを検査する。

受取残高差だけで一般トークンの着金を保証するものではない。固定された非hook・非rebase・非upgradeのdUSDと実Router/Pairの処理を根拠に、検査区間の無関係な移転や即時転送がないことを確認する。別の挙動を持つトークンは初版の固定token検査で拒否し、敵対的stubによる検査はその境界だけの証拠とする。

| Adapterのエラー | 意味 |
| --- | --- |
| `InvalidPayment()` | 要求の形、owner、公開額、ID結合の不一致 |
| `InvalidPaymentSignature()` | 非正規署名、復元失敗、別owner |
| `UnsupportedToken()` / `UnsupportedRecipient()` | 固定tokenまたは宛先制約違反 |
| `PaymentExpired(uint64 deadline)` | 実行時刻が期限を超える |
| `PaymentAlreadyExecuted(bytes32 paymentId)` | 成功済みの論理支払い |
| `UnexpectedEthReceipt()` / `ReentrantPayment()` | 実行文脈外の受領、額不一致、再入 |
| `SwapAccountingMismatch()` / `DeliveryMismatch()` | 全額交換・全量着金・中間残高の不一致 |

外部先の失敗データは信頼しない。Pool/Router由来のrevertとAdapter自身のエラーを実行経路に対応付けて診断し、秘密金額・乱数をエラーへ追加しない。上表をAdapter独自エラーのABIとし、selector、外部エラーの伝播と境界を[#45](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45)で照合する。

### Payの初期値

対応仕様: [Payの入力と認可開始](specification.md#payの入力と認可開始)、[再試行と条件変更](specification.md#再試行と条件変更)。

| 項目 | 合意した初版の検証基準 |
| --- | --- |
| 見積りの有効期間 | 30秒 |
| 自動設定する最低受取額 | 見積額から1%差し引いた額 |
| 支払い認可の期限 | 10分 |
| UTXOの自動選択 | 支払額を超える候補のうち最小額 |

最低受取額と期限は認可前に表示し、変更できるものとする。認可後の条件変更は、旧認可の期限切れなどを確認するまで開始しない。見積り、整数への変換、同額UTXOの選択順は以下の規則とする。変更可能な最低額は `1..2^256−1` の整数で、見積額を超える値も明示確認すれば入力可能とし、実行時に満たせなければ取り消す。期限は最新の確定チェーン時刻より後、`2^64−1` 以下の整数秒とし、署名開始時に再確認する。操作性と境界は[#50](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/50)で検証する。

同額候補はUTXO IDの符号なし昇順で選ぶ。金額入力は10進の通常表記だけを受け付け、指数表記、負値、18桁を超える小数、整数上限超過を拒否する。内部はbigintと最小単位、JSONは10進文字列とし、浮動小数点を金額に使わない。見積りは固定Routerの `getAmountsOut(w,[WETH,dUSD])` を特定ブロックで読み、ブロックhashとリクエスト開始時の単調時計を保存する。認可開始までの経過時間が0〜30,000msなら鮮度条件を満たす。応答待ち時間も含め、再読み込み後は再取得する。

自動最低額は `max(1, floor(quoteOut × 99 / 100))` とし、整数への変換規則と実際の最低額を表示する。これは自動値の規則であり、手入力額を丸めるものではない。自動期限は取得した最新ブロック時刻＋600秒とし、認可前にUTCの期限と有効期間を示す。変更値は整数秒の絶対期限として扱い、現在チェーン時刻より後かつuint64範囲内であることを確認する。期限・最低額を変更した場合は差分を再確認し、署名開始後には更新しない。

証明生成は署名前にWeb Workerで行う。証明生成中に見積りが失効したら再取得し、最低額・期限が変わる場合は再確認へ戻す。見積りの鮮度だけでRPCの最新性を保証したとは扱わず、RPCがチェーンを正しく報告する信頼前提とブロック情報を記録する。

### 鍵・本人認証・保持場所

対応仕様: [準備、入金、残高再利用、出金](specification.md#準備入金残高再利用出金)、[公開範囲と本人の受領](specification.md#公開範囲と本人の受領)。

受領鍵は専用メッセージへのMetaMaskの `personal_sign` から導出する。本体操作やAPIログインの署名とは別の署名要求にする。メッセージは次の6行を改行LFで連結したUTF-8バイト列で、末尾改行を付けない。`chainId` は10進表記、`pool` と `owner` は小文字の `0x` 付き40桁アドレスとする。動的nonce、時刻、ブラウザ名、配信URLを入れない。配信元の本人確認は別の信頼条件とする。

```text
ECU Uniswap recipient-key reproducibility probe v1
This signature is secret key material. Never share it.
Purpose: ecu/uniswap/key-root/v1
ChainId: {chainId}
Pool: {pool}
Owner: {owner}
```

署名のowner一致と正規化を確認した65 byte `r||s||v` をHKDF-SHA256の入力とし、saltはUTF-8 `ecu/uniswap/key-root/hkdf-salt/v1` のSHA-256、infoは受領鍵用にUTF-8 `ecu/uniswap/recipient-ikm/v1`、操作記録鍵用にUTF-8 `ecu/uniswap/operation-record-key/v1` とする。それぞれ32 byteを別々に導出する。`v` は27または28、署名はlow-sとし、EIP-191のメッセージhashからownerを復元して照合する。HKDF前のバイト列は書き換えない。受領鍵用IKMはHPKEのDHKEM(X25519, HKDF-SHA256)の`DeriveKeyPair`へ渡し、32 byteをX25519の生の秘密スカラーとして直接読み込まない。[UX-02の追補](../../../experiments/design/uniswap/ux02/hpke-plan-amendment.json)との独立ベクトルと操作記録鍵の実装照合は[#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46)で行う。[RFC 5869](https://www.rfc-editor.org/rfc/rfc5869)はKDFの規則の根拠であり、署名素材の秘密性・再現性の証拠ではない。X25519公開鍵は本体のRecipientInfoとして、所有者が別途EIP-712署名する。導出署名と鍵はAPI、RPC、ログ、URL、localStorageへ送らず、セッション中のメモリだけで扱う。切替・終了時に保持を解除するが、JavaScriptの完全なメモリ消去は保証しない。

操作記録はAES-256-GCM、保存ごとにCSPRNGで生成する96 bit nonce、128 bit tagで暗号化する。AADに環境、owner、記録ID、単調増加revisionを結合し、別記録への付替えと古いrevisionの上書きを拒否する。受領用X25519鍵をそのまま対称鍵へ流用しない。IndexedDBには暗号文と公開の照合情報だけをキャッシュし、本人確認後のサーバー記録とチェーンから復旧する。nonce重複と改変拒否の検査をUX-04に含める。

APIの本人確認には[ERC-4361 SIWE](https://eips.ethereum.org/EIPS/eip-4361)を用いる。サーバーが32 byte乱数の16進nonceを発行し、5分以内の一回だけ使用可能にする。正規domain・URI・chainId・owner・発行/失効時刻と署名を照合する。鍵導出署名をログインに使わない。セッションは30分で失効し、ランダムな識別子をSecure・HttpOnly・SameSite=Strictのcookieに保持する。同一originの状態変更だけを受け、CSRFと別ownerの照会を拒否する。初回・再訪の追加署名回数は[#50](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/50)で評価する。

### 進行中操作の復旧方針

対応仕様: [再試行と条件変更](specification.md#再試行と条件変更)、[共通の操作状態](specification.md#共通の操作状態)。

進行中の支払い情報を暗号化してサーバーへ保存し、別ブラウザから照合する方針を合意した。サーバーと照合できない間は新しい認可を開始しない。復号鍵は利用者側で保持し、サーバーの識別情報とアクセス履歴を機密性評価に含める。

暗号化した保存だけでは、二つのブラウザが同時に別条件を認可することを防げない。署名要求より前に入力の利用予約と条件固定を原子的に永続化し、応答を確認する順序が必要である。短い予約の有効期間が切れたことだけを理由に、有効な旧認可を無視して入力を解放しない。予約の識別、保存世代、署名拒否・応答喪失・記録復旧時の規則は以下に定め、[#48](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/48)で実取引を使って検証する。

予約索引のウォレットアドレス、対象環境、入力UTXO ID、認可期限をサーバーへ開示する方針は合意済みである。サーバーは本人認証と所有者・環境を照合し、同じ入力の有効な予約に対する条件差替えを拒否する。期限による解放では、同じfinalized履歴上で時刻が旧期限を超え、旧成功がなく、入力が未使用であることを照合する。端末時計やlatestの時刻だけで解放しない。

予約のキーを `(deploymentId,owner,inputId)` とし、operationId、paymentId、期限、暗号文、revision、署名要求を開始した事実、既知の試行を保持する。予約と内容hashの保存が成功してからウォレットの署名要求を出す。保存ACKが失われた場合は同じ記録IDで再照会し、別IDで作り直さない。署名・取引承認拒否も旧認可が不存在である証拠として入力を解放せず、同条件の再開かチェーン照合後の解放へ進む。

全額Withdrawも同じ入力の予約を原子的に取得し、内容を保存してから署名を要求する。Pay予約中の入力は取得できず、逆にWithdraw予約中の入力もPayに使わない。予約は操作種別を持ち、Withdrawには接続の期限を付けない。本体のWithdraw認可は無期限なので、時間経過で予約を解除せず、同じ操作を再開するか入力の確定消費を照合する。単に署名画面を閉じたことを取消の証拠にしない。

Pay成功時は同じfinalizedブロックでAdapterの成功、Poolの同じoperationId、入力消費、残額出力を照合する。イベントやreceiptを単独で成功の根拠にしない。paymentIdの成功が別提出者から見つかった場合も元の操作へ対応付ける。RPC不一致・再編成・保存revision不整合では確認不能へ戻し、残額を利用可能から外して本体の再同期を行う。

サーバーの全記録を失った場合は空のDBを「進行中操作なし」と扱わない。配置単位を停止し、バックアップとチェーンを照合して復旧する。旧署名の有効性を排除できなければ旧配置の新規認可を再開しない。残高の読取・既存資産の受領能力と、サイトの新規Payの可用性は区別する。

### 報酬配布の並行性

対応仕様: [要求の状態と遷移](specification.md#要求の状態と遷移)、[重複、修正、追加要求](specification.md#重複修正追加要求)。

初版は配布を一件ずつ処理し、finalizedで配布の確定を確認してから次へ進む。配布の確定と本人の受領確認は別に管理する。本人がブラウザを閉じたことを理由に、他の利用者への次の配布まで停止しない。本人の追加要求には、仕様どおり元の要求の受領完了を確認する。

配布要求の内容と試行を永続化し、応答喪失・再起動後にも元の要求を照合する。送信結果が不明な間に、新しい入力を使う別の配布を作らない。旧試行の後成功を排除する具体的な方法は、外側の取引nonceだけでなく本体の認可とUTXOの使用状態を含めて設計する。

### 報酬APIと永続化

対応仕様: [入力と要求の同一性](specification.md#入力と要求の同一性)、[要求の状態と遷移](specification.md#要求の状態と遷移)。

環境単位の一つのSQLite Durable Objectに、本人認証、予約、暗号化操作記録、報酬要求と配布試行を置く方針は合意済みである。ネットワークI/Oの前後にSQLトランザクションを分け、永続化と送信を一つの原子的処理であるとは扱わない。

| API | 入力と呼出し主体 | 出力・保持状態・失敗 |
| --- | --- | --- |
| `POST /v1/auth/challenge`・`/verify` | owner・環境、続いて専用のSIWE署名。ブラウザ | 一回用challenge、成功時session。別domain・再使用・期限切れ・偽署名は拒否 |
| `PUT /v1/operations/{id}` | 本人session、公開予約索引、期待revision、暗号化bundle | 予約とrevisionを原子的に保存。同条件再送は同じ結果、別条件・競合は409、永続化不可は503 |
| `GET /v1/operations` | 本人sessionと環境。別ブラウザからも使用 | 本人の進行中記録と照合点。暗号文はブラウザだけが復号 |
| `POST /v1/rewards` | 本人session、ランダム32 byte requestId、整数wei文字列、本人の署名済みRecipientInfo | 受付状態。同一ID同内容は元要求へ戻す。額・鍵・owner・環境の差替えは409。形式/上限/資金不足は理由を区別 |
| `GET /v1/rewards`・`/{id}` | 本人session。保存済みIDを失った再訪も一覧で照合 | 本人の要求・試行・operationId・既知tx hash・確定状態。第三者へ額や存在を開示しない |
| `POST /v1/rewards/{id}/received` | 本人session、本人が照合した出力IDとブロックhash | サーバーも要求とfinalized生成・ownerを照合し本人確認済みを記録。復号正当性のオンチェーン証明とは扱わない |

HTTP JSONの整数は文字列、hashは固定長0x形式とし、全入口で環境とsessionのownerを検査する。要求額・RecipientInfo・試行秘密は配布元が必要な情報として扱い、通常ログやエラー監視へ本文を出さない。成功/失敗の応答は本人だけへ返す。秘密を持つ配布元の保存内容は専用のSecrets鍵で暗号化し、アクセス管理とバックアップにも同じ境界を適用する。

受付では要求主体とRecipientInfo.ownerの一致、受取情報の本体認可、正の額、本体上限、未予約の配布資金、本人の既存未完了要求を検査する。自由入力を固定額・日次上限へ置き換えない。別要求IDを並行に送っても本人の未完了要求へ案内し、独立した二重配布を始めない。SQL上で額・受取先を固定し、資金を予約してからACKする。gas用の公開ETHと機密配布資金を分ける。

一つの配布要求に一つの本体operationIdを割り当て、入力、出力、乱数、packet、証明と署名を保存する。同じ要求の再送で新しい乱数やoperationIdを作らない。署名済みraw transactionとhash・nonceを永続化し、保存完了後にbroadcastする。応答喪失時はそのhashとoperationIdを照合し、必要なら同じraw transactionを再送する。gasを変える置換も同じ論理操作に限定し、全ての外側試行を保持する。

本体送金には支払いの期限がないため、失敗やnonceの置換だけで「配布なし終了」にしない。終了が必要な場合は、旧入力の少なくとも一つを同じ配布元の正当な自己送金で確定消費し、全旧配布操作が実行不能で、元要求の配布成功もないことを照合する。競合で元の配布が先に成立したら配布成立へ戻す。確認不能の間は新しい入力による配布を禁止する。この取消用操作も保存してから提出し、資金とgasの変化を記録する。

配布資金の断片化で本体の最大入力数を超える場合は、先に配布元自身の機密送金で整理して確定させる。資金はあるのに単一入力が足りないことを、報酬額の固定上限へ置き換えない。合算が単一UTXOの上限を超える場合も本体の入出力上限内に分割する。整理中は同じ受付要求を保持し、整理操作と配布操作を混同しない。初期の必須推論例では整理や追加入金を混ぜず、指定の一入力二出力を維持する。

無料枠・RPC・資金不足による停止は理由を示し、要求状態を保持する。配布サービスを別インスタンスで二重起動しない。バックアップ復元後は保存時点より後の配布と入力消費を再走査する。ただし、未提出認可と予約はチェーンにないため、再走査だけで安全な復旧とはしない。全損だけでなく一部の記録巻戻りにも停止規則を適用し、ACK済み記録の欠落・旧認可の再実行可能性を排除できるまで、新しい認可・配布を再開しない。

### 機密性評価で追加確認する情報

対応仕様: [公開範囲と本人の受領](specification.md#公開範囲と本人の受領)、[必須の推論履歴](specification.md#必須の推論履歴)。

自由入力の報酬要求に対する資金不足の回答は、配布元の利用可能額の上界を与え得る。自己宛ての追加要求で知った受領額も、配布元の残額や過去の配布額の推論に使われ得る。残高の数値をAPIから返さないことだけで、この推論を防いだとは主張しない。

必須履歴の公開観測による評価に加え、能動的に額を変えて要求する観測者が、応答と自分の受領額から得る制約を対照実験に含める。非公開の本人向け応答、公開応答、配布元の知識、運営者に見える予約索引を分けて記録する。公開情報に属する実装メタデータを必須履歴の評価から除外しない。必須例の複数候補が失われた場合の方式・上流見直し条件は維持する。

## 最小実験の結果と証拠の境界

本体は参照開始版では未実装であり、依存する実装Issueの完了を前提にしない。以下で問いと判定基準を固定し、各実験の部分結果を後述する。保存先は `experiments/design/uniswap/` とし、コード、入力、固定版、設定、生の結果、再現手順と未検証範囲を対応付ける。

| ID | 解決する問い | 方法と合格の条件 | 証拠の境界 |
| --- | --- | --- | --- |
| UX-01 | 五条件の認可・切出し拒否・全額交換・全量着金を同時に実現できるか | 本体の認可と出金の規則を実装した最小境界、実ECDSA、固定版の実Uniswapで正常・改変・期限境界・コピー・再入・後段失敗を実行。失敗時は入力、残額、ETH、Pair、受取人、成功記録が巻き戻る | 本体暗号を代替したケースは呼出し境界の証拠に限定。実暗号との結合の証拠を別に要する |
| UX-02 | MetaMaskで鍵の再利用と受領が成立するか | Chromeの再起動後と独立した別Chromeプロファイルで導出鍵を照合。後者でHPKE packetを復号しコミットメントを照合。アカウント・環境違い、拒否、漏えいを検査 | ソフトウェアライブラリだけの署名一致を、実拡張の証拠としない。試験専用の鍵を使う |
| UX-03 | 無料枠で配布用の実暗号処理が可能か | 固定した本体v3規則で配布の証明・packet・署名を生成し、Cloudflare対象runtimeの時間とメモリを測る | ローカルのNode成功だけでホストの制限適合を主張しない。未移植の本体処理を隠さない |
| UX-04 | 予約・報酬要求が競合と障害を越えて一意に復旧できるか | 並行開始、保存直後停止、署名後応答喪失、broadcast応答喪失、再起動、再編成を再現。既存要求と操作を追跡し別配布を作らない | 永続化モデルの確認と、対象runtime・チェーンを含む確認を区別する |
| UX-05 | 全公開情報を含めて必須推論履歴に複数候補が残るか | 仕様の固定履歴、直接Deposit、全額出金、能動要求の対照を構築。API・ログ・予約・暗号表現も含め観測者別に評価 | 数式上の候補と暗号学的な秘匿の根拠を区別する。モック暗号の成功では解消しない |

本表の部分結果を初版方式の選定資料とする。実Pool・実暗号・実ウォレット・公開配置での成立性は[#45〜#50](#実装後の検証と見直し条件)へ移し、検証前に実装の受入合格を主張しない。本体の形式証明、公開サイトの公開、正式測定も後続作業として追跡する。

### UX-01の部分結果

[事前計画](../../../experiments/design/uniswap/ux01/plan.json)に従い、固定したUniswap v2 Core、Router02、WETH9、デモ用dUSD、実ECDSAと最小Pool境界を[実行スクリプト](../../../experiments/design/uniswap/ux01/run.sh)で接続した。[生結果](../../../experiments/design/uniswap/ux01/outputs/result.json)ではForgeとローカルAnvil forkで各9件が通過した。五条件の署名改変、出金先と額の付替え、直接ETH送付、期限境界、成功後コピーを拒否し、正常時は支払い全額がPairへ入りRouterの算出量と受取人の残高増加が一致した。最低受取額未達ではPoolの使用済み記録・残額・ETH、Adapter、Pair、受取人残高が巻き戻った。最小Poolからの同一支払い再呼出し、fallback呼出し、想定外のETH受領も拒否し、Poolが中断した分岐では全状態が巻き戻った。

この結果は二署名と実v2資産移動の接続境界に限る。最小Poolは実暗号証明を検証せず平文fixtureを持つ。[固定版と差分](../../../experiments/design/uniswap/ux01/provenance.json)のとおり、ローカルでコンパイルしたPairの作成hashに合わせてRouter側の定数を一行補正したため、公式配布版・Sepoliaでの同等性を示さない。Anvil forkの試験はRPCへの実取引送信ではない。再入の証拠は最小Poolからの呼出しに限り、実Pool、実トランザクションのreceipt log、完全な暗号結合は未検証である。実Pool・実トランザクションとの適合は[#45](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45)で検証する。

### UX-02の部分結果と未判定条件

[事前計画](../../../experiments/design/uniswap/ux02/plan.json)と[初回の生結果](../../../experiments/design/uniswap/ux02/result.json)を保存した。当初の計画にはFirefoxも含めたが、[対象範囲の更新](../../../experiments/design/uniswap/ux02/scope-revision.json)により初版はChromeのみとした。初回実験ではMetaMask通常拡張v13.50.0の配布物を公式checksumと照合し、隔離したChrome for Testing 153で試験用ウォレットを作成、ブラウザ再起動後にホーム画面まで到達した。手元のGoogle Chrome 152は拡張のサイドロード指定を受け付けなかった。

初回実験では専用メッセージの署名に到達しなかった。その後、ユーザーからChromeでローカル署名プローブの指紋が一致し、独立した二つ目のChromeプロファイルでも一致したとの報告を得た。元の指紋値、使用したChrome・拡張の完全版、プロファイル分離を示す実行記録はまだ受け取っていないため、実拡張の署名指紋再現についての本人報告として扱う。試験用の復元語・パスワード・プロファイルは成果物へ含めない。

[ローカル署名プローブ](../../../experiments/design/uniswap/ux02/signature-probe.html)は署名ハッシュの一致だけを比較し、受領鍵を導出しない。次の実ウォレット試験用に、固定した導出規則を[実験計画の追補](../../../experiments/design/uniswap/ux02/hpke-plan-amendment.json)へ記録し、[HPKE試験ページ](../../../experiments/design/uniswap/ux02/hpke-probe.html)を用意した。[ローカル結果](../../../experiments/design/uniswap/ux02/hpke-local-result.json)では模擬署名による同一公開鍵、112 byte packetの別インスタンスでの復号、改変拒否を確認した。実MetaMaskでの[手動結果](../../../experiments/design/uniswap/ux02/manual-hpke-result.json)として、ユーザーから二つのChromeプロファイルで受領公開鍵が一致し、B画面で復号・改変拒否がともに成功したとの報告を得た。

HPKE試験の公開contextには有効な合成点`C=(1,2)`を用いるが、乱数で生成する受領額のコミットメントそのものではない。この試験が通っても、RecipientInfoのEIP-712署名、実コミットメント、公開イベントからの再構成、finalized・未使用照合、ネットワークと保存領域の漏えい検査は未検証である。実RecipientInfo・履歴・漏えい検査は[#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46)で行う。

### UX-03の部分結果

[事前計画](../../../experiments/design/uniswap/ux03/plan.json)と[再実行コード](../../../experiments/design/uniswap/ux03/run.py)により、既存のv3 Java範囲証明器を実行した。[生結果](../../../experiments/design/uniswap/ux03/result.json)では、正例3件をJava検証器が受理し、範囲外1件を拒否した。4件を含むプロセス全体は約5.01秒、最大常駐メモリは約412 MBだった。これはJVMを含むローカル測定値であり、CloudflareのV8 isolateの使用量へ換算しない。

報酬操作全体のpacket・署名・raw transaction生成とv3証明器の対象runtimeへの移植が存在せず、Cloudflare Freeでの実行・測定も行っていない。無料枠への適合は未判定であり、[#47](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/47)で検証する。

### UX-04の部分結果

[事前計画](../../../experiments/design/uniswap/ux04/plan.json)、[再実行コード](../../../experiments/design/uniswap/ux04/run.mjs)、[生結果](../../../experiments/design/uniswap/ux04/result.json)を保存した。Miniflare 4.20260730.0のローカルSQLite Durable Objectモデルで21操作を実行し、同一入力の競合・同一要求の再送・revision不一致を拒否した。模擬broadcast前のraw transaction保存、応答不明時の新規配布停止、インスタンス再生成後の記録保持、模擬再編成後の保留復帰、AES-GCMのAAD・暗号文改変拒否も確認した。さらに[別Nodeプロセスでの再起動結果](../../../experiments/design/uniswap/ux04/process-restart-result.json)では、保存した予約・報酬要求・raw transaction・結果不明の状態を再取得し、競合する新規要求を拒否した。

これは状態機械の局所検査である。認証・実暗号bundle、実チェーンへの送信とfinalized照合、公開Cloudflareでの永続性は検証していない。運用上の成立性は未解決であり、[#48](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/48)で検証する。

### UX-05の部分結果

[事前計画](../../../experiments/design/uniswap/ux05/plan.json)の条件で[計算スクリプト](../../../experiments/design/uniswap/ux05/run.py)を実行し、[生結果](../../../experiments/design/uniswap/ux05/result.json)を保存した。実行環境はCPython 3.13.7。`u = 0.001 ETH`の整数倍だけを列挙した狭い候補集合でも、公開の入金10u・支払い3u・正の二つの残額から、報酬候補は4u〜9uとなり、実額6uと対照の7uが共に残った。配布元の実額知識、または後続の3u全額出金を加えると6uへ一意化した。

別の要求主体が配布元の釣銭UTXOだけを原資として4uを要求する対照では、6u履歴なら釣銭4uで資金条件を満たし、7u履歴なら釣銭3uで不足する。要求主体自身が得るAPI応答はこの二候補を区別できる。成功すれば追加配布が発生して履歴自体も変わるため、元の受動的な公開観測者へこの結果を黙って追加しない。他資金の補充や別入力がある場合は判定を作り直す。

この実験は算術と観測者の知識の分離を確認した。実暗号の証明・packet、実Uniswap、公開calldataとgas、配置後API・ログ、finalized履歴は検査していない。したがってUPRIV-02の必須例全体の成立性は未解決であり、機密性の主張は[#49](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/49)で対象観測者を分けて検証する。

## 採用理由と成立性の検証

### 鍵復元方式の採用理由と検証

対応仕様: [準備と残高再利用](specification.md#準備入金残高再利用出金)。

ウォレット以外の追加インストールを避け、固定した鍵復元専用メッセージへの署名から受領鍵を導出する。初回と別ブラウザでの利用時に追加の署名操作を求めることは合意済みである。

対象ウォレットと版を限定し、署名と導出鍵の再現性、別ブラウザでの受領データの復号、用途・環境の分離、署名拒否時の停止、秘密の漏えいがないことを[#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46)で確認する。鍵導出用署名は秘密として扱い、認証API・公開受取情報・オンチェーン認可に兼用しない。文面にサイト名を含めるだけで、別サイトによる同じ文面への署名要求を禁止できるとは扱わない。

MetaMask拡張の通常アカウントを検証対象として合意した。[MetaMask公式の暗号化設定同期の説明](https://metamask.io/your-metamask-account)には、同じアカウントとメッセージの署名から決定的な暗号鍵を生成し、別端末で復元する先例がある（確認日: 2026-09-27）。これは今回のX25519導出規則や対応版の実証を代替しない。Chrome二プロファイルの署名指紋・受領公開鍵・局所HPKE復号については本人報告を得たが、完全版と生結果、実コミットメント・履歴・漏えい検査は不足している。導出方式を初版の実装基準とし、未検証の安全性と実受領は[#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46)で受入判定する。

### 交換先をデモ用ERC-20に限定する理由

対応仕様: [支払い由来の資産と全量着金](specification.md#支払い由来の資産と全量着金)。

自前のデモ用ERC-20一銘柄を使い、転送手数料、残高の自動増減、アップグレードを持たせない方針を合意した。既存のテスト用トークンを使う案に対し、資産移動の挙動と追試の初期条件を管理できるためである。実コード、交換出力と受取人の残高差、失敗時の取消を検証し、単にERC-20という分類だけで全量着金を保証しない。

### 二つの認可署名を使う構成の採用理由と検証

対応仕様: [認可対象と実行時の検査](specification.md#認可対象と実行時の検査)、[失敗の伝播](specification.md#失敗の伝播)。

本体の出金認可と接続の支払条件の認可を分け、支払いに二回の認可署名を求める構成を採用する。外側の取引送信の承認は別に数える。この操作負担の許容は合意済みである。

接続専用コントラクトが同じ所有者による両認可の結合を検査し、本体の出金を呼び出す。ETH受領を認可済み実行の文脈に限定して出金だけの切出しを拒否し、交換・着金の失敗を外側へ伝播させる。正当な別提出者による実行は維持する。

本体の認可対象とABIを変更せずに検討できる点を理由として、この方式を選ぶ。署名回数を減らす候補とは、実装の複雑さ、gas、操作負担を比較する。UX-01で五条件改変、別操作への付替え、直接ETH送付、コピー提出、後段失敗、最小Poolからの再入を確認した。実Poolの出金・再入経路と実トランザクションの取消は未検証であり、[#45](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45)で確認する。

## 要件と後続検証の対応

本表の対応付けは合格記録ではなく、実装担当が用意する証拠の索引とする。上記の部分結果をシナリオ全体の合格に代用しない。シナリオの前提・境界・期待結果は[接続仕様](specification.md#必須の仕様確認シナリオ)を正本とし、省略しない。

| 要件 | 詳細規則・計画 | 必須シナリオと後続の証拠 |
| --- | --- | --- |
| UFR-01 | 報酬API、本体の受領と同期 | S-01〜02。実配布と送信者停止後の発見・復号・再使用 |
| UFR-02 | デモ資産、公開ABI、交換と取消 | S-01・03〜12。実Uniswap、正の残額、全額交換と全量着金、整数境界 |
| UFR-03 | 操作復旧、本体の残額受領 | S-01・13・28。残額の再送金と受領、二重計上・無認可の拒否 |
| USEC-01 | 支払い認可とABI、期限 | S-14〜17・20。五条件・環境・owner・出金の付替え、切出し拒否 |
| USEC-02 | 交換と取消 | S-08〜12・18〜20。全資産・Pool/Adapter成功記録・ログの前後比較 |
| USEC-03 | 一度だけの成功、全入口の再入拒否 | S-21〜24。コピーと別提出者、競合、再入拒否と外側の結果。S-24の再入受理分岐は不採用の理由を記録 |
| UPRIV-01 | 鍵、API保存、追加の観測情報 | S-47・50。ブラウザ・API・RPC・ログ・分析ツールの漏えい検査 |
| UPRIV-02 | 初期状態、推論計画UX-05 | S-49〜50。仕様の全時点・観測者と能動要求、Deposit、全額出金の対照 |
| UEVAL-01 | 下記の評価単位 | 同条件の公開交換との差、証明生成・gas・操作回数の実測 |
| UEVAL-02 | 下記の再現条件 | 固定した版・入力・履歴・全試行・生データからの再集計 |
| UOPS-01 | 操作復旧、報酬API | S-21〜30・48。operation/payment/request/attempt/txの照合と再編成 |
| UOPS-02 | Architectureの環境、UX-01〜05 | ローカル自動検証と公開テストネットの実暗号・実資産経路を別記録 |
| UOPS-03 | CLIと再現スクリプト | 作成者の非公開設定・鍵なしで別担当者が再実行した記録 |
| UUI-01 | Architectureの紹介・4カード | S-31・40・50。英語の説明、デモの理由、公開情報、証拠への導線 |
| UUI-02 | 鍵方式、環境案 | S-31〜32。ウォレットだけの初回準備、別ブラウザでの実鍵復旧 |
| UUI-03 | 報酬API・配布処理 | S-41〜50。自由入力、状態照合、一要求一配布、受領後追加と漏えい検査 |
| UUI-04 | 共通状態、本体同期、Withdraw | S-30・32・38〜39。機密/公開残高、対象選択、全額出金とExplorer |
| UUI-05 | Payの初期値と詳細規則 | S-03〜08・26・33〜36。単一入力、選択順、鮮度境界、条件変更と再確認 |
| UUI-06 | 保存・予約・復旧・所属 | S-25〜30・37・39・41〜48。拒否、応答喪失、タブ/アカウント変更、結果不明時の停止 |
| UDEL-01 | 本体依存、UX計画、後続作業 | 全主張に対象版と証拠、未完了FVと外部信頼条件を添えて引継ぎ |

S-01〜50の各ケースには、ローカル・公開テストネットの実施先、入力fixture、期待状態、結果artifactを対応付ける。正常例だけをグループの代表として異常分岐の合格に代用しない。全量着金の対象外トークン・再入受理など、不採用方式の分岐は拒否または適用不能の根拠を記録する。

シナリオの実装後検証先は、S-03〜24を[#45](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45)、S-02・13・28・30・32を[#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46)、S-25〜30・37〜48を[#48](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/48)、S-49〜50を[#49](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/49)に対応付ける。S-01〜02とS-31〜40の画面と一連の操作、各Issueの結果を通した全50件の受入索引は[#50](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/50)が持つ。複数Issueにまたがるケースはそれぞれの証拠を結合し、単独の局所合格を全体合格にしない。

### 評価と追試の具体化

対応仕様: [コストと操作回数の対応](specification.md#コストと操作回数の対応)、[追試と成果の説明](specification.md#追試と成果の説明)。

ローカルの支払い比較では、同じPair・初期reserve・w・m・R・期限・token・ブロック条件を使い、各試行前にsnapshotを戻す。通常公開交換は同じRouter入口へ公開ETHを送るものとする。機密側は本体出金、検証、Adapter、交換、着金を含む取引全体を測り、内訳を合計へ重複加算しない。初期計画は正常と最低額未達を各10回、初回のキャッシュなしと反復を分けて記録する。中央値・最小・最大と全試行を保存し、失敗や外れ値を黙って除かない。

支払い単体、報酬配布と受領、残額再送金と受領、配置・流動性・鍵設定・faucetなどの準備、同期を別の測定単位にする。証明生成、署名待ち、RPC待ち、finalized待ち、復号と同期を別に記録し、時間とgasを加算した単一値へ変換しない。操作回数はアプリの開始クリック、用途別署名、取引承認、拒否後や再読み込み後の追加操作を区別する。

公開テストネットでは正常の報酬受領→Pay→残額再送金・受領と、最低額未達、期限切れ、改ざん拒否を検証する。初回準備、Deposit、全額Withdraw、別ブラウザ、Explorerも実行する。異常の一部をeth_callで検証した場合は、実取引の取消や実測gasと区別する。公開ネットワークの別時点の取引を、同じ初期状態の反復測定と呼ばない。

実行manifestはソースcommit、依存lockfile、compiler/EVM設定、runtime hash、chain/配置、ブロック、CPU/OS/ブラウザ、入力、反復番号、乱数の扱いを持つ。試験用秘密と公開観測用データを分離し、公開成果物には利用者や運営の秘密を混ぜない。第三者は自分の鍵・乱数で配置から再実行する。推論例の実額を公開する評価用fixtureと、観測者へ与える情報の集合を混同しない。

## 実装後の検証と見直し条件

本書は方式と規則を確定するが、UX-01〜05の局所実験から実装後の成立性は証明されない。実Pool・Uniswap・認可/取消は[#45](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45)、Chrome間の実受領と鍵の安全性は[#46](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/46)、Cloudflare Freeでの実暗号処理は[#47](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/47)、予約・配布の実取引復旧は[#48](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/48)、公開情報と能動照会を含む機密性は[#49](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/49)、公開サイトと一連の利用者操作は[#50](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/50)で受入判定する。完全版・配置・RPCは[Architecture](architecture.md#実行前に固定する版と配置情報)の条件に従い各実行前に固定する。

検証で不成立が判明した場合は、影響する要件と合意条件を示して代替案を再検討し、本書とArchitectureを改訂する。本体の変更が必要なら能力不足の証拠、変更案、維持する保証、検証方法を本体担当へ渡し、接続文書だけで採用しない。特に能動的な報酬要求が候補額を区別できる結果を受動的な公開観測者の主張と混同せず、[#49](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/49)で両者を分けて合否を決める。
