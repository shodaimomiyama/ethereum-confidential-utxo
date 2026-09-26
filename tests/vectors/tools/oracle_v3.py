"""Independent, test-only EXP-08 v3 transcript and BN254 boundary oracle."""
import argparse
import hashlib
import json
from pathlib import Path

from Crypto.Hash import keccak
from reference_bn254 import P, Q, IDENTITY, check_point, add, multiply

ROOT = Path(__file__).resolve().parents[3]
EXP08 = ROOT / 'experiments/design/crypto-profile-v3/exp08'
EXP07 = ROOT / 'experiments/design/crypto-profile-v2/vectors.json'


def k256(data):
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def tag(label):
    return k256(label.encode('utf-8'))


def word(value):
    return int(value).to_bytes(32, 'big')


def point(x, y):
    return word(x) + word(y)


def commitment(value, blinding, value_base, blinding_base):
    if not 0 <= value <= 2**64 or not 0 <= blinding < Q:
        raise ValueError('amount or blinding out of range')
    return add(multiply(value_base, value), multiply(blinding_base, blinding))


def valid_withdraw_amount(value):
    """Public w may spend both maximum-value inputs, unlike one UTXO amount."""
    return 1 <= value <= 2**65


def derive_parameters_hash(vectors):
    by_role = {(v['role'], v['index']): v for v in vectors['generators']}
    ordered = [by_role['valueBase', 0], by_role['blindingBase', 0]]
    ordered += [by_role['vectorG', i] for i in range(64)]
    ordered += [by_role['vectorH', i] for i in range(64)]
    packed = b''.join(point(int(v['xHex'], 16), int(v['yHex'], 16)) for v in ordered)
    return '0x' + k256(tag('ecu/bp/parameters/v3') + word(64) + packed).hex()


def validate_proof_shape(proof):
    if len(proof.get('coords', [])) != 10 or len(proof.get('scalars', [])) != 5:
        return False
    if len(proof.get('ls', [])) != 12 or len(proof.get('rs', [])) != 12:
        return False
    try:
        coords = [int(v) for v in proof['coords']]
        scalars = [int(v) for v in proof['scalars']]
        ls = [int(v) for v in proof['ls']]
        rs = [int(v) for v in proof['rs']]
    except (ValueError, TypeError):
        return False
    return (all(check_point(*coords[i:i+2]) for i in range(0, 10, 2))
            and all(0 <= x < Q for x in scalars)
            and all(check_point(ls[i], ls[i+6]) for i in range(6))
            and all(check_point(rs[i], rs[i+6]) for i in range(6)))


def first_v3_challenge(candidates):
    for counter, candidate in enumerate(candidates[:256]):
        if 0 < candidate < Q:
            return counter, candidate
    raise ValueError('256 candidates exhausted')


def replay_trace(proof, profile, parameters):
    tags = profile['tags']
    coords = list(map(int, proof['coords']))
    prefix = (tag(tags['protocol']) + word(64) + word(1)
              + bytes.fromhex(profile['expectedParametersHash'][2:])
              + bytes.fromhex(proof['operationId'][2:])
              + tag(tags['role']) + word(proof['outputIndex'])
              + point(*coords[:2]))
    recorded = proof['transcriptTrace']
    if '0x' + k256(prefix).hex() != recorded['initialState']:
        raise ValueError('initial prefix mismatch')
    stages = []
    for old in recorded['stages']:
        name = old['stage']
        if name == 'y':
            payload = b''.join(word(x) for x in coords[2:6])
        elif name == 'z':
            payload = b''
        elif name == 'x':
            payload = b''.join(word(x) for x in coords[6:10])
        elif name == 'u':
            payload = b''.join(word(x) for x in proof['scalars'][:3])
        elif name == 'inner':
            payload = word(64) + point(*old['P']) + point(*old['uPoint'])
        elif name == 'round':
            i = old['roundIndex']
            ls = list(map(int, proof['ls']))
            rs = list(map(int, proof['rs']))
            payload = word(i) + point(ls[i], ls[i+6]) + point(rs[i], rs[i+6])
        else:
            raise ValueError('unknown transcript stage')
        segment = tag(tags[name]) + word(len(payload)) + payload
        actual = {'stage': name, 'previousState': '0x' + k256(prefix).hex(),
                  'payloadHex': '0x' + payload.hex()}
        if name != 'inner':
            actual['inputState'] = '0x' + k256(prefix + segment).hex()
            candidates = []
            for counter in range(256):
                candidate = k256(prefix + segment + tag(tags['candidate']) + word(counter))
                candidates.append('0x' + candidate.hex())
                c = int.from_bytes(candidate, 'big')
                if 0 < c < Q:
                    break
            else:
                raise ValueError('256 candidates exhausted')
            actual.update(counter=counter, candidates=candidates, challenge=str(c))
            prefix += segment + tag(tags['accepted']) + word(c)
        else:
            prefix += segment
        actual['nextState'] = '0x' + k256(prefix).hex()
        if name == 'inner':
            actual['P'] = old['P']
            actual['uPoint'] = old['uPoint']
        if name == 'round':
            actual['roundIndex'] = old['roundIndex']
        stages.append(actual)
    if '0x' + k256(prefix).hex() != recorded['finalState']:
        raise ValueError('final prefix mismatch')
    return stages


