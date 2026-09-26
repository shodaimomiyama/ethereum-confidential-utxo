requires "../paths.k"
module UTXO-MODEL-07
  imports UTXO-PATHS

  claim <k> execP(St:State,
                  pRequest(Intent:AuthIntent, Cert:AuthCert,
                           Submitter:Int, Nonce:Int),
                  LiveCtx:PContext, Ctx:Context)
          => apply(St, operationOf(Intent), Ctx) </k>
    requires pProofValid(Cert, Intent, LiveCtx)
    [label(MODEL-07-p-normalizes-to-kernel)]

  claim <k> execQ(St:State,
                  qRequest(Intent:AuthIntent, Cert:AuthCert, Claimed:Bool,
                           Submitter:Int, Nonce:Int),
                  authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                              Now:Int, Issuer:Int, Registry:List), Ctx:Context)
          => apply(St, operationOf(Intent), Ctx) </k>
    requires hasTrustedCert(Cert, Registry)
      andBool validCert(Cert, Intent,
                        authContext(Chain, Pool, Rule, Version, Now, Issuer, Registry))
    [label(MODEL-07-q-normalizes-to-kernel)]

  claim <k> execP(St:State,
                  pRequest(Intent:AuthIntent, Cert:AuthCert,
                           Submitter:Int, Nonce:Int),
                  LiveCtx:PContext, Ctx:Context)
          => rejected(St, invalidOperation) </k>
    requires notBool pProofValid(Cert, Intent, LiveCtx)
    [label(MODEL-07-p-invalid-authorization)]

  claim <k> execQ(St:State,
                  qRequest(Intent:AuthIntent, Cert:AuthCert, Claimed:Bool,
                           Submitter:Int, Nonce:Int),
                  authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                              Now:Int, Issuer:Int, Registry:List), Ctx:Context)
          => rejected(St, invalidOperation) </k>
    requires notBool hasTrustedCert(Cert, Registry)
    [label(MODEL-07-q-untrusted-certificate)]

  claim <k> execQ(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  qRequest(authIntent(validatedTransfer(Op:Int, Owner:Int,
                                   ListItem(Input:Int), Recipient:Int, T:Int,
                                   NewId:Int, ChangeId:Int),
                                      Packet:Int, ChangePacket:Int, Random:Int),
                           Cert:AuthCert, true, Submitter:Int, Nonce:Int),
                  authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                              Now:Int, Issuer:Int, Registry:List), Ctx:Context)
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires Input in S
      andBool hasTrustedCert(Cert, Registry)
      andBool validCert(Cert,
        authIntent(validatedTransfer(Op, Owner, ListItem(Input), Recipient,
                                     T, NewId, ChangeId), Packet, ChangePacket, Random),
        authContext(Chain, Pool, Rule, Version, Now, Issuer, Registry))
    [label(MODEL-07-q-rechecks-spent-input)]

  claim <k> execP(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  pRequest(authIntent(validatedDeposit(Id:Int, Owner:Int,
                                     D:Int, D, Op:Int), Packet:Int, 0, Random:Int),
                           Cert:AuthCert, Submitter:Int, Nonce:Int),
                  LiveCtx:PContext, Ctx:Context)
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires Op in H
      andBool pProofValid(Cert,
        authIntent(validatedDeposit(Id, Owner, D, D, Op), Packet, 0, Random),
        LiveCtx)
    [label(MODEL-07-p-rechecks-deposit-history)]
endmodule
