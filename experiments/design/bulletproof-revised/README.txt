EXP-03: 修正版Bulletproofsの相互運用と境界入力

再現コマンド（リポジトリルートから）:
  python3 experiments/design/bulletproof-revised/run.py

実行前の問い、入力集合、資源上限、判定条件は docs/design.md の EXP-03 を参照する。
規則は profile.json、生成点は parameters.json に固定する。
これは実験用の改訂規則であり、監査済みの暗号プロトコルや本体採用済み実装ではない。
Dalek、Grin、Merlinの証明形式との互換性を主張しない。

前提は Python 3.12以上、git、Node 22.22.0、npm、Temurin Java 23、Anvil 1.7.1。
ローカルTCPポート18548を使い、外部チェーンへ接続しない。
EXP-01の固定ソース b7ec38970636d47f6b6bc0db6a3df62b188a247c と依存manifestを使う。
必要な依存が未取得ならネットワークで取得する。
依存cacheは ../bulletproof/.cache を再利用する。
npm依存は毎回 ../bulletproof/package-lock.json から npm ci で復元し、Java依存は固定SHA256と照合する。
上流ソースの変更は検出して停止し、EXP-01の保存結果や暗号コードは変更しない。
Javaは上流の点演算と生成点導出を使い、改訂proverとverifierを java/ に置く。
Solidityの改訂コードは solidity/ に置く。
上流MITライセンスを UPSTREAM-LICENSE.txt に保持する。

Javaヒープ上限は2 GiB、各実行コマンドの上限は600秒。
一時AnvilはPrague、chainId 31337、block gas limit 30,000,000。
solc 0.4.19、optimizer有効・200 runsを固定する。
run.pyの既定結果は .cache/reproduction に保存し、outputsの証拠を上書きしない。
--output .cache/別名 で別の出力先を指定できる。
上限超過、例外、検証結果の不一致は非ゼロ終了とし、成功扱いしない。
measurements.jsonはプロセス単位の時間と最大RSSを記録する。
未取得の依存の初回通信時間と、温まったcacheでの再実行時間は区別する。

秘密スカラーの標本はSecureRandomによる棄却法を使い、ゼロを許容する。
テスト用のcommitment blinding 42・0と強制した多項式blinding 0は既知値であり、機密性の実証には使わない。
金額vに対して実際に C_range = C_original - valueBase を計算し、v−1の範囲証明を生成する。
v=2^64を64 bit整数へ切り詰めない。
証明の各段階で前段のstate、固定tag、公開文脈を引き継ぐ。
challengeは非ゼロかつq未満になる最初の候補をcounter 0..255から選ぶ。
秘密スカラーの候補棄却とchallenge候補の棄却は、ゼロの扱いが異なる。
局所境界の試験はproductionコードのpredicateを同じhelperから呼ぶ。
ゼロになる実Keccak入力を探索した試験や、偽のhashをproduction verifierへ注入した試験ではない。

結果の解釈:
acceptedはverifierが返したbooleanであり、revertした場合もfalseと記録する。
returnedNormallyは正常にbooleanを返したかであり、証明の受理とは別である。
proverが範囲外入力で証明データを返した場合も、Java/EVMの拒否を別に記録する。
正常証明は真返値を要求するVerificationHarness経由でも取引を実行する。
harnessはSTATICCALLの成功、returndataが32 bytes、返値1を要求する。
gasはその単一範囲証明の取引全体であり、本体の署名、保存証明、状態更新、受領イベントを含まない。
証明の乱数によってバイト列、challenge候補数、gas、生成時間が変化する。
少数の入力集合の値を正式な性能比較と扱わない。

未検証範囲:
独自transcriptと生成点導出の暗号学的安全性、全入力の健全性・ゼロ知識性、定数時間実装、実コードの形式証明、本体の収支・認可・受領との合成は、この実験だけでは確認できない。
元コードで得たEXP-02の形式検証環境の未判定も、この具体実行で解消したとは扱わない。

保存した結果:
outputs/ は初回の一括実行、outputs/locked-reproduction/ はlockfileからnpm依存を復元した手順による再実行の証拠。
両方とも正常5例のJava/EVM受理、範囲外2例の拒否、Java改変21例の拒否、EVMの全47例（正常5・不正42）の期待結果を確認した。
正常5例それぞれ全11段階のtranscriptをJava/JavaScript/EVMで照合し、生成点変更3例をconstructorで拒否した。
初回は正常5例で3,808,413〜3,849,645 gas、再実行は3,806,997〜3,827,433 gas、calldataはいずれも1,444 bytes。
初回Javaプロセスは11.196秒・最大RSS423,149,568 bytes、EVM用Nodeプロセスは5.972秒。
Javaの生成と検証の式は別クラスだが、曲線演算・符号化・transcriptコードは共有している。
source-hashes.jsonは各実行時点のファイルを記録する。
初回後にrunnerを常時npm ciとする修正を行い、再実行のsource-hashesが最終runnerに対応する。
暗号コード・profile・生成点はこの2回の間で変更していない。
結果説明を後で追記したREADME/manifestは、実行時点のhashと区別する。
