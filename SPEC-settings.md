# Spec: Corral Settings — V1

Status: approved

Modules: `settings-form`, `tg-settings`, `auto-update` (`keys-settings` was removed after the pilot) (see [CAPABILITY-MAP.md](CAPABILITY-MAP.md)).
One form, so one spec; each module has its own part and its own success criteria.

## Objective

Today Corral is set up by hand: `telegram.json` is written in a terminal, the bridge is started with
`node`, keys are edited in `keys.json`, and a new version means a new `git pull` and `install.sh`.
A person who installed Corral from the Herdr gallery has no clone and no idea where these files are.

V1 adds a gear button to Corral's header. It opens one settings form with three sections:

1. **Telegram.** The person turns on "Work through Telegram", goes through a wizard and starts the
   bridge with a button. The bridge then runs under launchd, also after a restart of the Mac.
2. **Keys.** The person changes the four keys that switch Board, Files, Log and Changes.
3. **Updates.** Corral says when a new release is out and updates itself by one click.

More sections come later. The form must take a new section without a change to the others.

### User stories

- As the owner, I open the settings from the header and see all sections in one place.
- As the owner, I connect Corral to Telegram without a terminal: I paste the token, pick the group
  from a list, pick the root topic and press "Start".
- As the owner, I see if the bridge runs, and I can stop or restart it from the form.
- As the owner, I turn "Work through Telegram" off, and the bridge stops and does not come back after a restart.
- As the owner, I bind Board to another chord by pressing that chord, and the form tells me when the chord is taken.
- As the owner, I put the four keys back to the defaults with one button.
- As a user from the gallery, I get a toast "Corral 0.5.0 is out" with an "Update" button, and after a
  click the new version runs without a terminal.
- As the owner (developer), my `--link` install never updates itself.

## Facts and things to verify

Verified:

- The mod runs programs with `exec` (used for `git` and `osascript`) and reads files with `readTextFile` and `fs.readdir`.
- Shared keys (`setShared`) are stored by Herdr and survive restarts. Every copy of the mod redraws on a write.
- The header block is 123 px high. Row one ends with the plan limit pills (`main.js`, `header()`).
- `mods/corral/keys.json` has the section `layout:corral` with `cmd-alt-1…4` → `corral.board|files|log|changes`.
  `install.sh` merges it into the person's `~/.config/herdr-app/keys.json` and keeps their own keys.
  `cmd-1…9`, `ctrl-1…9` and `cmd-shift-3/4` are taken.
- The bridge reads `telegram.json` and writes `telegram-state.json` with `daemon.status`, `daemon.heartbeat_at` (every 30 s),
  `daemon.error`, `chats` (groups it saw) and `topics` (topics it saw).
- The Herdr gallery only indexes repositories. An install from it is a copy with no link back to GitHub.
  A name that is taken gets another folder name, so the mod's folder is not always `corral`.

From `herdr.d.ts` (the mod API):

- `writeTextFile(path, text, expected)` writes atomically and only if the file still holds `expected`
  (`null` = create). A stale read rejects, so a concurrent edit of `keys.json` is not lost.
- `appHome()` gives `~/.config/herdr-app` (or `$HERDR_APP_HOME`).
- `keys()` lists every binding as `{ section, keys, action }`: the Keys section reads conflicts from it.
- `exec` runs with the user's real environment (HOME, PATH), 30 s timeout by default, up to 10 min.
- `checking()` is true under `herdr-app check`: `init()` must not start network checks or launchd then.
- `notify({ action })` runs a command on click; `"<mod>.<command>"` reaches the mod's `nextCommand()`.
- `openOverlay({ kind: "dialog" })` gives a centered dialog that dims the window.
From `AGENTS.md` (Herdr's guide for mods):

- `keys.json` is applied live; the macOS menu bar shows the new keys at once. An invalid file keeps the
  last good one and writes why to `keys.error`, which the Keys section reads after a write.
- `fetch` is a global built-in of the mod runtime: the update check uses it.
- `fs/promises` writes only under `~/.config/herdr-app`. A file elsewhere (the launchd plist) is written by the bridge.
- A gallery install whose name is taken is renamed, and the agent rewrites the mod's own `mods/<name>/` paths.
  So the `MOD` constant in `main.js` always holds the mod's real folder name.
- Any edit of `keys.json` makes the whole file the person's: Herdr stops adding its new default keys to it.
  `install.sh` already causes this today.
- Sections: `global`, `layout:<name>`, `terminal` (a terminal has focus), `mod:<name>`. The more specific wins:
  `layout:corral` over `global`, `terminal` over both. So `cmd-1` in `layout:corral` beats `tab.select:1` from `global`,
  but a chord the `terminal` section binds (`cmd-c`, `cmd-v`, `cmd-a`, `cmd-f`, `cmd-left`…) still goes to the terminal
  while one has focus.
- Option+digits and letters type characters on many Mac keyboards; Herdr's guide asks not to pick them unasked.

Spike results (Task 1):

- **Node.** On the owner's Mac, Node 20 comes from nvm (`~/.nvm/versions/node/v20.19.5/bin/node`), and nvm is loaded
  only in `~/.zshrc`, so only an interactive shell has it. herdr-core's own terminals did not find `node` (seen in the
  bridge pilot). So the mod does not trust one PATH. It finds Node in this order and takes the first that reports
  v20 or newer: `exec("node", ["-v"])`; `$SHELL -lic 'command -v node'`; the newest `~/.nvm/versions/node/*/bin/node`;
  `/opt/homebrew/bin/node`; `/usr/local/bin/node`. The absolute path goes into the plist, so launchd needs no PATH for it.
