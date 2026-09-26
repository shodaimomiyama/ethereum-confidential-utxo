requires "operations.k"
module UTXO-PATHS
  imports UTXO-OPERATIONS
  imports K-EQUAL

  syntax PRequest ::= pRequest(AuthIntent, AuthCert, Int, Int)
  syntax QRequest ::= qRequest(AuthIntent, AuthCert, Bool, Int, Int)
  syntax PContext ::= pContext(Int, Int, Int, Int, Int, Int, List)
  syntax Bool ::= pProofValid(AuthCert, AuthIntent, PContext) [function]
  syntax AuthIntent ::= decodeP(PRequest) [function]
                      | decodeQ(QRequest) [function]
  syntax AssetView ::= assetAccepted(State) | assetRejected(State)
                     | assetView(Outcome) [function]
  syntax Bool ::= sameLogicalEffect(Outcome, Outcome, Map) [function]
  syntax Outcome ::= execP(State, PRequest, PContext, Context)
                   | pVerify(State, AuthIntent, AuthCert, PContext, Context)
                   | pCurrent(State, AuthIntent, Context)
                   | execQ(State, QRequest, AuthContext, Context)
                   | qReceipt(State, AuthIntent, AuthCert, AuthContext, Context)
                   | qCurrent(State, AuthIntent, AuthCert, AuthContext, Context)
                   | qReady(State, AuthIntent, Context)

  rule decodeP(pRequest(Intent:AuthIntent, _Cert:AuthCert,
                         _Submitter:Int, _Nonce:Int)) => Intent
  rule decodeQ(qRequest(Intent:AuthIntent, _Cert:AuthCert, _ClaimedSuccess:Bool,
                         _Submitter:Int, _Nonce:Int)) => Intent
  rule pProofValid(Cert:AuthCert, Intent:AuthIntent,
                   pContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                            Now:Int, Issuer:Int, LiveResults:List))
    => validCert(Cert, Intent,
                 authContext(Chain, Pool, Rule, Version, Now, Issuer, LiveResults))

  rule execP(St:State, pRequest(Intent:AuthIntent, Cert:AuthCert,
                                _Submitter:Int, _Nonce:Int),
             LiveCtx:PContext, execContext(Chain:Int, Pool:Int))
    => pVerify(St, Intent, Cert, LiveCtx, execContextLocked(Chain, Pool))
  rule pVerify(St:State, Intent:AuthIntent, Cert:AuthCert,
               LiveCtx:PContext, execContextLocked(Chain:Int, Pool:Int))
    => pCurrent(St, Intent, execContext(Chain, Pool))
    requires pProofValid(Cert, Intent, LiveCtx)
  rule pVerify(St:State, Intent:AuthIntent, Cert:AuthCert,
               LiveCtx:PContext, execContextLocked(_Chain:Int, _Pool:Int))
    => rejected(St, invalidOperation)
    requires notBool pProofValid(Cert, Intent, LiveCtx)
  rule pCurrent(St:State, Intent:AuthIntent, Ctx:Context)
    => apply(St, operationOf(Intent), Ctx)
  rule execP(St:State, _Req:PRequest, _LiveCtx:PContext,
             execContextLocked(_Chain:Int, _Pool:Int))
    => rejected(St, invalidOperation)

  rule execQ(St:State, qRequest(Intent:AuthIntent, Cert:AuthCert,
                                _ClaimedSuccess:Bool, _Submitter:Int, _Nonce:Int),
             AuthCtx:AuthContext, execContext(Chain:Int, Pool:Int))
    => qReceipt(St, Intent, Cert, AuthCtx, execContext(Chain, Pool))
  rule qReceipt(St:State, Intent:AuthIntent, Cert:AuthCert,
                authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                            Now:Int, Issuer:Int, Registry:List), Ctx:Context)
    => qCurrent(St, Intent, Cert,
                authContext(Chain, Pool, Rule, Version, Now, Issuer, Registry), Ctx)
    requires hasTrustedCert(Cert, Registry)
  rule qReceipt(St:State, _Intent:AuthIntent, Cert:AuthCert,
                authContext(_Chain:Int, _Pool:Int, _Rule:Int, _Version:Int,
                            _Now:Int, _Issuer:Int, Registry:List), _Ctx:Context)
    => rejected(St, invalidOperation)
    requires notBool hasTrustedCert(Cert, Registry)
  rule qCurrent(St:State, Intent:AuthIntent, Cert:AuthCert,
                AuthCtx:AuthContext, Ctx:Context)
    => qReady(St, Intent, Ctx)
    requires validCert(Cert, Intent, AuthCtx)
  rule qCurrent(St:State, Intent:AuthIntent, Cert:AuthCert,
                AuthCtx:AuthContext, _Ctx:Context)
    => rejected(St, invalidOperation)
    requires notBool validCert(Cert, Intent, AuthCtx)
  rule qReady(St:State, Intent:AuthIntent, Ctx:Context)
    => apply(St, operationOf(Intent), Ctx)
  rule execQ(St:State, _Req:QRequest, _AuthCtx:AuthContext,
             execContextLocked(_Chain:Int, _Pool:Int))
    => rejected(St, invalidOperation)

  rule assetView(accepted(St:State)) => assetAccepted(St)
  rule assetView(rejected(St:State, _Reason:RejectReason)) => assetRejected(St)
  rule sameLogicalEffect(accepted(St:State), accepted(St), .Map) => true
  rule sameLogicalEffect(rejected(St:State, _R1:RejectReason),
                         rejected(St, _R2:RejectReason), .Map) => true
  rule sameLogicalEffect(_O1:Outcome, _O2:Outcome, _Ids:Map) => false [owise]
endmodule
