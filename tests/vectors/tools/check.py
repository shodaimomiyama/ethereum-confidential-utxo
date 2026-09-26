"""Read-only structural and digest checks for published vector cases."""

import hashlib
import json
import re
import sys
from pathlib import Path


HEX_BYTES = re.compile(r"^0x(?:[0-9a-f]{2})*$")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_bytes(value, case_id: str) -> None:
    if isinstance(value, dict):
        for child in value.values():
            validate_bytes(child, case_id)
    elif isinstance(value, list):
        for child in value:
            validate_bytes(child, case_id)
    elif isinstance(value, str) and value.startswith("0x"):
        if not HEX_BYTES.fullmatch(value):
            raise ValueError(f"{case_id}: noncanonical hex bytes: {value!r}")


def validate_case(case: dict, schema: dict) -> None:
    if not isinstance(case, dict):
        raise ValueError("case must be an object")
    case_id = case.get("id", "<missing id>")
    required = set(schema["required"])
    allowed = set(schema["properties"])
    if missing := required - set(case):
        raise ValueError(f"{case_id}: missing fields: {sorted(missing)}")
    if unknown := set(case) - allowed:
        raise ValueError(f"{case_id}: unknown fields: {sorted(unknown)}")
    if not isinstance(case_id, str) or not re.fullmatch(
        schema["properties"]["id"]["pattern"], case_id
    ):
        raise ValueError(f"{case_id}: invalid case ID")
    for key in ("profile", "source", "stage", "oracle"):
        if not isinstance(case[key], str) or not case[key]:
            raise ValueError(f"{case_id}: invalid {key}")
    for key in ("input", "expected"):
        if not isinstance(case[key], dict):
            raise ValueError(f"{case_id}: invalid {key}")
    if not isinstance(case["consumers"], list) or not case["consumers"] or any(
        not isinstance(consumer, str) or not consumer for consumer in case["consumers"]
    ):
        raise ValueError(f"{case_id}: invalid consumers")
    validate_bytes(case, case_id)


def check(root: Path) -> int:
    schema_path = root / "schema.json"
    if not schema_path.is_file():
        raise ValueError("schema.json is missing")
    schema = json.loads(schema_path.read_text())
    manifest = json.loads((root / "manifest.json").read_text())
    coverage = json.loads((root / "coverage.json").read_text())
    if manifest.get("version") != 1 or coverage.get("version") != 1:
        raise ValueError("unsupported manifest or coverage version")
    files = {entry["path"]: entry for entry in manifest["files"]}
    if len(files) != len(manifest["files"]):
        raise ValueError("duplicate manifest path")
    case_paths = sorted((root / "cases").glob("*.json")) if (root / "cases").exists() else []
    if set(files) != {str(path.relative_to(root)) for path in case_paths}:
        raise ValueError("case file not tracked by manifest, or manifest entry missing file")
    cases = {}
    for path in case_paths:
        relative = str(path.relative_to(root))
        data = json.loads(path.read_text())
        if not isinstance(data, list):
            raise ValueError(f"{relative}: cases must be an array")
        first_id = data[0].get("id", relative) if data and isinstance(data[0], dict) else relative
        if sha256_file(path) != files[relative]["sha256"]:
            raise ValueError(f"{first_id}: source hash mismatch in {relative}")
        for case in data:
            validate_case(case, schema)
            if case["id"] in cases:
                raise ValueError(f"{case['id']}: duplicate case ID")
            cases[case["id"]] = case
    mapped = set()
    for rule, ids in coverage["rules"].items():
        if not re.fullmatch(r"VEC-0[1-8]", rule) or not isinstance(ids, list):
            raise ValueError(f"invalid coverage rule: {rule}")
        for case_id in ids:
            if case_id not in cases:
                raise ValueError(f"{case_id}: coverage references missing case")
            mapped.add(case_id)
    if missing := set(cases) - mapped:
        raise ValueError(f"{sorted(missing)[0]}: case is absent from coverage")
    for case in cases.values():
        if base := case.get("baseCase"):
            if base not in cases:
                raise ValueError(f"{case['id']}: missing baseCase {base}")
    return len(cases)


if __name__ == "__main__":
    try:
        count = check(Path(__file__).resolve().parents[1])
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
    print(f"Integrity valid: {count} cases" + ("; coverage pending" if count == 0 else ""))
