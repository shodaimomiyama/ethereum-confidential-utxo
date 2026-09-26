import hashlib
import json
from pathlib import Path


P = 21888242871839275222246405745257275088696311157297823662689037894645226208583
ROOT = Path(__file__).resolve().parent
vectors = json.loads((ROOT / "vectors.json").read_text())

expected_roles = [("blindingBase", 1, 1), ("valueBase", 2, 1), ("vectorG", 3, 64), ("vectorH", 4, 64)]
expected_labels = [
    (name, index, b"ECU" + bytes([2, code]) + index.to_bytes(4, "big"))
    for name, code, count in expected_roles
    for index in range(count)
]
assert vectors["generatorCount"] == len(expected_labels) == 130
assert len(vectors["generators"]) == 130
assert vectors["dstAscii"] == "ECU_BP_BN254_G1_V2"

seen = set()
digest = hashlib.sha256()
for entry, (role, index, label) in zip(vectors["generators"], expected_labels):
    assert (entry["role"], entry["index"], entry["inputHex"]) == (role, index, label.hex())
    x_bytes = bytes.fromhex(entry["xHex"])
    y_bytes = bytes.fromhex(entry["yHex"])
    assert len(x_bytes) == len(y_bytes) == 32
    x, y = int.from_bytes(x_bytes, "big"), int.from_bytes(y_bytes, "big")
    assert 0 <= x < P and 0 <= y < P
    assert x != 0 or y != 0
    assert (y * y - x * x * x - 3) % P == 0
    assert (x, y) not in seen
    seen.add((x, y))
    digest.update(x_bytes)
    digest.update(y_bytes)

assert digest.hexdigest() == vectors["orderedSha256"]
print(json.dumps({"checked": len(seen), "orderedSha256": digest.hexdigest()}))
