import hashlib
import importlib.metadata
import json
import pathlib
import subprocess

import kontrol


package_directory = pathlib.Path(kontrol.__file__).resolve().parent
package_hashes = {
    "src/kontrol/" + str(path.relative_to(package_directory)): hashlib.sha256(
        path.read_bytes()
    ).hexdigest()
    for path in sorted(package_directory.rglob("*"))
    if path.is_file() and "__pycache__" not in path.parts
}
versions = {}
for command in [
    ["kontrol", "version"],
    ["kompile", "--version"],
    ["kore-rpc", "--version"],
    ["z3", "--version"],
    ["forge", "--version"],
]:
    completed = subprocess.run(command, capture_output=True, text=True, timeout=60)
    versions[command[0]] = {
        "exit_code": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }
print(
    json.dumps(
        {
            "versions": versions,
            "python_packages": {
                name: importlib.metadata.version(name)
                for name in ["kontrol", "kevm-pyk", "kframework"]
            },
            "kontrol_source_sha256": package_hashes,
        },
        indent=2,
    )
)
