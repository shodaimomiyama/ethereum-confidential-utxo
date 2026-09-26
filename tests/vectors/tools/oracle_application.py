"""Bind deterministic v3 range proofs to the HPKE application operation fixture."""
import argparse
import copy
import hashlib
import json
from pathlib import Path

from oracle_range_prover import prove, verify
from oracle_v3 import Q, commitment, replay_trace
from oracle_range_prover import pts

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / 'experiments/design/crypto-profile-v3/exp08'


def add_range_proofs(base):
    cases = copy.deepcopy(base)
    parameters = json.loads((EXP / 'parameters.json').read_text())
    profile = json.loads((EXP / 'profile.json').read_text())
    h, g, _, _ = pts(parameters)
    for case in cases:
        expected = case['expected']
        if case['id'] != 'VEC-07-APPLICATION-TRANSFER-CHANGE':
            if expected['rangeProofs']:
                raise ValueError('unexpected base range proof')
            continue
        proofs = []
        for index, (receipt, output) in enumerate(zip(expected['receipts'], case['input']['outputs'])):
            value = int(receipt['value'])
            blind = int(receipt['blinding'])
            if not 1 <= value <= 2**64 or not 0 <= blind < Q:
                raise ValueError('invalid receipt opening')
            if commitment(value, blind, h, g) != (int(output['Cx']), int(output['Cy'])):
                raise ValueError('receipt commitment mismatch')
            seed = hashlib.sha256(b'ecu/test/v3/application-transfer/' + bytes([index])).digest()
            proof = prove(value, blind, bytes.fromhex(expected['operationId'][2:]),
                          index, seed, parameters, profile)
            if not verify(proof, parameters, profile):
                raise ValueError('new proof failed v3 equations')
            if replay_trace(proof, profile, parameters) != proof['transcriptTrace']['stages']:
                raise ValueError('new proof transcript mismatch')
            if tuple(map(int, proof['coords'][:2])) != (0, 0):
                raise ValueError('expected valid identity range commitment')
            proofs.append(proof)
        expected['rangeProofs'] = proofs
        expected['rangeProofStatus'] = 'valid-v3-two-outputs'
    return cases


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--in-base', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.resolve() == (ROOT / 'tests/vectors/cases/application-operation.json').resolve():
        raise SystemExit('choose separate output file')
    cases = add_range_proofs(json.loads(args.in_base.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(cases, indent=2, ensure_ascii=False) + '\n')
