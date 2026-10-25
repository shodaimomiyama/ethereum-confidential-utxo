module UTXO-MODEL
  imports INT
  imports BOOL
  imports MAP
  imports SET
  imports LIST
  imports COLLECTIONS

  syntax Utxo ::= utxo(Int, Int) | "missingUtxo"
  syntax State ::= state(Map, Set, Set, Int, Int, Int)
                 | initial(Int) [function]
  syntax Context ::= execContext(Int, Int) | execContextLocked(Int, Int)
  syntax ValidatedOperation ::= validatedDeposit(Int, Int, Int, Int, Int)
                              | validatedReceive(Int)
                              | validatedTransfer(Int, Int, List, Int, Int, Int, Int)
                              | validatedWithdraw(Int, Int, List, Int, Int, Int)
  syntax RejectReason ::= "insufficientDeposit" | "invalidOperation"
  syntax Event ::= successEvent(Int)
  syntax Execution ::= execution(State, List)
  syntax RecipientBehavior ::= "receiveOK" | "catchReentry"
                             | "propagateReentry" | "rejectReceive"
                             | "outerRevert" | returnETH(Int)
                             | returnThenOuterRevert(Int)
  syntax Frame ::= frame(Execution, State, ValidatedOperation,
                        RecipientBehavior, Context)
  syntax Envelope ::= envelope(Int, Int, Int, Int, Int)
  syntax Packed ::= packed(Execution, Envelope)
                  | applyEnvelope(Packed, Int, Int)
  syntax Execution ::= assetExecution(Packed) [function]
  rule assetExecution(packed(Exec:Execution, _Envelope:Envelope)) => Exec
  rule applyEnvelope(packed(Exec:Execution,
                            envelope(Sender:Int, Payer:Int, Nonce:Int,
                                     Spent:Int, Refund:Int)),
                     Charged:Int, Refunded:Int)
    => packed(Exec, envelope(Sender, Payer, Nonce +Int 1,
                             Spent +Int Charged, Refund +Int Refunded))
    requires Charged >=Int 0 andBool Refunded >=Int 0
  syntax List ::= events(Execution) [function]
  syntax State ::= assetState(Execution) [function]
  rule events(execution(_St:State, Events:List)) => Events
  rule assetState(execution(St:State, _Events:List)) => St
  syntax Int ::= valueOf(KItem) [function]
               | ownerOf(KItem) [function]
               | inputTotal(Map, List) [function]
               | liability(State) [function]
               | sumUtxos(List) [function]
               | sumActive(Map, Set) [function]
  syntax Map ::= utxos(State) [function]
  syntax Set ::= spentIds(State) [function]
  rule utxos(state(U:Map, _S:Set, _H:Set, _B:Int, _A:Int, _E:Int)) => U
  rule spentIds(state(_U:Map, S:Set, _H:Set, _B:Int, _A:Int, _E:Int)) => S

  syntax Bool ::= validInput(Map, Set, Int, Int) [function]
                | validInputs(Map, Set, Int, List) [function]
                | validShape(State, ValidatedOperation) [function]
                | wellFormed(State) [function]
                | backed(State) [function]
  syntax FinalOutcome ::= accepted(State) | rejected(State, RejectReason)
  syntax Outcome ::= FinalOutcome
                   | apply(State, ValidatedOperation, Context)
                   | assertIntEqual(Int, Int)

  configuration <k> $PGM:Outcome </k>

  rule assertIntEqual(X:Int, Y:Int) => accepted(initial(0))
    requires X ==Int Y
  rule I:Int -Int I => 0 [simplification]
  rule valueOf(utxo(_Owner:Int, V:Int)) => V
  rule valueOf(missingUtxo) => 0
  rule ownerOf(utxo(Owner:Int, _V:Int)) => Owner
  rule ownerOf(missingUtxo) => -1

  rule liability(state(U:Map, S:Set, _H:Set, _B:Int, _A:Int, _E:Int))
    => sumActive(U, S)
  rule sumActive(.Map, _S:Set) => 0
  rule sumActive((I:Int |-> utxo(_Owner:Int, _V:Int)) Rest:Map,
                 S:Set SetItem(I))
    => sumActive(Rest, S) [simplification]
  rule sumActive((I:Int |-> utxo(_Owner:Int, V:Int)) Rest:Map, S:Set)
    => V +Int sumActive(Rest, S)
    requires notBool (I in S)
  rule sumActive((I:Int |-> utxo(_Owner:Int, _V:Int)) Rest:Map, S:Set)
    => sumActive(Rest, S)
    requires I in S
  rule sumUtxos(.List) => 0
  rule sumUtxos(ListItem(utxo(_Owner:Int, V:Int)) Rest:List)
    => V +Int sumUtxos(Rest)
  rule backed(St:State) => balance(St) ==Int ledger(St) +Int excess(St)
  rule wellFormed(St:State)
    => ledger(St) ==Int liability(St) andBool balance(St) ==Int ledger(St) +Int excess(St)
       andBool excess(St) >=Int 0
  syntax Int ::= ledger(State) [function]
               | balance(State) [function]
               | excess(State) [function]
  rule ledger(state(_U:Map, _S:Set, _H:Set, _B:Int, A:Int, _E:Int)) => A
  rule balance(state(_U:Map, _S:Set, _H:Set, B:Int, _A:Int, _E:Int)) => B
  rule excess(state(_U:Map, _S:Set, _H:Set, _B:Int, _A:Int, E:Int)) => E

  rule initial(B:Int) => state(.Map, .Set, .Set, B, 0, B)
    requires B >=Int 0

endmodule
