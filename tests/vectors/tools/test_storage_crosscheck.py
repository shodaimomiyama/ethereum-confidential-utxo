import unittest
import json
import tempfile
from pathlib import Path

from verify_storage import verify_saved_storage_cases

ROOT = Path(__file__).resolve().parents[1]


class StorageCrosscheckTests(unittest.TestCase):
    def test_python_cryptographic_crosscheck_of_saved_envelopes(self):
        self.assertEqual(verify_saved_storage_cases(ROOT / 'cases/storage.json'), 5)

    def test_changed_tag_is_detected_without_overwriting_fixture(self):
        cases = json.loads((ROOT / 'cases/storage.json').read_text())
        cases[0]['expected']['tag'] = '0x' + '00' * 16
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'storage.json'
            path.write_text(json.dumps(cases))
            before = path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'VEC-08-ENVELOPE'):
                verify_saved_storage_cases(path)
            self.assertEqual(path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
