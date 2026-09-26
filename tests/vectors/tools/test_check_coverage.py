import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from check_coverage import check_coverage

ROOT = Path(__file__).resolve().parents[1]


class CoverageGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'cases').mkdir()
        for name in ('schema.json', 'manifest.json', 'coverage.json'):
            (self.root / name).write_bytes((ROOT / name).read_bytes())
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        for entry in manifest['files']:
            source = ROOT / entry['path']
            (self.root / entry['path']).write_bytes(source.read_bytes())
        for relative in list(manifest['toolHashes']) + list(manifest['artifactHashes']):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / relative).read_bytes())

    def rewrite(self, name, change):
        path = self.root / name
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))

    def test_required_rule_removed_is_reported(self):
        self.rewrite('coverage.json', lambda d: d['requirements'].pop('VEC-01-operation-hash'))
        with self.assertRaisesRegex(ValueError, 'VEC-01-operation-hash'):
            check_coverage(self.root)

    def test_required_case_removed_is_reported(self):
        self.rewrite('coverage.json', lambda d: d['requirements']['VEC-01-operation-hash'].remove('VEC-01-DEPOSIT'))
        with self.assertRaisesRegex(ValueError, 'VEC-01-DEPOSIT'):
            check_coverage(self.root)

    def test_missing_case_source_is_reported(self):
        self.rewrite('cases/operation.json', lambda d: d[0].update(source=''))
        with self.assertRaisesRegex(ValueError, 'VEC-01-DEPOSIT'):
            check_coverage(self.root)

    def test_missing_case_oracle_and_consumer_are_reported(self):
        self.rewrite('cases/operation.json', lambda d: d[0].update(oracle=''))
        with self.assertRaisesRegex(ValueError, 'VEC-01-DEPOSIT'):
            check_coverage(self.root)
        (self.root / 'cases/operation.json').write_bytes((ROOT / 'cases/operation.json').read_bytes())
        self.rewrite('cases/operation.json', lambda d: d[0].update(consumers=[]))
        with self.assertRaisesRegex(ValueError, 'VEC-01-DEPOSIT'):
            check_coverage(self.root)

    def test_corrupted_expected_does_not_get_overwritten(self):
        self.rewrite('cases/operation.json', lambda d: d[0]['expected'].update(operationId='0x' + 'ff'*32))
        before = (self.root / 'cases/operation.json').read_bytes()
        with self.assertRaisesRegex(ValueError, 'VEC-01-DEPOSIT'):
            check_coverage(self.root)
        self.assertEqual((self.root / 'cases/operation.json').read_bytes(), before)

    def test_source_hash_mutation_is_reported(self):
        self.rewrite('manifest.json', lambda d: d['sources'][0].update(sha256='0' * 64))
        with self.assertRaisesRegex(ValueError, 'source hash mismatch'):
            check_coverage(self.root)

    def test_generator_hash_mutation_is_reported(self):
        self.rewrite('manifest.json', lambda d: d['toolHashes'].update({'tools/oracle_v3.py': '0' * 64}))
        with self.assertRaisesRegex(ValueError, 'tool hash mismatch'):
            check_coverage(self.root)


if __name__ == '__main__':
    unittest.main()
