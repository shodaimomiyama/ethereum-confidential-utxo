import ast
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parent
IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, timeout, cwd):
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    return {"command": command, "seconds": round(time.monotonic() - started, 3), "exitCode": process.returncode, "timedOut": timed_out, "stdoutTail": stdout[-4000:], "stderrTail": stderr[-4000:]}


def cells(obj, wanted, output):
    if isinstance(obj, dict):
        if obj.get("node") == "KApply" and obj.get("label", {}).get("name") in wanted:
            output[obj["label"]["name"]] = obj["args"][0]
        for value in obj.values():
            cells(value, wanted, output)
    elif isinstance(obj, list):
        for value in obj:
            cells(value, wanted, output)


def graph_summary(project):
    graphs = list((project / "out/proofs").rglob("kcfg/kcfg.json"))
    if not graphs:
        return {"available": False}
    path = graphs[0]
    graph = json.loads(path.read_text())
    nodes = []
    for node_path in sorted(path.parent.glob("nodes/*.json")):
        node = json.loads(node_path.read_text())
        found = {}
        cells(node["cterm"]["config"], {"<program>", "<pc>", "<callDepth>", "<id>"}, found)
        program = found.get("<program>", {})
        code = ast.literal_eval(program["token"]) if program.get("node") == "KToken" else None
        nodes.append({"id": node["id"], "attrs": node["attrs"], "pc": found.get("<pc>", {}).get("token"), "callDepth": found.get("<callDepth>", {}).get("token"), "accountId": found.get("<id>", {}).get("token"), "programSha256": hashlib.sha256(code).hexdigest() if code is not None else None})
    return {"available": True, "edges": [{"source": edge["source"], "target": edge["target"], "depth": edge["depth"]} for edge in graph["edges"]], "nodes": nodes}


def container():
    source = pathlib.Path("/evidence")
    base = pathlib.Path("/tmp/exp07f")
    base.mkdir()
    definition = base / "kompiled"
    shutil.copytree(source / "out/kompiled", definition, ignore=shutil.ignore_patterns("llvm-library"))
    result = {"experiment": "EXP-07F", "image": IMAGE, "definitionSha256": digest(definition / "definition.kore")}
    result["serialization"] = run(["kore-exec", str(definition / "definition.kore"), "--module", "KONTROL-MAIN", "--serialize", "--output", str(definition / "haskellDefinition.bin")], 60, base)
    if result["serialization"]["exitCode"] != 0:
        print(json.dumps(result))
        return
    for name, source_dir in [("large", source / "optimized"), ("stub", source / "EXP-07F-stub")]:
        project = base / name
        (project / "test").mkdir(parents=True)
        shutil.copy2(source_dir / "test/OptimizedVerifierRejection.t.sol", project / "test/OptimizedVerifierRejection.t.sol")
        config = (source_dir / "foundry.toml").read_text()
        config = re.sub(r'^solc = .*$', 'solc = "/evidence/revised/.cache/bin/solc-0.4.19"', config, flags=re.MULTILINE)
        (project / "foundry.toml").write_text(config)
        (project / "out").mkdir()
        (project / "out/kompiled").symlink_to(definition)
        if name == "large":
            shutil.copytree(source_dir / "out/OptimizedVerifierRejection.t.sol", project / "out/OptimizedVerifierRejection.t.sol")
            preparation = {"status": "reused EXP-06 artifact"}
        else:
            preparation = run(["forge", "test", "--fuzz-runs", "1"], 60, project)
        record = {"preparation": preparation, "sourceSha256": digest(project / "test/OptimizedVerifierRejection.t.sol")}
        artifact = project / "out/OptimizedVerifierRejection.t.sol/OptimizedVerifierRejectionTest.json"
        if artifact.exists():
            record["artifactSha256"] = digest(artifact)
        if name == "large" or preparation.get("exitCode") == 0:
            record["proof"] = run(["kontrol", "prove", "--foundry-project-root", str(project), "--match-test", "test_rejectsWrongLeftLength", "--schedule", "BYZANTIUM", "--no-use-booster", "--workers", "1", "--max-frontier-parallel", "1", "--force-sequential", "--no-gas", "--reinit", "--hide-status-bar"], 90, project)
            record["listing"] = run(["kontrol", "list", "--foundry-project-root", str(project)], 15, project)
            record["graph"] = graph_summary(project)
        result[name] = record
    result["memory"] = {name: pathlib.Path("/sys/fs/cgroup", name).read_text() for name in ["memory.peak", "memory.events"]}
    print(json.dumps(result))


def host():
    output = ROOT / "EXP-07F-result.json"
    if output.exists():
        raise SystemExit("Refusing to overwrite EXP-07F result")
    name = "exp07f-setup-comparison"
    command = ["docker", "run", "--rm", "--platform", "linux/amd64", "--name", name, "--cpus", "4", "--memory", "8g", "--memory-swap", "8g", "--network", "none", "--env", "KPROFILE_TELEMETRY_DISABLED=true", "--env", "PYTHONDONTWRITEBYTECODE=1", "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--mount", "type=bind,source=" + str(ROOT) + ",target=/evidence,readonly", "--workdir", "/tmp", IMAGE, "python3", "-B", "/evidence/EXP-07F-run.py", "container"]
    record = {"startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(), **run(command, 400, ROOT)}
    output.write_text(json.dumps(record, indent=2) + "\n")
    subprocess.run(["docker", "rm", "--force", name], capture_output=True, text=True)
    print(json.dumps({"output": str(output), "exitCode": record["exitCode"], "seconds": record["seconds"], "timedOut": record["timedOut"]}))


if __name__ == "__main__":
    container() if len(sys.argv) > 1 and sys.argv[1] == "container" else host()
