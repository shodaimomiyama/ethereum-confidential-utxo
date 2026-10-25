requires "../operations.k"
module UTXO-MODEL-04
  imports UTXO-OPERATIONS

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedDeposit(Id:Int, Owner:Int, D:Int, D, Op), execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires D >Int 0 andBool D <=Int 18446744073709551616
      andBool Op in H
    [label(MODEL-04-deposit-replay)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedTransfer(Op, Owner:Int, Inputs:List, Recipient:Int,
                                    T:Int, NewId:Int, ChangeId:Int), execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires Op in H
    [label(MODEL-04-transfer-replay)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedWithdraw(Op, Owner:Int, Inputs:List, W:Int,
                                    Destination:Int, ChangeId:Int), execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires Op in H
    [label(MODEL-04-withdraw-replay)]

  claim <k> apply(state(1 |-> utxo(100, D1:Int), .Set, SetItem(7), D1, D1, 0),
                  validatedDeposit(2, 100, D2:Int, D2, 8), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, D1)) (2 |-> utxo(100, D2)),
                            .Set, SetItem(7) SetItem(8), D1 +Int D2, D1 +Int D2, 0)) </k>
    requires D1 >Int 0 andBool D1 <=Int 18446744073709551616
      andBool D2 >Int 0 andBool D2 <=Int 18446744073709551616
    [label(MODEL-04-independent-deposit-order-a)]

  claim <k> apply(state(2 |-> utxo(100, D2:Int), .Set, SetItem(8), D2, D2, 0),
                  validatedDeposit(1, 100, D1:Int, D1, 7), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, D1)) (2 |-> utxo(100, D2)),
                            .Set, SetItem(7) SetItem(8), D1 +Int D2, D1 +Int D2, 0)) </k>
    requires D1 >Int 0 andBool D1 <=Int 18446744073709551616
      andBool D2 >Int 0 andBool D2 <=Int 18446744073709551616
    [label(MODEL-04-independent-deposit-order-b)]
endmodule
