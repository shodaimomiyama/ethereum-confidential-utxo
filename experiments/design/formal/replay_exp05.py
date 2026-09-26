import argparse
import datetime
import json
import os
import pathlib
import subprocess

from prove_exp05_existing import run_command


DIRECTORY = pathlib.Path(__file__).resolve().parent
SUCCESSFUL_RECORDS = {
    "legacy-sub": "exp05-existing-claim-offline.json",
    "revised-neg-zero": "exp05-revised-claim.json",
    "revised-sub": "exp05-revised-sub-claim.json",
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=SUCCESSFUL_RECORDS)
    parser.add_argument("--record", required=True)
    arguments = parser.parse_args()
    record_name = pathlib.Path(arguments.record)
    if record_name.name != arguments.record or record_name.suffix != ".json":
        raise SystemExit("--record must be a new JSON basename within this experiment")
    output_path = DIRECTORY / record_name
    if output_path.exists():
        raise SystemExit("Refusing to overwrite: " + str(output_path))
    original = json.loads((DIRECTORY / SUCCESSFUL_RECORDS[arguments.case]).read_text())
    command = original["command"].copy()
    container_name = "exp05-replay-" + arguments.case + "-" + str(os.getpid())
    command[command.index("--name") + 1] = container_name
    command[command.index("--mount") + 1] = "type=bind,source=" + str(DIRECTORY) + ",target=/evidence,readonly"
    record = {
        "experiment": "EXP-05 replay", "case": arguments.case,
        "original_record": SUCCESSFUL_RECORDS[arguments.case],
        "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **run_command(command, 750, DIRECTORY),
    }
    # A timed-out Docker client must not leave this experiment's proof running.
    cleanup = subprocess.run(
        ["docker", "rm", "--force", container_name],
        capture_output=True, text=True, timeout=30,
    )
    record["owned_container_cleanup"] = {
        "exit_code": cleanup.returncode, "stdout": cleanup.stdout, "stderr": cleanup.stderr,
    }
    with output_path.open("x") as output:
        json.dump(record, output, indent=2)
        output.write("\n")
    print(json.dumps({"saved": str(output_path), "exit_code": record["exit_code"]}))


if __name__ == "__main__":
    main()
