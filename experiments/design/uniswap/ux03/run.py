#!/usr/bin/env python3
"""Measure the existing EXP-08 Java range prover; this is not a DO benchmark."""
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "crypto-profile-v3" / "exp08"
CACHE = HERE / ".cache"
UPSTREAM = CACHE / "upstream"
COMMIT = "b7ec38970636d47f6b6bc0db6a3df62b188a247c"
JARS = {
    "gson-2.8.1.jar": ("https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.8.1/gson-2.8.1.jar", "4f65e7dca6528d644031c43d159f1614f2ed58db7daf75f1e91a9fc1b57818d4"),
    "bcprov-jdk15on-1.57.jar": ("https://repo.maven.apache.org/maven2/org/bouncycastle/bcprov-jdk15on/1.57/bcprov-jdk15on-1.57.jar", "4c7fb5f7fb043fedc4b7e7af88871050f61af8dea7aaade87f8ebd60e509cd89"),
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(command, cwd=HERE):
    subprocess.run(command, cwd=cwd, check=True)

def main():
    (CACHE / "jars").mkdir(parents=True, exist_ok=True)
    if not UPSTREAM.exists():
        run(["git", "clone", "--quiet", "https://github.com/leanderdulac/BulletProofLib.git", str(UPSTREAM)])
    run(["git", "checkout", "--quiet", "--detach", COMMIT], UPSTREAM)
    assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=UPSTREAM, text=True).strip() == COMMIT
    jars = []
    for name, (url, expected) in JARS.items():
        path = CACHE / "jars" / name
        if not path.exists():
            urllib.request.urlretrieve(url, path)
        assert sha(path) == expected, name
        jars.append(str(path))
    classes = CACHE / "classes"
    classes.mkdir(exist_ok=True)
    cp = os.pathsep.join(jars)
    java_sources = sorted((SOURCE / "java").glob("*.java"))
    run(["javac", "-d", str(classes), "-cp", cp, "-sourcepath", os.pathsep.join([str(SOURCE / "java"), str(UPSTREAM / "src/main/java")]), *map(str, java_sources)])
    command = ["java", "-Xmx2g", "-cp", os.pathsep.join([str(classes), cp]), "GenerateRevisedProofs", str(HERE / "proof-output.json")]
    started = time.perf_counter()
    with (HERE / "prover.log").open("w") as log:
        process = subprocess.Popen(command, cwd=SOURCE, stdout=log, stderr=subprocess.STDOUT)
        _, status, usage = os.wait4(process.pid, 0)
    elapsed = time.perf_counter() - started
    exit_code = os.waitstatus_to_exitcode(status)
    proof = json.loads((HERE / "proof-output.json").read_text()) if exit_code == 0 else None
    result = {
        "experiment": "UX-03",
        "outcome": "partial-only" if exit_code == 0 else "prover-failed",
        "subject": "EXP-08 Java v3 range prover and local verifier, not complete reward operation",
        "inputs": ["v=1,r=42", "v=2^64,r=42", "v=1,r=0", "v=2^64+1,r=42 (negative case)"],
        "versions": {"java": subprocess.run(["java", "-version"], capture_output=True, text=True).stderr.splitlines()[0], "sourceCommit": COMMIT, "gson": "2.8.1", "bcprov": "1.57", "platform": platform.platform()},
        "sourceHashes": {str(p.relative_to(SOURCE)): sha(p) for p in java_sources},
        "command": command,
        "cwd": str(SOURCE),
        "measurement": {"wallSeconds": elapsed, "userCpuSeconds": usage.ru_utime, "systemCpuSeconds": usage.ru_stime, "maxResidentBytes": usage.ru_maxrss if sys.platform == "darwin" else usage.ru_maxrss * 1024, "exitCode": exit_code},
        "proofChecks": None if proof is None else {"allExpectedJavaOutcomesSatisfied": proof.get("allExpectedJavaOutcomesSatisfied"), "cases": [{"label": p["label"], "proverMilliseconds": p["proverMilliseconds"], "javaVerifierAccepted": p["javaVerifierAccepted"]} for p in proof["proofs"]]},
        "cloudflareLimitsSources": ["https://developers.cloudflare.com/durable-objects/platform/limits/", "https://developers.cloudflare.com/workers/platform/limits/"],
        "unverified": ["No TypeScript/WASM port of v3 prover in repository", "No real reward operation implementation: packet, authorization signature, raw transaction, and Pool binding absent", "Java execution is not Cloudflare workerd execution", "JVM RSS includes runtime and cannot be compared directly to a V8 isolate memory limit", "No deployed Workers Free measurement; external deployment prohibited"]
    }
    (HERE / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"outcome": result["outcome"], "measurement": result["measurement"], "proofChecks": result["proofChecks"]}, indent=2))
    if exit_code:
        raise SystemExit(exit_code)

if __name__ == "__main__":
    main()
