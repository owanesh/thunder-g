"""Exercise real installer file writes in temporary profiles; no live profile access."""
import importlib.util
from pathlib import Path
import tempfile
import json
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def test_round_trip_with_existing_customization(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder)
            (profile / 'chrome').mkdir()
            (profile / 'prefs.js').write_text('user_pref("' + installer.PREF + '", false);\nuser_pref("other", 7);\n')
            (profile / 'user.js').write_text('user_pref("existing", true);\n')
            (profile / 'chrome/userChrome.css').write_text('@charset "UTF-8";\n/* custom */\n')
            originals={name:(profile/name).read_bytes() if (profile/name).exists() else None for name in installer.FILES}
            installer.install(profile)
            self.assertTrue((profile/installer.ADDON).exists())
            loader=(profile/'chrome/userChrome.css').read_text()
            self.assertTrue(loader.startswith('@charset "UTF-8";'))
            self.assertEqual(loader.encode(), originals['chrome/userChrome.css'])
            with self.assertRaises(RuntimeError): installer.install(profile)
            # Simulate Thunderbird persisting the installed setting and other changes.
            (profile/'prefs.js').write_text('user_pref("' + installer.PREF + '", true);\nuser_pref("other", 8);\n')
            installer.uninstall(profile)
            for name, data in originals.items():
                self.assertEqual((profile/name).read_bytes() if (profile/name).exists() else None,data)
            self.assertIn('true', (profile/'prefs.js').read_text())
            self.assertIn('"other", 8', (profile/'prefs.js').read_text())

    def test_new_profile_and_conflict_protection(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder); (profile/'prefs.js').write_text('')
            installer.install(profile)
            self.assertFalse((profile/'chrome/userChrome.css').exists())
            self.assertFalse((profile/'user.js').exists())
            addon=profile/installer.ADDON; installed=addon.read_bytes()
            addon.write_bytes(b'independent update')
            with self.assertRaises(RuntimeError): installer.uninstall(profile)
            addon.write_bytes(installed)
            installer.uninstall(profile)
            self.assertFalse(addon.exists())
            self.assertEqual((profile/'prefs.js').read_text(),'')

    def test_updated_addon_is_backed_up_before_explicit_uninstall(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder); (profile/'prefs.js').write_text('')
            installer.install(profile)
            (profile/installer.ADDON).write_bytes(b'updated companion')
            with self.assertRaises(RuntimeError): installer.uninstall(profile)
            loader=profile/'chrome/userChrome.css'; loader.parent.mkdir(exist_ok=True)
            loader.write_text('/* user edit */')
            installer.uninstall(profile, allow_addon_change=True)
            self.assertFalse((profile/installer.ADDON).exists())
            self.assertEqual(loader.read_text(),'/* user edit */')
            backups=list(profile.glob(installer.STATE+'-restored-*/before-uninstall/'+installer.ADDON))
            self.assertEqual(len(backups),1)
            self.assertEqual(backups[0].read_bytes(),b'updated companion')

    def test_repeated_uninstall_and_missing_state_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder); (profile/'prefs.js').write_text('user_pref("other", 7);')
            installer.uninstall(profile)
            self.assertFalse((profile/installer.STATE).exists())
            (profile/'chrome').mkdir()
            loader=profile/'chrome/userChrome.css'
            loader.write_text('@import url("gmail-header-polish.css");\n/* personal */\n')
            addon=profile/installer.ADDON; addon.parent.mkdir(); addon.write_bytes(b'updated')
            installer.uninstall(profile, allow_addon_change=True)
            self.assertEqual(loader.read_text(),'/* personal */\n')
            self.assertFalse(addon.exists())
            self.assertEqual((profile/'prefs.js').read_text(),'user_pref("other", 7);')
            backup=list(profile.glob(installer.STATE+'-cleanup-*/'+installer.ADDON))
            self.assertEqual(backup[0].read_bytes(),b'updated')
            installer.uninstall(profile)

    def test_legacy_identity_requires_explicit_migration(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder)
            (profile/'prefs.js').write_text('')
            old=profile/installer.LEGACY_ADDON
            old.parent.mkdir()
            old.write_bytes(b'legacy extension')
            with self.assertRaisesRegex(RuntimeError, 'previous inline-labels'):
                installer.install(profile)
            self.assertEqual(old.read_bytes(), b'legacy extension')
            self.assertFalse((profile/installer.STATE).exists())
            self.assertFalse((profile/installer.ADDON).exists())

