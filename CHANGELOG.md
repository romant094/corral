# Changelog

Each release has a `## x.y.z` section; `scripts/release.sh` uses it as the GitHub release notes.

## 0.1.17

- Log: a commit that changes thousands of files no longer breaks the view; its file list draws only the rows in sight.
- Limits: the "Limits stale" pill is gone; the limit pills always show the latest limits a session reported.

## 0.1.16

- Board: "+ Agent" starts the new agent at the right end of the shown tab (right of its last terminal), not beside the focused one.

## 0.1.15

- Board: a card of an agent in a worktree shows its project, not the worktree path. Outside a saved project it shows the repository folder; the full path is in the tooltip.
- "+ Agent", "+ Terminal", split right and split down start at the project root, not in a worktree an agent opened.
- Telegram: a topic belongs to the Claude session, not to the terminal. Restart, Restore after a reboot and `claude --resume` keep the session's topic; a closed one opens again with "Resumed in …".
- Telegram: `/clear` and Clear all under the dashboard also delete the bot's topics that no agent holds, such as those left after Clear all in the settings. The bridge keeps the list of its topics in `telegram-topics.json`.

## 0.1.14

- Diffs (Changes, Log, file History): drag over lines, or Shift-click, to pick them; ⌘C or the "Copy N lines" button copies their text. Rows now take the whole width.

## 0.1.13

- Settings → Restore: after a restart of the computer or of the terminal server, the Claude sessions that ran start again with `claude --resume`, each in its own terminal, and the empty shells of that restart close. "Restore now" does it by hand.
- Board and pane header: ↺ restarts an agent on the same session.
- Files, Log and Changes: a project picker before the agent picker; the agent list shows that project's agents.
- Files: History shows the commits that changed the open file and its diff in each; ↑ ↓ move through them.
- Files: the tree shows files made or removed while it is open (the open folders are read again every 4 seconds).
- Log: ↑ ↓ (and Page Up/Down) move through the commits; opening Log fetches all remotes; the Paths filter finds nested folders and files; another commit opens with its folders open and no diff.
- Diffs scroll sideways to their longest line.
- Limits: a window past its reset time shows 0%; "Limits stale" shows when agents work but the statusline hook sends nothing.
- Statusline: `install.sh` checks that `statusLine` runs the hook and offers to set it; `CORRAL_STATUSLINE_CHAIN` keeps your own status line.
- The settings dialog is titled "Corral settings".

## 0.1.12

- Files: pictures (PNG, JPEG, GIF, WebP, BMP, ICO, SVG) show as pictures with their size in pixels; an SVG opens as text too. A file that is not text says "Binary file." instead of "Loading…".
- Files: what git ignores shows dimmed in the tree.
- Settings → Files: "Ignored files and folders", names the tree never shows (`.DS_Store`, `*.pyc` and others by default), as in WebStorm.
- Files: a click in the tree keeps its scroll.
- Changes: a new picture that is not committed yet no longer hides the files after it.

## 0.1.11

- Pane header: closing an agent's pane (× or Close pane in the ⋮ menu) asks "End this session?" when the agent has done work, as its card does; an agent that has not started closes at once.

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
