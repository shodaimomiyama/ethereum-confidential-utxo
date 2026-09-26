requires "operations.k"

module UTXO-SCENARIOS
  imports UTXO-OPERATIONS

  claim <k> apply(initial(7), validatedDeposit(1, 100, 10, 10, 1), execContext(1, 1))
          => accepted(state(1 |-> utxo(100, 10), .Set, SetItem(1), 17, 10, 7)) </k>
    [label(S-01)]

  claim <k> apply(initial(7), validatedDeposit(1, 100, 10, 9, 1), execContext(1, 1))
          => rejected(initial(7), insufficientDeposit) </k>
    [label(S-01-reject-value)]
  claim <k> apply(initial(7), validatedReceive(4), execContext(1, 1))
          => accepted(state(.Map, .Set, .Set, 11, 0, 11)) </k>
    [label(S-12)]
endmodule
