<div align="center">
  <img src="docs/resources/logo.png" height="100px">
  <p>
<h3>Thunder-G</h3></p>
 <p><i>An experimental, independently developed Gmail-inspired skin for Thunderbird.  </i></p>
 <p><img src="https://img.shields.io/github/v/release/vschiavoni/thunderbird-gmail-skin"/></p>
</div>

> [!NOTE]
> This independent project is not affiliated with Google and requires no Gmail account. It works with your existing email provider.
> Cross-client synchronization of Exchange tags is not supported.
> Compatibility with Windows and Linux has not yet been verified.

A compact inbox, existing tags as colored chips before the subject, and a conversation reader with a Back button and message actions.

Current version: **0.8.0**. Installable package: `thunder-g-0.8.0.xpi`. The companion accepts **Thunderbird 153–158.x**.

Tested on macOS with **Thunderbird 158.0.1** and **Betterbird 153.5.0**
(Betterbird testing reported by the maintainer). Renderer hooks were inspected
against Thunderbird 158.0.1. This does not imply that every feature has been
verified on both clients; Windows and Linux remain unverified.

Release history and detailed changes are in [CHANGELOG.md](CHANGELOG.md).

## What is included

- Automatic light/dark shell, responsive pencil/Write button, and yellow stars.
- Native tag chips, searchable Labels menu, and gray snippets from locally available mail.
- Hidden From/Subject header text; native column visibility and order are respected. UI font size follows Thunderbird.
- Single-click reading in the current tab; Back restores the list; Previous/Next navigate.
- Archive, spam, delete, unread, Move, Labels, and a Follow-Up clock in the reader.
- Return to the full list after archiving, with the native preview collapsed.
- Native quick-filter chips and row actions for archive, delete, and read/unread.
- Optional Conversations styling and reversible From → Subject → Date layout scripts.

## Label picker

Press **L** in the mail browsing pane or use the Labels button. Search supports
Unicode names; use Up/Down to navigate, Space to toggle, and Escape to close.
Mixed checkboxes indicate tags assigned to only part of the selection.
Use **Create new** to open New Tag or **Manage labels** to open tag settings.

In the conversation reader, **L / Label as** acts on every displayed message,
including messages in Sent or Archive. In the list it acts on the native selection.
The × on an individual message chip removes that tag only from that message.
Loading or unresolved conversations must be retried; cross-folder writes may
partially succeed if a folder rejects an update.

## Settings

Open Add-ons Manager → Thunder-G → Preferences and enable **Hide Today Pane
completely** to hide the calendar pane, its splitter and bottom-right toggle.
The option is off by default, applies immediately and is saved across restarts.
Turning it off or disabling Thunder-G restores Thunderbird’s existing visibility
setting without changing calendar preferences.

### Independent Gmail-style reader (experimental)

Preferences → **Use Thunder-G's independent Gmail-style reader** is off by default
and applies to all mail windows. It does not require Thunderbird Conversations.
Changing the option returns any open reader to the list; open a message again.

Thunder-G owns the conversation header and expandable message cards.
The most recent message is expanded and brought into view when a conversation opens; earlier messages can be expanded individually.
Number shortcuts (1–9, and 0 to clear tags) target the active message card, including replies in Sent.
The L picker applies labels to the entire loaded conversation.
Message tags sit beside the sender; the title shows the conversation’s combined labels.
DKIM chips use the optional local DKIM Verifier compatibility bridge (see `integrations/README.md`): green for verified, amber for warnings or unavailable checks, and red for failed verification. The DKIM toolbar button is hidden in the independent reader.
A missing result is never shown as verified.
Thunderbird's local conversation index supplies messages across folders.
The reader also checks local Sent folder summaries, including custom Sent destinations, and links outgoing replies by Message-ID and References even when the global index is unavailable.
No subject-only grouping is performed.
Duplicate stored copies are shown once, preferentially retaining the selected copy.
Messages absent from local summaries or the index may remain unavailable.

Bodies load on expansion in Thunderbird's native `about:message` viewer. This
preserves its MIME handling, remote-content policy, security indicators and
attachment controls. Reply, Reply all, Forward and per-message Print delegate to
the native commands and composer. A failed message offers a native-window fallback.
The conversation toolbar continues to act on the native list selection, **not**
automatically on additional messages discovered in other folders. The L picker separately applies tags to every loaded conversation member, including Sent replies.

Styles are isolated in a shadow root. The native list, columns, row renderer,
zoom and density are not replaced. Expanded native message viewers register with
Thunderbird's font-size and density controllers. Tests use mocked interfaces;
live layout, attachments, signed/encrypted mail, and interaction verification
without Thunderbird Conversations is still required before treating this as stable.

