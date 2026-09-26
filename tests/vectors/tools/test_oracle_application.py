import copy
import json
import unittest
from pathlib import Path

from oracle_application import add_range_proofs
from oracle_range_prover import verify, pts
from oracle_v3 import replay_trace, commitment
from oracle_balance import verify_case, challenge_trace, compute_x, PARAMETERS_HASH

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / 'experiments/design/crypto-profile-v3/exp08'


class ApplicationProofTests(unittest.TestCase):
    def test_three_operations_and_two_bound_range_proofs(self):
        saved = json.loads((ROOT / 'tests/vectors/cases/application-operation.json').read_text())
        base = copy.deepcopy(saved)
        transfer = base[1]
        transfer['expected']['rangeProofs'] = []
        transfer['expected']['rangeProofStatus'] = 'pending-v3-two-outputs'
        self.assertEqual(add_range_proofs(base), saved)
        parameters = json.loads((EXP / 'parameters.json').read_text())
        profile = json.loads((EXP / 'profile.json').read_text())
        h, g, _, _ = pts(parameters)
        for case in saved:
            balance = case['expected']['balanceProof']
            balance_input = {
                'parametersHash': PARAMETERS_HASH,
                'chainId': case['input']['chainId'], 'pool': case['input']['pool'],
                'operationId': case['expected']['operationId'],
                'd': case['input']['d'], 'w': case['input']['w'],
                'inputCommitments': [[ctx['Cx'], ctx['Cy']] for ctx in case['expected']['inputContext']],
                'outputCommitments': [[out['Cx'], out['Cy']] for out in case['input']['outputs']],
                'proof': {'R': balance['R'], 's': balance['s']},
            }
            self.assertTrue(verify_case({'input': balance_input}))
            self.assertEqual(list(map(str, compute_x(balance_input))), balance['X'])
            self.assertEqual(challenge_trace(balance_input), balance['challengeTrace'])
            proofs = case['expected']['rangeProofs']
            self.assertEqual(len(proofs), 2 if case['input']['kind'] == 1 else 0)
            for index, proof in enumerate(proofs):
                with self.subTest(case=case['id'], index=index):
                    self.assertEqual(proof['operationId'], case['expected']['operationId'])
                    self.assertEqual(proof['outputIndex'], str(index))
                    opening = case['expected']['receipts'][index]
                    output = case['input']['outputs'][index]
                    self.assertEqual(commitment(int(opening['value']), int(opening['blinding']), h, g),
                                     (int(output['Cx']), int(output['Cy'])))
                    self.assertTrue(verify(proof, parameters, profile))
                    self.assertEqual(replay_trace(proof, profile, parameters),
                                     proof['transcriptTrace']['stages'])
                    self.assertEqual(proof['coords'][:2], ['0', '0'])


if __name__ == '__main__':
    unittest.main()
