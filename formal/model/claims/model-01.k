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
endmodule
