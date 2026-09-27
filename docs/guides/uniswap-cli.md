# Uniswap接続CLIの操作

このガイドは、CLI利用者Bが報酬APIから機密UTXOを受け取り、その一部をUniswap v2経由でdUSDへ交換し、残額を別所有者Cへ送る手順を示す。AdapterへのPay提出者はBとは別の鍵・保存先を使う。自動追試の環境構築と受入証拠は[開発ガイド](development.md)を参照する。

## 前提

リポジトリのルートでNode 24.21.0、pnpm 10.34.5、Foundry 1.8.3を使う。ローカルで環境ごと起動して通しで試す場合は、次を実行する。試験は破棄可能な鍵と独立したAnvil・SQLite Durable Objectを作り、サービスの配布資金も用意する。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:integration:uniswap-cli
```

以下の手動操作には、稼働中のPool、Adapter、Uniswap v2、報酬APIと、その**同じ配置世代**を指す本体・接続manifestが必要である。配布元には機密UTXO資金と公開gas、提出者には公開gasが必要になる。Bが `pay resume` または `pay retry` で自分から提出する場合は、Bにも公開gasが必要である。BとCはそれぞれ独立した所有者鍵、受領鍵、暗号化storeを持つ。`B`・`C`・`SUBMITTER`は各署名鍵から導くアドレスと一致させる。この全量残額送金の例では、支払い前にBの使用可能UTXOが今回の報酬1件だけであり、並行入金・別操作がないことを前提とする。既存資金がある場合、以下の `r = V - w` とBの最終残高0は成り立たない。

| 変数 | 指すもの |
| --- | --- |
| `POOL_MANIFEST`、`CONNECTION_MANIFEST`、`POOL_RPC`、`DEPLOYMENT_ID` | 同一世代の本体・接続manifest、RPC、サービスの配置ID |
| `API_ORIGIN`、`API_URL` | SIWEで署名するHTTPS origin、CLIが接続する報酬API入口。入口が同じなら同じURLを使う |
| `B`、`C`、`SUBMITTER` | B・C・提出者の公開アドレス |
| `B_STORE`、`C_STORE`、`PAY_JOURNAL`、`MOVE_JOURNAL` | B・Cの別々の所有者store、提出者のPay・送金journal |
| `B_SIGNER`、`C_SIGNER`、`SUBMITTER_SIGNER` | 対応する秘密鍵**ファイルのパス** |
| `REWARD_AMOUNT_FILE`、`PAY_AMOUNT_FILE`、`REMAINING_AMOUNT_FILE` | 報酬要求額、支払い額、BからCへ送る残額の秘密額ファイル |
| `TOKEN_RECIPIENT` | 交換したdUSDを全量受け取る公開アドレスR |
| `C_RECIPIENT`、`PAY_PUBLIC_FILE`、`MOVE_PUBLIC_FILE` | Cの署名済み受取情報、Pay公開要求、機密送金の公開要求の保存先 |

鍵ファイルは `0x` と64桁の秘密鍵を入れる。額ファイルは `{"amountWei":"..."}` のJSONとし、数値は10進数のwei文字列で記入する。秘密ファイルの親ディレクトリと出力ファイルの親ディレクトリを事前に作り、秘密用は0700、秘密ファイルは0600にする。秘密鍵・額・パスフレーズをコマンド引数、環境変数、shell履歴へ書かない。RPC URLに認証情報を含む場合も、認証情報を含まないローカルproxyを介して接続する。所有者の各操作は対話端末でパスフレーズを入力する。`--json`でも解除にTTYが必要である。Payの公開要求には支払額 `w` が含まれるため、提出者にも公開される。

以下はBashで実行する。各変数へ上表の値を設定した後、共通引数を作る。

```bash
CLI=(node packages/cli/dist/bin.js)
POOL=(--manifest "$POOL_MANIFEST" --rpc "$POOL_RPC")
CONNECTION=("${POOL[@]}" --connection-manifest "$CONNECTION_MANIFEST" --deployment-id "$DEPLOYMENT_ID")
B_OWNER=(--store "$B_STORE" --owner "$B")
C_OWNER=(--store "$C_STORE" --owner "$C")
B_API=(--api-origin "$API_ORIGIN" --api-url "$API_URL" --signer "$B_SIGNER")
PAY_SENDER=(--journal "$PAY_JOURNAL" --signer "$SUBMITTER_SIGNER" --submitter "$SUBMITTER")
MOVE_SENDER=(--journal "$MOVE_JOURNAL" --signer "$SUBMITTER_SIGNER" --submitter "$SUBMITTER")
```

### 1. BとCの受領準備

BとCを別々のstoreで初期化し、受領鍵を作る。Cの受取情報ファイルをBへ渡す。Bの報酬要求に使う署名済み受取情報はCLIがBのstoreから生成する。

```bash
"${CLI[@]}" init "${B_OWNER[@]}" "${POOL[@]}"
"${CLI[@]}" key add "${B_OWNER[@]}"
"${CLI[@]}" sync "${B_OWNER[@]}" "${POOL[@]}"

