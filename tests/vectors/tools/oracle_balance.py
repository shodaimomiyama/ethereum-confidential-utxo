"""Test-only BN254 Schnorr balance oracle; public fixtures contain toy secrets."""

import argparse
import json
from pathlib import Path

from Crypto.Hash import keccak

from reference_bn254 import IDENTITY, Q, add, check_point, multiply, negate


ROOT = Path(__file__).resolve().parents[3]
PARAMETERS_HASH = "0x0bfd116b8ef31332d31d3350ed24fa36d1e17865a7c1dc0758331da0755f8dae"
PARAMETERS = json.loads((ROOT / "experiments/design/crypto-profile-v3/exp08/parameters.json").read_text())
H = tuple(map(int, PARAMETERS["base"][:2]))
G = tuple(map(int, PARAMETERS["base"][2:]))
OPERATION_CASES = {
    case["id"]: case for case in json.loads((ROOT / "tests/vectors/cases/operation.json").read_text())
}


def keccak256(data: bytes) -> bytes:
    digest = keccak.new(digest_bits=256)
    digest.update(data)
    return digest.digest()


def word(value: int) -> bytes:
    if not 0 <= value < 2**256:
        raise ValueError("uint256 out of range")
    return value.to_bytes(32, "big")


def encode_challenge(chain_id: int, pool: str, operation_id: str,
                     x: tuple[int, int], r: tuple[int, int], counter: int) -> bytes:
    """Static Solidity abi.encode, twelve 32-byte words in the specified order."""
    pool_bytes = bytes.fromhex(pool.removeprefix("0x"))
    operation_bytes = bytes.fromhex(operation_id.removeprefix("0x"))
    if len(pool_bytes) != 20 or len(operation_bytes) != 32:
        raise ValueError("invalid pool or operationId length")
    return b"".join([
        keccak256(b"ecu/balance-schnorr/bn254/v1"),
        word(chain_id), b"\x00" * 12 + pool_bytes,
        bytes.fromhex(PARAMETERS_HASH[2:]), operation_bytes,
        word(G[0]), word(G[1]), word(x[0]), word(x[1]),
        word(r[0]), word(r[1]), word(counter),
    ])


def first_challenge(candidates: list[int]) -> tuple[int, int]:
    for counter, candidate in enumerate(candidates[:256]):
        if 1 <= candidate < Q:
            return counter, candidate
    raise ValueError("256 candidates exhausted")


def challenge_trace(inputs: dict) -> list[dict]:
    x = compute_x(inputs)
    r = point(inputs["proof"]["R"])
    trace = []
    for counter in range(256):
        preimage = encode_challenge(int(inputs["chainId"]), inputs["pool"],
                                    inputs["operationId"], x, r, counter)
        candidate = int.from_bytes(keccak256(preimage), "big")
        accepted = 1 <= candidate < Q
        trace.append({"counter": str(counter), "preimage": "0x" + preimage.hex(),
                      "candidate": str(candidate), "accepted": accepted})
        if accepted:
            return trace
    raise ValueError("256 candidates exhausted")


def point(values: list[str]) -> tuple[int, int]:
    if len(values) != 2:
        raise ValueError("point requires two coordinates")
    result = tuple(int(value) for value in values)
    if not check_point(*result):
        raise ValueError("noncanonical or off-curve point")
    return result


def point_json(value: tuple[int, int]) -> list[str]:
    return [str(value[0]), str(value[1])]


def commitment(amount: int, blinding: int) -> tuple[int, int]:
    if not 0 <= blinding < Q:
        raise ValueError("blinding out of range")
    return add(multiply(H, amount), multiply(G, blinding))


def compute_x(inputs: dict) -> tuple[int, int]:
    result = IDENTITY
    for value in inputs["inputCommitments"]:
        result = add(result, point(value))
    result = add(result, multiply(H, int(inputs["d"])))
    for value in inputs["outputCommitments"]:
        result = add(result, negate(point(value)))
    result = add(result, negate(multiply(H, int(inputs["w"]))))
    return result


def verify_case(case: dict) -> bool:
    try:
        inputs = case["input"]
        if inputs["parametersHash"] != PARAMETERS_HASH:
            return False
        x = compute_x(inputs)
        r = point(inputs["proof"]["R"])
        s = int(inputs["proof"]["s"])
        if r == IDENTITY or not 0 <= s < Q:
            return False
        c = int(challenge_trace(inputs)[-1]["candidate"])
        return multiply(G, s) == add(r, multiply(x, c))
    except (ValueError, KeyError, TypeError, OverflowError):
        return False


def make_case(inputs: dict) -> dict:
    trace = challenge_trace(inputs)
    x = compute_x(inputs)
    return {"expected": {
        "decision": "accept", "X": point_json(x),
        "R": list(inputs["proof"]["R"]), "s": inputs["proof"]["s"],
        "challengeTrace": trace, "acceptedCounter": trace[-1]["counter"],
        "challenge": trace[-1]["candidate"], "equationHolds": verify_case({"input": inputs}),
    }}


