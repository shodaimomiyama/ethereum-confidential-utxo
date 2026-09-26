EXP-02: 既存検証器の限定した経路への形式検証の適用

今回の結論

形式証明は未実行であり、対象の命題はすべて未判定。
固定した Docker イメージは起動し、Solidity 0.4.26 によるコンパイルと
補助的な具体テストは成功した。Kontrol 用定義のビルドで停止したため、
これらを機械証明の成功とは扱わない。

初回ビルドでは並列 JVM の一つが終了コード 137 で停止し、cgroup の
oom_kill=1 を確認した。逐次化・Java heap 制限による再試行では、この
停止を回避したが、Haskell backend の定義検証が終了コード 113 で失敗した。
該当する kore-exec --serialize は stdout/stderr とも空で終了コード 1。
不存在の入力ファイルでも同じ終了となった。根本原因は未特定であり、
エミュレーションの不具合や定義の不整合と断定しない。
kore-parser による生成定義の受理は、形式証明や Haskell 定義検証の代わりにならない。

対象と境界

src/alt_bn128.sol は BulletProofLib の固定コミットから無変更で取得した。
test/VerifierSlice.t.sol が内部関数 sub、neg と ECADD wrapper を呼び出す。
元コードの移植や、検証器全体を正しいとする公理は追加していない。
Solidity 0.4.26 で生成した harness bytecode が対象であり、EXP-01 の
Solidity 0.4.19 バイトコードや検証器全体についての証拠ではない。
本体の認可、出金、資産状態の原子性は対象外。

正規入力下の sub の範囲・剰余に関する命題を準備した。
非正規入力の場合は harness が戻るため、入力拒否を証明するものではない。
neg(0)=q は具体実行で確認した反例 witness であり、常に正規出力を返す
という主張は成立しない。ただし悪用可能性や検証器全体の欠陥は主張しない。
precompile の対象は不正点 (0,1) と恒等点 (0,0) の ECADD に限定する。
低水準の自己呼出しが失敗し、marker の更新が戻ることを具体テストした。
任意の precompile 失敗、外部受領先、本体の資産状態への一般化はしていない。

固定版と環境

manifest.json にソース比較、SHA-256、イメージ digest、実行版、命題、
前提、今回の分類を保存した。イメージ内 Kontrol の全 28 ファイルは
公開版 v1.0.255 のソースと一致した。設計上の候補コミットとの差は
Kontrol 本体では VERSION 定数だけ。deps、Dockerfile、uv.lock は一致した。

