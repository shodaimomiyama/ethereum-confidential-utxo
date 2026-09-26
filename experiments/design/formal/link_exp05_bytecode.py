import ast
import hashlib
import json
import pathlib


DIRECTORY = pathlib.Path(__file__).resolve().parent


def matching_tokens(value, expected, pointer="", labels=()):
    matches = []
    if isinstance(value, dict):
        if value.get("node") == "KApply":
            labels += (value.get("label", {}).get("name"),)
        if value.get("node") == "KToken" and value.get("sort", {}).get("name") == "Bytes":
            decoded = ast.literal_eval(value["token"])
            if isinstance(decoded, bytes) and decoded == expected:
                matches.append({"json_pointer": pointer, "ancestor_k_labels": labels})
        for key, child in value.items():
            escaped = key.replace("~", "~0").replace("/", "~1")
            matches.extend(matching_tokens(child, expected, pointer + "/" + escaped, labels))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            matches.extend(matching_tokens(child, expected, pointer + "/" + str(index), labels))
    return matches


def main():
    cases = [
        ("exp05-existing-claim-offline.json", "out/VerifierSlice.t.sol/VerifierSliceTest.json"),
        ("exp05-revised-claim.json", "revised/out/VerifierSlice.t.sol/VerifierSliceTest.json"),
        ("exp05-revised-sub-claim.json", "revised/out/VerifierSlice.t.sol/VerifierSliceTest.json"),
    ]
    links = []
    for record_name, artifact_name in cases:
        record = json.loads((DIRECTORY / record_name).read_text())
        evidence = json.loads(record["stdout"])
        artifact_path = DIRECTORY / artifact_name
        artifact = json.loads(artifact_path.read_text())
        runtime = bytes.fromhex(artifact["deployedBytecode"]["object"].removeprefix("0x"))
        metadata_path = next(name for name in evidence["proof_files"] if name.endswith("/proof.json"))
        metadata = json.loads(evidence["proof_files"][metadata_path])
        node_path = metadata_path.removesuffix("proof.json") + "kcfg/nodes/" + str(metadata["init"]) + ".json"
        node_text = evidence["proof_files"][node_path]
        matches = matching_tokens(json.loads(node_text), runtime)
        assert matches, "Target deployed bytecode is absent from the initial proof node"
        links.append({
            "proof_record": record_name, "proof_id": metadata["id"],
            "artifact": artifact_name,
            "artifact_sha256": hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
            "runtime_bytes": len(runtime),
            "runtime_sha256": hashlib.sha256(runtime).hexdigest(),
            "initial_node": node_path,
            "initial_node_json_sha256": hashlib.sha256(node_text.encode()).hexdigest(),
            "exact_match_count": len(matches), "matches": matches,
        })
    record = {
        "method": "Decode the Foundry artifact deployedBytecode.object as hex bytes. Load the retained APR proof metadata init node, recursively decode KToken values of sort Bytes with Python ast.literal_eval, and compare every byte including compiler metadata. Preserve JSON pointer and ancestor K labels for each exact match.",
        "claims": links,
    }
    with (DIRECTORY / "exp05-bytecode-links.json").open("x") as output:
        json.dump(record, output, indent=2)
        output.write("\n")
    print(json.dumps({"claims": len(links), "match_counts": [link["exact_match_count"] for link in links]}))


if __name__ == "__main__":
    main()
