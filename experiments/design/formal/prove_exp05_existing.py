import datetime
import hashlib
import json
import os
import pathlib
import shutil
import signal
import subprocess
import sys
import time


DIRECTORY = pathlib.Path(__file__).resolve().parent
IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"


def run_command(command, timeout_seconds, working_directory):
    started = time.monotonic()
    process = subprocess.Popen(
        command, cwd=working_directory, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        os.killpg(process.pid, signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    return {
        "command": command, "timeout_seconds": timeout_seconds,
        "duration_seconds": round(time.monotonic() - started, 3),
        "exit_code": process.returncode, "timed_out": timed_out,
        "stdout": stdout, "stderr": stderr,
    }


def prove_in_container():
    evidence = pathlib.Path("/evidence")
    project = pathlib.Path("/tmp/exp05-project")
    project.mkdir()
    for name in ["src", "test", "out"]:
        # The Haskell-only proof does not load the separately compiled LLVM backend.
        shutil.copytree(evidence / name, project / name, ignore=shutil.ignore_patterns("llvm-library"))
    shutil.copy2(evidence / "foundry.toml", project / "foundry.toml")
    plan = json.loads((evidence / "exp05-proof-plan.json").read_text())
    hashes_before = {name: hashlib.sha256((project / name).read_bytes()).hexdigest() for name in plan["hashes"]}
    assert hashes_before == plan["hashes"]
    serialization = run_command([
        "kore-exec", str(project / "out/kompiled/definition.kore"),
        "--module", "KONTROL-MAIN", "--serialize",
        "--output", str(project / "out/kompiled/haskellDefinition.bin"),
    ], 60, project)
    observations = {"serialization": serialization, "hashes_before": hashes_before}
    if serialization["exit_code"] == 0 and not serialization["timed_out"]:
        observations["proof"] = run_command(plan["command"], 600, project)
        observations["proof_files"] = {
            str(path.relative_to(project)): path.read_text()
            for path in (project / "out/proofs").rglob("*.json")
        }
        observations["proof_listing"] = run_command([
            "kontrol", "list", "--foundry-project-root", str(project),
        ], 60, project)
    observations["hashes_after"] = {name: hashlib.sha256((project / name).read_bytes()).hexdigest() for name in plan["hashes"]}
    observations["memory"] = {
        name: pathlib.Path("/sys/fs/cgroup", name).read_text()
        for name in ["memory.max", "memory.current", "memory.peak", "memory.events"]
    }
    observations["filesystem"] = run_command(["df", "-kT", "/", "/tmp"], 10, project)
    print(json.dumps(observations, indent=2))


def prove_from_host():
    output_path = DIRECTORY / "exp05-existing-claim.json"
    if output_path.exists():
        raise SystemExit("Refusing to overwrite: " + str(output_path))
    command = [
        "docker", "run", "--rm", "--platform", "linux/amd64",
        "--name", "exp05-existing-claim", "--cpus", "4", "--memory", "8g",
        "--memory-swap", "8g", "--network", "none",
        "--tmpfs", "/tmp:rw,size=512m,mode=1777",
        "--mount", "type=bind,source=" + str(DIRECTORY) + ",target=/evidence,readonly",
        "--workdir", "/tmp", IMAGE, "python3", "/evidence/prove_exp05_existing.py", "container",
    ]
    record = {
        "experiment": "EXP-05",
        "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **run_command(command, 750, DIRECTORY),
    }
    with output_path.open("x") as output:
        json.dump(record, output, indent=2)
        output.write("\n")
    print(json.dumps({"saved": str(output_path), "exit_code": record["exit_code"], "duration_seconds": record["duration_seconds"], "stderr": record["stderr"]}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "container":
        prove_in_container()
    else:
        prove_from_host()
