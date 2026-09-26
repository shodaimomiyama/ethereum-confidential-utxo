"""Public-value, deterministic Pool operation scenarios for contract tests."""
import hashlib
import json
from pathlib import Path

from oracle_range_prover import pts
from oracle_v3 import commitment

ROOT = Path(__file__).resolve().parents[3]
PARAMETERS = ROOT / 'experiments/design/crypto-profile-v3/exp08/parameters.json'
M = 2**64


def packet(name, index):
    seed = hashlib.sha256(f'ecu/pool-fixture/{name}/{index}'.encode()).digest()
    return '0x' + (seed * 4)[:112].hex()


def make_base():
    h, g, _, _ = pts(json.loads(PARAMETERS.read_text()))
    specs = [
        ('DEPOSIT-TEN', 0, [], [('A', 10)], 10, 0, 'ZERO'),
        ('DEPOSIT-TWO', 0, [], [('A', 2)], 2, 0, 'ZERO'),
        ('DEPOSIT-THREE', 0, [], [('A', 3)], 3, 0, 'ZERO'),
        ('DEPOSIT-MAX-A', 0, [], [('A', M)], M, 0, 'ZERO'),
        ('DEPOSIT-MAX-B', 0, [], [('A', M)], M, 0, 'ZERO'),
        ('TRANSFER-FULL', 1, ['DEPOSIT-TEN:0'], [('B', 10)], 0, 0, 'ZERO'),
        ('TRANSFER-PARTIAL', 1, ['DEPOSIT-TEN:0'], [('B', 3), ('A', 7)], 0, 0, 'ZERO'),
        ('CONSOLIDATE', 1, ['DEPOSIT-TWO:0', 'DEPOSIT-THREE:0'], [('B', 4), ('A', 1)], 0, 0, 'ZERO'),
        ('WITHDRAW-FULL', 2, ['DEPOSIT-TEN:0'], [], 0, 10, 'RECIPIENT'),
        ('WITHDRAW-PARTIAL', 2, ['DEPOSIT-TEN:0'], [('A', 7)], 0, 3, 'RECIPIENT'),
        ('SELF-MERGE', 1, ['DEPOSIT-TWO:0', 'DEPOSIT-THREE:0'], [('A', 5)], 0, 0, 'ZERO'),
        ('SELF-SPLIT', 1, ['DEPOSIT-TEN:0'], [('A', 3), ('A', 7)], 0, 0, 'ZERO'),
        ('RECREATE', 1, ['DEPOSIT-TEN:0'], [('A', 10)], 0, 0, 'ZERO'),
        ('TWO-MAX-OUTPUTS', 1, ['DEPOSIT-MAX-A:0', 'DEPOSIT-MAX-B:0'], [('A', M), ('A', M)], 0, 0, 'ZERO'),
        ('WITHDRAW-MAX', 2, ['DEPOSIT-MAX-A:0', 'DEPOSIT-MAX-B:0'], [], 0, 2*M, 'RECIPIENT'),
        ('WITHDRAW-CALLBACK-FULL', 2, ['DEPOSIT-TEN:0'], [], 0, 10, 'CALLBACK'),
        ('WITHDRAW-SELF', 2, ['DEPOSIT-TEN:0'], [], 0, 10, 'POOL'),
        ('RECIPIENT-REUSE', 1, ['TRANSFER-FULL:0'], [('A', 10)], 0, 0, 'ZERO'),
        ('DEPOSIT-BLIND', 0, [], [('A', 1)], 1, 0, 'ZERO'),
        ('TRANSFER-BLIND', 1, ['DEPOSIT-BLIND:0'], [('A', 1)], 0, 0, 'ZERO'),
        ('TRANSFER-CHANGE-REUSE', 1, ['TRANSFER-PARTIAL:1'], [('A', 7)], 0, 0, 'ZERO'),
        ('WITHDRAW-REMAINDER-REUSE', 1, ['WITHDRAW-PARTIAL:0'], [('A', 7)], 0, 0, 'ZERO'),
        ('RECIPIENT-PARTIAL-REUSE', 1, ['TRANSFER-PARTIAL:0'], [('B', 3)], 0, 0, 'ZERO'),
        ('DEPOSIT-TEN-ALT', 0, [], [('A', 10)], 10, 0, 'ZERO'),
        ('WITHDRAW-OWNER', 2, ['DEPOSIT-TEN:0'], [], 0, 10, 'OWNER'),
    ]
    result = []
    for name, kind, inputs, outputs, d, w, destination in specs:
        out = []
        for index, (owner, value) in enumerate(outputs):
            blind = 3 if name == 'DEPOSIT-BLIND' else 1 if name == 'TRANSFER-BLIND' else 0
            cx, cy = commitment(value, blind, h, g)
            out.append({'ownerSymbol': owner, 'value': str(value), 'blinding': str(blind),
                        'Cx': str(cx), 'Cy': str(cy),
                        'receiptFormat': 1, 'packet': packet(name, index)})
        result.append({'name': name, 'kind': kind,
                       'ownerSymbol': 'B' if name in ('RECIPIENT-REUSE', 'RECIPIENT-PARTIAL-REUSE') else 'A', 'inputs': inputs,
                       'outputs': out, 'd': str(d), 'w': str(w), 'destinationSymbol': destination})
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.resolve() == (ROOT / 'tests/vectors/cases/pool-operations.json').resolve():
        raise SystemExit('generate through the full Pool fixture pipeline')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(make_base(), indent=2) + '\n')