"${CLI[@]}" init "${C_OWNER[@]}" "${POOL[@]}"
"${CLI[@]}" key add "${C_OWNER[@]}"
"${CLI[@]}" recipient "${C_OWNER[@]}" --signer "$C_SIGNER" --out "$C_RECIPIENT"
"${CLI[@]}" sync "${C_OWNER[@]}" "${POOL[@]}"
```

### 2. Bが報酬を受け取る

`REQUEST_ID` は同一要求の再照会に使う32 byteのランダムIDである。`reward status` を繰り返し、配布が `finalized` になったことを確認する。Bが `sync` で受領できた後に `reward received` を実行する。`reward received` 自身も同期して対象outputを照合する。

```bash
REQUEST_ID="0x$(openssl rand -hex 32)"
"${CLI[@]}" reward request "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --amount-file "$REWARD_AMOUNT_FILE" --request-id "$REQUEST_ID"
"${CLI[@]}" reward status "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --request-id "$REQUEST_ID"
"${CLI[@]}" sync "${B_OWNER[@]}" "${POOL[@]}"
"${CLI[@]}" balance "${B_OWNER[@]}"
"${CLI[@]}" reward received "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --request-id "$REQUEST_ID"
```

### 3. Bが部分支払いを認可する

報酬UTXOの額を `V`、支払額を `w` とし、`0 < w < V` を満たす額ファイルを用意する。`pay quote` と `pay prepare` は本人のTTY通常表示で秘密額と条件を確認する。`pay prepare` の `operationId` と `paymentId` を控え、`PAY_OPERATION_ID` と `PAYMENT_ID` に設定する。`confirmation` の入力ID、token、最低受取額、R、期限と、TTYにだけ表示される `paymentWei` を照合する。JSON出力は秘密額を含まない。

```bash
"${CLI[@]}" pay quote "${B_OWNER[@]}" "${CONNECTION[@]}" --amount-file "$PAY_AMOUNT_FILE"
"${CLI[@]}" pay prepare "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --amount-file "$PAY_AMOUNT_FILE" --recipient "$TOKEN_RECIPIENT"
# 表示された公開値を設定する: PAY_OPERATION_ID、PAYMENT_ID
"${CLI[@]}" pay authorize "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --id "$PAY_OPERATION_ID" --confirmed-content-hash "$PAYMENT_ID"
```

`pay authorize` は共有予約の確認後に署名を保存し、取引は送らない。見積り後に自動最低額が変わった場合や期限が過ぎた場合は停止する。未認可の準備をやり直すときだけ `pay prepare` に `--replace-id "$PAY_OPERATION_ID"` を付け、表示された新しい条件を確認する。

### 4. 別提出者がPayを送る

Bが書き出した公開ファイルだけを提出者へ渡す。Bの鍵やstoreは渡さない。`pay submit` の `pending` は送信受付であり、支払い成功ではない。提出者は同じjournalで `pay status` を繰り返し、`finalized-success` を確認する。ローカルAnvilの確定モードは `local-simulated`、Sepoliaは `finalized` であり、両者の証拠を区別する。Bも自身の `pay status` と `sync` で残額を照合する。

```bash
"${CLI[@]}" pay export "${B_OWNER[@]}" "${CONNECTION[@]}" \
  --id "$PAY_OPERATION_ID" --out "$PAY_PUBLIC_FILE"
"${CLI[@]}" pay submit "${CONNECTION[@]}" "${PAY_SENDER[@]}" --public "$PAY_PUBLIC_FILE"
"${CLI[@]}" pay status "${CONNECTION[@]}" --journal "$PAY_JOURNAL" \
  --submitter "$SUBMITTER" --id "$PAY_OPERATION_ID"
"${CLI[@]}" pay status "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --id "$PAY_OPERATION_ID"
"${CLI[@]}" sync "${B_OWNER[@]}" "${POOL[@]}"
"${CLI[@]}" balance "${B_OWNER[@]}"
"${CLI[@]}" utxos "${B_OWNER[@]}"
```

### 5. Bが残額をCへ機密送金する

BのTTY表示で残額 `r = V - w` と使用可能なUTXOを確認し、`REMAINING_AMOUNT_FILE` に `r` を記入する。`create` の結果の `operationId` を `MOVE_OPERATION_ID` に設定する。全量送金ではBへの `--change-recipient` は不要である。提出後、journalの `operation` が `executed` になってからC自身が `sync` する。最後にBを再同期し、Bの残高が0、Cの受領UTXOが使用可能であることをTTYで確認する。

```bash
"${CLI[@]}" create "${B_OWNER[@]}" "${POOL[@]}" --kind transfer \
  --amount-file "$REMAINING_AMOUNT_FILE" --recipient "$C_RECIPIENT"
