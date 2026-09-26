import json
import unittest
from pathlib import Path

from oracle_v3 import (
    P, Q, check_point, commitment, derive_parameters_hash,
    replay_trace, validate_proof_shape, build_cases,
    first_v3_challenge, valid_withdraw_amount,
)


ROOT = Path(__file__).resolve().parents[3]
EXPERIMENT = ROOT / "experiments/design/crypto-profile-v3/exp08"
VECTORS = ROOT / "experiments/design/crypto-profile-v2/vectors.json"


class V3OracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profile = json.loads((EXPERIMENT / "profile.json").read_text())
        cls.parameters = json.loads((EXPERIMENT / "parameters.json").read_text())
        cls.java = json.loads((EXPERIMENT / "java-result.json").read_text())
        cls.vectors = json.loads(VECTORS.read_text())

    def test_role_order_produces_fixed_parameters_hash(self):
        self.assertEqual(derive_parameters_hash(self.vectors),
            "0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae")

    def test_amount_one_without_blinding_has_identity_range_commitment(self):
        value_base = tuple(map(int, self.parameters["base"][:2]))
        blinding_base = tuple(map(int, self.parameters["base"][2:]))
        self.assertEqual(commitment(1, 0, value_base, blinding_base), value_base)
        proof = next(p for p in self.java["proofs"] if p["label"] == "amount-1-blinding-0")
        self.assertEqual(proof["coords"][:2], ["0", "0"])
        self.assertTrue(proof["expectedValid"])

    def test_commitments_match_independent_exp08_values(self):
        value_base = tuple(map(int, self.parameters["base"][:2]))
        blinding_base = tuple(map(int, self.parameters["base"][2:]))
        group = json.loads((ROOT / 'tests/vectors/cases/group.json').read_text())
        for label in ('amount-1-blinding-42', 'amount-max-blinding-42',
                      'amount-1-blinding-0'):
            proof = next(p for p in self.java['proofs'] if p['label'] == label)
            point = commitment(int(proof['originalAmount']),
                               int(proof['testOnlyCommitmentBlinding']),
                               value_base, blinding_base)
            self.assertEqual([str(point[0]), str(point[1])], proof['originalCommitment'])
            case = next(c for c in group if c['id'] == 'VEC-03-COMMITMENT-' + label.upper())
            self.assertEqual(case['expected']['point'], proof['originalCommitment'])

    def test_public_withdraw_bound_is_twice_max_utxo(self):
        max_utxo = 2**64
        max_withdraw = 2**65
        self.assertFalse(valid_withdraw_amount(0))
        self.assertTrue(valid_withdraw_amount(max_utxo))
        self.assertTrue(valid_withdraw_amount(max_withdraw))
        self.assertFalse(valid_withdraw_amount(max_withdraw + 1))
        group = json.loads((ROOT / 'tests/vectors/cases/group.json').read_text())
        by_id = {case['id']: case for case in group}
        self.assertEqual(by_id['VEC-03-WITHDRAW-MAX']['input']['w'], str(max_withdraw))
        self.assertEqual(by_id['VEC-03-WITHDRAW-MAX']['expected']['decision'], 'accept')
        self.assertEqual(by_id['VEC-03-WITHDRAW-OVER-MAX']['expected']['decision'], 'reject')

    def test_point_canonicality_is_separate_from_proof_validity(self):
        self.assertTrue(check_point(0, 0))
        self.assertFalse(check_point(P, 0))
        self.assertFalse(check_point(1, 1))
        self.assertTrue(check_point(1, 2))

    def test_proof_shape_rejects_short_arrays_and_scalar_q(self):
        proof = self.java["proofs"][0]
        self.assertTrue(validate_proof_shape(proof))
        self.assertFalse(validate_proof_shape({**proof, "ls": proof["ls"][:-1]}))
        self.assertFalse(validate_proof_shape({**proof, "scalars": [str(Q), *proof["scalars"][1:]]}))
        self.assertFalse(validate_proof_shape({**proof, "rs": proof["rs"] + ['0']}))

    def test_challenge_rejection_boundaries(self):
        self.assertEqual(first_v3_challenge([0, Q, 2**256-1, 1]), (3, 1))
        self.assertEqual(first_v3_challenge([Q-1]), (0, Q-1))
        with self.assertRaisesRegex(ValueError, '256 candidates exhausted'):
            first_v3_challenge([0] * 256)

    def test_full_prefix_replays_all_challenges(self):
        proof = self.java["proofs"][0]
        trace = replay_trace(proof, self.profile, self.parameters)
        self.assertEqual(len(trace), 11)
        self.assertEqual([stage["stage"] for stage in trace],
            ["y", "z", "x", "u", "inner", "round", "round", "round", "round", "round", "round"])
        self.assertEqual(trace, proof["transcriptTrace"]["stages"])

    def test_mutated_operation_id_changes_first_prefix(self):
        proof = self.java["proofs"][0]
        changed = {**proof, "operationId": "0x" + "ff" * 32}
        with self.assertRaisesRegex(ValueError, "prefix mismatch"):
            replay_trace(changed, self.profile, self.parameters)

    def test_mutated_output_index_changes_prefix(self):
        proof = self.java['proofs'][0]
        with self.assertRaisesRegex(ValueError, "prefix mismatch"):
            replay_trace({**proof, 'outputIndex': '1'}, self.profile, self.parameters)

    def test_all_source_proofs_and_saved_cases_match(self):
        for proof in self.java['proofs']:
            with self.subTest(proof=proof['label']):
                self.assertTrue(validate_proof_shape(proof))
                self.assertEqual(replay_trace(proof, self.profile, self.parameters),
                                 proof['transcriptTrace']['stages'])
                self.assertEqual(proof['expectedValid'], proof['javaVerifierAccepted'])
        for filename, generated in build_cases().items():
            self.assertEqual(generated, json.loads((ROOT / 'tests/vectors/cases' / filename).read_text()))


if __name__ == "__main__":
    unittest.main()
