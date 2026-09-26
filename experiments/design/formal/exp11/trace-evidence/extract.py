"""Extract the limited runtime-reachability observation from EXP-11 node 10."""

import ast
import hashlib
import json
from pathlib import Path


HERE = Path(__file__).resolve().parent
FORMAL = HERE.parent.parent
NODE = HERE / "node-10.json"
RUNTIME = FORMAL / "exp09/runtime.hex"
RUN_RESULT = HERE.parent / "run-result-2.json"


def cells(term, label):
    if isinstance(term, dict):
        term_label = term.get("label")
        if isinstance(term_label, dict) and term_label.get("name") == label:
            yield term["args"][0]
        for value in term.values():
            yield from cells(value, label)
    elif isinstance(term, list):
        for value in term:
            yield from cells(value, label)


def only_cell(config, label):
    matches = list(cells(config, label))
    assert len(matches) == 1, (label, len(matches))
    return matches[0]


def main():
    node_bytes = NODE.read_bytes()
    node = json.loads(node_bytes)
    assert node["id"] == 10
    config = node["cterm"]["config"]
    program = ast.literal_eval(only_cell(config, "<program>")["token"])
    pc = int(only_cell(config, "<pc>")["token"])
    expected_runtime = bytes.fromhex(RUNTIME.read_text().strip())
    result = json.loads(RUN_RESULT.read_text())
    assert any(path.endswith("/kcfg/nodes/10.json") for path in result["proofSnapshotFiles"])
    assert program == expected_runtime
    assert hashlib.sha256(program).hexdigest() == result["targetRuntimeSha256"]
    assert 0 < pc < len(program)

    observation = {
        "experiment": "EXP-11",
        "sourceRun": "../run-result-2.json",
        "sourceSnapshot": "../proof-snapshot-2/EXP11-SYMBOLIC-SPEC.wrong-left-length/kcfg/nodes/10.json",
        "publishedNode": "node-10.json",
        "publishedNodeSha256": hashlib.sha256(node_bytes).hexdigest(),
        "nodeId": node["id"],
        "programBytes": len(program),
        "programSha256": hashlib.sha256(program).hexdigest(),
        "matchesExp09Runtime": program == expected_runtime,
        "pc": pc,
        "interpretation": "A pending KCFG node has a program byte-for-byte equal to the v3 deployed runtime and a nonzero PC within that runtime. This is runtime reachability only; the claim was not proved.",
        "limits": "No full trace, call-depth claim, rejection-site proof, precompile-exclusion proof, or completed symbolic proof follows from this node.",
    }
    (HERE / "observation.json").write_text(json.dumps(observation, indent=2) + "\n")
    print(json.dumps({"nodeId": observation["nodeId"], "pc": pc, "matchesRuntime": True}))


if __name__ == "__main__":
    main()