# 表示された公開値を設定する: MOVE_OPERATION_ID
"${CLI[@]}" prove "${B_OWNER[@]}" --id "$MOVE_OPERATION_ID"
"${CLI[@]}" authorize "${B_OWNER[@]}" --id "$MOVE_OPERATION_ID" --signer "$B_SIGNER"
"${CLI[@]}" export "${B_OWNER[@]}" --id "$MOVE_OPERATION_ID" --out "$MOVE_PUBLIC_FILE"
"${CLI[@]}" submit "${POOL[@]}" "${MOVE_SENDER[@]}" --public "$MOVE_PUBLIC_FILE"
"${CLI[@]}" operation "${POOL[@]}" "${MOVE_SENDER[@]}" --id "$MOVE_OPERATION_ID"
"${CLI[@]}" sync "${C_OWNER[@]}" "${POOL[@]}"
"${CLI[@]}" balance "${C_OWNER[@]}"
"${CLI[@]}" utxos "${C_OWNER[@]}"
"${CLI[@]}" sync "${B_OWNER[@]}" "${POOL[@]}"
"${CLI[@]}" balance "${B_OWNER[@]}"
```

## 応答喪失・失敗時

| 状況 | 操作 |
| --- | --- |
| 報酬要求の応答を失った | `reward list` でBの保存済み `requestId` を確認し、**同じIDと額ファイル**で `reward request` を再実行する。配布が確定したら `reward received` を再実行できる。 |
| 見積りが変わり、認可前に止まった | 旧準備が未認可・未予約であることを確認し、`pay prepare --replace-id "$PAY_OPERATION_ID"` で再準備する。新しい `paymentId` を確認し直す。 |
| `pay submit` の応答を失った | 同じjournalの提出者 `pay status` とBの `pay status` で確定履歴を照合する。同じ公開ファイルを機械的に再提出しない。 |
| 送信した取引が失敗した | Bの `pay status` で失敗・入力未使用・予約を確認し、同条件の明示再試行には `pay retry ... --id "$PAY_OPERATION_ID"` を使う。中断した元操作を復旧する場合は `pay resume` を使う。いずれもCLIが再照合してから送信する。 |
| 支払い条件を変更したい | 旧認可の期限超過と、同一確定履歴での未実行・入力未使用を確認する。0600の条件ファイル `{"minAmountOut":"...","deadline":"..."}` を用意し、`pay change-terms` を実行する。返った新しい操作IDとpaymentIdで認可・書き出しからやり直す。`deadline` はUnix秒、`minAmountOut` はdUSDの最小単位による10進数文字列である。 |

復旧時は状況を確認して、該当するコマンドだけを実行する。

```bash
"${CLI[@]}" reward list "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}"
"${CLI[@]}" reward request "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --amount-file "$REWARD_AMOUNT_FILE" --request-id "$REQUEST_ID"

"${CLI[@]}" pay status "${CONNECTION[@]}" --journal "$PAY_JOURNAL" \
  --submitter "$SUBMITTER" --id "$PAY_OPERATION_ID"
"${CLI[@]}" pay status "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --id "$PAY_OPERATION_ID"
"${CLI[@]}" pay resume "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --id "$PAY_OPERATION_ID"
"${CLI[@]}" pay retry "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --id "$PAY_OPERATION_ID"
"${CLI[@]}" pay prepare "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --amount-file "$PAY_AMOUNT_FILE" --recipient "$TOKEN_RECIPIENT" --replace-id "$PAY_OPERATION_ID"
"${CLI[@]}" pay change-terms "${B_OWNER[@]}" "${CONNECTION[@]}" "${B_API[@]}" \
  --id "$PAY_OPERATION_ID" --terms-file "$TERMS_FILE"
```

`unknown`、`stale`、`pending-receipt` は完了を示さない。`--json` は公開の `status`、`reason`、`allowedActions` を返すが、`allowedActions` は自動再送の許可ではない。終了コードは0が完了・既知の成功、2が入力・配置、3が保存・ロック、4がRPC・状態不明、5が失敗・競合である。`pay quote`・`pay prepare`などのCLI結果JSONは支払額を省く。一方、書き出したPay公開要求、そのコピーを保持する提出者journal、Adapter呼出しには支払ETH額 `w` と公開条件が含まれる。元UTXO額 `V`、残額 `r`、受領開示値はこれらの公開要求へ含めない。所有者storeと秘密ファイルのバックアップ・復旧は[本体CLIの手順](development.md#issue-31-cliの操作復旧)を参照する。

Sepoliaでも同じコマンドを使い、chain ID 11155111の本体・接続manifestと `finalized` を返せるRPCを指定する。配置の公開読取照合はCLI開始時に行う。Sepoliaの資金付き正常・異常系の実行証拠は[#45](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/45)・[#50](https://github.com/shodaimomiyama/ethereum-confidential-utxo/issues/50)が担当する。
