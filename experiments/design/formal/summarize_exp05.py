import ast
import hashlib
import json
import pathlib


DIRECTORY = pathlib.Path(__file__).resolve().parent


def read_json(path):
    return json.loads(path.read_text())


def collect_byte_tokens(value):
    tokens = []
    if isinstance(value, dict):
        if value.get("node") == "KToken" and value.get("sort", {}).get("name") == "Bytes":
            tokens.append(ast.literal_eval(value["token"]))
        for child in value.values():
            tokens.extend(collect_byte_tokens(child))
    elif isinstance(value, list):
        for child in value:
            tokens.extend(collect_byte_tokens(child))
    return tokens


def summarize_claim(record_name, artifact_path, scope, property_text):
    outer = read_json(DIRECTORY / record_name)
    evidence = json.loads(outer["stdout"])
    artifact = read_json(artifact_path)
    bytecode = bytes.fromhex(artifact["deployedBytecode"]["object"].removeprefix("0x"))
    proof_files = evidence.get("proof_files", {})
    initial_paths = [name for name in proof_files if name.endswith("/nodes/1.json")]
    bytecode_matches = sum(
        token == bytecode
        for name in initial_paths
        for token in collect_byte_tokens(json.loads(proof_files[name]))
    )
    proof_metadata = [json.loads(content) for name, content in proof_files.items() if name.endswith("/proof.json")]
    proof = evidence.get("proof", {})
    listing = evidence.get("proof_listing", {}).get("stdout", "")
    passed = (
        proof.get("exit_code") == 0
        and not proof.get("timed_out")
        and "status: ProofStatus.PASSED" in listing
        and all(label + ": 0" in listing for label in ["pending", "failing", "vacuous", "stuck"])
        and proof_metadata
        and all(not item["admitted"] for item in proof_metadata)
    )
    source_hashes_unchanged = evidence["hashes_before"] == evidence["hashes_after"]
    if passed and (not source_hashes_unchanged or bytecode_matches == 0):
        raise RuntimeError("Passed proof cannot be linked to the unchanged target artifact")
    return {
        "scope": scope, "property": property_text,
        "classification": "proved" if passed else "inconclusive",
        "command": proof.get("command"),
        "proof_duration_seconds": proof.get("duration_seconds"),
        "total_container_duration_seconds": outer["duration_seconds"],
        "serialization_duration_seconds": evidence["serialization"]["duration_seconds"],
        "proof_listing": listing,
        "proof_exit_code": proof.get("exit_code"),
        "timed_out": proof.get("timed_out"),
        "source_artifact_hashes_unchanged": source_hashes_unchanged,
        "deployed_bytecode_sha256": hashlib.sha256(bytecode).hexdigest(),
        "exact_deployed_bytecode_matches_in_initial_proof_state": bytecode_matches,
        "artifact_sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
        "hashes": evidence["hashes_before"],
        "memory": evidence["memory"],
        "proof_json_files_retained": len(proof_files),
        "evidence": record_name,
    }


def main():
    output_path = DIRECTORY / "exp05-summary.json"
    if output_path.exists():
        raise SystemExit("Refusing to overwrite: " + str(output_path))
    claims = [
        summarize_claim(
            "exp05-existing-claim-offline.json",
            DIRECTORY / "out/VerifierSlice.t.sol/VerifierSliceTest.json",
            "Unchanged upstream library in the EXP-02 harness, solc 0.4.26, optimizer=false, CANCUN.",
            "For ABI uint256 left,right with left<q and right<q, sub(left,right)<q. The harness returns outside that precondition; no input-rejection property.",
        ),
        summarize_claim(
            "exp05-revised-claim.json",
            DIRECTORY / "revised/out/VerifierSlice.t.sol/VerifierSliceTest.json",
            "Byte-identical EXP-03 revised library source in a separate harness, solc 0.4.19, optimizer=false, BYZANTIUM; not the full deployed verifier bytecode.",
            "alt_bn128.neg(uint256(0)) == 0. Only the fixed-zero input; no all-scalar theorem.",
        ),
        summarize_claim(
            "exp05-revised-sub-claim.json",
            DIRECTORY / "revised/out/VerifierSlice.t.sol/VerifierSliceTest.json",
            "Same revised library and harness artifact as the fixed-zero claim, solc 0.4.19, optimizer=false, BYZANTIUM.",
            "For ABI uint256 left,right with left<q and right<q, sub(left,right)<q. The harness returns outside that precondition; no input-rejection property or modular-correctness theorem.",
        ),
    ]
    summary = {
        "experiment": "EXP-05",
        "formal_claims_attempted": len(claims),
        "formal_claims_completed": sum(item["classification"] == "proved" for item in claims),
        "claims": claims,
        "current_environment_diagnosis": {
            "host_available_kib": 270801736,
            "docker_vm_memory_bytes": 4109803520,
            "docker_rootfs_available_kib": 0,
            "docker_rootfs_inode_use_percent": 43,
            "container_tmpfs_bytes": 536870912,
            "container_memory_limit_bytes": 8589934592,
            "observed_failures": [
                "Creating /tmp/exp05 on the Docker rootfs returned ENOSPC.",
                "Same Kore command and definition: ordinary /tmp returned empty exit 1; container tmpfs /tmp serialized successfully.",
                "Kontrol telemetry initialization then returned ENOSPC for /home/user/.config; documented KPROFILE_TELEMETRY_DISABLED=true avoided that non-proof initialization path.",
            ],
            "exp02_causality_limit": "No contemporaneous EXP-02 df/ENOSPC record was retained. The current cause is consistent with the old silent failure but does not retrospectively establish its cause.",
            "global_configuration_changed": False,
            "user_docker_images_or_caches_deleted": False,
            "full_k_definition_rebuild_performed": False,
        },
        "trust_and_scope_limits": [
            "Trusted fixed Kontrol/KEVM semantics, Haskell backend, Z3 and Solidity compilers; retained APR graphs make these tool-relative proofs replayable.",
            "Gas computations were omitted explicitly. No gas-cost or out-of-gas theorem.",
            "No custom axiom, assume-defined, no-stack-checks, admitted node or proof summary was supplied.",
            "Reused generic K definition was normally validated/serialized, with unchanged definition hash.",
            "Revised noncanonical-input rejection, modular arithmetic correctness, neg for all scalars, precompile wrappers, transcript, full Bulletproof verifier and UTXO core are not established by these claims.",
            "Cryptographic soundness and the complete FV-03/FV-04 obligations remain unproved.",
        ],
        "evidence": [
            "exp05-runtime-diagnostic.json", "exp05-storage-inspection.json",
            "exp05-host-storage-and-prior-evidence.json", "exp05-tmpfs-diagnostic.json",
            "exp05-paired-serialization.json", "exp05-primary-source-evidence.json",
            "exp05-telemetry-module.json", "exp05-existing-claim.json",
            "exp05-existing-claim-stop.json", "exp05-proof-plan.json",
            "exp05-revised-proof-plan.json", "exp05-revised-sub-proof-plan.json",
            "revised/outputs/target-bytecode.json",
        ],
    }
    with output_path.open("x") as output:
        json.dump(summary, output, indent=2)
        output.write("\n")
    print(json.dumps({"saved": str(output_path), "completed": summary["formal_claims_completed"]}))


if __name__ == "__main__":
    main()
