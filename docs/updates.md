# Updates and maintenance

## Automatic updates

After installing the first update-enabled release, enable **Allow automatic updates** in Thunder-G’s Add-ons Manager details, or use **Check for Updates**.
Only compatible stable releases are offered; the first configured release must be published before the feed is available.

## Migrating an older installer-managed profile

Old Python installations left CSS outside the extension, so installing the XPI alone is not enough.
Quit Thunderbird and run this from the new source bundle with Python 3.9+.

```sh
python3 install.py "/path/to/profile" --upgrade
```

This backs up the installation, restores original profile styles and installs the self-updating XPI while preserving mail, tags and personal CSS.
If managed files were edited, migration stops; reconcile them with the saved originals before retrying.
Keep profile backups private.

The old ID `inline-labels@local.gmail-skin` is a separate extension: uninstall it before installing `thunder-g@vschiavoni`.
For installer-managed copies, use the old installer’s `--uninstall` first; extension-local preferences do not migrate between IDs.
Rebuild any local DKIM compatibility patch for the new ID.

## Rollback and column scripts

For installer-managed installations, quit Thunderbird and run `python3 install.py "/path/to/profile" --uninstall` to restore the saved installation.
Edited managed files block rollback; mail actions are not undone.

Optional column scripts run in Thunderbird’s Error Console: `scripts/apply-gmail-columns.js` saves one folder snapshot and `scripts/restore-columns.js` restores it.
Keep the original folder open when restoring, and preserve `gmail-skin-columns.json` before applying another layout.
Column snapshots are separate from installer rollback.

## Publishing a release

1. Add changelog notes under **Unreleased**, then run `python3 publish.py 0.14.0 --dry-run` to preview or omit `--dry-run` to prepare the version and assets.
2. Review and merge, push the matching tag, then publish a stable release in `vschiavoni/thunderbird-gmail-skin`.
3. Check that **Publish extension update assets** succeeds and the [update feed](https://github.com/vschiavoni/thunderbird-gmail-skin/releases/latest/download/updates.json) is available before announcing the release.

Publishing the release triggers tests, builds and uploads of the XPI, source ZIP, checksums and `updates.json`; a push or tag alone does not.
The release tag must contain the workflow; forks and prereleases do not publish to this channel.
Local preparation never commits, pushes, publishes or installs anything.
Keep the latest stable release’s feed and referenced XPI available, and avoid replacing an XPI already distributed to users.

Let the workflow upload the release assets rather than attaching local builds at
publication time. Re-running it keeps byte-identical assets and refuses to replace
different published files. A failed workflow must be fixed before announcing the
release. Do not mark an older release as latest: the stable feed lives on GitHub's
latest release. Automatic update delivery still requires a live published release.
