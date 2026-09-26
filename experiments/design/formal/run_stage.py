import argparse
import datetime
import json
import pathlib
import subprocess
import time


def execute_stage(name, command, timeout_seconds, working_directory):
    output_directory = pathlib.Path(__file__).resolve().parent / "outputs"
    output_directory.mkdir(exist_ok=True)
    started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    started_clock = time.monotonic()
    log_path = output_directory / (name + ".log")
    with log_path.open("w") as log_file:
        try:
            completed = subprocess.run(
                command,
                cwd=working_directory,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                timeout=timeout_seconds,
                check=False,
            )
            exit_code = completed.returncode
            status = "completed" if exit_code == 0 else "failed"
        except subprocess.TimeoutExpired:
            exit_code = None
            status = "timeout"
    record = {
        "name": name,
        "command": command,
        "working_directory": str(working_directory),
        "started_at_utc": started_at,
        "duration_seconds": round(time.monotonic() - started_clock, 3),
        "timeout_seconds": timeout_seconds,
        "exit_code": exit_code,
        "status": status,
        "log": str(log_path.relative_to(output_directory.parent)),
    }
    (output_directory / (name + ".json")).write_text(
        json.dumps(record, indent=2) + "\n"
    )
    print(json.dumps(record))
    return exit_code if exit_code is not None else 124


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("name")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--cwd", default=str(pathlib.Path.cwd()))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    command = arguments.command
    if command and command[0] == "--":
        command = command[1:]
    raise SystemExit(
        execute_stage(arguments.name, command, arguments.timeout, arguments.cwd)
    )
