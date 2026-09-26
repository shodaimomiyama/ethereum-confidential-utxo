"""Attach independently checked v3 proofs to fixed public Pool cases."""
import argparse
import hashlib
import json
from pathlib import Path

from oracle_range_prover import prove, pts, verify
from oracle_v3 import commitment, replay_trace
from oracle_balance import case_input, verify_case

ROOT = Path(__file__).resolve().parents[3]
EXP = ROOT / 'experiments/design/crypto-profile-v3/exp08'


def add_proofs(base):
    parameters = json.loads((EXP / 'parameters.json').read_text())
    profile = json.loads((EXP / 'profile.json').read_text())
    h, g, _, _ = pts(parameters)
    openings = {}
    for case in base:
        proofs = []
        incoming = [openings[utxo_id] for utxo_id in case['input']['inputIds']]
        outgoing = [(int(output['value']), int(output['blinding']))
                    for output in case['input']['outputs']]
        balance = case_input(case['expected']['operationId'], incoming, outgoing,
                             int(case['input']['d']), int(case['input']['w']), 1)
        if not verify_case({'input': balance}):
            raise ValueError(f"bad balance proof in {case['id']}")
        case['expected']['balanceProof'] = {
            'Rx': balance['proof']['R'][0], 'Ry': balance['proof']['R'][1],
            's': balance['proof']['s']}
        for index, output in enumerate(case['input']['outputs']):
            value = int(output['value'])
            blind = int(output['blinding'])
            if commitment(value, blind, h, g) != (int(output['Cx']), int(output['Cy'])):
                raise ValueError(f"bad commitment in {case['id']} output {index}")
            if case['input']['kind'] == 0:
                continue
            seed = hashlib.sha256(f"ecu/test/pool/{case['id']}/{index}".encode()).digest()
            proof = prove(value, blind, bytes.fromhex(case['expected']['operationId'][2:]),
                          index, seed, parameters, profile)
            if not verify(proof, parameters, profile):
                raise ValueError(f"bad v3 proof in {case['id']} output {index}")
            if replay_trace(proof, profile, parameters) != proof['transcriptTrace']['stages']:
                raise ValueError(f"bad transcript in {case['id']} output {index}")
            proofs.append(proof)
        for index, output_id in enumerate(case['expected']['outputIds']):
            openings[output_id] = outgoing[index]
        case['expected']['rangeProofs'] = proofs
    return base


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--in-base', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.resolve() == (ROOT / 'tests/vectors/cases/pool-operations.json').resolve():
        raise SystemExit('choose a temporary output file')
    result = add_proofs(json.loads(args.in_base.read_text()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
