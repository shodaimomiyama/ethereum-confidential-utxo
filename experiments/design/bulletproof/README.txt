EXP-01: Java Bulletproof proverとEVM verifierの接続

再現コマンド（リポジトリルートから）:
  python3 experiments/design/bulletproof/run.py

前提はPython 3.12以上、git、Node 22.22.0、npm、Temurin Java 23、Anvil 1.7.1と、未使用のローカルTCPポート18547である。
ソースと依存の初回取得にインターネット接続を使う。
外部チェーンへは接続せず、127.0.0.1だけで一時Anvilを動かす。
Maven 3.9.9、Java依存、npm依存、upstream checkout、コンパイル出力はこのディレクトリ内に限定する。
run.pyの既定出力は.cache/reproductionであり、outputsに保存した初回証拠は上書きしない。
別の出力先は --output .cache/別名 で指定できる。
依存版はpackage-lock.json、java-dependencies.json、maven-archive.jsonで固定・照合する。
upstreamのライセンスはUPSTREAM-LICENSE.txtに保存している。

実験の範囲:
元コードはBulletProofLib b7ec38970636d47f6b6bc0db6a3df62b188a247cである。
Javaの暗号コード、生成点の導出、Fiat–Shamir transcriptは変更していない。
64 bit用の暗号コード差分は、2つのSolidity verifierのmを4から64、nを2から6へ変える4行だけである。
差分はoutputs/dimension-64.patchで確認できる。
GenerateProofs.javaは既存proverを呼び出し、証明の各要素をEVM ABIに並べるためのrunnerである。
既存web3j wrapper、個人keystore、RangeProof.serialize()は使用しない。
検証する開示値uは本体の金額vに対するv−1であり、u=0はv=1 wei、u=2^64−1はv=2^64 weiに対応する。
コミットメントのblinding=42は公開した試験専用値であり、機密性を示す試験ではない。
prover内部の乱数は元のSecureRandomを使うため、再実行で証明bytes、実行時間、gasは変わり得る。
保存した証明要素とcalldataは各入力・結果JSONに残す。

実行結果:
4 bitのソース再compile後、既存fixtureはtrueを返し、tauXとcommitmentの改変はfalseを返した。
新規Java証明では4 bitの0/1/15、64 bitの0/1/(2^64−1)をJava verifierとEVM verifierが受理した。
−1と各bit幅の2^bitはproverが証明を返したが、Java verifierとEVM verifierがfalse相当で拒否した。
「proverで拒否」と「生成された証明をverifierで拒否」は同じ扱いにしていない。
正常証明のtauX + 1とcommitmentを(1,2)に置換した例もEVMでfalseとなった。
returnedNormallyはeth_callが正常にbooleanを返したこと、acceptedはそのbooleanを表す。
初期consoleログのreturnedもreturnedNormallyと同じ意味であり、trueという検証結果を意味しない。

gasの解釈:
環境はPrague、solc 0.4.19、optimizer有効・runs=200、block gas limit 30,000,000である。
direct verifierの参考値は、直前のeth_callでtrueを確認した後に同じcalldataを送った取引全体のgasである。
64 bitの3例では3,635,630〜3,635,728 gasであった。
VerificationHarness.solは同じcalldataをSTATICCALLし、呼出し成功・returndata長32 bytes・返値1を取引内で要求する。
同じ64 bitの3例についてharness取引もstatus=1となり、3,640,807〜3,640,905 gasであった。
directとharnessのcalldataはいずれも1,380 bytesであり、単一範囲証明の取引である。
tauX改変証明の元verifierがfalseを返すことを確認した後、harness取引がstatus=0でrevertすることも確認した。
そのrevert取引のgasは321,097であり、正常検証のgasへ含めない。
これらに本体の認可、保存証明、状態更新、受領イベント、複数出力は含まれない。

採用上の未解消条件:
最終inner-product scalar aまたはbへ群位数qを加えた非正規値がEVMでtrueとなった。
tauX、mu、tへqを加えた試験はfalseであったが、これは全scalarの正規範囲検査を代替しない。
値0、blinding0のidentity commitmentでは、元JavaのProofUtils.computeChallengeがaffine座標を読みNullPointerExceptionを投げた。
このidentity例はEVMへ未提出であり、EVMで拒否されたという結果ではない。
challenge=0となる証明は生成しておらず、EVMへ提出していない。
ソースではSolidityのinv(0)=0となり、challengeを0として明示拒否する条件はない。
JavaのFieldVector.invertはBigInteger.modInverseを使うため、0の逆元を計算しようとすると失敗する。
これらの境界、canonical encoding、transcriptへのoperation IDの束縛、生成点導出、安全性、形式証明は採用前に扱う必要がある。

再現・資源記録:
最初のMaven依存解決は37.460秒だった（outputs/maven-dependencies-first.log）。
初回git取得とnpm取得の正確なCPU時間・最大メモリは測定していない。
初回64 bitの正常証明生成は各約1.02〜1.25秒だった（outputs/java-64.json）。
初回の別プロセス全体の時間と最大RSSはoutputs/java-64-process.jsonに残す。
run.pyで新たな証明を生成して一括再現し、その結果、コマンド別時間、最大RSSをoutputs/reproduction.jsonへ保存した。
この一括再現はharness追加前であり、依存キャッシュは温まっていた。
harness追加後は同じ64 bit証明集合を再実行し、outputs/fresh-64-evm.jsonに保存した。
最新run.pyはharnessを含む構成を再現する。
最初の64 bit実行でethersのreceipt待機が停止したため、直接RPCの期限付きreceipt取得へ変更した。
暗号コードの失敗とは区別し、観測したreceiptをoutputs/initial-64-transport-issue.jsonに残した。
これは接続実験であり、暗号学的安全性、形式証明、本体適合、公開テストネット動作、正式な比較性能の達成を示さない。
