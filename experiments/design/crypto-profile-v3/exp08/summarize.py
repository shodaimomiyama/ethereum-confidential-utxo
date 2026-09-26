import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
VECTORS = ROOT.parent.parent / "crypto-profile-v2" / "vectors.json"
V2_RESULT = ROOT.parent.parent / "crypto-profile-v2" / "exp07b" / "exp07b-result.json"


def read(name):
    return json.loads((ROOT / name).read_text())


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


plan = read("plan.json")
profile = read("profile.json")
java = read("java-result.json")
evm = read("evm-result.json")
v2 = json.loads(V2_RESULT.read_text())

assert plan["experiment"] == java["experiment"] == evm["experiment"] == "EXP-08"
assert java["parametersHash"] == evm["constructorParametersHash"] == profile["expectedParametersHash"]
assert profile["expectedParametersHash"] != v2["inputs"]["parametersHashV2"]
assert sha256(VECTORS) == v2["inputs"]["EXP07AVectorsJsonSha256"]

expected = {
    "amount-1-blinding-42": True,
    "amount-max-blinding-42": True,
    "amount-1-blinding-0": True,
    "amount-over-max": False,
}
assert len(java["proofs"]) == 4
java_cases = {}
for proof in java["proofs"]:
    label = proof["label"]
    assert label in expected
    assert proof["expectedValid"] == proof["javaVerifierAccepted"] == expected[label]
    if expected[label]:
        assert proof["javaTranscriptMatchesProver"]
    assert proof["proverAttempts"] == 1 and not proof["retryReasons"]
    java_cases[label] = {
        "expected": expected[label],
        "accepted": proof["javaVerifierAccepted"],
        "proverVerifierTraceMatched": proof["javaTranscriptMatchesProver"],
        "attempts": proof["proverAttempts"],
    }
assert set(java_cases) == set(expected)

evm_cases = {}
for observation in evm["observations"]:
    assert observation["matchesJava"]
    assert observation["accepted"] == observation["expectedValid"]
    evm_cases[observation["label"]] = {
        "expected": observation["expectedValid"],
        "accepted": observation["accepted"],
        "returnedNormally": observation["returnedNormally"],
    }
assert set(evm_cases) == set(expected) | {"changed-operation-id"}
assert not evm_cases["changed-operation-id"]["accepted"]
assert not next(case for case in java["javaMutationChecks"] if case["label"] == "operation-id-changed")["accepted"]

point_expected = {"canonical-identity": True, "x-equals-p": False, "off-curve": False}
for source in [java["pointDecodeBoundaryChecks"], evm["pointDecodeBoundaryChecks"]]:
    assert {item["label"]: item["accepted"] for item in source} == point_expected
assert all(item["matchesJava"] for item in evm["pointDecodeBoundaryChecks"])

valid = java["proofs"][0]
stages = valid["transcriptTrace"]["stages"]
assert len(stages) == 11 and len(evm["transcriptStagesChecked"]) == 11
assert [stage["stage"] for stage in stages] == evm["transcriptStagesChecked"]
assert sum(stage["stage"] != "inner" for stage in stages) == 10
assert evm["passed"] is True
assert 0 < int(evm["validProofTransactionGasUsed"]) < 16_777_216

sources = ["plan.json", "profile.json", "parameters.json", "build-profile.cjs", "run-evm.cjs", "summarize.py"]
sources += [str(path.relative_to(ROOT)) for path in sorted((ROOT / "java").glob("*.java"))]
sources += [str(path.relative_to(ROOT)) for path in sorted((ROOT / "solidity").glob("*.sol"))]
evidence = ["java-result.json", "evm-result.json", "evm-compiler-diagnostics.json"]
result = {
    "experiment": "EXP-08",
    "status": "passed within the bounded design-stage interoperability scope",
    "parametersHashV3": profile["expectedParametersHash"],
    "EXP07AVectorsSha256": sha256(VECTORS),
    "v2ResultSha256": sha256(V2_RESULT),
    "toolchain": {
        "java": "Temurin 23+37",
        "node": "22.22.0",
        "solc": evm["compiler"],
        "anvil": "1.7.1, commit 4072e48705af9d93e3c0f6e29e93b5e9a40caed8",
        "hardfork": "prague",
        "optimizerRuns": evm["optimizerRuns"],
        "transactionGasLimit": 16_777_216,
    },
    "commands": [
        "node build-profile.cjs",
        "javac -d .cache/classes -cp $(cat ../../bulletproof/.cache/classpath.txt) -sourcepath java:../../bulletproof/.cache/upstream/src/main/java java/*.java",
        "java -Xmx2g -cp .cache/classes:$(cat ../../bulletproof/.cache/classpath.txt) GenerateRevisedProofs java-result.json",
        "node run-evm.cjs",
        "python3 summarize.py",
    ],
    "results": {
        "java": java_cases,
        "evm": evm_cases,
        "pointDecodeBoundary": point_expected,
        "transcript": "One valid proof: 10 challenges and accepted counters, 11 Java/EVM prefix hashes; every candidate through acceptance independently recomputed in ethers from the direct full prefix.",
        "stageSequence": evm["transcriptStagesChecked"],
        "singleVerifierTransactionGas": int(evm["validProofTransactionGasUsed"]),
        "v2SingleVerifierTransactionGasDifferentFixture": v2["result"]["wordCopyGas"],
        "v3MinusV2GasDifferentFixtures": int(evm["validProofTransactionGasUsed"]) - v2["result"]["wordCopyGas"],
        "twoV3ProofsArithmeticSumNotPoolTransaction": 2 * int(evm["validProofTransactionGasUsed"]),
        "runtimeBytes": evm["runtimeBytes"],
        "runtimeKeccak256": evm["deployment"]["runtimeKeccak256"],
    },
    "sourceSha256": {name: sha256(ROOT / name) for name in sources},
    "evidenceSha256": {name: sha256(ROOT / name) for name in evidence},
    "interpretation": "The v3 encoding and verifier interoperate for the specified finite cases, and one direct verification fits the configured transaction cap. The v2 and v3 gas fixtures differ and their difference is not a controlled marginal-cost estimate. The two-proof figure is arithmetic only; Pool state, balance proof, authorization, events, and call-context costs were not measured.",
    "unverified": [
        "Cryptographic soundness, zero knowledge, and applicability of the original Bulletproofs theorem to this profile and identity-point policy",
        "A naturally generated identity proof point or adversarial identity-point soundness; only decoding boundaries and invalid mutations were checked",
        "All possible values, blindings, malformed inputs, prefix lengths, or candidate-exhaustion paths",
        "Formal verification, full Pool operation, two-output gas, and public testnet behavior",
    ],
}
(ROOT / "result.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
print(json.dumps({"status": result["status"], "gas": result["results"]["singleVerifierTransactionGas"], "runtimeBytes": result["results"]["runtimeBytes"]}))