def case_input(operation_id: str, incoming: list[tuple[int, int]],
               outgoing: list[tuple[int, int]], d: int, w: int, nonce: int) -> dict:
    if not 1 <= nonce < Q:
        raise ValueError("balance nonce must be in [1,q-1]")
    x_scalar = (sum(r for _, r in incoming) - sum(r for _, r in outgoing)) % Q
    x = add(add(sum_points(commitment(v, r) for v, r in incoming), multiply(H, d)),
            negate(add(sum_points(commitment(v, r) for v, r in outgoing), multiply(H, w))))
    if x != multiply(G, x_scalar):
        raise ValueError("unbalanced test opening")
    r_point = multiply(G, nonce)
    inputs = {
        "chainId": "31337", "pool": "0x1111111111111111111111111111111111111111",
        "parametersHash": PARAMETERS_HASH, "operationId": operation_id,
        "operationIdScope": "domain-separation input from VEC-01; commitments here are independent test values",
        "d": str(d), "w": str(w),
        "inputOpenings": [{"amount": str(v), "blinding": str(r)} for v, r in incoming],
        "outputOpenings": [{"amount": str(v), "blinding": str(r)} for v, r in outgoing],
        "inputCommitments": [point_json(commitment(v, r)) for v, r in incoming],
        "outputCommitments": [point_json(commitment(v, r)) for v, r in outgoing],
        "proof": {"R": point_json(r_point), "s": "0"},
        "testNonce": str(nonce),
    }
    c = int(challenge_trace(inputs)[-1]["candidate"])
    inputs["proof"]["s"] = str((nonce + c * x_scalar) % Q)
    return inputs


def sum_points(points) -> tuple[int, int]:
    result = IDENTITY
    for value in points:
        result = add(result, value)
    return result


def generate() -> list[dict]:
    specs = [
        ("VEC-05-DEPOSIT", "VEC-01-DEPOSIT", [], [(5, 3)], 5, 0, 7),
        ("VEC-05-TRANSFER-ONE", "VEC-01-TRANSFER-ONE", [(7, 9)], [(7, 4)], 0, 0, 11),
        ("VEC-05-TRANSFER-MERGE-IDENTITY-X", "VEC-01-TRANSFER-MERGE",
         [(2, 1), (3, 2)], [(5, 3)], 0, 0, 13),
        ("VEC-05-WITHDRAW-FULL", "VEC-01-WITHDRAW-FULL", [(9, 8)], [], 0, 9, 17),
        ("VEC-05-WITHDRAW-PARTIAL", "VEC-01-WITHDRAW-PARTIAL", [(9, 8)], [(4, 2)], 0, 5, 19),
    ]
    cases = []
    for case_id, operation_case, incoming, outgoing, d, w, nonce in specs:
        operation_id = OPERATION_CASES[operation_case]["expected"]["operationId"]
        inputs = case_input(operation_id, incoming, outgoing, d, w, nonce)
        expected = make_case(inputs)["expected"]
        cases.append({"id": case_id, "profile": "balance-schnorr-bn254-v1",
                      "source": "docs/design.md#操作の結合とabi", "stage": "balance-proof",
                      "input": inputs, "expected": expected,
                      "oracle": "tools/oracle_balance.py; pycryptodome 3.23.0",
                      "consumers": ["#27", "#28", "#30"]})

    base = cases[0]
    mutations = [
        ("R-IDENTITY", "proof.R", ["0", "0"]),
        ("S-ZERO", "proof.s", "0"),
        ("S-Q", "proof.s", str(Q)),
        ("R-OFF-CURVE", "proof.R", ["1", "1"]),
        ("OPERATION-ID-CHANGED", "operationId", "0x" + "ee" * 32),
        ("CHAIN-CHANGED", "chainId", "31338"),
        ("POOL-CHANGED", "pool", "0x" + "22" * 20),
    ]
    for name, path, value in mutations:
        mutated = json.loads(json.dumps(base))
        mutated["id"] = "VEC-05-" + name
        mutated["baseCase"] = base["id"]
        mutated["mutatedField"] = path
        target = mutated["input"]
        parts = path.split(".")
        for part in parts[:-1]:
            target = target[part]
        target[parts[-1]] = value
        mutated["expected"] = {"decision": "reject", "reason": name,
                               "equationHolds": False}
        cases.append(mutated)
    for name, candidates, expected in [
        ("CANDIDATE-ZERO", [0, 1], (1, 1)),
        ("CANDIDATE-Q", [Q, 1], (1, 1)),
        ("CANDIDATE-MAX", [2**256 - 1, 1], (1, 1)),
        ("CANDIDATE-ONE", [1], (0, 1)),
        ("CANDIDATE-Q-MINUS-ONE", [Q - 1], (0, Q - 1)),
    ]:
        cases.append({"id": "VEC-05-" + name, "profile": "balance-schnorr-bn254-v1",
                      "source": "docs/design.md#操作の結合とabi", "stage": "challenge-predicate",
                      "input": {"candidates": [str(v) for v in candidates],
                                "scope": "acceptance predicate only; not a forged Keccak transcript"},
                      "expected": {"decision": "accept", "counter": str(expected[0]),
                                   "challenge": str(expected[1])},
                      "oracle": "tools/oracle_balance.py#first_challenge",
                      "consumers": ["#27", "#28"]})
    cases.append({"id": "VEC-05-CANDIDATES-EXHAUSTED", "profile": "balance-schnorr-bn254-v1",
                  "source": "docs/design.md#操作の結合とabi", "stage": "challenge-predicate",
                  "input": {"candidateRepeated": "0", "count": "256",
                            "scope": "acceptance predicate only; not a forged Keccak transcript"},
                  "expected": {"decision": "reject", "reason": "256 candidates exhausted"},
                  "oracle": "tools/oracle_balance.py#first_challenge", "consumers": ["#27", "#28"]})
    cases.append({"id": "VEC-05-NONCE-ZERO", "profile": "balance-schnorr-bn254-v1",
                  "source": "docs/design.md#収支差の検証", "stage": "proof-generation",
                  "input": {"nonce": "0", "scope": "balance prover nonce only"},
                  "expected": {"decision": "reject", "reason": "balance nonce out of range"},
                  "oracle": "tools/oracle_balance.py#case_input", "consumers": ["#28", "#30"]})
    return cases


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "balance.json").write_text(json.dumps(generate(), indent=2) + "\n")
