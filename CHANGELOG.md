# Changelog

Each release has a `## x.y.z` section; `scripts/release.sh` uses it as the GitHub release notes.

## 0.1.10

- Projects: "Add project…" opens Herdr's own folder picker, which comes up at once (the macOS dialog took seconds to start). It takes one folder and opens a space with Claude there.

## 0.1.9

- Updates: the check runs every hour, with no interval to choose; the section still shows the next check's time.

## 0.1.8

- Updates: the check interval is a choice (5 min, 15 min, 1 hour, 6 hours; default 1 hour, as VS Code and Zed), and the section shows the next check's time.
- Updates: a check asks github.com where its latest release is, outside the GitHub API's 60 requests an hour; the API is asked once per new release, for its notes.

## 0.1.7

- Telegram settings: a "Use Rich Messages" checkbox instead of the format tabs. Off sends a classic formatted message (bold, italics, code, links, quotes; headings as bold lines, tables as code) instead of Markdown as plain text.
- Telegram: the bridge reads the formatter's options at each reply, so changing them no longer restarts it.
- Telegram settings: Log opens Bridge Logs in the settings dialog (a back arrow returns), not in a terminal tab. The text can be selected; a Copy button copies all of it.

## 0.1.6

- Telegram: agents' replies go as rich messages (rendered Markdown); a long reply folds its sections, the rest stays in view.
- Telegram settings: Formatter options. Format is Rich message or Markdown (plain text); Long replies sets the fold limit (default 1200, 0 never folds) and is locked for Markdown.
- Telegram: only the text that ends a turn is posted, so a note written between tool calls no longer shows up out of order.
- Telegram: a question's "Chat about this" gets a button; preview boxes stay out of the button labels.
- Telegram: a message that replies to another one reaches the agent with a line saying which, and with that message's photo or file.
- Telegram: a persistent command keyboard in the group (/new /status /clear /stop /close /help); /help brings it back.
- Updates: Install automatically puts a found release in at once; a toast says when an update is installed or failed.
- Updates: the check uses curl with a timeout, so a hung request no longer stops later checks.
- Settings: one settings dialog at a time.

## 0.1.5

- Updates: the 6-hour check counts from the last check, not from when Corral loaded, so a reload does not push it back.
- Updates: `herdr-app do corral.updates-due` moves the last check to 5:59:50 ago, to watch the next check happen.

## 0.1.4

- Updates: a toast says when a new version is out, whichever check found it (at start, every 6 hours, Check now), once per version.

## 0.1.3

- Updates: a yellow dot on the gear and on the section when a new version is out.
- Updates: after the installed version changes, Corral checks for releases at once instead of waiting an hour.

## 0.1.2

- install.sh adds all four view keys to a new keys.json (0.1.0 and 0.1.1 added only the first).
- install.sh restarts only its own home's Telegram bridge, not one of another Herdr home.

## 0.1.1

- Updates: the first release to update to from 0.1.0, to try the update path end to end.
- Settings: the wizard's how-to lines wrap inside the dialog.

## 0.1.0

- Settings: a gear right of the plan limits opens one dialog with Telegram and Updates.
- Telegram: a guided setup. Paste the bot's token, make a new group with Topics, press "Add the bot", and Corral fills in the group and the owner by itself and runs the bridge under launchd.
- Telegram: owners by login, Restore for the root topic, Export / Import of the settings, Clear all.
- Updates: Corral checks GitHub Releases and updates itself with one click.
- The Telegram bridge: a topic per agent, status icons, replies, questions with buttons, files and photos, `/new`, `/status`, `/stop`, `/close`, `/clear`.
