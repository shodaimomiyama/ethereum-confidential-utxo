"""Deterministic test-only v3 range prover and independent equation verifier.

The scalar stream is SHA-256(seed || uint256(counter)), rejected unless < q.
Its seed is public test material; it must never be used in an application prover.
"""
import hashlib
import argparse
import json
from pathlib import Path

from oracle_v3 import Q, check_point, commitment, k256, point, tag, word
from reference_bn254 import IDENTITY, add, multiply, negate

N = 64


def pts(parameters):
    def unpack(values):
        return [(int(values[i]), int(values[i+N])) for i in range(N)]
    base = list(map(int, parameters['base']))
    return (tuple(base[:2]), tuple(base[2:]), unpack(parameters['gs']), unpack(parameters['hs']))


def suma(*points):
    result = IDENTITY
    for item in points:
        result = add(result, item)
    return result


def dot(left, right):
    return sum(a*b for a, b in zip(left, right)) % Q


def multi(points, scalars):
    return suma(*(multiply(p, s) for p, s in zip(points, scalars)))


def coords(points):
    return [str(v) for p in points for v in p]


def columns(points):
    return [str(p[0]) for p in points] + [str(p[1]) for p in points]


class ScalarTape:
    def __init__(self, seed):
        if len(seed) != 32:
            raise ValueError('seed must be 32 bytes')
        self.seed = seed
        self.counter = 0
        self.accepted = []

    def next(self):
        for _ in range(256):
            candidate = int.from_bytes(hashlib.sha256(self.seed + word(self.counter)).digest(), 'big')
            self.counter += 1
            if candidate < Q:
                self.accepted.append(str(candidate))
                return candidate
        raise ValueError('256 scalar candidates exhausted')


class Transcript:
    def __init__(self, operation_id, output_index, range_commitment, profile):
        tags = profile['tags']
        self.tags = tags
        self.prefix = (tag(tags['protocol']) + word(64) + word(1)
            + bytes.fromhex(profile['expectedParametersHash'][2:])
            + operation_id + tag(tags['role']) + word(output_index)
            + point(*range_commitment))
        self.trace = {'initialState': '0x' + k256(self.prefix).hex(), 'stages': []}

    def challenge(self, name, payload, round_index=None):
        old = self.prefix
        segment = tag(self.tags[name]) + word(len(payload)) + payload
        candidates = []
        for counter in range(256):
            candidate = k256(old + segment + tag(self.tags['candidate']) + word(counter))
            candidates.append('0x' + candidate.hex())
            number = int.from_bytes(candidate, 'big')
            if 0 < number < Q:
                break
        else:
            raise ValueError('256 challenges exhausted')
        self.prefix += segment + tag(self.tags['accepted']) + word(number)
        step = {'stage': name, 'previousState': '0x' + k256(old).hex(),
                'payloadHex': '0x' + payload.hex(),
                'inputState': '0x' + k256(old + segment).hex(),
                'counter': counter, 'candidates': candidates,
                'challenge': str(number), 'nextState': '0x' + k256(self.prefix).hex()}
        if round_index is not None:
            step['roundIndex'] = round_index
        self.trace['stages'].append(step)
        self.trace['finalState'] = step['nextState']
        return number

    def inner(self, commitment_point, u_point):
        old = self.prefix
        payload = word(64) + point(*commitment_point) + point(*u_point)
        self.prefix += tag(self.tags['inner']) + word(len(payload)) + payload
        step = {'stage': 'inner', 'previousState': '0x' + k256(old).hex(),
                'payloadHex': '0x' + payload.hex(),
                'P': [str(x) for x in commitment_point],
                'uPoint': [str(x) for x in u_point],
                'nextState': '0x' + k256(self.prefix).hex()}
        self.trace['stages'].append(step)
        self.trace['finalState'] = step['nextState']


def prove(value, blinding, operation_id, output_index, seed, parameters, profile):
    return _prove(value, blinding, operation_id, output_index, seed, parameters, profile, False)


def prove_with_internal_identity(value, blinding, operation_id, output_index, seed, parameters, profile):
    """Test-only construction with S = 0; keeps the ordinary scalar tape position."""
    return _prove(value, blinding, operation_id, output_index, seed, parameters, profile, True)


