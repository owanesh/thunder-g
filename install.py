#!/usr/bin/env python3
"""Install or undo the skin in an explicitly selected Thunderbird profile."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime

ROOT = Path(__file__).resolve().parent
PREF = 'toolkit.legacyUserProfileCustomizations.stylesheets'
ADDON = 'extensions/thunder-g@vschiavoni.xpi'
LEGACY_ADDON = 'extensions/inline-labels@local.gmail-skin.xpi'
FILES = ['chrome/userChrome.css', 'chrome/gmail-inspired.css',
         'chrome/gmail-columns.css', 'user.js', ADDON]
STATE = '.gmail-skin-install'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def ensure_closed():
    if sys.platform == 'win32':
        result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq thunderbird.exe'],
                                capture_output=True, text=True, check=True)
        running = 'thunderbird.exe' in result.stdout.lower()
    else:
        result = subprocess.run(['pgrep', '-if', r'(^|/)(thunderbird|Thunderbird)(-bin)?([[:space:]]|$)'], capture_output=True)
        if result.returncode not in (0, 1):
            raise RuntimeError('Could not check Thunderbird process state.')
        running = result.returncode == 0
    if running:
        raise RuntimeError('Quit Thunderbird completely, then retry.')


def install(profile):
    state = profile / STATE
    if state.exists():
        raise RuntimeError('Skin already installed. Use --upgrade for the one-time automatic-update migration.')
    if (profile / LEGACY_ADDON).exists():
        raise RuntimeError('Uninstall the previous inline-labels extension before installing Thunder-G under its new ID.')
    subprocess.run([sys.executable, str(ROOT / 'build.py')], check=True)
    version = json.loads((ROOT / 'inline-labels/manifest.json').read_text())['version']
    target = profile / ADDON
    state.mkdir()
    record = {'version': version, 'mode': 'extension-only', 'preference': None,
              'before': {ADDON: target.exists()}, 'after': {}}
    if target.exists():
        backup = state / 'before' / ADDON
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.copy2(ROOT / f'thunder-g-{version}.xpi', target)
    except Exception:
        if record['before'][ADDON]:
            shutil.copy2(state / 'before' / ADDON, target)
        else:
            target.unlink(missing_ok=True)
        record['after'] = {ADDON: digest(target)}
        (state / 'state.json').write_text(json.dumps(record, indent=2))
        state.rename(profile / (STATE + '-failed-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f')))
        raise
    record['after'] = {ADDON: digest(target)}
    (state / 'state.json').write_text(json.dumps(record, indent=2))
    print('Installed extension with bundled styles. Restart Thunderbird; future releases use native automatic updates.')


def upgrade(profile):
    """Replace the XPI and retire only unchanged installer-managed profile CSS."""
    state = profile / STATE
    if not (state / 'state.json').is_file():
        install(profile)
        return
    record = json.loads((state / 'state.json').read_text())
    legacy = record.get('mode') != 'extension-only'
    styles = [name for name in FILES if name != ADDON and name in record['after']] if legacy else []
    conflicts = [name for name in styles if digest(profile / name) != record['after'][name]]
    if conflicts:
        raise RuntimeError('Managed styles changed; preserve/reconcile them before migrating: ' + ', '.join(conflicts))
    # Check every original before writing anything.
    for name in styles:
        if record['before'][name] and not (state / 'before' / name).is_file():
            raise RuntimeError('Missing original file for migration: ' + name)
    subprocess.run([sys.executable, str(ROOT / 'build.py')], check=True)
    version = json.loads((ROOT / 'inline-labels/manifest.json').read_text())['version']
    backup = profile / (STATE + '-upgrade-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    affected = styles + [ADDON, 'prefs.js']
    existed = {name: (profile / name).exists() for name in affected}
    for name in affected:
        if existed[name]:
            saved = backup / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(profile / name, saved)
    shutil.copytree(state, backup / 'installer-state')
    try:
        for name in styles:
            target = profile / name
            if record['before'][name]:
                shutil.copy2(state / 'before' / name, target)
            else:
                target.unlink(missing_ok=True)
        if legacy and 'user.js' in styles:
            prefs = profile / 'prefs.js'
            text = prefs.read_text()
            pattern = r'user_pref\("' + re.escape(PREF) + r'",\s*(true|false)\);\n?'
            current = re.search(pattern, text)
            if current and current.group(1) == 'true':
                text = re.sub(pattern, '', text)
                if record.get('preference') is not None:
                    text += '\nuser_pref("' + PREF + '", ' + record['preference'] + ');\n'
                prefs.write_text(text)
        target = profile / ADDON
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / f'thunder-g-{version}.xpi', target)
        record.update(version=version, mode='extension-only', after={ADDON: digest(target)})
        (state / 'state.json').write_text(json.dumps(record, indent=2))
    except Exception:
        for name in affected:
            target = profile / name
            if existed[name]:
                shutil.copy2(backup / name, target)
            else:
                target.unlink(missing_ok=True)
        shutil.copy2(backup / 'installer-state/state.json', state / 'state.json')
        raise
    print('Upgraded to extension-only automatic updates. Migration backup:', backup)


def uninstall_without_state(profile):
    # With no snapshot, remove only identifiable skin files/rules. Preserve
    # general stylesheet preferences: their pre-installation value is unknown.
    changes = {}
    for name in ['chrome/gmail-inspired.css', 'chrome/gmail-columns.css',
                 'chrome/gmail-header-polish.css', ADDON]:
        if (profile / name).is_file():
            changes[name] = None
    imports = re.compile(r'^\s*@import\s+url\([\"\'](?:gmail-inspired|gmail-columns|gmail-header-polish)\.css[\"\']\);[ \t]*\r?\n?', re.MULTILINE)
    marker = re.compile(r'^user_pref\("' + re.escape(PREF) + r'", true\); // gmail-skin[ \t]*\r?\n?', re.MULTILINE)
    for name, pattern in [('chrome/userChrome.css', imports), ('user.js', marker)]:
        target = profile / name
        if target.is_file():
            text = target.read_text()
            cleaned = pattern.sub('', text)
            if cleaned != text:
                changes[name] = cleaned
    if not changes:
        print('Skin already uninstalled; no managed files or rules remain.')
        return
    backup = profile / (STATE + '-cleanup-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    # Back up every affected file before making any change.
    for name in changes:
        saved = backup / name
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(profile / name, saved)
    for name, text in changes.items():
        target = profile / name
        if text is None:
            target.unlink()
        else:
            target.write_text(text)
    print('Skin remnants removed; unrelated settings preserved. Backup:', backup)


def uninstall(profile, allow_addon_change=False):
    state = profile / STATE
    if not (state / 'state.json').is_file():
        uninstall_without_state(profile)
        return
    record = json.loads((state / 'state.json').read_text())
    # Use the recorded paths so snapshots remain restorable after file renames.
    managed_files = list(record['after'])
    changed = [name for name in managed_files if digest(profile / name) != record['after'][name]]
    conflicts = [name for name in changed if not (allow_addon_change and name == ADDON)]
    if conflicts:
        raise RuntimeError('Files changed since installation; refusing to overwrite: ' + ', '.join(conflicts)
                           + '. Saved originals are in ' + str(state / 'before'))
    if allow_addon_change and ADDON in changed and (profile / ADDON).exists():
        backup = state / 'before-uninstall' / ADDON
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(profile / ADDON, backup)
        print('Updated companion backed up:', backup)
    for name in managed_files:
        target = profile / name
        if record['before'][name]:
            shutil.copy2(state / 'before' / name, target)
        elif target.exists():
            target.unlink()
    if record.get('mode') != 'extension-only':
        # user.js is applied at startup, so also undo its persisted preference value.
        prefs = profile / 'prefs.js'
        text = prefs.read_text()
        pattern = r'user_pref\("' + re.escape(PREF) + r'",\s*(true|false)\);\n?'
        text = re.sub(pattern, '', text)
        if record['preference'] is not None:
            text += '\nuser_pref("' + PREF + '", ' + record['preference'] + ');\n'
        prefs.write_text(text)
    state.rename(profile / (STATE + '-restored-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f')))
    print('Previous installation restored. Restart Thunderbird.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('profile', type=Path, help='Existing profile folder containing prefs.js')
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--uninstall', action='store_true')
    action.add_argument('--upgrade', action='store_true', help='Migrate managed profile styles to the self-updating XPI')
    parser.add_argument('--allow-addon-change', action='store_true',
                        help='With --uninstall, back up an updated companion and allow its removal/restoration')
    args = parser.parse_args()
    if args.allow_addon_change and not args.uninstall:
        parser.error('--allow-addon-change requires --uninstall')
    profile = args.profile.expanduser().resolve()
    if not (profile / 'prefs.js').is_file():
        parser.error('Choose an existing Thunderbird profile containing prefs.js.')
    try:
        ensure_closed()
        if args.uninstall:
            uninstall(profile, allow_addon_change=args.allow_addon_change)
        elif args.upgrade:
            upgrade(profile)
        else:
            install(profile)
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
