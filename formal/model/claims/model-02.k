requires "../operations.k"
module UTXO-MODEL-02
  imports UTXO-OPERATIONS

  claim <k> validate(St:State,
          authIntent(validatedDeposit(Id:Int, Owner:Int, D:Int, D, Op:Int),
                     Packet:Int, 0, Random:Int),
          authCert(Issuer:Int, 1, WrongOwner:Int,
            logicalId(authIntent(validatedDeposit(Id, Owner, D, D, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain, Pool, 1, 1, Now:Int, Issuer, ListItem(authCert(Issuer:Int, 1, WrongOwner:Int,
            logicalId(authIntent(validatedDeposit(Id, Owner, D, D, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int))))
          => rejected(St, invalidOperation) </k>
    requires WrongOwner =/=Int Owner andBool Now <=Int Expiry
    [label(MODEL-02-owner-mismatch-deposit)]

  claim <k> validate(St:State,
          authIntent(validatedDeposit(Id:Int, Owner:Int, D2:Int, D2, Op:Int),
                     Packet:Int, 0, Random:Int),
          authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D1:Int, D1, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain, Pool, 1, 1, Now:Int, Issuer, ListItem(authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D1:Int, D1, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int))))
          => rejected(St, invalidOperation) </k>
    requires D1 =/=Int D2 andBool Now <=Int Expiry
    [label(MODEL-02-deposit-amount-tamper)]

  claim <k> validate(St:State,
          authIntent(validatedTransfer(Op:Int, Owner:Int, ListItem(Input:Int),
                                       Recipient2:Int, T:Int, NewId:Int, ChangeId:Int),
                     Packet:Int, ChangePacket:Int, Random:Int),
          authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedTransfer(Op, Owner, ListItem(Input),
                                                 Recipient1:Int, T, NewId, ChangeId),
                                 Packet, ChangePacket, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain, Pool, 1, 1, Now:Int, Issuer, ListItem(authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedTransfer(Op, Owner, ListItem(Input),
                                                 Recipient1:Int, T, NewId, ChangeId),
                                 Packet, ChangePacket, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int))))
          => rejected(St, invalidOperation) </k>
    requires Recipient1 =/=Int Recipient2 andBool Now <=Int Expiry
    [label(MODEL-02-transfer-recipient-tamper)]

  claim <k> validate(St:State,
          authIntent(validatedWithdraw(Op:Int, Owner:Int, ListItem(Input:Int),
                                       W:Int, Destination2:Int, ChangeId:Int),
                     0, ChangePacket:Int, Random:Int),
          authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedWithdraw(Op, Owner, ListItem(Input),
                                                 W, Destination1:Int, ChangeId),
                                 0, ChangePacket, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain, Pool, 1, 1, Now:Int, Issuer, ListItem(authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedWithdraw(Op, Owner, ListItem(Input),
                                                 W, Destination1:Int, ChangeId),
                                 0, ChangePacket, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int))))
          => rejected(St, invalidOperation) </k>
    requires Destination1 =/=Int Destination2 andBool Now <=Int Expiry
    [label(MODEL-02-withdraw-destination-tamper)]

  claim <k> validate(St:State, Intent:AuthIntent, Cert:AuthCert,
          authContext(Chain:Int, Pool:Int, Rule:Int, Version:Int,
                      Now:Int, Issuer:Int, .List))
          => rejected(St, invalidOperation) </k>
    requires notBool hasTrustedCert(Cert, .List)
    [label(MODEL-02-untrusted-certificate)]

  claim <k> validate(St:State,
          authIntent(validatedDeposit(Id:Int, Owner:Int, D:Int, D, Op:Int),
                     Packet:Int, 0, Random:Int),
          authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D, D, Op),
                                 Packet, 0, Random), domain(OtherChain:Int, Pool:Int)),
            domain(OtherChain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain:Int, Pool, 1, 1, Now:Int, Issuer, ListItem(authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D, D, Op),
                                 Packet, 0, Random), domain(OtherChain:Int, Pool:Int)),
            domain(OtherChain, Pool), 1, Expiry:Int, Seal:Int))))
          => rejected(St, invalidOperation) </k>
    requires Chain =/=Int OtherChain andBool Now <=Int Expiry
    [label(MODEL-02-cross-chain-rejected)]

  claim <k> validate(St:State,
          authIntent(validatedDeposit(Id:Int, Owner:Int, D:Int, D, Op:Int),
                     Packet:Int, 0, Random:Int),
          authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D, D, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain, Pool, 1, 1, Now:Int, Issuer, ListItem(authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D, D, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int))))
          => rejected(St, invalidOperation) </k>
    requires Now >Int Expiry
    [label(MODEL-02-expired-certificate)]

  claim <k> validate(St:State,
          authIntent(validatedDeposit(Id:Int, Owner:Int, D2:Int, D2, Op:Int),
                     Packet:Int, 0, Random:Int),
          authCert(Issuer:Int, 1, Owner,
            logicalId(authIntent(validatedDeposit(Id, Owner, D2, D2, Op),
                                 Packet, 0, Random), domain(Chain:Int, Pool:Int)),
            domain(Chain, Pool), 1, Expiry:Int, Seal:Int),
          authContext(Chain, Pool, 1, 1, Now:Int, Issuer,
            ListItem(authCert(Issuer, 1, Owner,
              logicalId(authIntent(validatedDeposit(Id, Owner, D1:Int, D1, Op),
                                   Packet, 0, Random), domain(Chain, Pool)),
              domain(Chain, Pool), 1, Expiry, Seal))))
          => rejected(St, invalidOperation) </k>
    requires D1 =/=Int D2 andBool Now <=Int Expiry
    [label(MODEL-02-forged-certificate-reusing-seal)]
endmodule
