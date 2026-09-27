requires "model.k"
module UTXO-AUTH
  imports UTXO-MODEL

  syntax Domain ::= domain(Int, Int)
  syntax AuthIntent ::= authIntent(ValidatedOperation, Int, Int, Int)
  syntax LogicalId ::= logicalId(AuthIntent, Domain)
  syntax AuthCert ::= authCert(Int, Int, Int, LogicalId, Domain, Int, Int, Int)
  syntax AuthContext ::= authContext(Int, Int, Int, Int, Int, Int, List)
  syntax Int ::= ownerOfOperation(ValidatedOperation) [function]
               | operationId(ValidatedOperation) [function]
  syntax ValidatedOperation ::= operationOf(AuthIntent) [function]
  syntax Bool ::= validCert(AuthCert, AuthIntent, AuthContext) [function]
                 | isAssetOperation(ValidatedOperation) [function]
                 | sameDomain(Domain, Domain) [function]
                 | sameLogicalId(LogicalId, LogicalId) [function]
                 | sameIntent(AuthIntent, AuthIntent) [function]
                 | sameOperation(ValidatedOperation, ValidatedOperation) [function]
                 | sameInputs(List, List) [function]
                 | sameCert(AuthCert, AuthCert) [function]
                 | hasTrustedCert(AuthCert, List) [function]
  syntax Outcome ::= checked(ValidatedOperation)
                   | validate(State, AuthIntent, AuthCert, AuthContext)

  rule operationOf(authIntent(Op:ValidatedOperation, _RecipientPacket:Int,
                               _ChangePacket:Int, _Randomness:Int)) => Op
  rule ownerOfOperation(validatedDeposit(_Id:Int, Owner:Int, _D:Int, _R:Int, _Op:Int)) => Owner
  rule ownerOfOperation(validatedTransfer(_Op:Int, Owner:Int, _Inputs:List,
                                          _Recipient:Int, _T:Int, _NewId:Int, _ChangeId:Int)) => Owner
  rule ownerOfOperation(validatedWithdraw(_Op:Int, Owner:Int, _Inputs:List,
                                          _W:Int, _Destination:Int, _ChangeId:Int)) => Owner
  rule ownerOfOperation(validatedReceive(_R:Int)) => -1
  rule operationId(validatedDeposit(_Id:Int, _Owner:Int, _D:Int,
                                    _R:Int, Op:Int)) => Op
  rule operationId(validatedTransfer(Op:Int, _Owner:Int, _Inputs:List,
                                     _Recipient:Int, _T:Int, _NewId:Int,
                                     _ChangeId:Int)) => Op
  rule operationId(validatedWithdraw(Op:Int, _Owner:Int, _Inputs:List,
                                     _W:Int, _Destination:Int, _ChangeId:Int)) => Op
  rule operationId(validatedReceive(_R:Int)) => -1
  rule isAssetOperation(validatedDeposit(_, _, _, _, _)) => true
  rule isAssetOperation(validatedTransfer(_, _, _, _, _, _, _)) => true
  rule isAssetOperation(validatedWithdraw(_, _, _, _, _, _)) => true
  rule isAssetOperation(validatedReceive(_)) => false

  rule sameDomain(domain(C1:Int, P1:Int), domain(C2:Int, P2:Int))
    => C1 ==Int C2 andBool P1 ==Int P2
  rule sameLogicalId(logicalId(I1:AuthIntent, D1:Domain),
                     logicalId(I2:AuthIntent, D2:Domain))
    => sameIntent(I1, I2) andBool sameDomain(D1, D2)
  rule sameIntent(authIntent(O1:ValidatedOperation, R1:Int, C1:Int, N1:Int),
                  authIntent(O2:ValidatedOperation, R2:Int, C2:Int, N2:Int))
    => sameOperation(O1, O2) andBool R1 ==Int R2
       andBool C1 ==Int C2 andBool N1 ==Int N2
  rule sameCert(authCert(I1:Int, R1:Int, O1:Int, L1:LogicalId, D1:Domain,
                          V1:Int, E1:Int, S1:Int),
                authCert(I2:Int, R2:Int, O2:Int, L2:LogicalId, D2:Domain,
                          V2:Int, E2:Int, S2:Int))
    => I1 ==Int I2 andBool R1 ==Int R2 andBool O1 ==Int O2
       andBool sameLogicalId(L1, L2) andBool sameDomain(D1, D2)
       andBool V1 ==Int V2 andBool E1 ==Int E2 andBool S1 ==Int S2
  rule hasTrustedCert(_Cert:AuthCert, .List) => false
  rule hasTrustedCert(Cert:AuthCert, ListItem(Registered:AuthCert) Rest:List)
    => sameCert(Cert, Registered) orBool hasTrustedCert(Cert, Rest)
  rule sameInputs(ListItem(I1:Int), ListItem(I2:Int)) => I1 ==Int I2
  rule sameInputs(ListItem(I1:Int) ListItem(J1:Int),
                  ListItem(I2:Int) ListItem(J2:Int))
    => I1 ==Int I2 andBool J1 ==Int J2
  rule sameInputs(_L1:List, _L2:List) => false [owise]
  rule sameOperation(validatedDeposit(Id1:Int, Owner1:Int, D1:Int, R1:Int, Op1:Int),
                     validatedDeposit(Id2:Int, Owner2:Int, D2:Int, R2:Int, Op2:Int))
    => Id1 ==Int Id2 andBool Owner1 ==Int Owner2 andBool D1 ==Int D2
       andBool R1 ==Int R2 andBool Op1 ==Int Op2
  rule sameOperation(validatedTransfer(Op1:Int, Owner1:Int, Inputs1:List,
                                        Recipient1:Int, T1:Int, NewId1:Int, ChangeId1:Int),
                     validatedTransfer(Op2:Int, Owner2:Int, Inputs2:List,
                                        Recipient2:Int, T2:Int, NewId2:Int, ChangeId2:Int))
    => Op1 ==Int Op2 andBool Owner1 ==Int Owner2
       andBool sameInputs(Inputs1, Inputs2)
       andBool Recipient1 ==Int Recipient2 andBool T1 ==Int T2
       andBool NewId1 ==Int NewId2 andBool ChangeId1 ==Int ChangeId2
  rule sameOperation(validatedWithdraw(Op1:Int, Owner1:Int, Inputs1:List,
                                        W1:Int, Destination1:Int, ChangeId1:Int),
                     validatedWithdraw(Op2:Int, Owner2:Int, Inputs2:List,
                                        W2:Int, Destination2:Int, ChangeId2:Int))
    => Op1 ==Int Op2 andBool Owner1 ==Int Owner2
       andBool sameInputs(Inputs1, Inputs2)
       andBool W1 ==Int W2 andBool Destination1 ==Int Destination2
       andBool ChangeId1 ==Int ChangeId2
  rule sameOperation(_O1:ValidatedOperation, _O2:ValidatedOperation) => false [owise]

  rule validCert(authCert(Issuer:Int, Rule:Int, Owner:Int,
                          BoundId:LogicalId, BoundDomain:Domain,
                          Version:Int, Expiry:Int, Seal:Int),
                 Intent:AuthIntent,
                 authContext(Chain:Int, Pool:Int, ExpectedRule:Int,
                             ExpectedVersion:Int, Now:Int, TrustedIssuer:Int,
                             Registry:List))
    => isAssetOperation(operationOf(Intent))
       andBool hasTrustedCert(authCert(Issuer, Rule, Owner, BoundId, BoundDomain,
                                       Version, Expiry, Seal), Registry)
       andBool Issuer ==Int TrustedIssuer
       andBool Rule ==Int ExpectedRule andBool Rule ==Int 1
       andBool Owner ==Int ownerOfOperation(operationOf(Intent))
       andBool sameDomain(BoundDomain, domain(Chain, Pool))
       andBool sameLogicalId(BoundId, logicalId(Intent, domain(Chain, Pool)))
       andBool Version ==Int ExpectedVersion andBool Version ==Int 1
       andBool Now <=Int Expiry

  rule validate(_St:State, Intent:AuthIntent, Cert:AuthCert,
                authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                            Now:Int, Issuer:Int, Registry:List))
    => checked(operationOf(Intent))
    requires hasTrustedCert(Cert, Registry) andBool
             validCert(Cert, Intent,
                       authContext(Chain, Pool, Rule, Version, Now, Issuer, Registry))

  rule validate(St:State, _Intent:AuthIntent, Cert:AuthCert,
                authContext(_Chain:Int, _Pool:Int, _Rule:Int, _Version:Int,
                            _Now:Int, _Issuer:Int, Registry:List))
    => rejected(St, invalidOperation)
    requires notBool hasTrustedCert(Cert, Registry)

  rule validate(St:State, Intent:AuthIntent, Cert:AuthCert, Ctx:AuthContext)
    => rejected(St, invalidOperation)
    requires notBool validCert(Cert, Intent, Ctx)
endmodule