### Draft autosave

Thunder-G Preferences → **Automatically save messages in Drafts** is enabled by
default, every minute. Choose 1, 2, 5 or 10 minutes. This configures Thunderbird's
native autosave and each account's configured Drafts destination; changes apply
to newly opened compose windows. Disabling/uninstalling Thunder-G restores the
previous native settings unless independently changed in the meantime.
New mail and Forward keep Thunderbird's native compose window.

### Reply inside the current window (experimental)

Preferences → **Reply and Reply all in this window** is off by default. When enabled, the conversation footer opens Thunderbird's full `messengercompose.xhtml` editor below the message in the current conversation. Its detach control moves the same editor into a floating panel; the return control puts it back. From the floating panel, a separate-window control saves a native draft and opens it in Thunderbird's normal compose window, closing the embedded editor only after the new window reports its body ready. Failed saves leave the embedded reply open. It passes the exact reply header, native Reply-to-Sender/Reply-All type and account identity; native code supplies recipients, quoting, signatures, HTML/plain text, attachments, encryption controls and configured draft folders. The feature does not implement its own message sending or draft serialization. Compatibility of third-party compose add-ons with an embedded document is not guaranteed.

One reply stays open while the user navigates; clicking another Reply focuses the existing editor rather than replacing unsent work. Its subject and From fields remain visible. **Save draft**, native autosave, Send and attachment controls use Thunderbird's ordinary commands. Closing the panel, its mail tab or its containing window honors native Save/Discard/Cancel handling. Disabling the option affects new replies and does not discard an open editor.

Live verification on Thunderbird 158.0.1 covered native reply identities and recipients, draft save/reopen with a test attachment, and preserving an edited reply across folder navigation. Closing a modified reply showed the native Save/Discard/Cancel dialog; Cancel retained its contents. No mail was sent. These checks were performed only in Thunderbird. Native signatures follow the selected identity; signature text was not configured in the test accounts.

### Native message pages and zoom

Preferences → **Messages per page** offers 25, 50, 100 or **All** (default).
A Gmail-style range counter and arrows navigate the original virtual list.
Paging keeps Thunderbird's original rows, columns, chips, hover actions and
native row metrics; scrolling is constrained to the selected page. Collapsed
threads count as one row. Select-all in the list selects the current page.
Disabling paging restores continuous scrolling. The folder index remains native
and complete; paging does not establish a memory-use reduction.

Outside text-entry fields, Ctrl/Cmd + plus (or equals), minus and zero invoke
Thunderbird's native interface font-size increase, decrease and reset controls.
Paging recomputes boundaries when the list or native row metrics change.
Live zoom/density/layout verification in Thunderbird is still pending.

## Requirements

Python 3.9+ for the installer/build; Node.js 18+ only to run tests. No Python or
Node packages are downloaded or required.

