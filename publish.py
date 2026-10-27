#!/usr/bin/env python3
"""Prepare a local release; never commits, pushes, uploads, or installs."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def version_tuple(value):
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', value):
        raise ValueError('Use a version such as 0.5.1.')
    return tuple(map(int, value.split('.')))


def plan_release(root, version):
    manifest_path = root / 'thunder-g/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    old = manifest['version']
    if version_tuple(version) <= version_tuple(old):
        raise ValueError('The release version must be greater than ' + old)
    log_path = root / 'CHANGELOG.md'
    log = log_path.read_text()
    if re.search(r'^## ' + re.escape(version) + r'(?:\s|$)', log, re.M):
        raise ValueError('That release already exists in CHANGELOG.md.')
    match = re.search(r'^## Unreleased\s*\n(.*?)(?=^## |\Z)', log, re.M | re.S)
    if not match or not match.group(1).strip():
        raise ValueError('Add release notes under ## Unreleased first.')
    notes = match.group(1).strip()
    log = log[:match.start()] + '## Unreleased\n\n## ' + version + '\n\n' + notes + '\n\n' + log[match.end():]
    manifest['version'] = version
    return {manifest_path: json.dumps(manifest, indent=2) + '\n', log_path: log}



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version')
    parser.add_argument('--dry-run', action='store_true', help='Describe changes without changing files or building')
    args = parser.parse_args()
    try:
        edits = plan_release(ROOT, args.version)
        outputs = [ROOT / ('thunder-g-' + args.version + suffix) for suffix in
                   ['.xpi', '.xpi.sha256', '-source.zip', '-source.zip.sha256']]
        outputs.append(ROOT / 'updates.json')
        if any(path.exists() for path in outputs[:-1]):
            raise ValueError('Target release artifacts already exist; move them before preparing this release.')
        if args.dry_run:
            print('Would update manifest, move Unreleased notes to ' + args.version +
                  ', run tests, and create XPI/source ZIP, SHA-256 checksums and updates.json. No files changed.')
            return
        subprocess.run(['node', '--test', *map(str, sorted((ROOT / 'tests').glob('*.test.cjs')))], check=True)
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', str(ROOT / 'tests'), '-p', '*_test.py'], check=True)
        originals = {path: path.read_bytes() for path in edits}
        feed = ROOT / 'updates.json'
        previous_feed = feed.read_bytes() if feed.exists() else None
        try:
            for path, text in edits.items():
                path.write_text(text)
            subprocess.run([sys.executable, str(ROOT / 'build.py')], check=True)
            subprocess.run([sys.executable, str(ROOT / 'package.py')], check=True)
            subprocess.run([sys.executable, str(ROOT / 'release_assets.py'), '--tag', 'v' + args.version], check=True)
        except Exception:
            for path, data in originals.items():
                path.write_bytes(data)
            for path in outputs[:-1]:
                path.unlink(missing_ok=True)
            if previous_feed is None:
                feed.unlink(missing_ok=True)
            else:
                feed.write_bytes(previous_feed)
            raise
        print('Prepared local release ' + args.version + '. Nothing committed, uploaded, or installed.')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
