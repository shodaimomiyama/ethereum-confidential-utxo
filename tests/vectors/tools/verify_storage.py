"""Read-only independent Python KDF and AEAD check for published storage vectors."""
import base64
import hashlib
import json
import sys
from pathlib import Path

from Crypto.Cipher import AES


def unhex(value):
    return bytes.fromhex(value.removeprefix('0x'))


def verify_saved_storage_cases(path: Path) -> int:
    cases = json.loads(path.read_text())
    checked = 0
    for case in cases:
        if case['expected']['decision'] != 'accept':
            continue
        source = case['input']
        expected = case['expected']
        key = hashlib.scrypt(source['passphrase'].encode('utf-8'),
                             salt=unhex(source['salt']), n=131072, r=8, p=1,
                             dklen=32, maxmem=268435456)
        if key != unhex(expected['key']):
            raise ValueError(f"{case['id']}: independent scrypt key mismatch")
        cipher = AES.new(key, AES.MODE_GCM, nonce=unhex(source['nonce']), mac_len=16)
        cipher.update(unhex(source['rawHeaderBytes']))
        ciphertext, tag = cipher.encrypt_and_digest(unhex(source['plaintext']))
        if ciphertext != unhex(expected['ciphertext']) or tag != unhex(expected['tag']):
            raise ValueError(f"{case['id']}: independent AES-GCM mismatch")
        outer = json.loads(unhex(expected['outerBytes']).decode('utf-8'))
        for field, value in [('header', unhex(source['rawHeaderBytes'])),
                             ('ciphertext', ciphertext), ('tag', tag)]:
            if base64.b64decode(outer[field], validate=True) != value:
                raise ValueError(f"{case['id']}: outer {field} mismatch")
        checked += 1
    if checked == 0:
        raise ValueError('no accepted storage cases')
    return checked


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    try:
        count = verify_saved_storage_cases(root / 'cases/storage.json')
    except (ValueError, KeyError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
    print(f'Independent Python storage cross-check: {count} envelopes')
