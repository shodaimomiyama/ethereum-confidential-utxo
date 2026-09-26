"""Check published Pool proofs independently of Solidity and the JS encoder."""
import json
import unittest
from pathlib import Path

from oracle_range_prover import pts, verify
from oracle_v3 import commitment, replay_trace
from oracle_balance import PARAMETERS_HASH, compute_x, verify_case

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / 'experiments/design/crypto-profile-v3/exp08'


class PoolProofCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads((ROOT / 'tests/vectors/cases/pool-operations.json').read_text())
        cls.parameters = json.loads((EXP / 'parameters.json').read_text())
        cls.profile = json.loads((EXP / 'profile.json').read_text())
        cls.h, cls.g, _, _ = pts(cls.parameters)

    def test_every_published_commitment_and_range_proof(self):
        openings = {}
        for case in self.cases:
            with self.subTest(case=case['id']):
                outputs = case['input']['outputs']
                proofs = case['expected']['rangeProofs']
                self.assertEqual(len(proofs), 0 if case['input']['kind'] == 0 else len(outputs))
                balance_input = {
                    'parametersHash': PARAMETERS_HASH,
                    'chainId': case['input']['chainId'], 'pool': case['input']['pool'],
                    'operationId': case['expected']['operationId'],
                    'inputCommitments': [openings[utxo_id]['commitment']
                                         for utxo_id in case['input']['inputIds']],
                    'outputCommitments': [[output['Cx'], output['Cy']] for output in outputs],
                    'd': case['input']['d'], 'w': case['input']['w'],
                    'proof': {'R': [case['expected']['balanceProof']['Rx'],
                                    case['expected']['balanceProof']['Ry']],
                              's': case['expected']['balanceProof']['s']},
                }
                self.assertTrue(verify_case({'input': balance_input}))
                if case['id'] in ('VEC-07-POOL-DEPOSIT-BLIND', 'VEC-07-POOL-TRANSFER-BLIND'):
                    self.assertNotEqual(compute_x(balance_input), (0, 0))
                for index, output in enumerate(outputs):
                    self.assertEqual(commitment(int(output['value']), int(output['blinding']), self.h, self.g),
                                     (int(output['Cx']), int(output['Cy'])))
                    openings[case['expected']['outputIds'][index]] = {
                        'commitment': [output['Cx'], output['Cy']]}
                    if case['input']['kind'] == 0:
                        continue
                    proof = proofs[index]
                    self.assertEqual(proof['operationId'], case['expected']['operationId'])
                    self.assertEqual(int(proof['outputIndex']), index)
                    self.assertTrue(verify(proof, self.parameters, self.profile))
                    self.assertEqual(replay_trace(proof, self.profile, self.parameters),
                                     proof['transcriptTrace']['stages'])

    def test_mutated_proof_fails(self):
        case = next(item for item in self.cases if item['id'] == 'VEC-07-POOL-TRANSFER-FULL')
        proof = json.loads(json.dumps(case['expected']['rangeProofs'][0]))
        proof['scalars'][0] = str(int(proof['scalars'][0]) + 1)
        self.assertFalse(verify(proof, self.parameters, self.profile))


if __name__ == '__main__':
    unittest.main()