def read_evidence():
    vectors = json.loads(EXP07.read_text())
    profile = json.loads((EXP08 / 'profile.json').read_text())
    parameters = json.loads((EXP08 / 'parameters.json').read_text())
    java = json.loads((EXP08 / 'java-result.json').read_text())
    assert derive_parameters_hash(vectors) == profile['expectedParametersHash']
    return vectors, profile, parameters, java


def build_cases():
    vectors, profile, parameters, java = read_evidence()
    ordered = {(v['role'], v['index']): v for v in vectors['generators']}
    group = [{
        'id': 'VEC-03-PARAMETERS-HASH', 'profile': 'bn254-v3',
        'source': 'EXP-07A vectors.json and EXP-08 profile.json',
        'stage': 'generator-derivation',
        'input': {'order': ['valueBase', 'blindingBase', 'vectorG[0..63]', 'vectorH[0..63]'],
                  'sourceSha256': hashlib.sha256(EXP07.read_bytes()).hexdigest()},
        'expected': {'parametersHash': derive_parameters_hash(vectors), 'generatorCount': '130',
                     'valueBase': [ordered['valueBase', 0]['xHex'], ordered['valueBase', 0]['yHex']],
                     'blindingBase': [ordered['blindingBase', 0]['xHex'], ordered['blindingBase', 0]['yHex']]},
        'oracle': 'tools/oracle_v3.py#derive_parameters_hash', 'consumers': ['#26', '#27', '#28']
    }]
    boundaries = [
        ('IDENTITY', {'point': ['0', '0']}, 'accept'),
        ('X-EQUAL-P', {'point': [str(P), '0']}, 'reject'),
        ('OFF-CURVE', {'point': ['1', '1']}, 'reject'),
        ('CANONICAL-G1', {'point': ['1', '2']}, 'accept'),
        ('BLINDING-Q', {'blinding': str(Q)}, 'reject'),
        ('BLINDING-Q-MINUS-ONE', {'blinding': str(Q-1)}, 'accept'),
        ('AMOUNT-ZERO', {'amount': '0'}, 'reject'),
        ('AMOUNT-ONE', {'amount': '1'}, 'accept'),
        ('AMOUNT-MAX', {'amount': str(2**64)}, 'accept'),
        ('AMOUNT-OVER-MAX', {'amount': str(2**64+1)}, 'reject'),
        ('CHALLENGE-ZERO', {'candidate': '0'}, 'reject'),
        ('CHALLENGE-Q', {'candidate': str(Q)}, 'reject'),
        ('CHALLENGE-MAX', {'candidate': str(2**256-1)}, 'reject'),
        ('CHALLENGE-ONE', {'candidate': '1'}, 'accept'),
        ('CHALLENGE-Q-MINUS-ONE', {'candidate': str(Q-1)}, 'accept'),
        ('CHALLENGE-EXHAUSTED', {'candidates': ['0']*256}, 'reject'),
    ]
    for name, value, decision in boundaries:
        group.append({'id': 'VEC-03-' + name, 'profile': 'bn254-v3',
                      'source': 'docs/design.md#範囲証明', 'stage': 'group-boundary',
                      'input': value, 'expected': {'decision': decision},
                      'oracle': 'tools/oracle_v3.py', 'consumers': ['#26', '#27', '#28']})
    value_base = tuple(map(int, parameters['base'][:2]))
    blinding_base = tuple(map(int, parameters['base'][2:]))
    for label in ('amount-1-blinding-42', 'amount-max-blinding-42',
                  'amount-1-blinding-0'):
        proof = next(p for p in java['proofs'] if p['label'] == label)
        amount = int(proof['originalAmount'])
        blinding = int(proof['testOnlyCommitmentBlinding'])
        derived = commitment(amount, blinding, value_base, blinding_base)
        recorded = proof['originalCommitment']
        if [str(derived[0]), str(derived[1])] != recorded:
            raise ValueError('EXP-08 originalCommitment mismatch: ' + label)
        group.append({'id': 'VEC-03-COMMITMENT-' + label.upper(),
                      'profile': 'bn254-v3',
                      'source': 'EXP-08 java-result.json#proofs/' + label,
                      'stage': 'commitment',
                      'input': {'amount': str(amount), 'blinding': str(blinding),
                                'valueBase': [str(x) for x in value_base],
                                'blindingBase': [str(x) for x in blinding_base]},
                      'expected': {'point': recorded, 'decision': 'accept'},
                      'oracle': 'tools/oracle_v3.py#commitment; independent EXP-08 originalCommitment',
                      'consumers': ['#26', '#27', '#28']})
    for name, amount in [('ZERO', 0), ('UTXO-MAX', 2**64),
                         ('MAX', 2**65), ('OVER-MAX', 2**65+1)]:
        group.append({'id': 'VEC-03-WITHDRAW-' + name, 'profile': 'bn254-v3',
                      'source': 'docs/design.md#d-06-入力数と公開出金額の上限',
                      'stage': 'public-withdraw-boundary',
                      'input': {'w': str(amount)},
                      'expected': {'decision': 'accept' if valid_withdraw_amount(amount) else 'reject'},
                      'oracle': 'tools/oracle_v3.py#valid_withdraw_amount',
                      'consumers': ['#27', '#28']})
    cases = []
    labels = [('amount-1-blinding-42', 'VALID-MIN'),
              ('amount-max-blinding-42', 'VALID-MAX'),
              ('amount-1-blinding-0', 'VALID-IDENTITY'),
              ('amount-over-max', 'INVALID-OVER-MAX')]
    for label, suffix in labels:
        proof = next(p for p in java['proofs'] if p['label'] == label)
        assert validate_proof_shape(proof)
        assert replay_trace(proof, profile, parameters) == proof['transcriptTrace']['stages']
        cases.append({'id': 'VEC-04-' + suffix, 'profile': 'range-bp-v3',
                      'source': 'EXP-08 java-result.json, Java and EVM verifier results',
                      'stage': 'range-proof',
                      'input': {'operationId': proof['operationId'], 'outputIndex': proof['outputIndex'],
                                'originalAmount': proof['originalAmount'],
                                'originalCommitment': proof['originalCommitment'],
                                'coords': proof['coords'], 'scalars': proof['scalars'],
                                'ls': proof['ls'], 'rs': proof['rs']},
                      'expected': {'decision': 'accept' if proof['expectedValid'] else 'reject',
                                   'verifierReason': proof['javaVerifierReason'],
                                   'parametersHash': proof['parametersHash'],
                                   'initialState': proof['transcriptTrace']['initialState'],
                                   'stages': proof['transcriptTrace']['stages'],
                                   'finalState': proof['transcriptTrace']['finalState']},
                      'oracle': 'tools/oracle_v3.py#replay_trace',
                      'consumers': ['#28', '#27']})
    base = cases[0]['id']
    for name, field, new, stage in [
        ('OPERATION-ID-CHANGED', 'operationId', '0x' + 'ff'*32, 'transcript'),
        ('OUTPUT-INDEX-CHANGED', 'outputIndex', '1', 'transcript'),
        ('SHORT-L', 'ls', cases[0]['input']['ls'][:-1], 'proof-shape'),
        ('SCALAR-Q', 'scalars', [str(Q)] + cases[0]['input']['scalars'][1:], 'proof-shape'),
        ('PROOF-POINT-IDENTITY', 'coords', cases[0]['input']['coords'][:2] + ['0', '0'] + cases[0]['input']['coords'][4:], 'proof-equation'),
    ]:
        cases.append({'id': 'VEC-04-' + name, 'profile': 'range-bp-v3',
                      'source': 'EXP-08 java-result.json mutation of ' + base,
                      'stage': stage, 'input': {field: new},
                      'expected': {'decision': 'reject'},
                      'oracle': 'tools/oracle_v3.py', 'consumers': ['#28', '#27'],
                      'baseCase': base, 'mutatedField': field})
    return {'group.json': group, 'range-v3.json': cases}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.resolve() == (ROOT / 'tests/vectors/cases').resolve():
        raise SystemExit('refusing to overwrite checked-in fixtures; choose a separate --out')
    generated = build_cases()
    args.out.mkdir(parents=True, exist_ok=True)
    for filename, cases in generated.items():
        (args.out / filename).write_text(json.dumps(cases, indent=2, ensure_ascii=False) + '\n')
    print(f"Checked 4 EXP-08 proofs and wrote {sum(map(len, generated.values()))} cases")
