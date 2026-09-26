"""Independent boundary and fixture checks for the test-only balance oracle."""

import copy
import json
import unittest
from pathlib import Path

from reference_bn254 import IDENTITY, Q

from oracle_balance import (
    case_input,
    challenge_trace,
    first_challenge,
    make_case,
    verify_case,
)


ROOT = Path(__file__).resolve().parents[1]


class BalanceOracleTests(unittest.TestCase):
    def test_sampling_predicate(self):
        self.assertEqual(first_challenge([0, Q, 2**256 - 1, 1]), (3, 1))
        self.assertEqual(first_challenge([Q - 1]), (0, Q - 1))
        with self.assertRaisesRegex(ValueError, "256 candidates exhausted"):
            first_challenge([0] * 256)
        with self.assertRaisesRegex(ValueError, "256 candidates exhausted"):
            first_challenge([0] * 257)
        with self.assertRaisesRegex(ValueError, "balance nonce"):
            case_input("0x" + "11" * 32, [], [], 0, 0, 0)

    def test_valid_shapes_and_identity(self):
        cases = json.loads((ROOT / "cases/balance.json").read_text())
        valid = [c for c in cases if c["stage"] == "balance-proof"
                 and c["expected"]["decision"] == "accept"]
        self.assertEqual(len(valid), 5)
        for case in valid:
            with self.subTest(case=case["id"]):
                self.assertTrue(verify_case(case))
                self.assertEqual(make_case(case["input"])["expected"], case["expected"])
                trace = challenge_trace(case["input"])
                self.assertEqual(trace, case["expected"]["challengeTrace"])
        self.assertEqual(valid[2]["expected"]["X"], ["0", "0"])
        self.assertEqual(valid[0]["expected"]["challenge"],
                         "16130861187030484838142481811980187392293531597947394434271712416364639034358")

    def test_invalid_proof_and_context(self):
        cases = json.loads((ROOT / "cases/balance.json").read_text())
        invalid = [c for c in cases if c["stage"] == "balance-proof"
                   and c["expected"]["decision"] == "reject"]
        self.assertGreaterEqual(len(invalid), 6)
        for case in invalid:
            with self.subTest(case=case["id"]):
                self.assertFalse(verify_case(case))
        base = copy.deepcopy(next(c for c in cases if c["id"] == "VEC-05-DEPOSIT"))
        base["input"]["proof"]["R"] = ["0", "0"]
        self.assertFalse(verify_case(base))
        base = copy.deepcopy(next(c for c in cases if c["id"] == "VEC-05-DEPOSIT"))
        base["input"]["proof"]["s"] = str(Q)
        self.assertFalse(verify_case(base))
        base = copy.deepcopy(next(c for c in cases if c["id"] == "VEC-05-DEPOSIT"))
        base["input"]["parametersHash"] = "0x" + "00" * 32
        self.assertFalse(verify_case(base))

    def test_predicate_fixture(self):
        cases = json.loads((ROOT / "cases/balance.json").read_text())
        for case in cases:
            if case["stage"] != "challenge-predicate":
                continue
            with self.subTest(case=case["id"]):
                if case["expected"]["decision"] == "reject":
                    with self.assertRaisesRegex(ValueError, "256 candidates exhausted"):
                        first_challenge([int(case["input"]["candidateRepeated"])]
                                        * int(case["input"]["count"]))
                else:
                    counter, challenge = first_challenge(
                        [int(value) for value in case["input"]["candidates"]])
                    self.assertEqual((str(counter), str(challenge)),
                                     (case["expected"]["counter"],
                                      case["expected"]["challenge"]))


if __name__ == "__main__":
    unittest.main()