def _prove(value, blinding, operation_id, output_index, seed, parameters, profile, identity_s):
    if not 1 <= value <= 2**64 or not 0 <= blinding < Q:
        raise ValueError('witness out of range')
    h, g, gs, hs = pts(parameters)
    tape = ScalarTape(seed)
    c = commitment(value, blinding, h, g)
    crange = add(c, negate(h))
    bits = [((value-1) >> i) & 1 for i in range(N)]
    shifted = [(b-1) % Q for b in bits]
    lmask = [tape.next() for _ in range(N)]
    rmask = [tape.next() for _ in range(N)]
    alpha, rho = tape.next(), tape.next()
    if identity_s:
        lmask = [0] * N
        rmask = [0] * N
        rho = 0
    a_point = suma(multi(gs, bits), multi(hs, shifted), multiply(g, alpha))
    s_point = suma(multi(gs, lmask), multi(hs, rmask), multiply(g, rho))
    tr = Transcript(operation_id, output_index, crange, profile)
    y = tr.challenge('y', point(*a_point) + point(*s_point))
    z = tr.challenge('z', b'')
    z2 = z*z % Q
    yp = [pow(y, i, Q) for i in range(N)]
    lc = [(bits[i]-z) % Q for i in range(N)]
    rc = [(yp[i]*(shifted[i]+z) + z2*(1 << i)) % Q for i in range(N)]
    rl = [yp[i]*rmask[i] % Q for i in range(N)]
    t1 = (dot(lmask, rc) + dot(lc, rl)) % Q
    t2 = dot(lmask, rl)
    tau1, tau2 = tape.next(), tape.next()
    t1_point = suma(multiply(h, t1), multiply(g, tau1))
    t2_point = suma(multiply(h, t2), multiply(g, tau2))
    x = tr.challenge('x', point(*t1_point) + point(*t2_point))
    le = [(lc[i]+lmask[i]*x) % Q for i in range(N)]
    re = [(rc[i]+rl[i]*x) % Q for i in range(N)]
    h_adj = [multiply(hs[i], pow(yp[i], -1, Q)) for i in range(N)]
    t = dot(le, re)
    tau_x = (z2*blinding + tau1*x + tau2*x*x) % Q
    mu = (alpha + rho*x) % Q
    u_challenge = tr.challenge('u', word(tau_x) + word(mu) + word(t))
    u_point = multiply(h, u_challenge)
    inner = suma(multi(gs, le), multi(h_adj, re), multiply(u_point, t))
    tr.inner(inner, u_point)
    left_points, right_points = [], []
    for round_index in range(6):
        half = len(le)//2
        ll, lh = le[:half], le[half:]
        rl_, rh = re[:half], re[half:]
        left_point = suma(multi(gs[half:], ll), multi(h_adj[:half], rh), multiply(u_point, dot(ll, rh)))
        right_point = suma(multi(gs[:half], lh), multi(h_adj[half:], rl_), multiply(u_point, dot(lh, rl_)))
        left_points.append(left_point)
        right_points.append(right_point)
        challenge = tr.challenge('round', word(round_index) + point(*left_point) + point(*right_point), round_index)
        inverse = pow(challenge, -1, Q)
        gs = [suma(multiply(gs[i], inverse), multiply(gs[i+half], challenge)) for i in range(half)]
        h_adj = [suma(multiply(h_adj[i], challenge), multiply(h_adj[i+half], inverse)) for i in range(half)]
        le = [(ll[i]*challenge + lh[i]*inverse) % Q for i in range(half)]
        re = [(rl_[i]*inverse + rh[i]*challenge) % Q for i in range(half)]
    return {'operationId':'0x'+operation_id.hex(), 'outputIndex':str(output_index),
            'coords':coords([crange, a_point, s_point, t1_point, t2_point]),
            'scalars':[str(v) for v in [tau_x, mu, t, le[0], re[0]]],
            'ls':columns(left_points), 'rs':columns(right_points),
            'transcriptTrace':tr.trace,
            'testScalarSeed':'0x'+seed.hex(), 'testScalarCandidates':str(tape.counter)}