- **`--link` install.** The owner's install today is a copy (`mods/corral/main.js` is a plain file; `corral/telegram`
  is not installed, the bridge runs from the worktree). `--link` makes `main.js` a symlink, not the folder,
  so the mod asks `exec("test", ["-L", <appHome>/mods/<MOD>/main.js])`.
- **Second Herdr.** `herdr-app --help`: "Home: ~/.config/herdr-app (HERDR_APP_HOME picks another)". Whether a second
  window runs beside the owner's is tried in Task 12, the only task that needs it.

## Part 1: settings-form

- A gear button (`icons/settings.svg`, tooltip "Settings") sits in header row one, right of the limit pills.
  It is there in every view.
- A press opens a popup (`openOverlay`, role `settings`), about 720 × 520, in the middle of the window.
- Left: the list of sections ("Telegram", "Keys", "Updates"). Right: the selected section.
  The last selected section opens next time.
- A section is one object: `{ id, title, badge(), render(C, cx) }`. A new section is one more entry in a list.
- Esc and a press outside close the popup. Each section saves at once on a change; there is no "Save" button.
  Exception: a value that needs a check (the token) has its own button.
- When "Updates" has a new version, the gear shows a dot, and the section in the list shows it too.

## Part 2: tg-settings

### Wizard

The section shows a checkbox "Work through Telegram". Off: only the checkbox and one line about what it does.
On: the steps below, one under another. A step is open when the step before it is done.

1. **Bot token.** A password field and a "Check" button. The help text says: make a bot with @BotFather,
   turn on "Allow Groups", turn off group privacy. The check calls the bridge (see "Bridge additions").
   Good: "@ClaudeNowBot" with a green mark, and the token is saved. Bad: the Bot API error in red; nothing is saved.
2. **Group.** A dropdown with a filter field: the forum groups the bot saw. Under it: "Add @bot to the group as an
   admin with 'Manage topics', 'Delete messages' and 'Pin messages', then send any message there", and a
   "Refresh" button. A group with Topics off shows "Topics are off" and is not selectable.
   After the pick, the form shows which rights the bot is missing, if any.
3. **Root topic.** A dropdown: "General", the topics the bot saw in that group, and "Create 'Corral' topic".
4. **Owner.** The Telegram user who may give commands. The list shows the people who wrote in the group
   (from the same discovery); the person picks themselves. More than one is allowed.
5. **Daemon.** "Start" / "Stop" / "Restart" and a status line:
   - "Running as @bot since 14:02" (status `running` and a heartbeat less than 90 s old);
   - "Stopped";
   - "Not responding" (status `running`, heartbeat older than 90 s);
   - "Error: <daemon.error>".
   A "Show log" link opens the log file in a new terminal tab (`tail -f`).

A change of the token, the group, the topic or the owners while the daemon runs restarts it.
"Work through Telegram" off stops the daemon and unloads it from launchd. The settings stay, so on again is one click.

### Daemon under launchd (macOS)

- The bridge manages its own service, so the mod only runs `node bridge.mjs --service install|start|stop|restart|uninstall`
  (and a Linux build can add systemd behind the same flags later).
- `--service install` writes `~/Library/LaunchAgents/dev.corral.telegram.plist`:
  `ProgramArguments` = [absolute path of `node`, `$HERDR_HOME/corral/telegram/bridge.mjs`],
  `RunAtLoad` true, `KeepAlive` { `SuccessfulExit`: false }, `ThrottleInterval` 10,
  `StandardOutPath`/`StandardErrorPath` = `~/.config/herdr-app/corral/telegram.log`,
  `EnvironmentVariables` with `PATH` (so the bridge finds `hc`) and `HERDR_APP_HOME` when set.
