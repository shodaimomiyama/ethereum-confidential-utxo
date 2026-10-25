requires "auth.k"
module UTXO-OPERATIONS
  imports UTXO-AUTH

  rule validInput(U:Map, S:Set, Owner:Int, I:Int)
    => I in_keys(U) andBool notBool (I in S)
       andBool ownerOf(U[I] orDefault missingUtxo) ==Int Owner
       andBool valueOf(U[I] orDefault missingUtxo) >Int 0
       andBool valueOf(U[I] orDefault missingUtxo) <=Int 18446744073709551616
  rule validInputs(U:Map, S:Set, Owner:Int, ListItem(I:Int))
    => validInput(U, S, Owner, I)
  rule validInputs(_U:Map, _S:Set, _Owner:Int, ListItem(I:Int) ListItem(I)) => false
  rule validInputs(U:Map, S:Set, Owner:Int, ListItem(I:Int) ListItem(J:Int))
    => validInput(U, S, Owner, I) andBool validInput(U, S, Owner, J)
    requires I =/=Int J
  rule validInputs(_U:Map, _S:Set, _Owner:Int, _Inputs:List) => false [owise]

  rule inputTotal(U:Map, ListItem(I:Int))
    => valueOf(U[I] orDefault missingUtxo)
  rule inputTotal(U:Map, ListItem(I:Int) ListItem(J:Int))
    => valueOf(U[I] orDefault missingUtxo) +Int valueOf(U[J] orDefault missingUtxo)
  rule inputTotal(_U:Map, _Inputs:List) => 0 [owise]

  syntax Map ::= addChange(Map, Int, Int, Int) [function]
  rule addChange(U:Map, _Owner:Int, 0, _Id:Int) => U
  rule addChange(U:Map, Owner:Int, Change:Int, Id:Int)
    => U[Id <- utxo(Owner, Change)] requires Change >Int 0

  rule validShape(state(U:Map, _S:Set, H:Set, _B:Int, _A:Int, _E:Int),
                  validatedDeposit(Id:Int, _Owner:Int, D:Int, R:Int, Op:Int))
    => D >Int 0 andBool D <=Int 18446744073709551616
       andBool R ==Int D andBool notBool (Id in_keys(U))
       andBool notBool (Op in H)

  rule validShape(state(U:Map, S:Set, _H:Set, _B:Int, _A:Int, _E:Int),
                  validatedTransfer(_Op:Int, Owner:Int, Inputs:List, _Recipient:Int,
                                    T:Int, RecipientId:Int, ChangeId:Int))
    => validInputs(U, S, Owner, Inputs)
       andBool T >Int 0 andBool T <=Int 18446744073709551616
       andBool T <=Int inputTotal(U, Inputs)
       andBool inputTotal(U, Inputs) -Int T <=Int 18446744073709551616
       andBool notBool (RecipientId in_keys(U))
       andBool (inputTotal(U, Inputs) ==Int T orBool
                (RecipientId =/=Int ChangeId andBool notBool (ChangeId in_keys(U))))

  rule validShape(state(U:Map, S:Set, _H:Set, _B:Int, _A:Int, _E:Int),
                  validatedWithdraw(_Op:Int, Owner:Int, Inputs:List,
                                    W:Int, _Destination:Int, ChangeId:Int))
    => validInputs(U, S, Owner, Inputs)
       andBool W >Int 0 andBool W <=Int 36893488147419103232
       andBool W <=Int inputTotal(U, Inputs)
       andBool inputTotal(U, Inputs) -Int W <=Int 18446744073709551616
       andBool (inputTotal(U, Inputs) ==Int W orBool notBool (ChangeId in_keys(U)))

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedTransfer(Op:Int, Owner:Int, ListItem(I:Int), Recipient:Int,
                               T:Int, RecipientId:Int, ChangeId:Int), _C:Context)
    => accepted(state(addChange(U[RecipientId <- utxo(Recipient, T)], Owner,
                                inputTotal(U, ListItem(I)) -Int T, ChangeId),
                       S List2Set(ListItem(I)), H SetItem(Op), B, A, E))
    requires validShape(state(U, S, H, B, A, E),
                        validatedTransfer(Op, Owner, ListItem(I), Recipient, T,
                                          RecipientId, ChangeId))
         andBool notBool (Op in H)

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedTransfer(Op:Int, Owner:Int, ListItem(I:Int) ListItem(J:Int), Recipient:Int,
                               T:Int, RecipientId:Int, ChangeId:Int), _C:Context)
    => accepted(state(addChange(U[RecipientId <- utxo(Recipient, T)], Owner,
                                inputTotal(U, ListItem(I) ListItem(J)) -Int T, ChangeId),
                       S List2Set(ListItem(I) ListItem(J)), H SetItem(Op), B, A, E))
    requires I =/=Int J andBool validShape(state(U, S, H, B, A, E),
                        validatedTransfer(Op, Owner, ListItem(I) ListItem(J), Recipient, T,
                                          RecipientId, ChangeId))
         andBool notBool (Op in H)

  syntax State ::= withdrawEffect(State, ValidatedOperation) [function]
                 | increaseExcess(State, Int) [function]
  rule withdrawEffect(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                      validatedWithdraw(Op:Int, Owner:Int, Inputs:List, W:Int,
                                        _Destination:Int, ChangeId:Int))
    => state(addChange(U, Owner, inputTotal(U, Inputs) -Int W, ChangeId),
             S List2Set(Inputs), H SetItem(Op), B -Int W, A -Int W, E)
  rule increaseExcess(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int), R:Int)
    => state(U, S, H, B +Int R, A, E +Int R)

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedWithdraw(Op:Int, Owner:Int, Inputs:List, W:Int,
                               Destination:Int, ChangeId:Int), _C:Context)
    => accepted(withdrawEffect(state(U, S, H, B, A, E),
                               validatedWithdraw(Op, Owner, Inputs, W,
                                                 Destination, ChangeId)))
    requires validShape(state(U, S, H, B, A, E),
                        validatedWithdraw(Op, Owner, Inputs, W, Destination, ChangeId))
         andBool notBool (Op in H)

  rule apply(St:State,
             validatedTransfer(_Op:Int, _Owner:Int, ListItem(I:Int) ListItem(I),
                               _Recipient:Int, _T:Int, _NewId:Int, _ChangeId:Int), _C:Context)
    => rejected(St, invalidOperation)

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedTransfer(_Op:Int, _Owner:Int, _Inputs:List,
                               _Recipient:Int, _T:Int, RecipientId:Int, _ChangeId:Int), _C:Context)
    => rejected(state(U, S, H, B, A, E), invalidOperation)
    requires RecipientId in_keys(U)

  rule apply(St:State,
             validatedWithdraw(_Op:Int, _Owner:Int, ListItem(I:Int) ListItem(I),
                               _W:Int, _Destination:Int, _ChangeId:Int), _C:Context)
    => rejected(St, invalidOperation)

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedTransfer(_Op:Int, _Owner:Int, ListItem(I:Int),
                               _Recipient:Int, _T:Int, _RecipientId:Int, _ChangeId:Int), _C:Context)
    => rejected(state(U, S, H, B, A, E), invalidOperation)
    requires I in S

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedWithdraw(_Op:Int, _Owner:Int, ListItem(I:Int),
                               _W:Int, _Destination:Int, _ChangeId:Int), _C:Context)
    => rejected(state(U, S, H, B, A, E), invalidOperation)
    requires I in S

  rule apply(St:State, Transfer:ValidatedOperation, _C:Context)
    => rejected(St, invalidOperation)
    requires notBool validShape(St, Transfer)
        andBool isTransferOrWithdraw(Transfer)

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedTransfer(Op:Int, _Owner:Int, _Inputs:List, _Recipient:Int,
                               _T:Int, _RecipientId:Int, _ChangeId:Int), _C:Context)
    => rejected(state(U, S, H, B, A, E), invalidOperation)
    requires Op in H

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List, _W:Int,
                               _Destination:Int, _ChangeId:Int), _C:Context)
    => rejected(state(U, S, H, B, A, E), invalidOperation)
    requires Op in H

  syntax Bool ::= isTransferOrWithdraw(ValidatedOperation) [function]
  rule isTransferOrWithdraw(validatedTransfer(_, _, _, _, _, _, _)) => true
  rule isTransferOrWithdraw(validatedWithdraw(_, _, _, _, _, _)) => true
  rule isTransferOrWithdraw(_Other:ValidatedOperation) => false [owise]

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedDeposit(Id:Int, Owner:Int, D:Int, R:Int, Op:Int), _C:Context)
    => accepted(state(U[Id <- utxo(Owner, D)], S, H SetItem(Op), B +Int D, A +Int D, E))
    requires D >Int 0 andBool D <=Int 18446744073709551616
     andBool R ==Int D andBool notBool (Id in_keys(U))
     andBool notBool (Op in H)

  rule apply(St:State,
             validatedDeposit(Id:Int, Owner:Int, D:Int, R:Int, Op:Int), _C:Context)
    => rejected(St, invalidOperation)
    requires R ==Int D andBool
             notBool validShape(St, validatedDeposit(Id, Owner, D, R, Op))

  rule apply(St:State, validatedDeposit(_Id:Int, _Owner:Int, D:Int, R:Int, _Op:Int), _C:Context)
    => rejected(St, insufficientDeposit)
    requires R =/=Int D

  rule apply(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
             validatedReceive(R:Int), _C:Context)
    => accepted(state(U, S, H, B +Int R, A, E +Int R))
    requires R >=Int 0

  syntax Outcome ::= committed(Execution)
                   | rolledBack(Execution, RejectReason)
                   | runWithdrawal(Execution, ValidatedOperation,
                                   RecipientBehavior, Context)
                   | withdrawFrame(Frame)
                   | reentryBlocked(Frame)
                   | returnPending(Frame)
                   | attemptReentry(State, ValidatedOperation, Context)

  rule runWithdrawal(execution(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                               Events:List),
                     validatedWithdraw(Op:Int, Owner:Int, Inputs:List, W:Int,
                                       Destination:Int, ChangeId:Int),
                     Behavior:RecipientBehavior, execContext(Chain:Int, Pool:Int))
    => withdrawFrame(frame(execution(state(U, S, H, B, A, E), Events),
                           withdrawEffect(state(U, S, H, B, A, E),
                                          validatedWithdraw(Op, Owner, Inputs, W,
                                                            Destination, ChangeId)),
                           validatedWithdraw(Op, Owner, Inputs, W,
                                             Destination, ChangeId), Behavior,
                           execContext(Chain, Pool)))
    requires validShape(state(U, S, H, B, A, E),
                        validatedWithdraw(Op, Owner, Inputs, W, Destination, ChangeId))
      andBool notBool (Op in H) andBool B >=Int W

  rule runWithdrawal(Exec:Execution, _Op:ValidatedOperation,
                     _Behavior:RecipientBehavior,
                     execContextLocked(_Chain:Int, _Pool:Int))
    => rolledBack(Exec, invalidOperation)
  rule runWithdrawal(execution(St:State, Events:List),
                     Op:ValidatedOperation, _Behavior:RecipientBehavior, _Ctx:Context)
    => rolledBack(execution(St, Events), invalidOperation)
    requires notBool validShape(St, Op)

  rule runWithdrawal(execution(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                               Events:List),
                     validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List, _W:Int,
                                       _Destination:Int, _ChangeId:Int),
                     _Behavior:RecipientBehavior, _Ctx:Context)
    => rolledBack(execution(state(U, S, H, B, A, E), Events), invalidOperation)
    requires Op in H

  rule runWithdrawal(execution(state(U:Map, S:Set, H:Set, B:Int, A:Int, E:Int),
                               Events:List),
                     validatedWithdraw(_Op:Int, _Owner:Int, _Inputs:List, W:Int,
                                       _Destination:Int, _ChangeId:Int),
                     _Behavior:RecipientBehavior, _Ctx:Context)
    => rolledBack(execution(state(U, S, H, B, A, E), Events), invalidOperation)
    requires B <Int W

  rule withdrawFrame(frame(Exec:Execution, Pending:State,
                           validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List,
                                             _W:Int, Destination:Int, _ChangeId:Int),
                           receiveOK, execContext(_Chain:Int, Pool:Int)))
    => committed(execution(Pending, events(Exec) ListItem(successEvent(Op))))
    requires Destination =/=Int Pool
  rule withdrawFrame(frame(Exec:Execution, Pending:State,
                           validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List,
                                             W:Int, Destination:Int, _ChangeId:Int),
                           receiveOK, execContext(_Chain:Int, Pool:Int)))
    => committed(execution(increaseExcess(Pending, W),
                            events(Exec) ListItem(successEvent(Op))))
    requires Destination ==Int Pool

  rule withdrawFrame(frame(Exec:Execution, Pending:State, Op:ValidatedOperation,
                           catchReentry, Ctx:Context))
    => reentryBlocked(frame(Exec, Pending, Op, receiveOK, Ctx))
  rule reentryBlocked(frame(Exec:Execution, Pending:State,
                            Op:ValidatedOperation, receiveOK, Ctx:Context))
    => withdrawFrame(frame(Exec, Pending, Op, receiveOK, Ctx))

  rule withdrawFrame(frame(Exec:Execution, _Pending:State,
                           _Op:ValidatedOperation, propagateReentry, _Ctx:Context))
    => rolledBack(Exec, invalidOperation)
  rule withdrawFrame(frame(Exec:Execution, _Pending:State,
                           _Op:ValidatedOperation, rejectReceive, _Ctx:Context))
    => rolledBack(Exec, invalidOperation)
  rule withdrawFrame(frame(Exec:Execution, _Pending:State,
                           _Op:ValidatedOperation, outerRevert, _Ctx:Context))
    => rolledBack(Exec, invalidOperation)

  rule withdrawFrame(frame(Exec:Execution, Pending:State,
                           validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List,
                                             _W:Int, Destination:Int, _ChangeId:Int),
                           returnETH(R:Int), execContext(_Chain:Int, Pool:Int)))
    => committed(execution(increaseExcess(Pending, R),
                            events(Exec) ListItem(successEvent(Op))))
    requires R >=Int 0 andBool Destination =/=Int Pool
  rule withdrawFrame(frame(Exec:Execution, Pending:State,
                           validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List,
                                             W:Int, Destination:Int, _ChangeId:Int),
                           returnETH(R:Int), execContext(_Chain:Int, Pool:Int)))
    => committed(execution(increaseExcess(Pending, W +Int R),
                            events(Exec) ListItem(successEvent(Op))))
    requires R >=Int 0 andBool Destination ==Int Pool


  rule withdrawFrame(frame(Exec:Execution, Pending:State,
                           Op:ValidatedOperation, returnThenOuterRevert(R:Int), Ctx:Context))
    => returnPending(frame(Exec, increaseExcess(Pending, R), Op,
                           outerRevert, Ctx))
    requires R >=Int 0
  rule returnPending(F:Frame) => withdrawFrame(F)
  rule withdrawFrame(frame(Exec:Execution, _Pending:State,
                           _Op:ValidatedOperation, returnETH(R:Int), _Ctx:Context))
    => rolledBack(Exec, invalidOperation)
    requires R <Int 0
  rule attemptReentry(St:State, _Op:ValidatedOperation,
                      execContextLocked(_Chain:Int, _Pool:Int))
    => rejected(St, invalidOperation)
endmodule
