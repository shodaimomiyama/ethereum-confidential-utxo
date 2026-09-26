import json
import unittest
from pathlib import Path

from oracle_range_prover import prove, verify, build_deterministic_case
from oracle_v3 import replay_trace

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / 'experiments/design/crypto-profile-v3/exp08'


class DeterministicRangeProverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parameters = json.loads((EXP / 'parameters.json').read_text())
        cls.profile = json.loads((EXP / 'profile.json').read_text())
        cls.legacy = json.loads((EXP / 'java-result.json').read_text())

    def test_legacy_valid_and_invalid_proofs(self):
        for proof in self.legacy['proofs']:
            with self.subTest(proof=proof['label']):
                self.assertEqual(verify(proof, self.parameters, self.profile), proof['expectedValid'])

    def test_deterministic_minimum_and_maximum_with_identity(self):
        for value, blinding in ((1, 0), (1, 42), (2**64, 42)):
            with self.subTest(value=value, blinding=blinding):
                proof = prove(value, blinding, bytes.fromhex('66'*32), 0,
                              bytes.fromhex('12'*32), self.parameters, self.profile)
                self.assertTrue(verify(proof, self.parameters, self.profile))
                self.assertEqual(replay_trace(proof, self.profile, self.parameters),
                                 proof['transcriptTrace']['stages'])
                again = prove(value, blinding, bytes.fromhex('66'*32), 0,
                              bytes.fromhex('12'*32), self.parameters, self.profile)
                self.assertEqual(proof, again)

    def test_operation_binding(self):
        proof = prove(3, 5, bytes.fromhex('66'*32), 0,
                      bytes.fromhex('12'*32), self.parameters, self.profile)
        self.assertFalse(verify({**proof, 'operationId': '0x' + '77'*32}, self.parameters, self.profile))

    def test_saved_new_proof_reproduces_exact_bytes(self):
        saved = json.loads((ROOT / 'tests/vectors/cases/range-deterministic.json').read_text())[0]
        self.assertEqual(build_deterministic_case(self.parameters, self.profile), saved)
        proof = saved['input']
        self.assertTrue(verify(proof, self.parameters, self.profile))
        self.assertEqual(replay_trace(proof, self.profile, self.parameters),
                         proof['transcriptTrace']['stages'])


if __name__ == '__main__':
    unittest.main()
