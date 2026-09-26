import datetime
import hashlib
import json
import pathlib
import subprocess
import time


IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"
DIRECTORY = pathlib.Path(__file__).resolve().parent
DEFINITION = DIRECTORY / "out/kompiled/definition.kore"


def run_pair():
    output_path = DIRECTORY / "exp05-paired-serialization.json"
    if output_path.exists():
        raise SystemExit("Refusing to overwrite: " + str(output_path))
    definition_hash = hashlib.sha256(DEFINITION.read_bytes()).hexdigest()
    inside_script = r'''
import hashlib, json, pathlib, subprocess, time
command = ["kore-exec", "/evidence/out/kompiled/definition.kore", "--module", "KONTROL-MAIN", "--serialize", "--output", "/tmp/exp05-actual.bin"]
started = time.monotonic()
completed = subprocess.run(command, capture_output=True, text=True, timeout=60)
serialized = pathlib.Path("/tmp/exp05-actual.bin")
print(json.dumps({
    "command": command, "duration_seconds": round(time.monotonic()-started, 3),
    "exit_code": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr,
    "serialized_bytes": serialized.stat().st_size if serialized.exists() else None,
    "serialized_sha256": hashlib.sha256(serialized.read_bytes()).hexdigest() if serialized.exists() else None,
    "memory": {name:pathlib.Path("/sys/fs/cgroup",name).read_text() for name in ["memory.max","memory.peak","memory.events"]},
    "df": subprocess.run(["df","-kT","/","/tmp"],capture_output=True,text=True).stdout,
    "inodes": subprocess.run(["df","-i","/","/tmp"],capture_output=True,text=True).stdout
}, indent=2))
'''
    observations = []
    for use_tmpfs in [False, True]:
        command = [
            "docker", "run", "--rm", "--platform", "linux/amd64",
            "--name", "exp05-paired-" + str(use_tmpfs).lower(),
            "--cpus", "4", "--memory", "8g", "--memory-swap", "8g", "--network", "none",
            "--mount", "type=bind,source=" + str(DIRECTORY) + ",target=/evidence,readonly",
            "--workdir", "/tmp",
        ]
        if use_tmpfs:
            command += ["--tmpfs", "/tmp:rw,size=512m,mode=1777"]
        command += [IMAGE, "python3", "-c", inside_script]
        started = time.monotonic()
        completed = subprocess.run(command, capture_output=True, text=True, timeout=90)
        observations.append({
            "tmpfs": use_tmpfs, "command": command,
            "duration_seconds": round(time.monotonic() - started, 3),
            "exit_code": completed.returncode,
            "stdout": completed.stdout, "stderr": completed.stderr,
        })
    record = {
        "experiment": "EXP-05",
        "recorded_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "definition_sha256_before": definition_hash,
        "definition_sha256_after": hashlib.sha256(DEFINITION.read_bytes()).hexdigest(),
        "observations": observations,
    }
    with output_path.open("x") as output:
        json.dump(record, output, indent=2)
        output.write("\n")
    for observation in observations:
        print(json.dumps({"tmpfs": observation["tmpfs"], **json.loads(observation["stdout"])}))


if __name__ == "__main__":
    run_pair()
