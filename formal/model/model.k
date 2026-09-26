module UTXO-MODEL
  imports INT
  imports BOOL
  imports MAP
  imports SET
  imports LIST

  syntax Utxo ::= utxo(Int, Int)
  syntax State ::= state(Map, Set, Set, Int, Int, Int)
                 | initial(Int) [function]
  syntax Context ::= execContext(Int, Int)
  syntax ValidatedOperation ::= validatedDeposit(Int, Int, Int, Int, Int)
                              | validatedReceive(Int)
  syntax RejectReason ::= "insufficientDeposit"
  syntax Int ::= liability(State) [function]
               | sumUtxos(List) [function]
  syntax Bool ::= wellFormed(State) [function]
                | backed(State) [function]
  syntax Outcome ::= accepted(State)
                   | rejected(State, RejectReason)
                   | apply(State, ValidatedOperation, Context)

  configuration <k> $PGM:Outcome </k>

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
