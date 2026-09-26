import difflib
import hashlib
import json
import pathlib
import platform
import subprocess
import tarfile
import time
import urllib.request


EXPERIMENT_DIRECTORY = pathlib.Path(__file__).resolve().parent
CACHE_DIRECTORY = EXPERIMENT_DIRECTORY / ".cache"
KONTROL_CANDIDATE = "98fdebb7fce26b8764705a625cd2fbb01f27d6be"
KONTROL_RELEASE = "0ac55eda300e64ec30300117fe71c02d6db59ab5"
VERIFIER_REVISION = "b7ec38970636d47f6b6bc0db6a3df62b188a247c"
SOLC_FILENAME = "solc-linux-amd64-v0.4.26+commit.4563c3fc"
SOLC_SHA256 = "5d577b3f7918dd735ab157e2f37a21d06c90469f13868359874f15184f2fa4d0"


def calculate_sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch_archive(repository, revision):
    archive_path = CACHE_DIRECTORY / (revision + ".tar.gz")
    archive_url = "https://codeload.github.com/" + repository + "/tar.gz/" + revision
    started_clock = time.monotonic()
    with urllib.request.urlopen(archive_url) as response:
        archive_path.write_bytes(response.read())
    with tarfile.open(archive_path) as archive:
        archive.extractall(CACHE_DIRECTORY, filter="data")
    return {
        "url": archive_url,
        "sha256": calculate_sha256(archive_path),
        "bytes": archive_path.stat().st_size,
        "duration_seconds": round(time.monotonic() - started_clock, 3),
    }


def collect_hashes(source_directory, relative_directory):
    return {
        str(path.relative_to(source_directory)): calculate_sha256(path)
        for path in sorted((source_directory / relative_directory).rglob("*"))
        if path.is_file()
    }


def fetch_compiler():
    compiler_directory = CACHE_DIRECTORY / "bin"
    compiler_directory.mkdir(exist_ok=True)
    compiler_url = "https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/" + SOLC_FILENAME
    started_clock = time.monotonic()
    with urllib.request.urlopen(compiler_url) as response:
        compiler_bytes = response.read()
    compiler_hash = hashlib.sha256(compiler_bytes).hexdigest()
    if compiler_hash != SOLC_SHA256:
        raise ValueError("The downloaded Solidity compiler does not match its pinned hash")
    compiler_path = compiler_directory / "solc-0.4.26"
    compiler_path.write_bytes(compiler_bytes)
    compiler_path.chmod(0o755)
    return {
        "url": compiler_url,
        "version": "0.4.26",
        "sha256": "0x" + compiler_hash,
        "bytes": len(compiler_bytes),
        "duration_seconds": round(time.monotonic() - started_clock, 3),
    }


