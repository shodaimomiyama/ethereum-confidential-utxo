requires "../operations.k"
module UTXO-MODEL-06
  imports UTXO-OPERATIONS

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          B:Int, V, E:Int),
                  validatedTransfer(9, Owner, ListItem(1), Recipient:Int,
                                    T:Int, 2, 3),
                  execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool T >Int 0 andBool T <=Int V
      andBool T <=Int 18446744073709551616
      andBool V -Int T <=Int 18446744073709551616
    [label(MODEL-06-transfer-one-input-reachable)]

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          B:Int, V, E:Int),
                  validatedWithdraw(9, Owner, ListItem(1), W:Int,
                                    Destination:Int, 3),
                  execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool W >Int 0 andBool W <=Int V
      andBool W <=Int 36893488147419103232
      andBool V -Int W <=Int 18446744073709551616
    [label(MODEL-06-withdraw-one-input-reachable)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          B:Int, V1 +Int V2, E:Int),
                  validatedTransfer(9, Owner, ListItem(1) ListItem(2),
                                    Recipient:Int, T:Int, 3, 4), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool T >Int 0 andBool T <=Int 18446744073709551616
      andBool T <=Int V1 +Int V2
      andBool V1 +Int V2 -Int T <=Int 18446744073709551616
    [label(MODEL-06-transfer-two-input-reachable)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          B:Int, V1 +Int V2, E:Int),
                  validatedWithdraw(9, Owner, ListItem(1) ListItem(2),
                                    W:Int, Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool W >Int 0 andBool W <=Int 36893488147419103232
      andBool W <=Int V1 +Int V2
      andBool V1 +Int V2 -Int W <=Int 18446744073709551616
    [label(MODEL-06-withdraw-two-input-reachable)]
endmodule
