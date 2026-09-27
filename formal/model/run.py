#!/usr/bin/env python3
"""Fail-closed K proof evidence checker for the abstract UTXO model."""

import argparse
import hashlib
import json
import platform
import re
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "formal" / "model"
EVIDENCE = MODEL / "evidence"
GROUPS = {f"MODEL-{n:02d}" for n in range(1, 9)}
DEFINITION_SOURCES = [MODEL / name for name in ("model.k", "auth.k", "operations.k", "paths.k")]
LABEL = re.compile(r"\[label\((MODEL-\d\d-[A-Za-z0-9-]+)\)\]")
BAD_LOG = re.compile(
    r"(?i)\b(stuck|skipped|admitted|timeout|unresolved|error|partial|"
    r"WarnTrivialClaim)\b|Functional claims not yet supported|Unexpected empty set of claims"
)


def clean_top(log):
    return log.splitlines()[0:1] == ["#Top"] and not BAD_LOG.search(log)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve(path):
    path = Path(path)
    return path if path.is_absolute() else ROOT / path


def validate_manifest(claims):
    if not isinstance(claims, list) or not claims:
        raise ValueError("empty claim manifest")
    ids = [item.get("id") for item in claims]
    if len(ids) != len(set(ids)) or any(not value for value in ids):
        raise ValueError("duplicate or absent claim ID")
    groups = {item.get("group") for item in claims}
    if groups != GROUPS:
        raise ValueError(f"required groups differ: {GROUPS ^ groups}")
    by_source = {}
    for item in claims:
        if not item["id"].startswith(item["group"] + "-"):
            raise ValueError(f"claim/group mismatch: {item['id']}")
        for field in ("source", "module", "requirements", "specification",
                      "assumptions", "bridges"):
            if not item.get(field):
                raise ValueError(f"{item['id']}: missing {field}")
        if not {"#33", "#34"}.issubset(item["bridges"]):
            raise ValueError(f"{item['id']}: missing implementation bridges")
        details = item.get("bridge_details", {})
        if not isinstance(details, dict) or any(
               not isinstance(details.get(issue), str) or not details[issue].strip()
               for issue in ("#33", "#34")):
            raise ValueError(f"{item['id']}: missing bridge details")
        if not resolve(item["source"]).is_file():
            raise ValueError(f"{item['id']}: missing source")
        by_source.setdefault(str(resolve(item["source"])), set()).add(item["id"])
    for source, registered in by_source.items():
        source_text = Path(source).read_text()
        if re.search(r"\[\s*trusted\s*\]|\[[^\]]*,\s*trusted\s*\]", source_text):
            raise ValueError(f"{source}: trusted claim is not a proof")
        actual = LABEL.findall(source_text)
        if len(actual) != len(set(actual)) or set(actual) != registered:
            raise ValueError(f"{source}: source labels differ from manifest")


def validate_document(manifest):
    if manifest.get("bytecode_hash") is not None:
        raise ValueError("#32 has no verified bytecode hash")
    validate_manifest(manifest.get("claims"))
    if not isinstance(manifest.get("open_obligations"), list):
        raise ValueError("missing open-obligation register")


def validate_results(claims, results, lock, open_obligations=(), build=None):
    validate_manifest(claims)
    if not isinstance(lock, dict) or not re.fullmatch(r"[^\s]*sha256:[0-9a-f]{64}",
                                                      lock.get("image", "")):
        raise ValueError("tool image is not digest pinned")
    if not lock.get("k_version"):
        raise ValueError("missing locked K version")
    expected = {item["id"]: item for item in claims}
    if len(results) != len(expected) or {row.get("id") for row in results} != set(expected):
        raise ValueError("missing, duplicate or extra claim result")
    for row in results:
        item = expected[row["id"]]
        if row.get("status") != "proved" or row.get("exit_code") != 0:
            raise ValueError(f"{row['id']}: not proved")
        if row.get("tool_lock") != lock:
            raise ValueError(f"{row['id']}: tool lock mismatch")
        if row.get("source_sha256") != sha256(resolve(item["source"])):
            raise ValueError(f"{row['id']}: source hash mismatch")
        if build is not None and row.get("definition_sha256") != build["definition_sha256"]:
            raise ValueError(f"{row['id']}: compiled definition hash mismatch")
        if row.get("unproved_scope"):
            raise ValueError(f"{row['id']}: unproved scope")
        command = row.get("command")
        if not isinstance(command, list) or "--claims" not in command or row["id"] not in command:
            raise ValueError(f"{row['id']}: claim was not selected")
        log_path = resolve(row.get("log", ""))
        if not log_path.is_file():
            raise ValueError(f"{row['id']}: raw log missing")
        log = log_path.read_text(errors="replace")
        if not clean_top(log):
            raise ValueError(f"{row['id']}: prover did not emit clean #Top")
        if row.get("duration_seconds", -1) < 0:
            raise ValueError(f"{row['id']}: invalid duration")
    if open_obligations:
        raise ValueError(f"undischarged model obligations: {open_obligations}")


