requires "model.k"
module UTXO-OPERATIONS
  imports UTXO-MODEL

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedDeposit(Id:Int, Owner:Int, D:Int, R:Int, Op:Int), _C:Context)
    => accepted(state(U[Id <- utxo(Owner, D)], S, H SetItem(Op), B +Int D, A +Int D, E))
    requires D >Int 0 andBool D <=Int 18446744073709551616
     andBool R ==Int D andBool notBool (Id in_keys(U))
     andBool notBool (Op in H)

  rule apply(St:State, validatedDeposit(_Id:Int, _Owner:Int, D:Int, R:Int, _Op:Int), _C:Context)
    => rejected(St, insufficientDeposit)
    requires R =/=Int D

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedReceive(R:Int), _C:Context)
    => accepted(state(U, S, H, B +Int R, A, E +Int R))
    requires R >=Int 0
endmodule
