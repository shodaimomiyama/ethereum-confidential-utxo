module MODEL-SMOKE
  imports INT
  syntax Exp ::= "tick" Int
  configuration <k> $PGM:Exp </k>
  rule <k> tick I:Int => I +Int 1 </k>
endmodule