class InstallFailureTests(unittest.TestCase):
    def test_partial_package_write_restores_existing_addon_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);(profile/'prefs.js').write_text('')
            addon=profile/installer.ADDON;addon.parent.mkdir();addon.write_bytes(b'previous addon')
            copy=installer.shutil.copy2
            def fail(source,target,*args,**kwargs):
                if Path(source).parent==installer.ROOT and Path(target)==addon:
                    addon.write_bytes(b'partial');raise OSError('partial write')
                return copy(source,target,*args,**kwargs)
            with patch.object(installer.shutil,'copy2',side_effect=fail):
                with self.assertRaisesRegex(OSError,'partial write'):installer.install(profile)
            self.assertEqual(addon.read_bytes(),b'previous addon')
            self.assertFalse((profile/installer.STATE).exists())
            self.assertEqual(len(list(profile.glob(installer.STATE+'-failed-*'))),1)
            installer.install(profile)
            installer.uninstall(profile)
            self.assertEqual(addon.read_bytes(),b'previous addon')


def legacy_profile(profile):
    (profile/'prefs.js').write_text('user_pref("'+installer.PREF+'", true);\nuser_pref("other", 7);\n')
    installer.install(profile)
    state=profile/installer.STATE; record=json.loads((state/'state.json').read_text())
    record.pop('mode');record['preference']='false'
    originals={'chrome/userChrome.css':'/* personal rules */\n', 'user.js':'// personal preferences\n',
               'chrome/gmail-inspired.css':None,'chrome/gmail-columns.css':None}
    for name,original in originals.items():
        target=profile/name;target.parent.mkdir(parents=True,exist_ok=True)
        record['before'][name]=original is not None
        if original is not None:
            saved=state/'before'/name;saved.parent.mkdir(parents=True,exist_ok=True);saved.write_text(original)
        target.write_text((original or '')+'/* old managed style */\n')
        record['after'][name]=installer.digest(target)
    (state/'state.json').write_text(json.dumps(record))
    return originals


class MigrationTests(unittest.TestCase):
    def test_migration_retires_owned_styles_preserves_originals_and_keeps_native_preferences(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);originals=legacy_profile(profile)
            for name in ['accounts.json','extension-settings.json']:(profile/name).write_text('untouched')
            installer.upgrade(profile)
            for name,original in originals.items():
                self.assertEqual((profile/name).read_text() if (profile/name).exists() else None,original)
            self.assertIn('false',(profile/'prefs.js').read_text())
            self.assertIn('"other", 7',(profile/'prefs.js').read_text())
            for name in ['accounts.json','extension-settings.json']:self.assertEqual((profile/name).read_text(),'untouched')
            state=json.loads((profile/installer.STATE/'state.json').read_text())
            self.assertEqual(state['mode'],'extension-only');self.assertEqual(list(state['after']),[installer.ADDON])
            self.assertEqual(len(list(profile.glob(installer.STATE+'-upgrade-*'))),1)
            installer.upgrade(profile) # Repeating the migration does not touch restored styles.
            self.assertEqual((profile/'chrome/userChrome.css').read_text(),originals['chrome/userChrome.css'])
            installer.uninstall(profile)
            self.assertEqual((profile/'chrome/userChrome.css').read_text(),originals['chrome/userChrome.css'])

    def test_modified_styles_stop_before_any_write(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);legacy_profile(profile)
            (profile/'chrome/userChrome.css').write_text('personal change')
            state=(profile/installer.STATE/'state.json').read_bytes();addon=(profile/installer.ADDON).read_bytes()
            with self.assertRaisesRegex(RuntimeError,'Managed styles changed'):installer.upgrade(profile)
            self.assertEqual((profile/installer.STATE/'state.json').read_bytes(),state)
            self.assertEqual((profile/installer.ADDON).read_bytes(),addon)
            self.assertFalse(list(profile.glob(installer.STATE+'-upgrade-*')))

    def test_failed_upgrade_restores_files_and_installer_state(self):
        with tempfile.TemporaryDirectory() as folder:
            profile=Path(folder);legacy_profile(profile)
            names=installer.FILES+['prefs.js',installer.STATE+'/state.json']
            before={name:(profile/name).read_bytes() for name in names}
            copy=installer.shutil.copy2
            def failing_copy(source,target,*args,**kwargs):
                if Path(source).parent==installer.ROOT and str(source).endswith('.xpi') and Path(target)==profile/installer.ADDON:
                    raise OSError('test write failure')
                return copy(source,target,*args,**kwargs)
            with patch.object(installer.shutil,'copy2',side_effect=failing_copy):
                with self.assertRaisesRegex(OSError,'test write failure'):installer.upgrade(profile)
            for name,data in before.items():self.assertEqual((profile/name).read_bytes(),data,name)

if __name__ == '__main__': unittest.main()
