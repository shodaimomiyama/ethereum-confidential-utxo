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
  syntax AssetView ::= assetAccepted(State, List) | assetRejected(State, List)
                     | assetView(Outcome) [function]
  syntax Bool ::= sameLogicalEffect(Outcome, Outcome, Map) [function]
  syntax KResult ::= FinalOutcome
  syntax Outcome ::= execP(State, PRequest, PContext, Context)
                   | pVerify(State, AuthIntent, AuthCert, PContext, Context)
                   | pCurrent(State, AuthIntent, Context)
                   | execQ(State, QRequest, AuthContext, Context)
                   | qReceipt(State, AuthIntent, AuthCert, AuthContext, Context)
                   | qCurrent(State, AuthIntent, AuthCert, AuthContext, Context)
                   | qReady(State, AuthIntent, Context)
                   | settleP(Execution, PRequest, PContext,
                             RecipientBehavior, Context)
                   | pSettleVerify(Execution, AuthIntent, AuthCert, PContext,
                                   RecipientBehavior, Context)
                   | settleQ(Execution, QRequest, AuthContext,
                             RecipientBehavior, Context)
                   | qSettleReceipt(Execution, AuthIntent, AuthCert, AuthContext,
                                    RecipientBehavior, Context)
                   | qSettleCurrent(Execution, AuthIntent, AuthCert, AuthContext,
                                    RecipientBehavior, Context)
                   | commonSettlement(Execution, ValidatedOperation,
                                      RecipientBehavior, Context)
                   | settleOutcome(Outcome, Execution, ValidatedOperation,
                                   RecipientBehavior, Context) [strict(1)]

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

  rule settleP(Exec:Execution,
               pRequest(Intent:AuthIntent, Cert:AuthCert,
                        _Submitter:Int, _Nonce:Int),
               LiveCtx:PContext, Behavior:RecipientBehavior,
               execContext(Chain:Int, Pool:Int))
    => pSettleVerify(Exec, Intent, Cert, LiveCtx, Behavior,
                     execContextLocked(Chain, Pool))
  rule pSettleVerify(Exec:Execution, Intent:AuthIntent, Cert:AuthCert,
                     LiveCtx:PContext, Behavior:RecipientBehavior,
                     execContextLocked(Chain:Int, Pool:Int))
    => commonSettlement(Exec, operationOf(Intent), Behavior,
                        execContext(Chain, Pool))
    requires pProofValid(Cert, Intent, LiveCtx)
  rule pSettleVerify(Exec:Execution, Intent:AuthIntent, Cert:AuthCert,
                     LiveCtx:PContext, _Behavior:RecipientBehavior,
                     execContextLocked(_Chain:Int, _Pool:Int))
    => rolledBack(Exec, invalidOperation)
    requires notBool pProofValid(Cert, Intent, LiveCtx)
  rule settleQ(Exec:Execution,
               qRequest(Intent:AuthIntent, Cert:AuthCert, _ClaimedSuccess:Bool,
                        _Submitter:Int, _Nonce:Int),
               AuthCtx:AuthContext, Behavior:RecipientBehavior,
               execContext(Chain:Int, Pool:Int))
    => qSettleReceipt(Exec, Intent, Cert, AuthCtx, Behavior,
                      execContextLocked(Chain, Pool))
  rule qSettleReceipt(Exec:Execution, Intent:AuthIntent, Cert:AuthCert,
                      authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                                  Now:Int, Issuer:Int, Registry:List),
                      Behavior:RecipientBehavior, Ctx:Context)
    => qSettleCurrent(Exec, Intent, Cert,
                      authContext(Chain, Pool, Rule, Version, Now, Issuer,
                                  Registry), Behavior, Ctx)
    requires hasTrustedCert(Cert, Registry)
  rule qSettleReceipt(Exec:Execution, _Intent:AuthIntent, Cert:AuthCert,
                      authContext(_Chain:Int, _Pool:Int, _Rule:Int,
                                  _Version:Int, _Now:Int, _Issuer:Int,
                                  Registry:List),
                      _Behavior:RecipientBehavior, _Ctx:Context)
    => rolledBack(Exec, invalidOperation)
    requires notBool hasTrustedCert(Cert, Registry)
  rule qSettleCurrent(Exec:Execution, Intent:AuthIntent, Cert:AuthCert,
                      AuthCtx:AuthContext, Behavior:RecipientBehavior,
                      execContextLocked(Chain:Int, Pool:Int))
    => commonSettlement(Exec, operationOf(Intent), Behavior,
                        execContext(Chain, Pool))
    requires validCert(Cert, Intent, AuthCtx)
  rule qSettleCurrent(Exec:Execution, Intent:AuthIntent, Cert:AuthCert,
                      AuthCtx:AuthContext, _Behavior:RecipientBehavior,
                      execContextLocked(_Chain:Int, _Pool:Int))
    => rolledBack(Exec, invalidOperation)
    requires notBool validCert(Cert, Intent, AuthCtx)
  rule settleP(Exec:Execution, _Req:PRequest, _LiveCtx:PContext,
               _Behavior:RecipientBehavior,
               execContextLocked(_Chain:Int, _Pool:Int))
    => rolledBack(Exec, invalidOperation)
  rule settleQ(Exec:Execution, _Req:QRequest, _AuthCtx:AuthContext,
               _Behavior:RecipientBehavior,
               execContextLocked(_Chain:Int, _Pool:Int))
    => rolledBack(Exec, invalidOperation)
  rule commonSettlement(Exec:Execution, Op:ValidatedOperation,
                        Behavior:RecipientBehavior, Ctx:Context)
    => settleOutcome(apply(assetState(Exec), Op, Ctx),
                     Exec, Op, Behavior, Ctx)

  rule settleOutcome(accepted(Pending:State), Exec:Execution,
                     Op:ValidatedOperation, Behavior:RecipientBehavior,
                     Ctx:Context)
    => withdrawFrame(frame(Exec, Pending, Op, Behavior, Ctx))
    requires isWithdrawOperation(Op)
  rule settleOutcome(accepted(Pending:State), Exec:Execution,
                     Op:ValidatedOperation, _Behavior:RecipientBehavior,
                     _Ctx:Context)
    => committed(execution(Pending,
                           events(Exec) ListItem(successEvent(operationId(Op)))))
    requires notBool isWithdrawOperation(Op)
  rule settleOutcome(rejected(_RejectedState:State, Reason:RejectReason),
                     Exec:Execution, _Op:ValidatedOperation,
                     _Behavior:RecipientBehavior, _Ctx:Context)
    => rolledBack(Exec, Reason)

  syntax Bool ::= isWithdrawOperation(ValidatedOperation) [function]
  rule isWithdrawOperation(validatedWithdraw(_, _, _, _, _, _)) => true
  rule isWithdrawOperation(_Other:ValidatedOperation) => false [owise]

  rule assetView(accepted(St:State)) => assetAccepted(St, .List)
  rule assetView(rejected(St:State, _Reason:RejectReason)) => assetRejected(St, .List)
  rule assetView(committed(execution(St:State, Events:List)))
    => assetAccepted(St, Events)
  rule assetView(rolledBack(execution(St:State, Events:List), _Reason:RejectReason))
    => assetRejected(St, Events)
  rule sameLogicalEffect(accepted(St:State), accepted(St), .Map) => true
  rule sameLogicalEffect(committed(Exec:Execution), committed(Exec), .Map) => true
  rule sameLogicalEffect(rolledBack(Exec:Execution, _R1:RejectReason),
                         rolledBack(Exec, _R2:RejectReason), .Map) => true
  rule sameLogicalEffect(rejected(St:State, _R1:RejectReason),
                         rejected(St, _R2:RejectReason), .Map) => true
  rule sameLogicalEffect(_O1:Outcome, _O2:Outcome, _Ids:Map) => false [owise]
endmodule
