requires "../paths.k"
module UTXO-MODEL-05
  imports UTXO-PATHS

  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set,
                                            10, 10, 0), .List),
                            validatedWithdraw(7, 100, ListItem(1), 3, 200, 2),
                            catchReentry, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10))
                                       (2 |-> utxo(100, 7)),
                                       SetItem(1), SetItem(7), 7, 7, 0),
                                 ListItem(successEvent(7)))) </k>
    [label(MODEL-05-caught-reentry-outer-commits)]

  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set,
                                            10, 10, 0), .List),
                            validatedWithdraw(7, 100, ListItem(1), 3, 200, 2),
                            propagateReentry, execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set,
                                         10, 10, 0), .List), invalidOperation) </k>
    [label(MODEL-05-propagated-reentry-rolls-back)]

  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set,
                                            10, 10, 0), .List),
                            validatedWithdraw(7, 100, ListItem(1), 3, 200, 2),
                            returnETH(2), execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10))
                                       (2 |-> utxo(100, 7)),
                                       SetItem(1), SetItem(7), 9, 7, 2),
                                 ListItem(successEvent(7)))) </k>
    [label(MODEL-05-return-eth-is-unaccounted)]

  claim <k> withdrawFrame(frame(execution(St:State, Events:List), Pending:State,
                           Op:ValidatedOperation, propagateReentry, Ctx:Context))
          => rolledBack(execution(St, Events), invalidOperation) </k>
    [label(MODEL-05-symbolic-propagation-rollback)]

  claim <k> withdrawFrame(frame(execution(St:State, Events:List), Pending:State,
                           Op:ValidatedOperation, rejectReceive, Ctx:Context))
          => rolledBack(execution(St, Events), invalidOperation) </k>
    [label(MODEL-05-symbolic-receiver-rejection-rollback)]

  claim <k> withdrawFrame(frame(execution(St:State, Events:List), Pending:State,
                           Op:ValidatedOperation, outerRevert, Ctx:Context))
          => rolledBack(execution(St, Events), invalidOperation) </k>
    [label(MODEL-05-symbolic-outer-frame-rollback)]

  claim <k> attemptReentry(St:State, Op:ValidatedOperation,
                           execContextLocked(Chain:Int, Pool:Int))
          => rejected(St, invalidOperation) </k>
    [label(MODEL-05-symbolic-reentry-rejected)]

  claim <k> execP(St:State, Req:PRequest, LiveCtx:PContext,
                  execContextLocked(Chain:Int, Pool:Int))
          => rejected(St, invalidOperation) </k>
    [label(MODEL-05-p-entry-locked)]

  claim <k> execQ(St:State, Req:QRequest, AuthCtx:AuthContext,
                  execContextLocked(Chain:Int, Pool:Int))
          => rejected(St, invalidOperation) </k>
    [label(MODEL-05-q-entry-locked)]

  claim <k> runWithdrawal(execution(state(1 |-> utxo(Owner:Int, V:Int),
                                             .Set, .Set, V +Int E:Int, V, E),
                                    Events:List),
                            validatedWithdraw(9, Owner, ListItem(1), W:Int,
                                              Destination:Int, 2),
                            returnETH(R:Int), execContext(1, 1))
          => committed(?Next:Execution) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool W >Int 0 andBool W <Int V andBool V -Int W >Int 0
      andBool E >=Int 0 andBool R >=Int 0 andBool Destination =/=Int 1
    ensures wellFormed(assetState(?Next))
      andBool excess(assetState(?Next)) ==Int E +Int R
      andBool ledger(assetState(?Next)) ==Int V -Int W
      andBool balance(assetState(?Next)) ==Int V +Int E -Int W +Int R
    [label(MODEL-05-symbolic-return-preserves-accounting)]

  claim <k> withdrawFrame(frame(execution(St:State, Events:List), Pending:State,
                           Op:ValidatedOperation, returnThenOuterRevert(R:Int),
                           Ctx:Context))
          => rolledBack(execution(St, Events), invalidOperation) </k>
    requires R >=Int 0
    [label(MODEL-05-return-undone-by-outer-revert)]

  claim <k> runWithdrawal(execution(state(1 |-> utxo(Owner:Int, V:Int),
                                             .Set, .Set, V +Int E:Int, V, E),
                                    Events:List),
                            validatedWithdraw(9, Owner, ListItem(1), W:Int,
                                              Destination:Int, 2),
                            catchReentry, execContext(1, 1))
          => committed(?Next:Execution) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool W >Int 0 andBool W <Int V andBool V -Int W >Int 0
      andBool E >=Int 0 andBool Destination =/=Int 1
    ensures wellFormed(assetState(?Next))
      andBool excess(assetState(?Next)) ==Int E
      andBool ledger(assetState(?Next)) ==Int V -Int W
    [label(MODEL-05-caught-reentry-preserves-accounting)]

  claim <k> settleP(Exec:Execution, Req:PRequest, LiveCtx:PContext,
                    Behavior:RecipientBehavior,
                    execContextLocked(Chain:Int, Pool:Int))
          => rolledBack(Exec, invalidOperation) </k>
    [label(MODEL-05-public-p-entry-locked)]

  claim <k> settleQ(Exec:Execution, Req:QRequest, AuthCtx:AuthContext,
                    Behavior:RecipientBehavior,
                    execContextLocked(Chain:Int, Pool:Int))
          => rolledBack(Exec, invalidOperation) </k>
    [label(MODEL-05-public-q-entry-locked)]
endmodule