macOS ARM64 上で linux/amd64 をエミュレーションした。
コンテナは CPU 4、メモリ上限 8 GiB、追加 swap なし。
既存 Docker VM のメモリは約 3.83 GiB で、実効上限はこれより大きくならない。
公式推奨の RAM 16 GB と swap 16 GB より小さい限定実験であり、native の
性能評価ではない。ホストと Docker の設定、認証、Nix は変更していない。
各命題の初回上限は 600 秒だが、今回は証明フェーズに到達していない。
依存取得、コンパイル、具体テスト、診断の時間は outputs/*.json に分けた。

再現手順（リポジトリルートで実行）

  open -a Docker
  python3 experiments/design/formal/run_stage.py --timeout 1200 image-pull -- docker pull --platform linux/amd64 runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204
  python3 experiments/design/formal/prepare_sources.py
  python3 experiments/design/formal/run_container.py --timeout 120 runtime-inspection -- python3 /workspace/inspect_runtime.py
  python3 experiments/design/formal/run_container.py --timeout 120 forge-build -- forge build --build-info
  python3 experiments/design/formal/run_container.py --timeout 120 concrete-tests -- forge test --fuzz-runs 32

通常の並列ビルド（今回 OOM を観測したコマンド）:

  python3 experiments/design/formal/run_container.py --timeout 600 kontrol-build -- kontrol build --no-forge-build --no-keccak-lemmas -O0 --verbose

逐次ビルド（今回 Haskell 定義検証で停止したコマンド）:

  python3 experiments/design/formal/run_container.py --timeout 600 kontrol-build-sequential -- env 'K_OPTS=-Xmx2304m -Xss8m -XX:ActiveProcessorCount=2' python3 /workspace/build_sequential.py build --no-forge-build --no-keccak-lemmas --no-O2 -O0 --verbose

build_sequential.py は compiler の実行順だけを変更する。
K/KEVM/Kontrol のソースや意味論、入力検査、定義検証は変更しない。
通常のコマンドでは -O0 だけでは既定の -O2 が残ったため、逐次コマンドでは
--no-O2 も指定している。元の実行記録を上書きせず再現する場合は、
スクリプトの stage 名を変更するか、別の作業コピーを使うこと。

ビルドが正常に完了した後だけ、次の命題を一つずつ実行する予定。
下の prove コマンドは今回未実行であり、成功記録ではない。

  python3 experiments/design/formal/run_container.py --timeout 600 proof-sub-range -- kontrol prove --match-test test_subCanonicalInputsStayCanonical --schedule CANCUN --reinit --hide-status-bar
  python3 experiments/design/formal/run_container.py --timeout 600 proof-sub-modular -- kontrol prove --match-test test_subCanonicalInputsMatchModularDifference --schedule CANCUN --reinit --hide-status-bar
  python3 experiments/design/formal/run_container.py --timeout 600 proof-neg-zero -- kontrol prove --match-test test_negZeroReturnsNoncanonicalScalar --schedule CANCUN --reinit --hide-status-bar
  python3 experiments/design/formal/run_container.py --timeout 600 proof-precompile-failure -- kontrol prove --match-test test_invalidPointAdditionRevertsAndRestoresCallerState --schedule CANCUN --reinit --hide-status-bar

保存した証拠

manifest.json: 固定版、ソース比較、命題、前提、未判定の理由。
outputs/summary.json: 成功・反例・未対応・未判定を区別した結果。
outputs/target-bytecode.json: 対象 bytecode、ABI、source map、コンパイラ metadata。
outputs/runtime-inspection.log: 実モジュールの hash と実行版。
outputs/initial-build-memory-events.log: 初回ビルドの OOM 証拠。
outputs/kontrol-build*.log: 二つのビルド経路と停止箇所。
outputs/haskell-validation-diagnostics.log: 生成定義の parser 受理と serialize 失敗。
outputs/solver-runtime-diagnostics.log: Z3 の簡単な実行、RTS 制限時の失敗。
outputs/*.json: 実行したコマンド、終了コード、時刻、時間上限、経過時間。

再実験で必要な条件

同じ digest の native linux/amd64 環境で、まず kore-exec の実入力による
定義検証を確認し、エミュレーションとの違いを切り分ける。
RAM 16 GiB と swap 16 GiB を確保するか、少なくとも逐次ビルドに必要な
実効メモリを確保する。メモリ増量だけで空の exit 1 が解消すると仮定しない。
同じ image で失敗が再現する場合は、固定ツールの初期化・配布物の問題として
診断を続ける。定義検証を無効化して今回の未判定を成功に変更しない。

EXP-05 の追試（上記 EXP-02 の歴史的記録とは別）

2026-09-26 の追試では、Docker 内の一時領域の容量不足を切り分け、
container 専用 tmpfs と telemetry opt-out を使用した。通常の K 定義検証を
通した後、旧 library の sub 範囲命題と、修正版 library の neg(0)=0 および
sub 範囲命題の計 3 件が Kontrol で PASSED となった。

詳細・限界・再現手順: EXP05-RESULTS.txt
機械可読な結果: exp05-summary.json
初期 proof state と実 bytecode の照合: exp05-bytecode-links.json
修正版ソース/コンパイラ/artifact: revised/manifest.json と revised/outputs/target-bytecode.json

ここで証明したのは各 harness の局所命題であり、Bulletproof verifier 全体や
UTXO 本体の証明ではない。EXP-02 当時の容量記録がないため、当時の無出力
exit1 の根本原因も今回の容量不足と同じだったとは断定していない。
