<div align="center"> <img src="docs/resources/logo.png" height="100px" alt="Thunder-G logo"> <h3>Thunder-G</h3> <p><i>An experimental, independently developed Gmail-inspired skin for Thunderbird.</i></p> <p><img src="https://img.shields.io/github/v/release/vschiavoni/thunderbird-gmail-skin" alt="Latest release"></p>
</div>

A compact inbox, searchable and nested labels, and optional conversation and in-window writing features, built around Thunderbird’s native messages, tags and composer.
Works with your existing email accounts; no Gmail account is required.

Thunder-G is experimental and independently developed, with no affiliation with Google.

Current version: **0.12.1**.
Installable package: `thunder-g-0.12.1.xpi`.
Supported versions: **Thunderbird 153–158.x**.
See the [changelog](CHANGELOG.md) for release history.

## What you can do

- Keep a compact inbox with light and dark styling, native columns, message previews, quick filters and row actions.
- Use native tags as colored labels, organize them into nested groups, search with **L**, and click a chip to find matching mail across folders.
- Read conversations in the current tab, including locally available sent replies, and return to the inbox with Back.
- Optionally write new messages and replies in the same window, with Thunderbird’s signatures, attachments and drafts, while keeping the folder sidebar visible.
- Choose pagination, thread connection lines, draft autosave and optional sender logos in [settings](docs/settings.md).

## Install

1. Download `thunder-g-0.12.1.xpi` from the [official releases](https://github.com/vschiavoni/thunderbird-gmail-skin/releases).
2. Open **Add-ons Manager → gear → Install Add-on From File**, select the XPI and review the permission prompt.
3. Use **Table View**, enable threaded sorting and select the built-in **System theme** for automatic light and dark styling.
4. Open **Add-ons Manager → Thunder-G → Preferences** to choose optional features.

**Disable Thunderbird Conversations before enabling Thunder-G’s conversation reader or Reply in this window.**
Thunder-G provides its own conversation handling for these experimental features.
The original reader can use [Thunderbird Conversations](https://addons.thunderbird.net/en-US/thunderbird/addon/gmail-conversation-view/) separately.

From **0.12.1**, compatible stable releases use Thunderbird’s native automatic updater.
Keep automatic add-on updates enabled.
The update feed becomes available after the first configured stable release is published successfully.
Older Python-installer installations need a one-time [profile-CSS migration](docs/updates.md#migrating-an-older-installer-managed-profile).

The Follow-Up clock requires [mailmindr](https://addons.thunderbird.net/en-US/thunderbird/addon/mailmindr/) and opens its reminder form.
Gmail-style snoozing is not implemented.
Third-party add-ons are not bundled or installed automatically.

## Compatibility and privacy

Tested on macOS with **Thunderbird 158.0.1** and **Betterbird 153.5.0**, with Betterbird testing reported by the maintainer.
This does not mean every feature has been verified on both clients.
Windows and Linux remain unverified, and cross-client synchronization of Exchange tags is not supported.

The extension uses privileged Thunderbird interfaces and can require adjustments when Thunderbird internals change.
The bundled code has no telemetry.
Optional [BIMI sender logos](docs/settings.md#sender-logos) perform DNS lookups and download remote images; native updates contact GitHub.
Mail actions use your configured mail service.

## Documentation

- [Settings](docs/settings.md)
- [Labels and conversation scope](docs/labels.md)
- [Updates and migration](docs/updates.md)
- [Development and tests](docs/development.md)

Contributions are welcome under the [MIT license](LICENSE).
