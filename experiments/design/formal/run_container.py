import argparse
import pathlib

from run_stage import execute_stage


IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"
EXPERIMENT_DIRECTORY = pathlib.Path(__file__).resolve().parent


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("name")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    command = arguments.command
    if command and command[0] == "--":
        command = command[1:]
    invocation = [
        "docker", "run", "--rm", "--platform", "linux/amd64",
        "--name", "exp02-" + arguments.name,
        "--cpus", "4", "--memory", "8g", "--memory-swap", "8g",
        "--mount", "type=bind,source=" + str(EXPERIMENT_DIRECTORY) + ",target=/workspace",
        "--workdir", "/workspace", IMAGE,
        "timeout", "--signal=TERM", "--kill-after=10s", str(arguments.timeout) + "s",
    ] + command
    raise SystemExit(
        execute_stage(
            arguments.name,
            invocation,
            arguments.timeout + 30,
            EXPERIMENT_DIRECTORY,
        )
    )
