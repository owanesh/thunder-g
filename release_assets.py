"""Generate native update metadata for a built, versioned GitHub release."""
import argparse
import hashlib
import json
from pathlib import Path
import re
from zipfile import ZipFile

REPOSITORY = 'vschiavoni/thunderbird-gmail-skin'
UPDATE_URL = f'https://github.com/{REPOSITORY}/releases/latest/download/updates.json'
ADDON_ID = 'thunder-g@vschiavoni'


def generate(root, tag):
    manifest = json.loads((root / 'thunder-g/manifest.json').read_text())
    version = manifest['version']
    if not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version) or tag != 'v' + version:
        raise ValueError('Release tag must match the manifest version exactly.')
    gecko = manifest['browser_specific_settings']['gecko']
    if gecko['id'] != ADDON_ID or gecko.get('update_url') != UPDATE_URL:
        raise ValueError('Unexpected extension identity or update URL.')
    xpi = root / f'thunder-g-{version}.xpi'
    with ZipFile(xpi) as archive:
        if json.loads(archive.read('manifest.json')) != manifest:
            raise ValueError('Built XPI does not match the source manifest. Rebuild it first.')
    checksum = hashlib.sha256(xpi.read_bytes()).hexdigest()
    entry = {'version': version,
             'update_link': f'https://github.com/{REPOSITORY}/releases/download/{tag}/{xpi.name}',
             'update_hash': 'sha256:' + checksum,
             'applications': {'gecko': {key: gecko[key] for key in
                                      ['strict_min_version', 'strict_max_version'] if key in gecko}}}
    result = {'addons': {ADDON_ID: {'updates': [entry]}}}
    (root / 'updates.json').write_text(json.dumps(result, indent=2) + '\n')
    xpi.with_suffix('.xpi.sha256').write_text(checksum + '  ' + xpi.name + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    try:
        generate(Path(__file__).resolve().parent, args.tag)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, str(error) + '\n')
