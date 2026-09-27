requires "../paths.k"
module UTXO-MODEL-08
  imports UTXO-PATHS

  claim <k> applyEnvelope(packed(Exec:Execution,
                                   envelope(Sender:Int, Payer:Int, Nonce:Int,
                                            Spent:Int, Refund:Int)),
                            Charged:Int, Refunded:Int)
          => packed(Exec, envelope(Sender, Payer, Nonce +Int 1,
                                   Spent +Int Charged, Refund +Int Refunded)) </k>
    requires Charged >=Int 0 andBool Refunded >=Int 0
    [label(MODEL-08-envelope-separate-from-assets)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedReceive(R:Int), execContextLocked(_Chain:Int, _Pool:Int))
          => accepted(state(U, S, H, B +Int R, A, E +Int R)) </k>
    requires R >=Int 0
    [label(MODEL-08-simple-receive-under-lock)]

  claim <k> apply(state(.Map, .Set, .Set, E:Int, 0, E),
                  validatedDeposit(1, Owner:Int, D:Int, D, 7), execContext(1, 1))
          => accepted(state(1 |-> utxo(Owner, D), .Set, SetItem(7),
                            E +Int D, D, E)) </k>
    requires E >=Int 0 andBool D >Int 0
      andBool D <=Int 18446744073709551616
    [label(MODEL-08-deposit-does-not-use-prior-excess)]

  claim <k> settleP(execution(initial(0), .List),
                    pRequest(authIntent(validatedDeposit(1, Owner:Int,
                                     D:Int, D, 7), Packet:Int, 0, Random:Int),
                             Cert:AuthCert, Submitter:Int, _Nonce:Int),
                    LiveCtx:PContext, receiveOK, execContext(1, 1))
          => committed(?Next:Execution) </k>
    requires Submitter =/=Int Owner
      andBool D >Int 0 andBool D <=Int 18446744073709551616
      andBool pProofValid(Cert,
        authIntent(validatedDeposit(1, Owner, D, D, 7), Packet, 0, Random),
        LiveCtx)
    ensures wellFormed(assetState(?Next))
      andBool events(?Next) ==K ListItem(successEvent(7))
    [label(MODEL-08-nonowner-submitter-authorized)]
endmodule