def prepare_sources():
    CACHE_DIRECTORY.mkdir(parents=True, exist_ok=True)
    archives = [
        fetch_archive("runtimeverification/kontrol", revision)
        for revision in [KONTROL_CANDIDATE, KONTROL_RELEASE]
    ]
    candidate_directory = CACHE_DIRECTORY / ("kontrol-" + KONTROL_CANDIDATE)
    release_directory = CACHE_DIRECTORY / ("kontrol-" + KONTROL_RELEASE)
    source_comparison = {}
    for relative_directory in ["src/kontrol", "deps"]:
        candidate_hashes = collect_hashes(candidate_directory, relative_directory)
        release_hashes = collect_hashes(release_directory, relative_directory)
        source_comparison[relative_directory] = {
            "candidate_sha256": candidate_hashes,
            "release_sha256": release_hashes,
            "changed_files": [
                path
                for path in sorted(candidate_hashes.keys() | release_hashes.keys())
                if candidate_hashes.get(path) != release_hashes.get(path)
            ],
        }
    for relative_path in ["pyproject.toml", "Dockerfile", "uv.lock"]:
        candidate_path = candidate_directory / relative_path
        release_path = release_directory / relative_path
        source_comparison[relative_path] = {
            "candidate_sha256": calculate_sha256(candidate_path),
            "release_sha256": calculate_sha256(release_path),
            "diff": "".join(
                difflib.unified_diff(
                    release_path.read_text().splitlines(True),
                    candidate_path.read_text().splitlines(True),
                    fromfile="release/" + relative_path,
                    tofile="candidate/" + relative_path,
                )
            ),
        }
    source_directory = EXPERIMENT_DIRECTORY / "src"
    source_directory.mkdir(exist_ok=True)
    upstream_url = (
        "https://raw.githubusercontent.com/leanderdulac/BulletProofLib/"
        + VERIFIER_REVISION
        + "/truffle/contracts/alt_bn128.sol"
    )
    with urllib.request.urlopen(upstream_url) as response:
        (source_directory / "alt_bn128.sol").write_bytes(response.read())
    license_url = (
        "https://raw.githubusercontent.com/leanderdulac/BulletProofLib/"
        + VERIFIER_REVISION
        + "/LICENSE"
    )
    with urllib.request.urlopen(license_url) as response:
        (EXPERIMENT_DIRECTORY / "UPSTREAM-LICENSE.txt").write_bytes(response.read())
    compiler = fetch_compiler()
    docker_memory = subprocess.run(
        ["docker", "info", "--format", "{{.MemTotal}}"],
        capture_output=True,
        text=True,
        check=True,
    )
    output_directory = EXPERIMENT_DIRECTORY / "outputs"
    output_directory.mkdir(exist_ok=True)
    (output_directory / "solc-download.json").write_text(json.dumps(compiler, indent=2) + "\n")
    manifest = {
        "experiment": "EXP-02",
        "status": "prepared",
        "image": "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204",
        "image_tag": "ubuntu-jammy-1.0.255",
        "platform": {
            "container": "linux/amd64",
            "host_system": platform.system(),
            "host_architecture": platform.machine(),
        },
        "candidate_commit": KONTROL_CANDIDATE,
        "release_commit": KONTROL_RELEASE,
        "source_archives": archives,
        "source_comparison": source_comparison,
        "verifier": {
            "repository": "https://github.com/leanderdulac/BulletProofLib",
            "revision": VERIFIER_REVISION,
            "url": upstream_url,
            "local_path": "src/alt_bn128.sol",
            "sha256": calculate_sha256(source_directory / "alt_bn128.sol"),
            "changes": [],
        },
        "compiler": compiler,
        "resources": {
            "container_cpu_limit": 4,
            "container_memory_limit_bytes": 8589934592,
            "docker_vm_memory_bytes": int(docker_memory.stdout.strip()),
            "claim_timeout_seconds": 600,
            "official_recommended_memory_bytes": 17179869184,
            "official_recommended_swap_bytes": 17179869184,
            "resource_note": "The Docker VM memory is recorded separately from the container limit. No host or Docker settings are changed. This is a bounded slice experiment; exhaustion is inconclusive.",
        },
        "scope": [
            "Upstream scalar sub with canonical inputs: canonical result and equality modulo scalar order",
            "Upstream scalar neg at zero: witness against canonical output",
            "Upstream precompile wrapper failure and EVM call rollback",
        ],
        "excluded": [
            "Whole Bulletproof verifier correctness or cryptographic soundness",
            "Confidential UTXO core authorization, withdrawals, and state machine",
            "Native ARM performance",
        ],
        "sources": [
            "https://docs.runtimeverification.com/kontrol/overview/readme/installations",
            "https://docs.docker.com/build/building/multi-platform/",
            "https://hub.docker.com/v2/repositories/runtimeverificationinc/kontrol/tags/ubuntu-jammy-1.0.255",
        ],
    }
    (EXPERIMENT_DIRECTORY / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    print(json.dumps({"status": "prepared", "verifier_sha256": manifest["verifier"]["sha256"]}))


if __name__ == "__main__":
    prepare_sources()