- Start: `launchctl bootstrap gui/<uid> <plist>`. Stop: `launchctl bootout gui/<uid>/dev.corral.telegram`.
  Restart: `launchctl kickstart -k gui/<uid>/dev.corral.telegram`.
- The bridge exits 0 on SIGTERM and also on a bad token or unfinished settings (after it writes the error to the
  state file), so launchd does not restart it in a loop; the form shows the error. A crash exits non-zero,
  and launchd starts it again after 10 s.
- Node 20 or newer is needed. If the mod finds no such `node`, step 5 says so and "Start" is off.
- The log file is cut to its last 1 MB at each start (by the bridge).

### Bridge additions (tg-bridge delta)

The mod never talks to Telegram itself; the bridge does, so the Bot API code stays in one tested place,
and the token never goes on a command line.

- `telegram.json` may be partial: `{ token }` alone is valid for the wizard. The daemon refuses to run
  until `chat_id` and `owner_ids` are set, with the error "Finish the Telegram settings in Corral".
- `node bridge.mjs --check --json`: the same checks as `--check`, as one JSON object
  (`{ bot, group, rights: { missing: [] }, hc, errors: [] }`).
- `node bridge.mjs --discover --json`: reads new updates (only while the daemon is stopped), adds the groups,
  topics and people it sees to `telegram-state.json`, and prints them. It does not move the daemon's offset
  past updates it did not handle.
- `node bridge.mjs --create-topic <name> --json`: makes a topic in the set group and prints its id.
- Discovery while the daemon runs: the daemon already fills `chats` and `topics`; the mod reads the state file.
- New in the state file: `people` — `{ id, name, username, chat_id }`, the last 50 people who wrote in a known group.

### Pairing and what the pilot changed (2026-11-16)

The pilot replaced the group list and the owner list as the main path with pairing:

1. The person pastes the token (a link to @BotFather is in the row).
2. "Add to a group" opens `t.me/<bot>?startgroup=<code>&admin=manage_topics+delete_messages+pin_messages`.
   Telegram lets them pick a group and grants those rights in one step, then posts `/start <code>` there from them.
3. Corral stops a running bridge (one reader per bot) and runs `bridge.mjs --pair <code> --json` (up to 290 s).
   The bridge reads updates until that message comes: the group is the chat, the owner is the sender (id, login,
   name). Without Topics, it asks once in the group to turn them on and follows the group to its new supergroup id.
4. Corral saves `chat_id`, `owner_ids`, `owners: [{ id, login, name }]`, turns the toggle on and starts the bridge.

The 8-character code is shown only in Corral, so nobody else becomes owner by adding the bot to their own group.
Cancel kills the waiting bridge. Other changes from the pilot:

- The root topic is always the group's built-in General (Telegram cannot list topics or say one was deleted);
  "Restore" unhides and reopens it and posts a line, which brings it back to a client's list.
- Owners are added by login (the account must have written in the group) and saved with id, login and name;
  × asks ✓ / ⊘ before removing.
- Export / Import of `telegram.json` (token included) and Clear all (stop, leave launchd, delete settings and state).
- The settings are a modal dialog; the Keys section was removed.

### Token handling (MVP)

The token is in `telegram.json` in plain text, mode 0600, as decided for the pilot. The form shows it masked
with a "Show" button. Keychain is deferred.

## Part 3: keys-settings

**Removed after the pilot (2026-11-16), at the owner's word.** Herdr runs a chord it already binds (`cmd-1`) before
the dialog sees the press, so such a key could not be recorded. The section and its code are gone; the view keys stay
in `mods/corral/keys.json` and can be changed in `keys.json` by hand. The text below is kept as the record.

- The section lists four rows: Board, Files, Log, Changes, each with its chord as keycaps (`⌘⌥1`).
- A press on a chord starts recording: "Press the new keys…". The next chord with at least one modifier is
  taken. Esc cancels. Backspace clears the binding (the view then has no key).
- A chord that Herdr already uses (for example `cmd-1…4` for tabs) is allowed. The row shows
  "Replaces <action> in Corral", and the chord does the Corral action while the Corral layout is on.
  The binding goes into the `layout:corral` section only, so other layouts keep Herdr's key.
- A chord the `terminal` section binds is allowed with a warning: "While a terminal has focus, this key stays
  <action>". The `terminal` section is not changed, because it serves every layout.
