import datetime
import hashlib
import json
import pathlib
import shutil
import sys

from prove_exp05_existing import IMAGE, run_command


DIRECTORY = pathlib.Path(__file__).resolve().parent


def prove_in_container():
    evidence = pathlib.Path("/evidence")
    revised = evidence / "revised"
    project = pathlib.Path("/tmp/exp05-revised")
    project.mkdir()
    for name in ["src", "test", "out"]:
        shutil.copytree(revised / name, project / name)
    shutil.copy2(revised / "foundry.toml", project / "foundry.toml")
    # The reused definition contains generic EVM semantics, not old target bytecode.
    shutil.copytree(
        evidence / "out/kompiled", project / "out/kompiled",
        ignore=shutil.ignore_patterns("llvm-library"),
    )
    plan = json.loads((evidence / "exp05-revised-proof-plan.json").read_text())
    hashes_before = {name: hashlib.sha256((project / name).read_bytes()).hexdigest() for name in plan["hashes"]}
    definition_hash = hashlib.sha256((project / "out/kompiled/definition.kore").read_bytes()).hexdigest()
    assert hashes_before == plan["hashes"]
    assert definition_hash == plan["generic_definition_sha256"]
    serialization = run_command([
        "kore-exec", str(project / "out/kompiled/definition.kore"),
        "--module", "KONTROL-MAIN", "--serialize",
        "--output", str(project / "out/kompiled/haskellDefinition.bin"),
    ], plan["serialized_timeout_seconds"], project)
    observations = {
        "serialization": serialization, "hashes_before": hashes_before,
        "definition_sha256": definition_hash,
    }
    if serialization["exit_code"] == 0 and not serialization["timed_out"]:
        observations["proof"] = run_command(plan["command"], plan["timeout_seconds"], project)
        observations["proof_files"] = {
            str(path.relative_to(project)): path.read_text()
            for path in (project / "out/proofs").rglob("*.json")
        }
        observations["proof_listing"] = run_command([
            "kontrol", "list", "--foundry-project-root", str(project),
        ], 60, project)
    observations["hashes_after"] = {name: hashlib.sha256((project / name).read_bytes()).hexdigest() for name in plan["hashes"]}
    observations["definition_sha256_after"] = hashlib.sha256((project / "out/kompiled/definition.kore").read_bytes()).hexdigest()
    observations["memory"] = {
        name: pathlib.Path("/sys/fs/cgroup", name).read_text()
        for name in ["memory.max", "memory.current", "memory.peak", "memory.events"]
    }
    observations["filesystem"] = run_command(["df", "-kT", "/", "/tmp"], 10, project)
    print(json.dumps(observations, indent=2))


def prove_from_host():
    output_path = DIRECTORY / "exp05-revised-claim.json"
    if output_path.exists():
        raise SystemExit("Refusing to overwrite: " + str(output_path))
    command = [
        "docker", "run", "--rm", "--platform", "linux/amd64",
        "--name", "exp05-revised-claim", "--cpus", "4", "--memory", "8g",
        "--memory-swap", "8g", "--network", "none",
        "--env", "KPROFILE_TELEMETRY_DISABLED=true",
        "--env", "PYTHONDONTWRITEBYTECODE=1",
        "--tmpfs", "/tmp:rw,size=512m,mode=1777",
        "--mount", "type=bind,source=" + str(DIRECTORY) + ",target=/evidence,readonly",
        "--workdir", "/tmp", IMAGE, "python3", "-B", "/evidence/prove_exp05_revised.py", "container",
    ]
    record = {
        "experiment": "EXP-05 revised actual source claim",
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
