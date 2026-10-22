"""Build a shareable ZIP from an explicit public-file allowlist."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

root = Path(__file__).resolve().parent
version = json.loads((root/'inline-labels/manifest.json').read_text())['version']
files = [root/name for name in ['README.md','CHANGELOG.md','LICENSE','.gitignore','install.py','build.py','package.py','publish.py']]
for folder in ['chrome','inline-labels','scripts','tests','integrations']:
    files += [p for p in (root/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc']
# Only approved documentation and assets; never include local screenshots.
files += [root/name for name in ['docs/settings.md','docs/resources/logo.png']]
output = root/f'thunder-g-{version}-source.zip'
with ZipFile(output,'w',ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, 'thunderbird-gmail-skin/' + path.relative_to(root).as_posix())
checksum=hashlib.sha256(output.read_bytes()).hexdigest()
output.with_suffix('.zip.sha256').write_text(checksum+'  '+output.name+'\n')
print(output)
print('SHA-256:',checksum)