- Only chords that macOS takes before any app (`cmd-tab`, `cmd-space`, `cmd-shift-3/4/5`) are refused, with the reason.
- "Reset to defaults" puts back `cmd-alt-1…4`.
- A change writes only the `layout:corral` section of `~/.config/herdr-app/keys.json` (read, change, write
  to a temp file, rename). Other sections and keys stay as they are, in the same order.
- After a write, the section reads `keys.error`; if Herdr refused the file, the section shows why and writes the last good text back.
- The keys are only for the Corral layout. Other layouts are not touched.

## Part 4: auto-update

### Release process (the owner)

1. Raise `VERSION` in `mods/corral/main.js` (semver, `x.y.z`) and add a line to `CHANGELOG.md`.
2. Commit, tag `vx.y.z`, push the tag.
3. `gh release create vx.y.z --notes-from-tag` (or with the changelog lines).

Only releases reach users, not each push to `main`. A test checks that `VERSION` is valid semver;
`scripts/release.sh x.y.z` does steps 1–3 and refuses a version that is not higher than the last tag.

### In the mod

- `const VERSION = "x.y.z"` in `main.js`. The section shows it.
- The board copy checks `https://api.github.com/repos/romant094/corral/releases/latest` at start and every 6 hours
  (no token; the limit is 60 requests per hour). Drafts and pre-releases are skipped.
- A newer `tag_name` than `VERSION`: a toast "Corral 0.5.0 is out" (Herdr's toast has one click action: it opens
  Settings → Updates, where "Update" and "Later" are),
  a dot on the gear, and in the section the release notes and an "Update" button.
  "Later" hides the toast for this version; the dot stays.
- The section has "Check automatically" (on by default) and "Check now". It shows the last check time and its error, if any.
  Off: no request goes out, except on "Check now".
- Update: the board copy downloads the release tarball with `curl` into a temp folder, unpacks it with `tar`,
  checks that it has `install.sh` and `mods/corral/main.js`, and runs `install.sh` from there with the mod's
  folder name. A toast shows the result. Herdr reloads the mod.
- `install.sh` also updates the statusline hook if it was installed before, and `telegram/` if it was installed
  before; if the bridge runs under launchd, it restarts it.
- A `--link` install (the mod folder is a symlink) never checks and never updates. The section says
  "Linked to <path>: update with git pull".
- A copy installed from a clone (the owner's install today: `mods/corral` is a plain folder) is treated like a
  gallery install. `VERSION` changes only in a release, so the owner's copy equals the latest release and gets no
  prompt. A copy with a `VERSION` newer than the latest release (a release being made) gets no prompt either.
- A renamed install (gallery, the name was taken): the update goes into the mod's own folder,
  not into a second `mods/corral` (the `MOD` constant names it).

### What it remembers

The shared key `corral.settings`:
`{ updates: { auto: true, checked_at, latest, notes, error, later } , section: "telegram" }`.

## Commands

```
Test (bridge):   node --test telegram/test/
Check (mod):     herdr-app check mods/corral        (install.sh runs it too)
Install (dev):   ./install.sh --link
Release:         scripts/release.sh 0.5.0
Smoke (bridge):  node telegram/bridge.mjs --check --json
```

## Project Structure

```
mods/corral/main.js           the gear, the settings popup and its three sections
mods/corral/icons/settings.svg
mods/corral/keys.json         default view keys (unchanged)
telegram/bridge.mjs           --check --json, --discover --json, --create-topic
telegram/config.mjs           partial settings, people in the state file
telegram/test/                tests for the new modes
scripts/release.sh            the release steps
CHANGELOG.md                  one line per release
install.sh                    updates statusline and telegram/ when present; restarts the launchd bridge
```

## Code Style

As in `main.js` today: plain functions that return GPUI elements, short comments on why, shared keys for state
between copies. Example of a section entry:

```js
const SECTIONS = [
  { id: "telegram", title: "Telegram", badge: () => tgBadge(), render: (C, view, cx) => view.telegramSection(C, cx) },
  { id: "keys",     title: "Keys",     badge: () => null,      render: (C, view, cx) => view.keysSection(C, cx) },
  { id: "updates",  title: "Updates",  badge: () => updateBadge(), render: (C, view, cx) => view.updatesSection(C, cx) },
];
```

## Testing Strategy

- The bridge's new modes: `node:test` with the fake Bot API and fake `hc`, as the bridge tests do now.
- Pure helpers in the mod (version compare, chord parse and format, `keys.json` merge, plist text, status from a
  state file) live in small functions and get a check through `node --test` on a copy of them, or by hand in the
  pilot if the mod cannot be imported by Node.
- Manual pilot on this Mac: the wizard from zero with a new bot, start/stop/restart, a reboot, a key change.

### Clean install in a sandbox

The owner's own Herdr already has Corral, so it cannot show what a new user sees of updates.
The last task checks only the gallery install and the update in a sandbox. Telegram and keys are checked
in the owner's local Herdr.

1. A second Herdr with its own empty home: `HERDR_APP_HOME=<scratch>/herdr-home`, started as a separate app
   instance. The sandbox never touches `~/.config/herdr-app`.
2. In it, a Claude agent gets the gallery link (`herdr.dev/layouts/romant094/corral`) and installs Corral the way
   any user's agent would (Herdr's guide: read the recipe, copy the files, merge `keys.json`, `herdr-app check`).
   The agent installs the release before the latest one.
