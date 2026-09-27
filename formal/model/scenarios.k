requires "paths.k"
requires "auth.k"

module UTXO-SCENARIOS
  imports UTXO-PATHS
  imports UTXO-AUTH

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


  claim <k> validate(initial(0),
          authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500),
          authCert(7, 1, 100,
            logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)),
            domain(1, 1), 1, 100, 900),
          authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100,
            logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)),
            domain(1, 1), 1, 100, 900))))
          => checked(validatedDeposit(1, 100, 10, 10, 1)) </k>
    [label(S-09-valid-deposit-authorization)]

  claim <k> validate(initial(0),
          authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500),
          authCert(7, 1, 101,
            logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)),
            domain(1, 1), 1, 100, 900),
          authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 101,
            logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)),
            domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-wrong-owner)]
  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 11, 11, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-amount)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(2, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-output-id)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 2), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-operation-id)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 78, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-receipt-packet)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 501), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-randomness)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(2, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-chain)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 2, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-pool)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 2, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-version)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 2, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-rule)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-issuer)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, .List))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-untrusted-seal)]

  claim <k> validate(initial(0), authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 101, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-expired)]

  claim <k> validate(initial(0), authIntent(validatedTransfer(2, 100, ListItem(1), 201, 3, 2, 3), 77, 78, 500), authCert(7, 1, 100, logicalId(authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-transfer-recipient)]

  claim <k> validate(initial(0), authIntent(validatedTransfer(2, 100, ListItem(9), 200, 3, 2, 3), 77, 78, 500), authCert(7, 1, 100, logicalId(authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-transfer-input)]

  claim <k> validate(initial(0), authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 79, 500), authCert(7, 1, 100, logicalId(authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedTransfer(2, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-transfer-change-packet)]

  claim <k> validate(initial(0), authIntent(validatedWithdraw(2, 100, ListItem(1), 3, 201, 2), 0, 77, 500), authCert(7, 1, 100, logicalId(authIntent(validatedWithdraw(2, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedWithdraw(2, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-withdraw-destination)]

  claim <k> validate(initial(0), authIntent(validatedWithdraw(2, 100, ListItem(1), 4, 200, 2), 0, 77, 500), authCert(7, 1, 100, logicalId(authIntent(validatedWithdraw(2, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), authContext(1, 1, 1, 1, 50, 7, ListItem(authCert(7, 1, 100, logicalId(authIntent(validatedWithdraw(2, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-withdraw-amount)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                  validatedDeposit(1, 100, 10, 10, 7), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                      invalidOperation) </k>
    [label(S-17-deposit-replay-with-new-eth)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                  validatedDeposit(2, 100, 10, 10, 8), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 10)),
                            .Set, SetItem(7) SetItem(8), 20, 20, 0)) </k>
    [label(S-17-fresh-same-amount-deposit)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                  validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                      invalidOperation) </k>
    [label(S-10-transfer-operation-id-replay)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                  validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                      invalidOperation) </k>
    [label(S-10-withdraw-operation-id-replay)]

  claim <k> validate(initial(0),
          authIntent(validatedDeposit(1, 100, 11, 11, 1), 77, 0, 500),
          authCert(7, 1, 100,
            logicalId(authIntent(validatedDeposit(1, 100, 11, 11, 1), 77, 0, 500), domain(1, 1)),
            domain(1, 1), 1, 100, 900),
          authContext(1, 1, 1, 1, 50, 7,
            ListItem(authCert(7, 1, 100,
              logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 1), 77, 0, 500), domain(1, 1)),
              domain(1, 1), 1, 100, 900))))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-forged-certificate-reusing-seal)]

  claim <k> execP(initial(0), pRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1),
                  pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0)) </k>
    [label(S-17-p-deposit)]

  claim <k> execQ(initial(0), qRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2),
                  authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0)) </k>
    [label(S-17-q-deposit)]
  claim <k> execP(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), pRequest(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 3)) (3 |-> utxo(100, 7)), SetItem(1), SetItem(7), 10, 10, 0)) </k>
    [label(S-07-p-transfer)]
  claim <k> execQ(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), qRequest(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 3)) (3 |-> utxo(100, 7)), SetItem(1), SetItem(7), 10, 10, 0)) </k>
    [label(S-07-q-transfer)]
  claim <k> execQ(state(1 |-> utxo(100, 10), SetItem(1), .Set, 0, 0, 0), qRequest(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2),
                  authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), SetItem(1), .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-18-q-stale-input)]
  claim <k> execP(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), pRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(7), 7, 7, 0)) </k>
    [label(S-07-p-withdraw)]
  claim <k> execQ(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), qRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(7), 7, 7, 0)) </k>
    [label(S-07-q-withdraw)]
  claim <k> execP(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0), pRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 3), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0), invalidOperation) </k>
    [label(S-17-p-cross-path-replay)]
  claim <k> execQ(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0), qRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 4), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => rejected(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0), invalidOperation) </k>
    [label(S-17-q-cross-path-replay)]
  claim <k> execQ(initial(0), qRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 101, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-18-q-expired)]
  claim <k> execQ(initial(0), qRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, .List), execContext(1, 1))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-18-q-fake-success)]
  claim <k> execQ(initial(0), qRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), false, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), execContext(1, 1))
          => accepted(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0)) </k>
    [label(S-18-q-false-flag-valid-cert)]
  claim <k> execP(initial(0), pRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1),
                  pContext(1, 1, 1, 1, 50, 8, .List), execContext(1, 1))
          => rejected(state(.Map, .Set, .Set, 0, 0, 0), invalidOperation) </k>
    [label(S-09-p-no-live-verifier-result)]
  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), rejectReceive, execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), invalidOperation) </k>
    [label(S-11-receive-rejected)]
  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), returnThenOuterRevert(2), execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), invalidOperation) </k>
    [label(S-11-return-then-outer-revert)]
  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), outerRevert, execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), invalidOperation) </k>
    [label(S-11-outer-revert)]
  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), returnETH(-1), execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), invalidOperation) </k>
    [label(S-11-negative-return)]
  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), receiveOK, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(7), 7, 7, 0), ListItem(successEvent(7)))) </k>
    [label(S-11-failed-then-retry)]
  claim <k> runWithdrawal(execution(state(1 |-> utxo(100, 10), .Set, .Set,
                                            10, 10, 0), .List),
                            validatedWithdraw(7, 100, ListItem(1), 3, 1, 2),
                            receiveOK, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)),
                                       SetItem(1), SetItem(7), 10, 7, 3),
                                 ListItem(successEvent(7)))) </k>
    [label(S-11-pool-self-withdrawal)]

  claim <k> runWithdrawal(execution(state((1 |-> utxo(100, 10))
                                             (9 |-> utxo(300, 2)), .Set,
                                             SetItem(5), 12, 12, 0),
                                    ListItem(successEvent(5))),
                            validatedWithdraw(7, 100, ListItem(1), 3, 200, 2),
                            outerRevert, execContext(1, 1))
          => rolledBack(execution(state((1 |-> utxo(100, 10))
                                              (9 |-> utxo(300, 2)), .Set,
                                              SetItem(5), 12, 12, 0),
                                     ListItem(successEvent(5))),
                        invalidOperation) </k>
    [label(S-11-prior-success-survives-current-revert)]

  claim <k> apply(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0),
                  validatedReceive(4), execContextLocked(1, 1))
          => accepted(state(1 |-> utxo(100, 10), .Set, SetItem(7), 14, 10, 4)) </k>
    [label(S-11-simple-receive-during-lock)]
  claim <k> settleP(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), pRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), rejectReceive,
                     execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), invalidOperation) </k>
    [label(S-11-p-recipient-failure)]
  claim <k> settleQ(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), qRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))), rejectReceive,
                     execContext(1, 1))
          => rolledBack(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), invalidOperation) </k>
    [label(S-11-q-recipient-failure)]
  claim <k> applyEnvelope(packed(execution(initial(7), .List),
                                    envelope(300, 400, 1, 0, 0)), 5, 2)
          => packed(execution(initial(7), .List),
                    envelope(300, 400, 2, 5, 2)) </k>
    [label(S-14-gas-is-outside-assets)]
  claim <k> settleP(execution(state(.Map, .Set, .Set, 0, 0, 0), .List), pRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     receiveOK, execContext(1, 1))
          => committed(execution(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0), ListItem(successEvent(7)))) </k>
    [label(S-14-p-deposit-event)]
  claim <k> settleQ(execution(state(.Map, .Set, .Set, 0, 0, 0), .List), qRequest(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedDeposit(1, 100, 10, 10, 7), 77, 0, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     receiveOK, execContext(1, 1))
          => committed(execution(state(1 |-> utxo(100, 10), .Set, SetItem(7), 10, 10, 0), ListItem(successEvent(7)))) </k>
    [label(S-14-q-deposit-event)]
  claim <k> settleP(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), pRequest(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     receiveOK, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 3)) (3 |-> utxo(100, 7)), SetItem(1), SetItem(7), 10, 10, 0), ListItem(successEvent(7)))) </k>
    [label(S-14-p-transfer-event)]
  claim <k> settleQ(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), qRequest(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedTransfer(7, 100, ListItem(1), 200, 3, 2, 3), 77, 78, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     receiveOK, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(200, 3)) (3 |-> utxo(100, 7)), SetItem(1), SetItem(7), 10, 10, 0), ListItem(successEvent(7)))) </k>
    [label(S-14-q-transfer-event)]
  claim <k> settleP(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), pRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), 300, 1), pContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     receiveOK, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(7), 7, 7, 0), ListItem(successEvent(7)))) </k>
    [label(S-14-p-withdraw-event)]
  claim <k> settleQ(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List), qRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2), authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     receiveOK, execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(7), 7, 7, 0), ListItem(successEvent(7)))) </k>
    [label(S-14-q-withdraw-event)]
  claim <k> settleQ(execution(state(1 |-> utxo(100, 10), .Set, .Set, 10, 10, 0), .List),
                     qRequest(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900), true, 400, 2),
                     authContext(1, 1, 1, 1, 50, 8, ListItem(authCert(8, 1, 100, logicalId(authIntent(validatedWithdraw(7, 100, ListItem(1), 3, 200, 2), 0, 77, 500), domain(1, 1)), domain(1, 1), 1, 100, 900))),
                     returnETH(2), execContext(1, 1))
          => committed(execution(state((1 |-> utxo(100, 10)) (2 |-> utxo(100, 7)), SetItem(1), SetItem(7), 9, 7, 2), ListItem(successEvent(7)))) </k>
    [label(S-11-q-return-eth)]
endmodule