def verify(proof, parameters, profile):
    try:
        h, g, gs, hs = pts(parameters)
        co = [int(v) for v in proof['coords']]
        sc = [int(v) for v in proof['scalars']]
        ls = [int(v) for v in proof['ls']]
        rs = [int(v) for v in proof['rs']]
        if len(co)!=10 or len(sc)!=5 or len(ls)!=12 or len(rs)!=12:
            return False
        if not all(check_point(*co[i:i+2]) for i in range(0, 10, 2)) or not all(0<=v<Q for v in sc):
            return False
        lpts=[(ls[i],ls[i+6]) for i in range(6)]
        rpts=[(rs[i],rs[i+6]) for i in range(6)]
        if not all(check_point(*p) for p in lpts+rpts):
            return False
        c, ap, sp, t1p, t2p = [tuple(co[i:i+2]) for i in range(0,10,2)]
        tau, mu, t, a, b = sc
        tr=Transcript(bytes.fromhex(proof['operationId'][2:]),int(proof['outputIndex']),c,profile)
        y=tr.challenge('y',point(*ap)+point(*sp));z=tr.challenge('z',b'')
        x=tr.challenge('x',point(*t1p)+point(*t2p))
        z2=z*z%Q;z3=z2*z%Q
        yp=[pow(y,i,Q) for i in range(N)]
        delta=((z-z2)*sum(yp)-z3*((1<<N)-1))%Q
        lhs=suma(multiply(h,t),multiply(g,tau))
        rhs=suma(multiply(c,z2),multiply(h,delta),multiply(t1p,x),multiply(t2p,x*x))
        if lhs!=rhs:return False
        u=tr.challenge('u',word(tau)+word(mu)+word(t));up=multiply(h,u)
        h_adj=[multiply(hs[i],pow(yp[i],-1,Q)) for i in range(N)]
        inner=suma(ap,multiply(sp,x),negate(multiply(g,mu)),multiply(up,t))
        for i in range(N):
            he=(yp[i]*z+z2*(1<<i))%Q
            inner=suma(inner,negate(multiply(gs[i],z)),multiply(h_adj[i],he))
        tr.inner(inner,up)
        for i in range(6):
            ch=tr.challenge('round',word(i)+point(*lpts[i])+point(*rpts[i]),i)
            inv=pow(ch,-1,Q)
            inner=suma(inner,multiply(lpts[i],ch*ch),multiply(rpts[i],inv*inv))
            half=len(gs)//2
            gs=[suma(multiply(gs[j],inv),multiply(gs[j+half],ch)) for j in range(half)]
            h_adj=[suma(multiply(h_adj[j],ch),multiply(h_adj[j+half],inv)) for j in range(half)]
        terminal=suma(multiply(gs[0],a),multiply(h_adj[0],b),multiply(up,a*b))
        if terminal != inner:
            return False
        return 'transcriptTrace' not in proof or tr.trace == proof['transcriptTrace']
    except (ValueError,KeyError,TypeError,OverflowError):
        return False


def build_deterministic_case(parameters, profile):
    proof = prove(1, 0, bytes.fromhex('66'*32), 0,
                  bytes.fromhex('12'*32), parameters, profile)
    if not verify(proof, parameters, profile):
        raise ValueError('generated v3 proof failed independent equation verification')
    return {'id': 'VEC-04-DETERMINISTIC-VALID-IDENTITY',
            'profile': 'range-bp-v3',
            'source': 'docs/design.md#v3範囲証明 and EXP-08 profile.json',
            'stage': 'range-proof',
            'input': {'amount': '1', 'blinding': '0', **proof},
            'expected': {'decision': 'accept',
                         'parametersHash': profile['expectedParametersHash'],
                         'C_range': ['0', '0']},
            'oracle': 'tools/oracle_range_prover.py#verify and tools/oracle_v3.py#replay_trace',
            'consumers': ['#26', '#28']}


def build_internal_identity_case(parameters, profile):
    proof = prove_with_internal_identity(1, 0, bytes.fromhex('66'*32), 0,
                                         bytes.fromhex('12'*32), parameters, profile)
    if proof['coords'][4:6] != ['0', '0'] or not verify(proof, parameters, profile):
        raise ValueError('internal identity proof failed independent verification')
    return {'id': 'VEC-04-DETERMINISTIC-VALID-INTERNAL-IDENTITY',
            'profile': 'range-bp-v3',
            'source': 'docs/design.md#v3範囲証明 and EXP-08 profile.json',
            'stage': 'range-proof',
            'input': {'amount': '1', 'blinding': '0', **proof},
            'expected': {'decision': 'accept',
                         'parametersHash': profile['expectedParametersHash'],
                         'identityPoint': 'S', 'S': ['0', '0']},
            'oracle': 'tools/oracle_range_prover.py#verify and tools/oracle_v3.py#replay_trace',
            'consumers': ['#26', '#28']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    if args.out.resolve() == (root / 'tests/vectors/cases').resolve():
        raise SystemExit('choose separate output directory')
    exp = root / 'experiments/design/crypto-profile-v3/exp08'
    parameters = json.loads((exp / 'parameters.json').read_text())
    profile = json.loads((exp / 'profile.json').read_text())
    case = build_deterministic_case(parameters, profile)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'range-deterministic.json').write_text(json.dumps([case], indent=2, ensure_ascii=False) + '\n')
