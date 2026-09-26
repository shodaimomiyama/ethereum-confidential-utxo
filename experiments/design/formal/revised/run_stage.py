import argparse
import datetime
import json
import pathlib
import subprocess
import time


ROOT = pathlib.Path(__file__).resolve().parent
IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["version", "build", "test"])
    arguments = parser.parse_args()
    outputs = ROOT / "outputs"
    outputs.mkdir(exist_ok=True)
    if arguments.stage == "version":
        command = ["sh", "-c", ".cache/bin/solc-0.4.19 --version && forge --version"]
    elif arguments.stage == "build":
        command = ["forge", "build", "--force"]
    else:
        command = ["forge", "test", "-vv", "--fuzz-runs", "256"]
    container_name = "exp05-revised-" + arguments.stage
    invocation = [
        "docker", "run", "--rm", "--platform", "linux/amd64", "--name", container_name,
        "--cpus", "2", "--memory", "1g", "--memory-swap", "1g",
        "--tmpfs", "/tmp:rw,size=268435456", "--env", "KPROFILE_TELEMETRY_DISABLED=true",
        "--mount", "type=bind,source=" + str(ROOT) + ",target=/workspace",
        "--workdir", "/workspace", IMAGE,
        "timeout", "--signal=TERM", "--kill-after=10s", "120s",
    ] + command
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    started = time.monotonic()
    with (outputs / (arguments.stage + ".log")).open("w") as log:
        try:
            completed = subprocess.run(invocation, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=150, check=False)
            exit_code = completed.returncode
            status = "completed" if exit_code == 0 else "failed"
        except subprocess.TimeoutExpired:
            subprocess.run(["docker", "stop", "--time", "5", container_name], capture_output=True, check=False)
            exit_code = None
            status = "host timeout"
    record = {
        "stage": arguments.stage,
        "command": invocation,
        "startedAtUtc": started_at,
        "seconds": round(time.monotonic() - started, 3),
        "containerTimeoutSeconds": 120,
        "exitCode": exit_code,
        "status": status,
        "log": "outputs/" + arguments.stage + ".log",
        "countsAsFormalProof": False,
    }
    (outputs / (arguments.stage + ".json")).write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))
    return exit_code if exit_code is not None else 124


if __name__ == "__main__":
    raise SystemExit(main())
