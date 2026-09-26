import ast
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time


FORMAL = Path(__file__).resolve().parent.parent
ROOT = Path(__file__).resolve().parent
PLAN = json.loads((ROOT / "plan.json").read_text())


def run(command, seconds, cwd):
    start = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    return {"command": command, "seconds": round(time.monotonic() - start, 3),
            "exitCode": process.returncode, "timedOut": timed_out,
            "stdoutTail": stdout[-6000:], "stderrTail": stderr[-6000:]}


def find_cells(obj, names, found):
    if isinstance(obj, dict):
        if obj.get("node") == "KApply" and obj.get("label", {}).get("name") in names:
            found[obj["label"]["name"]] = obj["args"][0]
        for value in obj.values():
            find_cells(value, names, found)
    elif isinstance(obj, list):
        for value in obj:
            find_cells(value, names, found)


def graphs(project):
    summaries = []
    for path in (project / "out/proofs").rglob("kcfg/kcfg.json"):
        graph = json.loads(path.read_text())
        nodes = []
        for node_path in path.parent.glob("nodes/*.json"):
            node = json.loads(node_path.read_text())
            found = {}
            find_cells(node["cterm"]["config"], {"<program>", "<pc>", "<callDepth>"}, found)
            program = found.get("<program>", {})
            code = ast.literal_eval(program["token"]) if program.get("node") == "KToken" else None
            nodes.append({"id": node["id"], "attrs": node["attrs"],
                          "pc": found.get("<pc>", {}).get("token"),
                          "callDepth": found.get("<callDepth>", {}).get("token"),
                          "programSha256": hashlib.sha256(code).hexdigest() if code else None})
        summaries.append({"path": str(path.relative_to(project)), "nodes": nodes,
                          "edgeCount": len(graph.get("edges", []))})
    return summaries


def inside():
    base = Path("/tmp/exp09")
    base.mkdir()
    evidence = Path("/evidence")
    project = base / "project"
    (project / "test").mkdir(parents=True)
    shutil.copy2(evidence / "exp09/test/V3OptimizedVerifierRejection.t.sol", project / "test")
    config = (evidence / "exp09/foundry.toml").read_text()
    config = re.sub(r'^solc = .*$', 'solc = "/evidence/revised/.cache/bin/solc-0.4.19"', config, flags=re.MULTILINE)
    (project / "foundry.toml").write_text(config)
    definition = base / "kompiled"
    shutil.copytree(evidence / "out/kompiled", definition, ignore=shutil.ignore_patterns("llvm-library"))
    (project / "out").mkdir()
    (project / "out/kompiled").symlink_to(definition)
    result = {"experiment": "EXP-09", "targetSha256": hashlib.sha256(bytes.fromhex(
        (evidence / "exp09/runtime.hex").read_text().strip())).hexdigest()}
    result["serialization"] = run(["kore-exec", str(definition / "definition.kore"),
                                   "--module", "KONTROL-MAIN", "--serialize",
                                   "--output", str(definition / "haskellDefinition.bin")], 120, base)
    if result["serialization"]["exitCode"] == 0:
        result["concrete"] = run(["forge", "test", "--fuzz-runs", "64"], 120, project)
        if result["concrete"]["exitCode"] == 0:
            result["proof"] = run(["kontrol", "prove", "--foundry-project-root", str(project),
                                   "--match-test", "test_rejectsWrongLeftLength", "--schedule", "BYZANTIUM",
                                   "--no-use-booster", "--workers", "1", "--max-frontier-parallel", "1",
                                   "--force-sequential", "--no-gas", "--reinit", "--hide-status-bar"],
                                  600, project)
            result["listing"] = run(["kontrol", "list", "--foundry-project-root", str(project)], 30, project)
            result["graphs"] = graphs(project)
    result["memory"] = {name: Path("/sys/fs/cgroup", name).read_text() for name in
                        ["memory.peak", "memory.events"]}
    print(json.dumps(result))


def outside():
    output = ROOT / "run-result.json"
    if output.exists():
        raise SystemExit("Refusing to overwrite EXP-09 result")
    name = "exp09-v3-formal-feasibility"
    command = ["docker", "run", "--rm", "--platform", "linux/amd64", "--name", name,
               "--cpus", "4", "--memory", "8g", "--memory-swap", "8g", "--network", "none",
               "--env", "KPROFILE_TELEMETRY_DISABLED=true", "--env", "PYTHONDONTWRITEBYTECODE=1",
               "--tmpfs", "/tmp:rw,size=512m,mode=1777",
               "--mount", f"type=bind,source={FORMAL},target=/evidence,readonly",
               "--workdir", "/tmp", PLAN["resources"]["pinnedImage"],
               "python3", "-B", "/evidence/exp09/run.py", "inside"]
    result = {"startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              **run(command, 900, ROOT)}
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    subprocess.run(["docker", "rm", "--force", name], capture_output=True, text=True, timeout=15)
    print(json.dumps({"saved": str(output), "exitCode": result["exitCode"],
                      "timedOut": result["timedOut"], "seconds": result["seconds"]}))


if __name__ == "__main__":
    inside() if sys.argv[1:] == ["inside"] else outside()
