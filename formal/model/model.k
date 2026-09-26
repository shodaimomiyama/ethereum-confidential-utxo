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
  syntax Context ::= execContext(Int, Int)
  syntax ValidatedOperation ::= validatedDeposit(Int, Int, Int, Int, Int)
                              | validatedReceive(Int)
                              | validatedTransfer(Int, Int, List, Int, Int, Int, Int)
                              | validatedWithdraw(Int, Int, List, Int, Int, Int)
  syntax RejectReason ::= "insufficientDeposit" | "invalidOperation"
  syntax Int ::= valueOf(KItem) [function]
               | ownerOf(KItem) [function]
               | inputTotal(Map, List) [function]
               | liability(State) [function]
               | sumUtxos(List) [function]
  syntax Map ::= utxos(State) [function]
  syntax Set ::= spentIds(State) [function]
  rule utxos(state(U:Map, _S:Set, _H:Set, _B:Int, _A:Int, _E:Int)) => U
  rule spentIds(state(_U:Map, S:Set, _H:Set, _B:Int, _A:Int, _E:Int)) => S

  syntax Bool ::= validInput(Map, Set, Int, Int) [function]
                | validInputs(Map, Set, Int, List) [function]
                | validShape(State, ValidatedOperation) [function]
                | wellFormed(State) [function]
                | backed(State) [function]
  syntax Outcome ::= accepted(State)
                   | rejected(State, RejectReason)
                   | apply(State, ValidatedOperation, Context)

  configuration <k> $PGM:Outcome </k>

  rule I:Int -Int I => 0 [simplification]
  rule valueOf(utxo(_Owner:Int, V:Int)) => V
  rule valueOf(missingUtxo) => 0
  rule ownerOf(utxo(Owner:Int, _V:Int)) => Owner
  rule ownerOf(missingUtxo) => -1

  rule liability(state(U:Map, S:Set, _H:Set, _B:Int, _A:Int, _E:Int))
    => sumUtxos(values(removeAll(U, S)))
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
