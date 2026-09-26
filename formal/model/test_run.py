import json
import tempfile
import unittest
from pathlib import Path

from formal.model.run import validate_build, validate_document, validate_manifest, validate_results


class EvidenceValidationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "claim.k"
        self.source.write_text("claim [label(MODEL-01-sample)]\n")
        self.log = self.root / "claim.log"
        self.log.write_text("#Top\n")
        self.lock = {"image": "example@sha256:" + "a" * 64, "k_version": "7.1.337"}
        self.claims = [
            {"id": f"MODEL-{i:02d}-sample", "group": f"MODEL-{i:02d}",
             "source": str(self.source if i == 1 else self.root / f"claim-{i}.k"),
             "module": f"UTXO-MODEL-{i:02d}",
             "requirements": ["FV-01"], "specification": "docs/specification.md#state",
             "assumptions": ["abstract authorization"], "bridges": ["#33", "#34"],
             "bridge_details": {"#33": "storage bridge", "#34": "verifier bridge"}}
            for i in range(1, 9)
        ]
        import hashlib
        for item in self.claims[1:]:
            Path(item["source"]).write_text(f"claim [label({item['id']})]\n")
        self.results = [
            {"id": item["id"], "status": "proved",
             "source_sha256": hashlib.sha256(Path(item["source"]).read_bytes()).hexdigest(),
             "log": str(self.log), "command": ["kprove", "--claims", item["id"]],
             "exit_code": 0, "duration_seconds": 1.0,
             "tool_lock": self.lock, "unproved_scope": []}
            for item in self.claims
        ]

    def test_complete_evidence(self):
        validate_manifest(self.claims)
        validate_results(self.claims, self.results, self.lock)

    def test_missing_or_duplicate_group_rejected(self):
        for bad in (self.claims[:-1], self.claims + [self.claims[0]]):
            with self.assertRaises(ValueError):
                validate_manifest(bad)

    def test_unregistered_source_claim_rejected(self):
        self.source.write_text(self.source.read_text() +
                               "claim [label(MODEL-01-unregistered)]\n")
        with self.assertRaisesRegex(ValueError, "source labels differ"):
            validate_manifest(self.claims)

    def test_missing_claim_and_partial_status_rejected(self):
        for bad in (self.results[:-1],
                    [dict(self.results[0], status="skipped")] + self.results[1:],
                    [dict(self.results[0], status="timeout")] + self.results[1:],
                    [dict(self.results[0], status="stuck")] + self.results[1:],
                    [dict(self.results[0], status="admitted")] + self.results[1:]):
            with self.assertRaises(ValueError):
                validate_results(self.claims, bad, self.lock)

    def test_zero_exit_without_top_rejected(self):
        self.log.write_text("proof omitted\n")
        with self.assertRaises(ValueError):
            validate_results(self.claims, self.results, self.lock)

    def test_compiler_warning_does_not_hide_top(self):
        self.log.write_text("#Top\n[Warning] Compiler: unused variable\n")
        validate_results(self.claims, self.results, self.lock)

    def test_missing_log_hash_and_wrong_lock_rejected(self):
        variants = [
            dict(self.results[0], log=str(self.root / "absent.log")),
            dict(self.results[0], source_sha256="0" * 64),
            dict(self.results[0], tool_lock={"image": "latest"}),
        ]
        for first in variants:
            with self.assertRaises(ValueError):
                validate_results(self.claims, [first] + self.results[1:], self.lock)

    def test_missing_traceability_rejected(self):
        for field in ("requirements", "specification", "assumptions", "bridges",
                      "bridge_details"):
            first = dict(self.claims[0])
            first[field] = [] if field != "specification" else ""
            with self.assertRaises(ValueError):
                validate_manifest([first] + self.claims[1:])

    def test_open_obligation_rejected_even_if_claims_pass(self):
        with self.assertRaisesRegex(ValueError, "undischarged"):
            validate_results(self.claims, self.results, self.lock,
                             ["arbitrary-map conservation"])

    def test_corrupt_log_reported_before_open_obligations(self):
        self.log.write_text("proof omitted\n")
        with self.assertRaisesRegex(ValueError, "prover did not emit"):
            validate_results(self.claims, self.results, self.lock,
                             ["arbitrary-map conservation"])

    def test_stale_build_rejected(self):
        with self.assertRaisesRegex(ValueError, "stale K sources"):
            validate_build({"tool_lock": self.lock, "backend": "haskell",
                            "sources": {}}, self.lock)

    def test_bytecode_hash_cannot_be_claimed_by_abstract_model(self):
        with self.assertRaisesRegex(ValueError, "bytecode hash"):
            validate_document({"claims": self.claims, "open_obligations": [],
                               "bytecode_hash": "0x" + "a" * 64})


if __name__ == "__main__":
    unittest.main()
