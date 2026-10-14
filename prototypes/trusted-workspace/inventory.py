"""Bounded candidate inventory; source/data only, never browser profiles."""
import hashlib
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
GENERATED = {'index.html', 'fixture-evidence.json', 'evidence-contract.js'}
MANIFESTS = {'SOURCE-SHA256.txt', 'ARTIFACT-SHA256.txt'}


def inventory():
    files = sorted(p for p in ROOT.iterdir() if p.is_file() and p.name not in MANIFESTS)
    if any(p.is_dir() for p in ROOT.iterdir()):
        raise RuntimeError('Unexpected directory in source-only prototype')
    if any(p.is_symlink() for p in files):
        raise RuntimeError('Unexpected symlink')
    return files


def manifest(files):
    return ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files)


def main():
    if sys.argv[1:] not in [[], ['--write']]:
        raise SystemExit('Usage: inventory.py [--write]')
    files = inventory()
    expected_source = manifest([p for p in files if p.name not in GENERATED])
    if sys.argv[1:] == ['--write']:
        (ROOT/'SOURCE-SHA256.txt').write_text(expected_source)
        (ROOT/'ARTIFACT-SHA256.txt').write_text(manifest(sorted(files+[ROOT/'SOURCE-SHA256.txt'])))
    else:
        if (ROOT/'SOURCE-SHA256.txt').read_text() != expected_source:
            raise RuntimeError('Source inventory mismatch')
        if (ROOT/'ARTIFACT-SHA256.txt').read_text() != manifest(sorted(files+[ROOT/'SOURCE-SHA256.txt'])):
            raise RuntimeError('Artifact inventory mismatch')
    print(f'Inventory OK: {len(files)} source/data files, {sum(p.stat().st_size for p in files)} bytes; no runtime data')
    print('SOURCE-SHA256.txt digest: '+hashlib.sha256((ROOT/'SOURCE-SHA256.txt').read_bytes()).hexdigest())


if __name__ == '__main__':
    main()
