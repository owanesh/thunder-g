# Settings

Open **Add-ons Manager → Thunder-G → Preferences**.

## Inbox

- **Messages per page** — Limit the list to 25, 50 or 100 messages; `All messages` is the default.
- **Hide Today Pane** — Hide the calendar pane and its toggle; `off` by default.
- **Show thread connection lines** — Connect replies in expanded threads; `on` by default.

Threaded message views start with threads collapsed. Use a thread's arrow to expand or collapse it; subsequent mail updates preserve threads you opened manually.

## Conversations and writing

The conversation reader and in-window writing are **experimental** and `off` by default.

Disable **Thunderbird Conversations** before enabling the reader or in-window replies.

- **Use Thunder-G’s conversation reader** — Group related mail, including locally available sent replies, with the newest message expanded.
- **Write new messages in this window** — Open a resizable floating composer that remembers its size and can expand or move to a separate window.
- **Reply in this window** — Open replies below the conversation, with an option to detach them.
- **Automatically save drafts** — Save to the account’s Drafts folder; on by default, with **✓ Saved** shown after a successful save.
- **Save every** — Choose 1, 2, 5 or 10 minutes; the default is 1 minute and changes apply to newly opened composers.

These composers use Thunderbird’s signatures, attachments and drafts, and keep the sidebar visible.
Forward still opens a separate window.

## Sender logos

**Show sender logos with BIMI** is off by default and requires aligned DKIM success through the [local DKIM integration](../integrations/README.md), not just an ordinary DKIM Verifier installation.
It looks up BIMI in DNS and downloads the advertised HTTPS SVG; **the logo host can see your IP address**.
Contact photos take priority, and missing logos leave the usual avatar in place.
Results are cached for one hour per session; disabling the option stops new downloads.
