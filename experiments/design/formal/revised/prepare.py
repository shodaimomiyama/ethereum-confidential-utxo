import hashlib
import json
import pathlib
import time
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT.parent.parent / "bulletproof-revised/solidity/alt_bn128.sol"
SOURCE_SHA256 = "b5db410990b99ac6ec25dc56a85f89cc9963126af11cc8b0f9385f74015ddd7c"
SOLC_FILENAME = "solc-linux-amd64-v0.4.19+commit.c4cbbb05"
SOLC_SHA256 = "07f89753cdda28054bb6f159a21911716caeb43b3c7659a25f1f2d9dd17bc827"
IMAGE = "runtimeverificationinc/kontrol@sha256:858f004144d61b005997f56bb8b7cd15673850286c96e0e5ec0502d9c9a9e204"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    plan = json.loads((ROOT.parent / "diagnostic-plan.json").read_text())
    if plan["resources"]["revisedArtifactCompileSeconds"] != 120:
        raise RuntimeError("Recheck the revised compile resource plan before running")
    if sha256(SOURCE) != SOURCE_SHA256:
        raise RuntimeError("Revised source differs from the pinned source")
    (ROOT / "src").mkdir(exist_ok=True)
    (ROOT / "src/alt_bn128.sol").write_bytes(SOURCE.read_bytes())
    assert (ROOT / "src/alt_bn128.sol").read_bytes() == SOURCE.read_bytes()
    compiler_directory = ROOT / ".cache/bin"
    compiler_directory.mkdir(parents=True, exist_ok=True)
    compiler = compiler_directory / "solc-0.4.19"
    url = "https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/" + SOLC_FILENAME
    started = time.monotonic()
    was_cached = compiler.exists()
    if not was_cached:
        with urllib.request.urlopen(url, timeout=30) as response:
            compiler.write_bytes(response.read())
    if sha256(compiler) != SOLC_SHA256:
        raise RuntimeError("Solidity compiler SHA256 differs from official pinned release")
    compiler.chmod(0o755)
    manifest = {
        "experiment": "EXP-05 revised verifier slice preparation",
        "source": {
            "original": "../../bulletproof-revised/solidity/alt_bn128.sol",
            "copy": "src/alt_bn128.sol",
            "sha256": SOURCE_SHA256,
            "byteIdentical": True,
        },
        "claims": [
            {
                "test": "VerifierSliceTest.test_subCanonicalInputsStayCanonical(uint256,uint256)",
                "precondition": "0 <= left < q and 0 <= right < q, where q is the BN254 scalar order",
                "property": "alt_bn128.sub(left,right) < q",
                "outsidePrecondition": "The harness returns; this is not a proof that inputs outside the precondition are rejected",
            },
            {
                "test": "VerifierSliceTest.test_negZeroReturnsZero()",
                "precondition": "Argument is uint256(0)",
                "property": "alt_bn128.neg(uint256(0)) == 0",
            },
        ],
        "concreteOnly": "test_subBoundaryInputsStayCanonical checks six explicit canonical input pairs; the fuzz test uses 256 runs with a fixed seed",
        "compiler": {
            "version": "0.4.19+commit.c4cbbb05",
            "platform": "linux-amd64",
            "officialBuildList": "https://raw.githubusercontent.com/ethereum/solc-bin/gh-pages/linux-amd64/list.json",
            "url": url,
            "sha256": SOLC_SHA256,
            "keccak256": "0x7310233685fca42969a942384662203fe3150098c20a3285ed702f769873661b",
            "downloadCached": was_cached,
            "downloadAndValidationSeconds": round(time.monotonic() - started, 3),
            "optimizer": False,
            "evmVersion": "byzantium",
        },
        "runtime": {
            "image": IMAGE,
            "platform": "linux/amd64",
            "cpuLimit": 2,
            "memoryLimitBytes": 1073741824,
            "tmpfsBytes": 268435456,
            "compileTimeoutSeconds": 120,
            "concreteTestTimeoutSeconds": 120,
        },
        "formalProofRunByThisPreparation": False,
        "notEstablished": ["Any symbolic claim", "Full verifier correctness", "Cryptographic security", "Input rejection outside the stated sub precondition"],
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"prepared": True, "sourceSha256": SOURCE_SHA256, "compilerSha256": SOLC_SHA256}))


if __name__ == "__main__":
    main()
