requires "../operations.k"
module UTXO-MODEL-03
  imports UTXO-OPERATIONS

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedTransfer(Op:Int, Owner:Int, ListItem(I:Int) ListItem(I),
                                    Recipient:Int, T:Int, NewId:Int, ChangeId:Int),
                  execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    [label(MODEL-03-duplicate-input)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedTransfer(Op:Int, Owner:Int, ListItem(I:Int),
                                    Recipient:Int, T:Int, I, ChangeId:Int),
                  execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires I in_keys(U)
    [label(MODEL-03-output-collision)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedTransfer(Op:Int, Owner:Int, ListItem(I:Int),
                                    Recipient:Int, T:Int, NewId:Int, ChangeId:Int),
                  execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires I in S
    [label(MODEL-03-spent-transfer-input)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedWithdraw(Op:Int, Owner:Int, ListItem(I:Int),
                                    W:Int, Destination:Int, ChangeId:Int),
                  execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    requires I in S
    [label(MODEL-03-spent-withdraw-input)]

  claim <k> apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                  validatedWithdraw(Op:Int, Owner:Int, ListItem(I:Int) ListItem(I),
                                    W:Int, Destination:Int, ChangeId:Int),
                  execContext(1, 1))
          => rejected(state(U, S, H, B, A, E), invalidOperation) </k>
    [label(MODEL-03-duplicate-withdraw-input)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V:Int))
                          (9 |-> utxo(Other:Int, OV:Int)), .Set, .Set,
                          B:Int, V +Int OV, E:Int),
                  validatedTransfer(8, Owner, ListItem(1), Recipient:Int,
                                    T:Int, 2, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool OV >Int 0 andBool OV <=Int 18446744073709551616
      andBool T >Int 0 andBool T <Int V
      andBool V -Int T >Int 0
      andBool T <=Int 18446744073709551616
      andBool V -Int T <=Int 18446744073709551616
    ensures valueOf(utxos(?Next)[1] orDefault missingUtxo) ==Int V
      andBool ownerOf(utxos(?Next)[1] orDefault missingUtxo) ==Int Owner
      andBool valueOf(utxos(?Next)[9] orDefault missingUtxo) ==Int OV
      andBool ownerOf(utxos(?Next)[9] orDefault missingUtxo) ==Int Other
      andBool 1 in spentIds(?Next)
      andBool notBool (9 in spentIds(?Next))
    [label(MODEL-03-existing-records-immutable-partial)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V:Int))
                          (9 |-> utxo(Other:Int, OV:Int)), .Set, .Set,
                          B:Int, V +Int OV, E:Int),
                  validatedTransfer(8, Owner, ListItem(1), Recipient:Int,
                                    V, 2, 3), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V >Int 0 andBool V <=Int 18446744073709551616
      andBool OV >Int 0 andBool OV <=Int 18446744073709551616
    ensures valueOf(utxos(?Next)[1] orDefault missingUtxo) ==Int V
      andBool ownerOf(utxos(?Next)[1] orDefault missingUtxo) ==Int Owner
      andBool valueOf(utxos(?Next)[9] orDefault missingUtxo) ==Int OV
      andBool ownerOf(utxos(?Next)[9] orDefault missingUtxo) ==Int Other
      andBool 1 in spentIds(?Next)
      andBool notBool (9 in spentIds(?Next))
    [label(MODEL-03-existing-records-immutable-full)]

  claim <k> apply(state((1 |-> utxo(Owner:Int, V1:Int))
                          (2 |-> utxo(Owner, V2:Int))
                          (9 |-> utxo(Other:Int, OV:Int)), .Set, .Set,
                          B:Int, V1 +Int V2 +Int OV, E:Int),
                  validatedTransfer(8, Owner, ListItem(1) ListItem(2),
                                    Recipient:Int, T:Int, 3, 4), execContext(1, 1))
          => accepted(?Next:State) </k>
    requires V1 >Int 0 andBool V1 <=Int 18446744073709551616
      andBool V2 >Int 0 andBool V2 <=Int 18446744073709551616
      andBool OV >Int 0 andBool OV <=Int 18446744073709551616
      andBool T >Int 0 andBool T <=Int 18446744073709551616
      andBool T <Int V1 +Int V2
      andBool V1 +Int V2 -Int T >Int 0
      andBool V1 +Int V2 -Int T <=Int 18446744073709551616
    ensures valueOf(utxos(?Next)[1] orDefault missingUtxo) ==Int V1
      andBool valueOf(utxos(?Next)[2] orDefault missingUtxo) ==Int V2
      andBool valueOf(utxos(?Next)[9] orDefault missingUtxo) ==Int OV
      andBool ownerOf(utxos(?Next)[1] orDefault missingUtxo) ==Int Owner
      andBool ownerOf(utxos(?Next)[2] orDefault missingUtxo) ==Int Owner
      andBool ownerOf(utxos(?Next)[9] orDefault missingUtxo) ==Int Other
      andBool 1 in spentIds(?Next) andBool 2 in spentIds(?Next)
      andBool notBool (9 in spentIds(?Next))
    [label(MODEL-03-two-input-existing-records-immutable)]
endmodule
