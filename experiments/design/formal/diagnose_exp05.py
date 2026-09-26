import datetime
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time


IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"
EXPERIMENT_DIRECTORY = pathlib.Path(__file__).resolve().parent


def execute_command(command, timeout_seconds=60, environment=None):
    started = time.monotonic()
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True,
            timeout=timeout_seconds, env=environment,
        )
        observation = {
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "status": "completed" if completed.returncode == 0 else "failed",
        }
    except subprocess.TimeoutExpired as error:
        observation = {
            "exit_code": None, "status": "timeout",
            "stdout": (error.stdout or b"").decode(errors="replace"),
            "stderr": (error.stderr or b"").decode(errors="replace"),
        }
    return {
        "command": command, "timeout_seconds": timeout_seconds,
        "duration_seconds": round(time.monotonic() - started, 3),
        **observation,
    }


def write_new_json(path, record):
    # EXP-02 is retained as evidence; a repeated run must use a fresh path.
    with pathlib.Path(path).open("x") as output:
        json.dump(record, output, indent=2)
        output.write("\n")


def diagnose_container():
    scratch = pathlib.Path("/tmp/exp05")
    scratch.mkdir()
    minimal = scratch / "minimal.txt"
    minimal.write_text("[]\nmodule EXP05\n  sort SortExp05{} []\nendmodule []\n")
    inspected_paths = ["/tmp", "/var/tmp", os.environ.get("TMPDIR", "/tmp")]
    inspection = {
        "runtime": execute_command(["uname", "-a"]),
        "tool_paths": {name: shutil.which(name) for name in ["kore-exec", "kore-rpc", "strace", "ghc", "runghc", "z3"]},
        "environment": {name: os.environ.get(name) for name in ["TMPDIR", "TMP", "TEMP", "KORE_EXEC_OPTS", "GHCRTS"]},
        "directory_status": {path: {"exists": pathlib.Path(path).exists(), "writable": os.access(path, os.W_OK)} for path in inspected_paths},
        "memory_before": {name: pathlib.Path("/sys/fs/cgroup", name).read_text() for name in ["memory.max", "memory.current", "memory.events"]},
        "meminfo": pathlib.Path("/proc/meminfo").read_text(),
        "binary_sha256": hashlib.sha256(pathlib.Path(shutil.which("kore-exec")).read_bytes()).hexdigest(),
    }
    probes = []
    for command in [["kore-exec", "--version"], ["kore-exec", "--help"], ["kontrol", "version"]]:
        probes.append(execute_command(command, 30))
    command = ["kore-exec", str(minimal), "--module", "EXP05", "--serialize", "--output", str(scratch / "serialized.bin")]
    probes.append(execute_command(command, 30))
    probes.append(execute_command(command + ["--no-bug-report", "--log-level", "debug"], 30))
    environment = dict(os.environ, TMPDIR=str(scratch))
    probe = execute_command(command + ["--no-bug-report", "--log-level", "debug"], 30, environment)
    probe["environment_override"] = {"TMPDIR": str(scratch)}
    probes.append(probe)
    probes.append(execute_command(["kore-exec", "/tmp/exp05/missing.txt", "--module", "EXP05", "--serialize", "--output", str(scratch / "missing.bin"), "--no-bug-report", "--log-level", "debug"], 30, environment))
    probes.append(execute_command(["kore-exec", "/evidence/out/kompiled/definition.kore", "--module", "KONTROL-MAIN", "--serialize", "--output", str(scratch / "actual.bin"), "--no-bug-report", "--log-level", "debug"], 60, environment))
    inspection["probes"] = probes
    inspection["scratch_files"] = [{"path": str(path), "bytes": path.stat().st_size} for path in scratch.rglob("*") if path.is_file()]
    inspection["memory_after"] = {name: pathlib.Path("/sys/fs/cgroup", name).read_text() for name in ["memory.current", "memory.peak", "memory.events"]}
    print(json.dumps(inspection, indent=2))


def diagnose_host():
    output_path = EXPERIMENT_DIRECTORY / "exp05-runtime-diagnostic.json"
    if output_path.exists():
        raise SystemExit("Refusing to overwrite: " + str(output_path))
    info = json.loads(subprocess.check_output(["docker", "info", "--format", "{{json .}}"], text=True))
    command = [
        "docker", "run", "--rm", "--platform", "linux/amd64", "--name", "exp05-runtime-diagnostic",
        "--cpus", "4", "--memory", "8g", "--memory-swap", "8g", "--network", "none",
        "--mount", "type=bind,source=" + str(EXPERIMENT_DIRECTORY) + ",target=/evidence,readonly",
        "--workdir", "/tmp", IMAGE, "python3", "/evidence/diagnose_exp05.py", "container",
    ]
    record = {
        "experiment": "EXP-05",
        "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "docker": {key: info[key] for key in ["OperatingSystem", "Architecture", "NCPU", "MemTotal", "ServerVersion", "KernelVersion"]},
        "host": execute_command(["uname", "-a"]),
        "native_tool_paths": {name: shutil.which(name) for name in ["kontrol", "kore-exec", "nix", "qemu-system-aarch64", "multipass", "limactl", "orb"]},
        "diagnostic": execute_command(command, 300),
    }
    write_new_json(output_path, record)
    print(json.dumps({"saved": str(output_path), "docker": record["docker"], "exit_code": record["diagnostic"]["exit_code"]}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "container":
        diagnose_container()
    else:
        diagnose_host()
