#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import platform
import signal
import threading
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASELINE = ROOT.parent / "bulletproof"
CACHE = BASELINE / ".cache"
LOCAL_CACHE = ROOT / ".cache"
UPSTREAM_COMMIT = "b7ec38970636d47f6b6bc0db6a3df62b188a247c"


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description="Reproduce EXP-03 using the revised profile and pinned dependencies")
    parser.add_argument("--output", default=".cache/reproduction", help="Output directory; existing evidence is not overwritten by default")
    arguments = parser.parse_args()
    output = (ROOT / arguments.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    CACHE.mkdir(exist_ok=True)
    LOCAL_CACHE.mkdir(exist_ok=True)
    environment = os.environ.copy()
    environment["EXPERIMENT_OUTPUT"] = str(output)
    environment["JAVA_TOOL_OPTIONS"] = "-Xmx2g"
    measurements = []

    def execute(label, command):
        started = time.perf_counter()
        with (output / f"{label}.log").open("w") as log:
            child = subprocess.Popen([str(part) for part in command], cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            deadline = threading.Timer(600, lambda: os.killpg(child.pid, signal.SIGKILL))
            deadline.start()
            _, status, usage = os.wait4(child.pid, 0)
            deadline.cancel()
            child.returncode = os.waitstatus_to_exitcode(status)
        measurement = {
            "phase": label,
            "command": [str(part).replace(str(ROOT), "<experiment>") for part in command],
            "seconds": time.perf_counter() - started,
            "maxResidentBytes": usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024,
            "userCpuSeconds": usage.ru_utime,
            "systemCpuSeconds": usage.ru_stime,
            "exitCode": child.returncode,
        }
        measurements.append(measurement)
        write_json(output / "measurements.json", measurements)
        print(f"{label}: exit {child.returncode}, {measurement['seconds']:.3f} s", flush=True)
        if child.returncode:
            raise RuntimeError(f"{label} failed; inspect {output / (label + '.log')}")

    for program in ["git", "npm", "node", "java", "javac", "anvil"]:
        if shutil.which(program) is None:
            raise RuntimeError(f"Required prerequisite is missing: {program}")
    versions = {}
    for program in ["node", "npm", "java", "javac", "anvil"]:
        option = "-version" if program == "java" else "--version"
        versions[program] = subprocess.run([program, option], capture_output=True, text=True, check=True).stdout.strip()
        if program == "java":
            versions[program] = subprocess.run([program, option], capture_output=True, text=True, check=True).stderr.strip()
    if not versions["anvil"].startswith("anvil Version: 1.7.1"):
        raise RuntimeError("This experiment pins Anvil 1.7.1; record a new toolchain before changing it")
    if versions["node"] != "v22.22.0" or 'version "23"' not in versions["java"]:
        raise RuntimeError("This experiment pins Node 22.22.0 and Temurin Java 23")
    write_json(output / "environment.json", {"platform": platform.platform(), "architecture": platform.machine(), "logicalCpuCount": os.cpu_count(), "tools": versions})

    upstream = CACHE / "upstream"
    if not upstream.exists():
        execute("clone", ["git", "clone", "--no-checkout", "https://github.com/leanderdulac/BulletProofLib.git", upstream])
        execute("checkout", ["git", "-C", upstream, "checkout", "--detach", UPSTREAM_COMMIT])
    current_commit = subprocess.check_output(["git", "-C", upstream, "rev-parse", "HEAD"], text=True).strip()
    if current_commit != UPSTREAM_COMMIT:
        raise RuntimeError("Upstream checkout does not match the manifest")
    subprocess.run(["git", "-C", upstream, "diff", "--exit-code"], check=True)
    if sha256(upstream / "LICENSE") != sha256(BASELINE / "UPSTREAM-LICENSE.txt"):
        raise RuntimeError("Upstream license does not match the retained license")
    execute("npm-ci", ["npm", "--prefix", BASELINE, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", CACHE / "npm"])

    maven_manifest = json.loads((BASELINE / "maven-archive.json").read_text())
    maven_archive = CACHE / "apache-maven-3.9.9-bin.tar.gz"
    archive_started = time.perf_counter()
    archive_cached = maven_archive.exists()
    if not archive_cached:
        maven_archive.write_bytes(urllib.request.urlopen(maven_manifest["url"]).read())
    if hashlib.sha512(maven_archive.read_bytes()).hexdigest() != maven_manifest["sha512"]:
        raise RuntimeError("Maven archive SHA512 mismatch")
    maven_directory = CACHE / "apache-maven-3.9.9"
    if not maven_directory.exists():
        with tarfile.open(maven_archive) as archive:
            archive.extractall(CACHE, filter="data")
    write_json(output / "maven-bootstrap.json", {"cached": archive_cached, "seconds": time.perf_counter() - archive_started, **maven_manifest})
    classpath_file = CACHE / "classpath.txt"
    execute("maven-dependencies", [maven_directory / "bin/mvn", "--batch-mode", "--no-transfer-progress", "-f", upstream / "pom.xml", f"-Dmaven.repo.local={CACHE / 'm2'}", f"-Dmdep.outputFile={classpath_file}", "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath"])
    classpath = classpath_file.read_text().strip()
    dependencies = [{"path": str(Path(filename).relative_to(CACHE / "m2")), "sha256": sha256(Path(filename))} for filename in classpath.split(os.pathsep)]
    dependencies.sort(key=lambda dependency: dependency["path"])
    expected_dependencies = json.loads((BASELINE / "java-dependencies.json").read_text())
    if dependencies != expected_dependencies:
        raise RuntimeError("Java dependency hashes do not match the initial experiment")
    write_json(output / "java-dependencies.json", dependencies)
    classes = LOCAL_CACHE / "classes"
    classes.mkdir(exist_ok=True)
    execute("java-compile", ["javac", "-d", classes, "-cp", classpath, "-sourcepath", str(ROOT / "java") + os.pathsep + str(upstream / "src/main/java"), *sorted((ROOT / "java").glob("*.java"))])
    runtime_classpath = str(classes) + os.pathsep + classpath

    execute("java-64", ["java", "-Xmx2g", "-cp", runtime_classpath, "GenerateRevisedProofs", output / "java-64.json"])
    execute("evm-64", ["node", "run-evm.cjs"])
    summary = json.loads((output / "evm-64.json").read_text())
    write_json(output / "summary.json", {
        "revisedProfileChecksSucceeded": summary["succeeded"],
        "productionAdoptionEstablished": False,
        "formalProofsCompleted": 0,
        "gasScope": "Single range proof, with a transaction harness requiring true; no UTXO logic",
    })
    source_hashes = {str(path.relative_to(ROOT)): sha256(path) for path in sorted(ROOT.rglob("*")) if path.is_file() and not any(part in [".cache", "outputs", "__pycache__"] for part in path.relative_to(ROOT).parts)}
    write_json(output / "source-hashes.json", source_hashes)
    print(json.dumps(json.loads((output / "summary.json").read_text()), indent=2))


if __name__ == "__main__":
    main()
