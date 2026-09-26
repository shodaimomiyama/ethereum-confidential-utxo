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

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, SetItem(1), 10, 10, 0),
                  validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 3)) (3 |-> utxo(100, 7)),
                            SetItem(1), SetItem(1) SetItem(2), 10, 10, 0)) </k>
    [label(S-03)]

  claim <k> apply(state((1 |-> utxo(100, 18446744073709551616))
                         (2 |-> utxo(100, 18446744073709551616)),
                         .Set, .Set, 36893488147419103232, 36893488147419103232, 0),
                  validatedWithdraw(3, 100, ListItem(1) ListItem(2), 36893488147419103232, 400, 0),
                  execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 18446744073709551616))
                            (2 |-> utxo(100, 18446744073709551616)),
                            SetItem(1) SetItem(2), SetItem(3), 0, 0, 0)) </k>
    [label(S-13-withdraw-max)]

  claim <k> apply(initial(0), validatedDeposit(1, 100, 0, 0, 1), execContext(1, 1))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-13-zero-deposit)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0),
                  validatedTransfer(2, 100, ListItem(1) ListItem(1), 200, 3, 2, 3),
                  execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), invalidOperation) </k>
    [label(S-04-duplicate-input)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0),
                  validatedTransfer(2, 100, ListItem(1), 200, 3, 1, 3), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), invalidOperation) </k>
    [label(S-04-output-collision)]
  claim <k> apply(initial(0), validatedDeposit(1, 100, 1, 1, 1), execContext(1, 1)) => accepted(state(1 |-> utxo(100, 1), .Set, SetItem(1), 1, 1, 0)) </k> [label(S-13-min-deposit)]

  claim <k> apply(initial(0), validatedDeposit(1, 100, 18446744073709551616, 18446744073709551616, 1), execContext(1, 1)) => accepted(state(1 |-> utxo(100, 18446744073709551616), .Set, SetItem(1), 18446744073709551616, 18446744073709551616, 0)) </k> [label(S-13-max-deposit)]

  claim <k> apply(initial(0), validatedDeposit(1, 100, 18446744073709551617, 18446744073709551617, 1), execContext(1, 1)) => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k> [label(S-13-over-deposit)]

  claim <k> apply(initial(0), validatedDeposit(1, 100, -1, -1, 1), execContext(1, 1)) => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k> [label(S-13-negative-deposit)]

  claim <k> apply(state((1 |-> utxo(100, 18446744073709551616)) (2 |-> utxo(100, 18446744073709551616)), .Set, .Set, 36893488147419103232, 36893488147419103232, 0), validatedTransfer(3, 100, ListItem(1) ListItem(2), 200, 18446744073709551616, 3, 4), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 18446744073709551616)) (2 |-> utxo(100, 18446744073709551616)) (3 |-> utxo(200, 18446744073709551616)) (4 |-> utxo(100, 18446744073709551616)), SetItem(1) SetItem(2), SetItem(3), 36893488147419103232, 36893488147419103232, 0)) </k> [label(S-03-max-input-sum)]

  claim <k> apply(state((1 |-> utxo(100, 2)) (2 |-> utxo(100, 3)) (3 |-> utxo(100, 4)), .Set, .Set, 9, 9, 0), validatedTransfer(4, 100, ListItem(1) ListItem(2) ListItem(3), 200, 5, 4, 5), execContext(1, 1)) => rejected(state((1 |-> utxo(100, 2)) (2 |-> utxo(100, 3)) (3 |-> utxo(100, 4)), .Set, .Set, 9, 9, 0), invalidOperation) </k> [label(S-13-over-input-count)]

  claim <k> apply(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 5)), .Set, .Set, 15, 15, 0), validatedTransfer(3, 100, ListItem(1) ListItem(2), 300, 12, 3, 4), execContext(1, 1)) => rejected(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 5)), .Set, .Set, 15, 15, 0), invalidOperation) </k> [label(S-04-mixed-owner)]

  claim <k> apply(initial(0), validatedTransfer(2, 100, ListItem(1), 200, 1, 2, 3), execContext(1, 1)) => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k> [label(S-04-absent-input)]

  claim <k> apply(state(1 |-> utxo(100, 10), SetItem(1), .Set, 0, 0, 0), validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), execContext(1, 1)) => rejected(state(1 |-> utxo(100, 10), SetItem(1), .Set, 0, 0, 0), invalidOperation) </k> [label(S-04-spent-input)]

  claim <k> apply(state((1 |-> utxo(100, 18446744073709551616)) (2 |-> utxo(100, 18446744073709551616)), .Set, .Set, 36893488147419103232, 36893488147419103232, 0), validatedTransfer(3, 100, ListItem(1) ListItem(2), 200, 1, 3, 4), execContext(1, 1)) => rejected(state((1 |-> utxo(100, 18446744073709551616)) (2 |-> utxo(100, 18446744073709551616)), .Set, .Set, 36893488147419103232, 36893488147419103232, 0), invalidOperation) </k> [label(S-13-overlarge-change)]

  claim <k> apply(state((1 |-> utxo(100, 10)) (9 |-> utxo(300, 2)), .Set, .Set, 12, 12, 0), validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 10)) (9 |-> utxo(300, 2)) (2 |-> utxo(200, 3)) (3 |-> utxo(100, 7)), SetItem(1), SetItem(2), 12, 12, 0)) </k> [label(S-03-unrelated-unchanged)]

  claim <k> apply(state((1 |-> utxo(100, 2)) (2 |-> utxo(100, 3)), .Set, .Set, 5, 5, 0), validatedTransfer(3, 100, ListItem(1) ListItem(2), 200, 4, 3, 4), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 2)) (2 |-> utxo(100, 3)) (3 |-> utxo(200, 4)) (4 |-> utxo(100, 1)), SetItem(1) SetItem(2), SetItem(3), 5, 5, 0)) </k> [label(S-04-merge-with-change)]

  claim <k> apply(state((1 |-> utxo(100, 2)) (2 |-> utxo(100, 3)), .Set, .Set, 5, 5, 0), validatedTransfer(3, 100, ListItem(1) ListItem(2), 100, 5, 3, 4), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 2)) (2 |-> utxo(100, 3)) (3 |-> utxo(100, 5)), SetItem(1) SetItem(2), SetItem(3), 5, 5, 0)) </k> [label(S-05-self-merge)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), validatedTransfer(2, 100, ListItem(1), 100, 3, 2, 3), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 3)) (3 |-> utxo(100, 7)), SetItem(1), SetItem(2), 10, 10, 0)) </k> [label(S-05-self-split)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), validatedTransfer(2, 100, ListItem(1), 100, 10, 2, 3), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 10)), SetItem(1), SetItem(2), 10, 10, 0)) </k> [label(S-05-self-recreate)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), validatedWithdraw(2, 100, ListItem(1), 10, 200, 3), execContext(1, 1)) => accepted(state(1 |-> utxo(100, 10), SetItem(1), SetItem(2), 0, 0, 0)) </k> [label(S-06-full-withdraw)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), validatedWithdraw(2, 100, ListItem(1), 3, 200, 2), execContext(1, 1)) => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(2), 7, 7, 0)) </k> [label(S-06-partial-withdraw)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), validatedWithdraw(2, 100, ListItem(1), 11, 200, 2), execContext(1, 1)) => rejected(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), invalidOperation) </k> [label(S-13-withdraw-over)]

endmodule