def read_json(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def validate_build(build, lock):
    if build.get("tool_lock") != lock or build.get("backend") != "haskell":
        raise ValueError("compiled definition uses a different tool lock or backend")
    expected = {str(path.relative_to(ROOT)): sha256(path) for path in DEFINITION_SOURCES}
    if build.get("sources") != expected:
        raise ValueError("compiled definition has stale K sources")
    definition = MODEL / ".cache" / "compiled" / "definition.kore"
    if not definition.is_file() or build.get("definition_sha256") != sha256(definition):
        raise ValueError("compiled definition missing or modified")


def locked_environment(lock):
    image = lock["image"]
    actual = subprocess.run(["docker", "image", "inspect", image, "--format", "{{json .RepoDigests}}"],
                            capture_output=True, text=True, check=True).stdout.strip()
    if image not in json.loads(actual):
        raise ValueError(f"Docker image digest mismatch: {actual} does not contain {image}")
    version = subprocess.run(["docker", "run", "--rm", "--platform", "linux/amd64",
                              image, "kprove", "--version"], capture_output=True,
                             text=True, check=True).stdout.strip()
    if lock["k_version"] not in version:
        raise ValueError(f"K version mismatch: {version}")
    return image


def docker_command(image, argv):
    return ["docker", "run", "--rm", "--platform", "linux/amd64",
            "--memory", "16g", "-e", "JAVA_OPTS=-Xmx8g",
            "-v", f"{ROOT}:/work", "-w", "/work", image, *argv]


def run_command(command, log_path, timeout):
    started = time.monotonic()
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
        exit_code = proc.returncode
        output = proc.stdout + proc.stderr
    except subprocess.TimeoutExpired as exc:
        exit_code = 124
        output = (exc.stdout or b"").decode(errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        output += "\nTIMEOUT\n"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(output)
    return exit_code, time.monotonic() - started


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["compile", "scenario", "prove", "check-results"])
    parser.add_argument("--group", choices=sorted(GROUPS))
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--lock", type=Path, default=ROOT / "formal" / "toolchain.lock.json")
    args = parser.parse_args()
    manifest = read_json(MODEL / "obligations.json")
    validate_document(manifest)
    claims = manifest["claims"]
    if args.command == "check-results":
        lock = read_json(args.lock)
        build = read_json(EVIDENCE / "build.json")
        validate_build(build, lock)
        validate_results(claims, read_json(EVIDENCE / "results.json"), lock,
                         manifest.get("open_obligations", []), build)
        print(f"verified {len(claims)} claim records")
        return
    if not args.lock.is_file():
        raise ValueError("#4 pinned toolchain lock unavailable; exploratory runs cannot be accepted")
    lock = read_json(args.lock)
    image = locked_environment(lock)
    definition = "formal/model/.cache/compiled"
    if args.command == "compile":
        command = docker_command(image, ["kompile", "formal/model/paths.k", "--main-module",
                                         "UTXO-PATHS", "--syntax-module", "UTXO-MODEL",
                                         "--backend", "haskell", "-o", definition])
        code, _duration = run_command(command, EVIDENCE / "compile.log", 3600)
        if code:
            raise ValueError("compilation failed; see evidence/compile.log")
        definition_path = MODEL / ".cache" / "compiled" / "definition.kore"
        write_json(EVIDENCE / "build.json", {
            "tool_lock": lock, "backend": "haskell", "command": command,
            "sources": {str(path.relative_to(ROOT)): sha256(path) for path in DEFINITION_SOURCES},
            "definition_sha256": sha256(definition_path),
            "host": platform.platform(),
        })
        return
    build = read_json(EVIDENCE / "build.json")
    validate_build(build, lock)
    if args.command == "scenario":
        command = docker_command(image, ["kprove", "formal/model/scenarios.k", "--definition",
                                         definition, "--spec-module", "UTXO-SCENARIOS"])
        code, _duration = run_command(command, EVIDENCE / "scenarios.log", 3600)
        if code or not clean_top((EVIDENCE / "scenarios.log").read_text()):
            raise ValueError("scenario proof failed; see evidence/scenarios.log")
        return
    if not args.group and not args.all:
        parser.error("prove requires --group or --all")
    selected = [item for item in claims if args.all or item["group"] == args.group]
    results = [] if args.all or not (EVIDENCE / "results.json").is_file() else read_json(EVIDENCE / "results.json")
    for item in selected:
        source = Path(item["source"])
        command = docker_command(image, ["kprove", str(source), "--definition", definition,
                                         "--spec-module", item["module"], "--claims", item["id"]])
        log_path = EVIDENCE / "logs" / f"{item['id']}.log"
        code, duration = run_command(command, log_path, 3600)
        row = {"id": item["id"], "status": "proved" if code == 0 and clean_top(log_path.read_text()) else "failed",
               "source_sha256": sha256(resolve(source)),
               "definition_sha256": build["definition_sha256"],
               "log": str(log_path.relative_to(ROOT)),
               "command": command, "exit_code": code, "duration_seconds": duration,
               "tool_lock": lock, "host": platform.platform(), "unproved_scope": []}
        results = [existing for existing in results if existing["id"] != row["id"]] + [row]
        write_json(EVIDENCE / "results.json", results)
        print(f"{item['id']}: {row['status']}", flush=True)
        if row["status"] != "proved":
            raise ValueError(f"{item['id']}: proof failed; see {log_path}")
    if args.all:
        validate_results(claims, results, lock, manifest.get("open_obligations", []), build)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
