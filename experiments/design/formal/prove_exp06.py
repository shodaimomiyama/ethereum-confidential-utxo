import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

from prove_exp05_existing import IMAGE, run_command


DIRECTORY = pathlib.Path(__file__).resolve().parent
PROJECT_NAME = "exp06-optimized"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def container_run():
    evidence = pathlib.Path("/evidence")
    source = evidence / "optimized"
    project = pathlib.Path("/tmp") / PROJECT_NAME
    project.mkdir()
    for name in ["test", "out"]:
        shutil.copytree(source / name, project / name)
    shutil.copy2(source / "foundry.toml", project / "foundry.toml")
    shutil.copytree(
        evidence / "out/kompiled", project / "out/kompiled",
        ignore=shutil.ignore_patterns("llvm-library"),
    )
    plan = json.loads((evidence / "exp06-plan.json").read_text())
    paths = {
        "harnessSourceSha256": project / "test/OptimizedVerifierRejection.t.sol",
        "harnessArtifactSha256": project / "out/OptimizedVerifierRejection.t.sol/OptimizedVerifierRejectionTest.json",
        "genericDefinitionSha256": project / "out/kompiled/definition.kore",
    }
    before = {name: sha256(path) for name, path in paths.items()}
    assert all(before[name] == plan["target"][name] for name in paths)
    serialized = run_command([
        "kore-exec", str(project / "out/kompiled/definition.kore"),
        "--module", "KONTROL-MAIN", "--serialize",
        "--output", str(project / "out/kompiled/haskellDefinition.bin"),
    ], plan["resources"]["serializationSeconds"], project)
    result = {"hashes_before": before, "serialization": serialized}
    if serialized["exit_code"] == 0 and not serialized["timed_out"]:
        result["proof"] = run_command([
            "kontrol", "prove", "--foundry-project-root", str(project),
            "--match-test", "test_rejectsWrongLeftLength", "--schedule", "BYZANTIUM",
            "--no-use-booster", "--workers", "1", "--max-frontier-parallel", "1",
            "--force-sequential", "--no-gas", "--reinit", "--hide-status-bar",
        ], plan["resources"]["proofSeconds"], project)
        result["proof_listing"] = run_command([
            "kontrol", "list", "--foundry-project-root", str(project),
        ], 60, project)
        result["proof_files"] = {
            str(path.relative_to(project)): path.read_text()
            for path in (project / "out/proofs").rglob("*.json")
        }
    result["hashes_after"] = {name: sha256(path) for name, path in paths.items()}
    result["memory"] = {
        name: pathlib.Path("/sys/fs/cgroup", name).read_text()
        for name in ["memory.max", "memory.current", "memory.peak", "memory.events"]
    }
    print(json.dumps(result))


def host_run():
    output = DIRECTORY / "exp06-proof-scalar-abi.json"
    if output.exists():
        raise SystemExit("Refusing to overwrite EXP-06 proof record")
    name = "exp06-optimized-proof-scalar-abi"
    command = [
        "docker", "run", "--rm", "--platform", "linux/amd64", "--name", name,
        "--cpus", "4", "--memory", "8g", "--memory-swap", "8g",
        "--network", "none", "--env", "KPROFILE_TELEMETRY_DISABLED=true",
        "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--tmpfs", "/tmp:rw,size=512m,mode=1777",
        "--mount", "type=bind,source=" + str(DIRECTORY) + ",target=/evidence,readonly",
        "--workdir", "/tmp", IMAGE, "python3", "-B", "/evidence/prove_exp06.py", "container",
    ]
    record = {
        "experiment": "EXP-06",
        "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **run_command(command, 750, DIRECTORY),
    }
    with output.open("x") as destination:
        json.dump(record, destination, indent=2)
        destination.write("\n")
    subprocess.run(["docker", "rm", "--force", name], capture_output=True, text=True)
    print(json.dumps({"saved": str(output), "exit_code": record["exit_code"], "timed_out": record["timed_out"]}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "container":
        container_run()
    else:
        host_run()