For the original reader, install **Thunderbird Conversations** [↗](https://addons.thunderbird.net/en-US/thunderbird/addon/gmail-conversation-view/) separately from Thunderbird's add-on
manager for the conversation cards and inline replies shown in this project.

The clock requires **mailmindr / Follow-Ups** [↗](https://addons.thunderbird.net/en-US/thunderbird/addon/mailmindr/); it opens that add-on's reminder
form.

Gmail-style snoozing is not implemented; mailmindr's icebox behavior needs its own configuration.

Tag Popup is optional: the skin uses native Thunderbird tags, including any previously created with Tag Popup.
These third-party add-ons are not bundled or automatically installed.

## Install

1. In Thunderbird, open Help → Troubleshooting Information → Profile Folder and
   locate the profile you want to customize. Quit Thunderbird completely.
2. Download and extract the source ZIP, or clone this repository.
3. In a terminal in this directory, run (replace the example path):

   ```sh
   python3 install.py "/absolute/path/to/your/Thunderbird/profile"
   ```

   On Windows use `py -3` instead of `python3` if appropriate.
4. Restart Thunderbird. Review any add-on permission prompt. Select the built-in
   System theme for automatic dark mode, Classic layout, and **Table View**. Enable threaded
   sorting. The companion starts with the message preview collapsed.
5. Optionally enable Tags folder-pane mode and the folder-pane header.

The installer builds the XPI from the included source, installs it and both CSS
files, preserves existing userChrome.css rules, and enables the custom-stylesheet
preference. It saves original affected files under `.gmail-skin-install` **inside
the selected profile**. It does not copy accounts, passwords, messages, tags,
sessions, or someone else's preferences into your profile. Do not share that
snapshot: pre-existing profile files may contain personal settings.

Alternatively build with `python3 build.py` and install the resulting XPI through
Add-ons Manager → gear → Install Add-on From File. The XPI also bundles shell and Conversations styles, loaded while the companion
is active. The installer additionally manages persistent profile CSS and rollback.

The installer places the companion permanently in the selected profile’s
`extensions` directory. It should survive restarts; temporary installation from
the debugging page is not needed. If the interface is missing after restart,
check whether Thunder-G is still enabled in Add-ons Manager and that Thunderbird
opened the same profile.

### Optional column layout

With the intended ordinary folder open, paste the entire
`scripts/apply-gmail-columns.js` into Thunderbird's Error Console and execute it.
This changes that folder's column order/visibility and shared sender/subject
widths. It saves a snapshot to `gmail-skin-columns.json` in your profile.
Only one folder snapshot is supported: preserve/rename it before configuring a
different folder. To restore, open the original folder and run
`scripts/restore-columns.js`. Column changes are separate from installer rollback.
You can also arrange columns manually using Thunderbird's column picker.

## Uninstall / rollback

Quit Thunderbird and run from this directory:

```sh
python3 install.py "/absolute/path/to/your/Thunderbird/profile" --uninstall
```

This restores the original CSS, user.js, companion package (if any), and custom
stylesheet preference, preserving the snapshot in a dated folder. It refuses to
overwrite installer-managed files edited since installation; inspect the saved
originals if that happens. Restore optional column changes separately as above.
Mail actions you performed through the toolbar are real mail actions, and are
not undone by uninstalling. Uninstall before installing a newer release.

## Source and access

`chrome/` contains presentation CSS. `inline-labels/` contains the MailExtension
and its privileged experiment. `reading.js` delegates mail actions to native
Thunderbird commands and opens the installed mailmindr scheduler. `labels.js`
reads native tag definitions/message keywords and renders chips. `build.py`
packages these sources without a network step.

The experiment has broad Thunderbird UI/profile privileges; it is more powerful
than an ordinary theme. Review the source before installing. The bundled code
has no telemetry or domain-logo network requests; mail actions use your configured
mail service normally. Compatibility can break when Thunderbird internals change.
Archive actions follow Thunderbird's selected-message/thread semantics; messages
found only by Conversations, such as additional Sent messages, are not always
included in the skin toolbar's action scope.

## Development and validation

```sh
node --test tests/*.test.cjs
python3 build.py
```

The tests use mocked Thunderbird interfaces and temporary installer profiles.
They cover presentation, row reuse, selection scope, navigation, local snippets,
component cleanup, and rollback. Run installer checks with:

```sh
python3 tests/installer_test.py
```

Live visual and interaction checks remain necessary, especially on another
Thunderbird version. See the changelog for validation limits.

Build a source ZIP and SHA-256 checksum with `python3 package.py`. Packaging uses
an explicit allowlist excluding generated packages and profile recovery data.

## Publishing to GitHub

Create a repository with this directory's contents (not a Thunderbird profile
and not the original development folder). The included MIT license allows reuse.
Keep generated XPI files out of Git history; attach the source ZIP, checksum and,
optionally, the built XPI as release assets tagged `v0.8.0`. The source ZIP is the
complete source bundle; the XPI contains the companion and its bundled styles.
Mark the first release experimental and include the compatibility/testing limits
above. No repository has been published by the package preparation step.


## Prepare a local release

Preview a version change without modifying files:

```sh
python3 publish.py 0.7.3 --dry-run
```

Prepare it with `python3 publish.py 0.7.3`. The command runs tests, updates the
manifest and README, moves Unreleased notes into the new changelog entry, and
builds XPI/source ZIP files with SHA-256 checksums. It preserves older release
notes and refuses existing target versions/artifacts. It does not commit, push,
upload, or install. Keep writing future notes under Unreleased.

Three-state reply verification: 69 automated tests pass. Live Thunderbird checks covered inline/floating transitions and native-window handoff with identity, recipient, subject and quoted body intact. The embedded editor closed only after the successor body loaded. An earlier server draft-copy failure retained the open reply. Attachments were saved/reopened in a native draft, but the separate-window attachment transfer still needs live confirmation. No mail was sent. These handoff checks were performed only in Thunderbird.

Column layouts: the reader no longer forces the selection column to be visible or first, and styling no longer hides native Tags or Spam columns. Responsive sizing reads native saved splitter widths and resets temporary preferences when the table is rebuilt. With Thunder-G enabled, Copy view also invokes Thunderbird's native column-copy operation, preserving visibility/order and the selected descendant scope. The separate native Copy columns command remains available; widths are stored globally by Thunderbird. Reply-panel actions have visible labels and panel/window icons rather than standalone arrows.
