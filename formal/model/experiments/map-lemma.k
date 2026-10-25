requires "../paths.k"
requires "domains.md"
module UTXO-MAP-LEMMA-EXPERIMENT
  imports UTXO-PATHS
  imports MAP-SYMBOLIC
  imports SET-SYMBOLIC

  claim <k> assertIntEqual(
          sumActive(U:Map [ Id:Int <- utxo(_Owner:Int, D:Int) ], S:Set),
          D +Int sumActive(U, S))
        => accepted(initial(0)) </k>
    requires notBool (Id in_keys(U)) andBool notBool (Id in S)
    [label(MAP-fresh-add)]

  claim <k> assertIntEqual(
          sumActive((1 |-> utxo(_Owner:Int, _V:Int)) Rest:Map,
                    S:Set SetItem(1)),
          sumActive(Rest, S))
        => accepted(initial(0)) </k>
    requires notBool (1 in_keys(Rest)) andBool notBool (1 in S)
    [label(MAP-spend-one)]
endmodule
