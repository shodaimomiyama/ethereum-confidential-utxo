requires "../operations.k"
module UTXO-MODEL-01
  imports UTXO-OPERATIONS

  claim <k> apply(state(U:Map, _S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedDeposit(Id:Int, _Owner:Int, D:Int, D, Op:Int), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires B >=Int 0 andBool E >=Int 0 andBool A >=Int 0
             andBool B ==Int A +Int E
             andBool D >Int 0 andBool D <=Int 18446744073709551616
             andBool notBool (Id in_keys(U)) andBool notBool (Op in H)
    ensures backed(?Next)
    [label(MODEL-01-backed-deposit)]

  claim <k> apply(state(.Map, .Set, .Set, B:Int, 0, B),
                  validatedDeposit(1, 100, D:Int, D, 1), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires B >=Int 0 andBool D >Int 0 andBool D <=Int 18446744073709551616
    ensures wellFormed(?Next)
    [label(MODEL-01-initial-deposit)]

  claim <k> apply(state(_U:Map, _S:Set, _H:Set, B:Int, A:Int, E:Int),
                  validatedReceive(R:Int), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires B >=Int 0 andBool E >=Int 0 andBool A >=Int 0
             andBool B ==Int A +Int E andBool R >=Int 0
    ensures backed(?Next)
    [label(MODEL-01-backed-receive)]

  claim <k> apply(state(.Map, .Set, .Set, B:Int, 0, B),
                  validatedReceive(R:Int), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires B >=Int 0 andBool R >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-initial-receive)]
  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          V +Int E:Int, V, E),
                  validatedTransfer(9, Owner, ListItem(1), Recipient:Int,
                                    T:Int, 2, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool T >Int 0 andBool T <=Int V
      andBool T <=Int 18446744073709551616
      andBool V -Int T <=Int 18446744073709551616
      andBool E >=Int 0
    ensures backed(?Next)
    [label(MODEL-01-backed-transfer-one-input)]

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          V +Int E:Int, V, E),
                  validatedWithdraw(9, Owner, ListItem(1), W:Int,
                                    Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool W >Int 0 andBool W <=Int V
      andBool W <=Int 36893488147419103232
      andBool V -Int W <=Int 18446744073709551616
      andBool E >=Int 0
    ensures backed(?Next)
    [label(MODEL-01-backed-withdraw-one-input)]

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          V +Int E:Int, V, E),
                  validatedTransfer(9, Owner, ListItem(1), Recipient:Int,
                                    T:Int, 2, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool T >Int 0 andBool T <Int V
      andBool V -Int T >Int 0
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-partial-transfer-one-input)]

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          V +Int E:Int, V, E),
                  validatedTransfer(9, Owner, ListItem(1), Recipient:Int,
                                    V, 2, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-full-transfer-one-input)]

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          V +Int E:Int, V, E),
                  validatedWithdraw(9, Owner, ListItem(1), W:Int,
                                    Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool W >Int 0 andBool W <Int V
      andBool V -Int W >Int 0
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-partial-withdraw-one-input)]

  claim <k> apply(state(1 |-> utxo(Owner:Int, V:Int), .Set, .Set,
                          V +Int E:Int, V, E),
                  validatedWithdraw(9, Owner, ListItem(1), V,
                                    Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-full-withdraw-one-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          V1 +Int V2 +Int E:Int, V1 +Int V2, E),
                  validatedTransfer(9, Owner, ListItem(1) ListItem(2),
                                    Recipient:Int, T:Int, 3, 4), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool T >Int 0 andBool T <=Int 18446744073709551616
      andBool T <=Int V1 +Int V2
      andBool V1 +Int V2 -Int T <=Int 18446744073709551616
      andBool E >=Int 0
    ensures backed(?Next)
    [label(MODEL-01-backed-transfer-two-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          V1 +Int V2 +Int E:Int, V1 +Int V2, E),
                  validatedWithdraw(9, Owner, ListItem(1) ListItem(2),
                                    W:Int, Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool W >Int 0 andBool W <=Int 36893488147419103232
      andBool W <=Int V1 +Int V2
      andBool V1 +Int V2 -Int W <=Int 18446744073709551616
      andBool E >=Int 0
    ensures backed(?Next)
    [label(MODEL-01-backed-withdraw-two-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          V1 +Int V2 +Int E:Int, V1 +Int V2, E),
                  validatedTransfer(9, Owner, ListItem(1) ListItem(2),
                                    Recipient:Int, T:Int, 3, 4), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool T >Int 0 andBool T <=Int 18446744073709551616
      andBool T <Int V1 +Int V2
      andBool V1 +Int V2 -Int T >Int 0
      andBool V1 +Int V2 -Int T <=Int 18446744073709551616
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-partial-transfer-two-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          V1 +Int V2 +Int E:Int, V1 +Int V2, E),
                  validatedTransfer(9, Owner, ListItem(1) ListItem(2),
                                    Recipient:Int, V1 +Int V2, 3, 4), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool V1 +Int V2 <=Int 18446744073709551616
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-full-transfer-two-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          V1 +Int V2 +Int E:Int, V1 +Int V2, E),
                  validatedWithdraw(9, Owner, ListItem(1) ListItem(2),
                                    W:Int, Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool W >Int 0 andBool W <Int V1 +Int V2
      andBool W <=Int 36893488147419103232
      andBool V1 +Int V2 -Int W >Int 0
      andBool V1 +Int V2 -Int W <=Int 18446744073709551616
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-partial-withdraw-two-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int)), .Set, .Set,
                          V1 +Int V2 +Int E:Int, V1 +Int V2, E),
                  validatedWithdraw(9, Owner, ListItem(1) ListItem(2),
                                    V1 +Int V2, Destination:Int, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool E >=Int 0
    ensures wellFormed(?Next)
    [label(MODEL-01-liability-full-withdraw-two-input)]
endmodule
