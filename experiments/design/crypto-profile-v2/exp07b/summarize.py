import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PARENT = ROOT.parent


def read(path):
    return json.loads(path.read_text())


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


java = read(ROOT / "java-result.json")
bytecopy = read(ROOT / "evm-result-bytecopy.json")
optimized = read(ROOT / "evm-result.json")
baseline = read(ROOT / "v1-comparison.json")
profile = read(ROOT / "profile.json")
parameters = read(ROOT / "parameters.json")
assert java["parametersHash"] == profile["expectedParametersHash"] == parameters["expectedParametersHash"]
assert all(item["javaVerifierAccepted"] == item["expectedValid"] for item in java["proofs"])
assert all(item["accepted"] == item["expectedValid"] for item in optimized["observations"])
assert optimized["passed"] and bytecopy["passed"]
assert len(optimized["transcriptStagesChecked"]) == 11
assert optimized["transcriptStagesChecked"] == bytecopy["transcriptStagesChecked"]
assert baseline["gasLimit"] == 16_777_216
assert sha256(ROOT / "Transcript-bytecopy.txt") == bytecopy["sourceSha256"]["Transcript.sol"]
assert sha256(ROOT / "solidity/Transcript.sol") == optimized["sourceSha256"]["Transcript.sol"]
assert sha256(PARENT / "vectors.json") == read(PARENT / "result.json")["result"]["vectorsJsonSha256"]

sources = sorted([*ROOT.glob("java/*.java"), *ROOT.glob("solidity/*.sol"),
                  *ROOT.glob("*.cjs"), ROOT / "summarize.py", ROOT / "profile.json",
                  ROOT / "parameters.json", ROOT / "UPSTREAM-LICENSE.txt",
                  ROOT / "Transcript-bytecopy.txt"])
source_hashes = {str(path.relative_to(ROOT)): sha256(path) for path in sources}

result = {
    "experiment": "EXP-07B",
    "status": "passed within the defined design-stage interoperability scope",
    "inputs": {
        "EXP07AVectorsJsonSha256": sha256(PARENT / "vectors.json"),
        "generatorSelection": "Select by role and index from EXP-07A. Constructor and parameters digest order: valueBase, blindingBase, vectorG[0..63], vectorH[0..63]. EXP-07A JSON lists blindingBase first.",
        "parametersHashV2": java["parametersHash"],
        "parametersHashV1": baseline["parametersHash"],
        "proofFixtures": "Freshly generated with v2 points and transcript; no EXP-03 proof fixture reused",
    },
    "toolchain": {
        "java": "Temurin 23+37",
        "node": "22.22.0",
        "solc": optimized["compiler"],
        "anvil": "1.7.1, commit 4072e48705af9d93e3c0f6e29e93b5e9a40caed8",
        "hardfork": "prague",
        "compilerOptimizerRuns": 200,
        "transactionGasLimit": 16_777_216,
    },
    "commands": [
        "node build-profile.cjs",
        "mkdir -p .cache/classes",
        "javac -d .cache/classes -cp <EXP-01 pinned classpath> -sourcepath java:<EXP-01 upstream source> java/*.java",
        "java -Xmx2g -cp .cache/classes:<EXP-01 pinned classpath> GenerateRevisedProofs java-result.json",
        "node run-evm.cjs",
        "node compare-v1.cjs",
        "python3 summarize.py",
    ],
    "result": {
        "javaProverAndVerifier": [{"case": item["label"], "accepted": item["javaVerifierAccepted"],
                                   "expected": item["expectedValid"], "transcriptMatches": item["javaTranscriptMatchesProver"]}
                                  for item in java["proofs"]],
        "evmVerifier": optimized["observations"],
        "directTranscriptCheck": "For the amount=1, blinding=42 valid fixture, Java and EVM agree on all 10 challenges/counters and the 11 prefix hashes (y,z,x,u,inner,six rounds). Other valid fixtures were accepted by EVM but did not receive per-stage probe checks.",
        "stagesChecked": optimized["transcriptStagesChecked"],
        "byteCopyGas": int(bytecopy["validProofTransactionGasUsed"]),
        "wordCopyGas": int(optimized["validProofTransactionGasUsed"]),
        "v1DirectGas": int(baseline["gasUsed"]),
        "wordCopyVsV1AdditionalGas": int(optimized["validProofTransactionGasUsed"]) - int(baseline["gasUsed"]),
        "wordCopyRuntimeBytes": optimized["runtimeBytes"],
        "v1RuntimeBytes": baseline["runtimeBytes"],
        "wordCopyRuntimeKeccak256": optimized["deployment"]["runtimeKeccak256"],
        "v1RuntimeKeccak256": baseline["runtimeKeccak256"],
        "twoWordCopyProofsArithmeticSum": 2 * int(optimized["validProofTransactionGasUsed"]),
        "twoProofInterpretation": "Arithmetic sum only, not a measured two-output Pool transaction; Pool state, authorization, balance proof, calldata, memory and call-context costs are absent.",
    },
    "sourceSha256": source_hashes,
    "evidenceSha256": {name: sha256(ROOT / name) for name in ["java-result.json", "evm-result.json", "evm-result-bytecopy.json", "v1-comparison.json"]},
    "decision": "The v2 generator and full-prefix transcript candidate is executable and interoperable for the tested boundaries. This is feasibility evidence only; crypto adoption remains subject to security argument and complete design-level integration review.",
    "unverified": [
        "Unknown discrete logarithm relations and theorem applicability for the fixed HashToG1 generators",
        "Random-oracle/Fiat-Shamir soundness and zero-knowledge argument for this custom full-prefix transcript and 256-candidate bounded rejection",
        "All possible values, blindings, malformed proofs and transcript-prefix lengths",
        "Formal proof of the v2 production verifier",
        "Complete Pool operation, two-output transaction gas, balance proof, authorization and recipient flow",
        "Public testnet execution and client-specific EIP-7825 enforcement",
    ],
}
(ROOT / "exp07b-result.json").write_text(json.dumps(result, indent=2) + "\n")
