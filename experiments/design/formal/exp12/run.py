import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import time


IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"
FORMAL = pathlib.Path(__file__).resolve().parent.parent
EXPERIMENT = pathlib.Path(__file__).resolve().parent


def execute(command, limit, cwd=None):
    started = time.monotonic()
    try:
        done = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=limit)
        return {
            "command": command,
            "exitCode": done.returncode,
            "timedOut": False,
            "seconds": round(time.monotonic() - started, 3),
            "stdoutTail": done.stdout[-12000:],
            "stderrTail": done.stderr[-12000:],
        }
    except subprocess.TimeoutExpired as error:
        return {
            "command": command,
            "exitCode": None,
            "timedOut": True,
            "seconds": round(time.monotonic() - started, 3),
            "stdoutTail": (error.stdout or b"")[-12000:].decode(errors="replace"),
            "stderrTail": (error.stderr or b"")[-12000:].decode(errors="replace"),
        }


def inside():
    evidence = pathlib.Path("/evidence")
    output = pathlib.Path("/output")
    plan = json.loads((evidence / "exp12/plan.json").read_text())
    runtime = bytes.fromhex((evidence / "exp09/runtime.hex").read_text().strip())
    assert len(runtime) == plan["target"]["bytes"]
    assert hashlib.sha256(runtime).hexdigest() == plan["target"]["sha256"]
    project = pathlib.Path("/tmp/exp12")
    project.mkdir()
    specification = project / "direct-symbolic-spec.k"
    shutil.copy2(evidence / "exp11/direct-symbolic-spec.k", specification)
    definition = project / "kompiled"
    shutil.copytree(evidence / "out/kompiled", definition, ignore=shutil.ignore_patterns("llvm-library"))
    expected_definition = json.loads((evidence / "exp06-plan.json").read_text())["target"]["genericDefinitionSha256"]
    actual_definition = hashlib.sha256((definition / "definition.kore").read_bytes()).hexdigest()
    assert actual_definition == expected_definition
    record = {
        "startedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "targetRuntimeSha256": hashlib.sha256(runtime).hexdigest(),
        "definitionSha256": actual_definition,
    }
    record["serialization"] = execute([
        "kore-exec", str(definition / "definition.kore"), "--module", "KONTROL-MAIN",
        "--serialize", "--output", str(definition / "haskellDefinition.bin"),
    ], 120, project)
    if record["serialization"]["exitCode"] == 0:
        record["proof"] = execute([
            "kevm", "prove", str(specification),
            "--definition", str(definition), "--spec-module", "EXP11-SYMBOLIC-SPEC",
            "--save-directory", str(project / "proof"), "--no-use-booster",
            "--workers", "1", "--max-frontier-parallel", "1", "--force-sequential",
            "--reinit", "-I", "/home/user/.local/lib/python3.10/site-packages/kevm_pyk/kproj/evm-semantics",
            "-I", "/home/user/.local/lib/python3.10/site-packages/kevm_pyk/kproj/plugin",
        ], plan["limits"]["proofSeconds"], project)
    proof = project / "proof"
    if proof.exists():
        destination = output / "proof-snapshot"
        shutil.copytree(proof, destination, dirs_exist_ok=True)
        record["proofSnapshotFiles"] = [str(path.relative_to(destination)) for path in destination.rglob("*") if path.is_file()]
    record["memory"] = {
        name: pathlib.Path("/sys/fs/cgroup", name).read_text()
        for name in ["memory.max", "memory.peak", "memory.events"]
    }
    (output / "run-result.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({"result": str(output / "run-result.json"), "proof": record.get("proof", {}).get("exitCode"), "timedOut": record.get("proof", {}).get("timedOut")}))


def outside():
    if (EXPERIMENT / "run-result.json").exists():
        raise SystemExit("Refusing to overwrite EXP-12 result")
    command = [
        "docker", "run", "--rm", "--platform", "linux/amd64", "--name", "exp12-direct-v3-proof",
        "--cpus", "4", "--memory", "8g", "--memory-swap", "8g", "--network", "none",
        "--env", "KPROFILE_TELEMETRY_DISABLED=true", "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--tmpfs", "/tmp:rw,exec,size=512m,mode=1777",
        "--mount", "type=bind,source=" + str(FORMAL) + ",target=/evidence,readonly",
        "--mount", "type=bind,source=" + str(EXPERIMENT) + ",target=/output",
        IMAGE, "python3", "-B", "/evidence/exp12/run.py", "inside",
    ]
    result = execute(command, 1050)
    (EXPERIMENT / "host-run-2.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"hostExitCode": result["exitCode"], "hostTimedOut": result["timedOut"], "seconds": result["seconds"]}))


if __name__ == "__main__":
    inside() if sys.argv[1:] == ["inside"] else outside()
