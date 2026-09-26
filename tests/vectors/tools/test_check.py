import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from shutil import copyfile

from check import check


CASE = {
    "id": "VEC-01-DEPOSIT",
    "profile": "operation-v1",
    "source": "docs/design.md#操作の結合とabi",
    "stage": "encoding",
    "input": {"raw": "0x00"},
    "expected": {"raw": "0x01"},
    "oracle": "hand-calculated",
    "consumers": ["#27"],
}


class CheckerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "cases").mkdir()
        copyfile(Path(__file__).resolve().parents[1] / "schema.json", self.root / "schema.json")
        self.write_cases([CASE])
        self.write_coverage([CASE["id"]])
        self.write_manifest()

    def write_cases(self, cases):
        (self.root / "cases" / "operation.json").write_text(json.dumps(cases))

    def write_coverage(self, ids):
        (self.root / "coverage.json").write_text(
            json.dumps({"version": 1, "rules": {"VEC-01": ids}})
        )

    def write_manifest(self):
        content = (self.root / "cases" / "operation.json").read_bytes()
        (self.root / "manifest.json").write_text(
            json.dumps({"version": 1, "files": [{
                "path": "cases/operation.json",
                "sha256": hashlib.sha256(content).hexdigest(),
                "source": "test-only",
            }]})
        )

    def test_valid_fixture_passes(self):
        self.assertEqual(check(self.root), 1)

    def test_duplicate_case_id_fails(self):
        self.write_cases([CASE, CASE])
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "VEC-01-DEPOSIT"):
            check(self.root)

    def test_invalid_hex_fails(self):
        self.write_cases([{**CASE, "input": {"raw": "0x0g"}}])
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "VEC-01-DEPOSIT"):
            check(self.root)

    def test_changed_expected_without_manifest_update_fails(self):
        self.write_cases([{**CASE, "expected": {"raw": "0x02"}}])
        with self.assertRaisesRegex(ValueError, "VEC-01-DEPOSIT"):
            check(self.root)

    def test_manifest_hash_change_fails(self):
        manifest = json.loads((self.root / "manifest.json").read_text())
        manifest["files"][0]["sha256"] = "0" * 64
        (self.root / "manifest.json").write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "VEC-01-DEPOSIT"):
            check(self.root)

    def test_coverage_missing_case_fails(self):
        self.write_coverage([])
        with self.assertRaisesRegex(ValueError, "VEC-01-DEPOSIT"):
            check(self.root)

    def test_missing_schema_fails(self):
        (self.root / "schema.json").unlink()
        with self.assertRaisesRegex(ValueError, "schema"):
            check(self.root)

    def test_nonobject_case_fails_with_context(self):
        self.write_cases(["garbage"])
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "case must be an object"):
            check(self.root)

    def test_duplicate_manifest_path_fails(self):
        path = self.root / "manifest.json"
        manifest = json.loads(path.read_text())
        manifest["files"].append(manifest["files"][0])
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "duplicate manifest path"):
            check(self.root)


if __name__ == "__main__":
    unittest.main()