3. "Check now" sees the latest release; the toast and the gear dot show.
4. "Update" brings the sandbox to the latest release; the dot goes.
5. The sandbox is removed at the end.

If Herdr does not run a second window beside the owner's, the fallback is to quit the owner's Herdr for the check
(agents keep running in herdr-core) and start it with `HERDR_APP_HOME` set, with the owner's consent.

## Boundaries

- Always: write `keys.json` and the settings files atomically (temp file + rename); keep the person's other keys;
  keep the token out of command lines, logs and toasts.
- Ask first: a new dependency; a new network host besides `api.telegram.org`, `api.github.com` and
  `github.com`/`codeload.github.com`; a change to Herdr's other files.
- Never: update a `--link` install; run code from a download that is not a release of `romant094/corral`;
  start the daemon when "Work through Telegram" is off.

## Success Criteria

settings-form:
- [ ] The gear is in the header in all four views; it opens the popup with three sections; Esc closes it.
- [ ] A fourth section can be added with one new entry in `SECTIONS` and its render function.

tg-settings:
- [ ] From an empty `telegram.json`, the wizard alone (no terminal) gets the bridge running in a group.
- [ ] A bad token shows the Bot API error and saves nothing.
- [ ] The group list shows only groups the bot saw; a group without Topics is not selectable.
- [ ] Start, Stop and Restart work; the status line matches the state file within 5 s.
- [ ] After a reboot of the Mac the bridge runs again if it ran before, and does not run if it was stopped.
- [ ] "Work through Telegram" off stops the bridge and keeps the settings.
- [ ] The token is not in `ps` output, the log or a toast.

keys-settings:
- [ ] A new chord for Board switches to Board; the old chord does nothing.
- [ ] `cmd-1` bound to Board switches to Board in the Corral layout and still switches tabs in other layouts.
- [ ] A chord macOS takes (`cmd-tab`) is refused with the reason.
- [ ] A chord from the `terminal` section (`cmd-f`) is saved with the warning.
- [ ] Other sections and keys in `keys.json` are byte-for-byte the same after a change.
- [ ] "Reset to defaults" gives `cmd-alt-1…4` back.

auto-update:
- [ ] With an older `VERSION` than the latest release, the toast and the gear dot show within 10 s of start.
- [ ] "Update" installs the release; after it, the section shows the new version and no dot.
- [ ] No network request goes out with "Check automatically" off.
- [ ] A `--link` install shows "Linked" and never checks.
- [ ] No network: the section shows the error; nothing else breaks.

clean install (sandbox):
- [ ] An agent in a fresh Herdr installs Corral from the gallery link with no step by hand.
- [ ] "Check now" finds the latest release; "Update" installs it there.
- [ ] Nothing in `~/.config/herdr-app` changed.

## Out of Scope (Deferred)

- Keychain for the token — a pilot keeps it in the file (decided).
- systemd and Raspberry Pi — macOS (launchd) first; the bridge itself stays portable.
- Keys for anything but the four views (dock, merge, split…) — the section takes more rows later.
- Rollback to the version before an update — install the older release by hand for now.
- Signed releases (minisign or `ssh-keygen -Y sign`, the key pinned in main.js) — today the trust is GitHub over HTTPS
  only: whoever can publish a release on the repo can run code on every Mac that presses Update. The security review
  rated it high; it needs a key-handling decision from the owner.
- Owner proof by a one-time `/claim <code>` sent in the group — today the owner step shows each person's numeric id,
  and the help asks to turn Allow Groups off once the bot is in the group.
- `leaveChat` for groups other than the set one.
- A gallery install has no bridge until "Install the bridge" (in the Telegram section) fetches this version's release.
- Other settings sections — the form is ready for them.

## Open Questions

None that blocks the plan. Spike results (see "To verify") may change the fallbacks, not the behaviour.
