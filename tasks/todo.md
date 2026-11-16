# Tasks: Corral Settings

Plan: [plan.md](plan.md). Spec: [SPEC-settings.md](../SPEC-settings.md).
Checks: `node --test telegram/test/` for the bridge; `herdr-app check mods/corral` and a look in the app for the mod.

## Phase 1: Foundation

- [x] **Task 1: Spike the facts the code depends on**
  - Acceptance:
    - [ ] The spec says where `exec` finds Node 20+ (plain PATH or a login shell)
    - [ ] The spec says if a second Herdr runs with another `HERDR_APP_HOME`, and how to start it
    - [ ] The spec says how the mod tells a `--link` install
  - Verify: the facts are in `SPEC-settings.md` with the commands that showed them
  - Dependencies: None. Files: `SPEC-settings.md`. Scope: XS

- [x] **Task 2: Gear button and the settings popup (settings-form)**
  - Acceptance:
    - [ ] The gear sits right of the limit pills in all four views; a press opens a dialog with "Telegram", "Keys", "Updates"
    - [ ] The last section opens next time (`corral.settings.section`); Esc closes the dialog
    - [ ] A section is one `SECTIONS` entry; a badge on an entry shows a dot on the gear
  - Verify: `herdr-app check`; open, switch, close in the app
  - Dependencies: 1. Files: `mods/corral/main.js`, `mods/corral/icons/settings.svg`. Scope: S

### Checkpoint: Foundation
- [ ] Bridge tests pass, the mod check passes, the gear works in all four views

## Phase 2: Telegram

- [x] **Task 3: Bridge accepts partial settings and exits cleanly for launchd**
  - Acceptance:
    - [ ] `{ token }` alone loads; the daemon writes "Finish the Telegram settings in Corral" to the state file and exits 0
    - [ ] A bad or revoked token: error in the state file, exit 0; a crash exits non-zero
    - [ ] The log file is cut to its last 1 MB at start
  - Verify: `node --test telegram/test/`
  - Dependencies: None. Files: `telegram/config.mjs`, `telegram/bridge.mjs`, `telegram/test/config.test.mjs`. Scope: S

- [x] **Task 4: Bridge `--check --json`, `--discover --json`, `--create-topic`**
  - Acceptance:
    - [ ] `--check --json` prints one object: bot, group, rights.missing, hc, errors
    - [ ] `--discover --json` (daemon stopped) stores and prints groups, topics and `people`; it does not move the offset past unhandled updates
    - [ ] `--create-topic <name> --json` prints the new topic id
  - Verify: `node --test telegram/test/` with the fake Bot API
  - Dependencies: 3. Files: `telegram/bridge.mjs`, `telegram/setup.mjs` (new), `telegram/config.mjs`, `telegram/test/setup.test.mjs`. Scope: M

- [ ] **Task 5: Bridge `--service install|start|stop|restart|uninstall|status`**
  - Acceptance:
    - [ ] The plist text has Node's absolute path, the bridge path, PATH, `HERDR_APP_HOME` when set, the log path, `KeepAlive.SuccessfulExit=false`, `ThrottleInterval` 10
    - [ ] Each verb runs the right `launchctl` call (injected runner in tests); `status` prints `{ installed, running, pid }`
    - [ ] Not macOS: a clear error, exit 1
  - Verify: `node --test telegram/test/`; by hand once: install, status, uninstall (with a stopped bridge)
  - Dependencies: 3. Files: `telegram/service.mjs` (new), `telegram/bridge.mjs`, `telegram/test/service.test.mjs`. Scope: M

- [ ] **Task 6: Telegram section — toggle and wizard steps 1–4**
  - Acceptance:
    - [ ] Toggle off shows one line; on shows the steps, each open when the one before is done
    - [ ] Token: masked field, "Check" runs `--check --json`; good saves `telegram.json` (0600 via the bridge), bad saves nothing
    - [ ] Group, root topic and owner dropdowns read `telegram-state.json`; "Refresh" runs `--discover`; "Create 'Corral' topic" works
  - Verify: `herdr-app check`; the wizard against the owner's bot with the bridge stopped
  - Dependencies: 2, 4. Files: `mods/corral/main.js`. Scope: M

- [ ] **Task 7: Telegram section — daemon step**
  - Acceptance:
    - [ ] Start/Stop/Restart call `--service`; the status line shows Running/Stopped/Not responding/Error within 5 s
    - [ ] A settings change while running restarts the bridge; toggle off stops and uninstalls it, settings stay
    - [ ] "Show log" opens `tail -f` of the log in a new tab; no Node 20 → "Start" is off with the reason
  - Verify: ask the owner first, then move the owner's bridge from its terminal tab to launchd; reboot check
  - Dependencies: 5, 6. Files: `mods/corral/main.js`. Scope: M

### Checkpoint: Telegram
- [ ] Bridge tests pass; the owner's bridge runs under launchd and survives a reboot; the token is not in `ps` or the log

## Phase 3: Keys

- [ ] **Task 8: Keys section**
  - Acceptance:
    - [ ] Four rows with keycaps; a press records the next chord with a modifier; Esc cancels; Backspace clears
    - [ ] A `global` chord shows "Replaces <action> in Corral"; a `terminal` chord shows its warning; `cmd-tab`, `cmd-space`, `cmd-shift-3/4/5` are refused
    - [ ] Only `layout:corral` changes (`writeTextFile` with the read text as `expected`); `keys.error` is shown; "Reset to defaults" works
  - Verify: `herdr-app check`; bind `cmd-1…4` here, check Corral and the `main` layout
  - Dependencies: 2. Files: `mods/corral/main.js`. Scope: M

## Phase 4: Updates

- [ ] **Task 9: Version, changelog, release script, install by name**
  - Acceptance:
    - [ ] `const VERSION = "0.1.0"` in `main.js`; `CHANGELOG.md`
    - [ ] `scripts/release.sh x.y.z` refuses a version not above the last tag, runs the tests and the mod check, sets `VERSION`, commits, tags, pushes and runs `gh release create` — each outward step after a prompt
    - [ ] `install.sh --name <folder>` installs into that mod folder; it updates the statusline hook and `telegram/` when present and restarts the launchd bridge when it runs
  - Verify: `scripts/release.sh 0.0.1 --dry-run`; `./install.sh --name corral-test` into a scratch `HERDR_APP_HOME`
  - Dependencies: 5. Files: `mods/corral/main.js`, `CHANGELOG.md`, `scripts/release.sh` (new), `install.sh`. Scope: M

- [ ] **Task 10: Update check and the Updates section**
  - Acceptance:
    - [ ] The board copy checks `releases/latest` with `fetch` at start and every 6 h, not under `checking()`; drafts and pre-releases skipped
    - [ ] Newer: toast with "Update"/"Later", a dot on the gear and on the section; the section shows notes, last check, errors
    - [ ] "Check automatically" off sends nothing but "Check now"; a `--link` install shows "Linked to <path>" and never checks
  - Verify: `herdr-app check`; a fake older `VERSION` in a scratch copy shows the toast
  - Dependencies: 2, 9. Files: `mods/corral/main.js`. Scope: M

- [ ] **Task 11: Update by one click**
  - Acceptance:
    - [ ] "Update" downloads the release tarball with `curl`, unpacks with `tar`, checks `install.sh` and `mods/corral/main.js`, runs `install.sh --name <MOD>`
    - [ ] The result is a toast; after the reload the section shows the new version and no dot
    - [ ] A failed download or install leaves the old version running and shows why
  - Verify: in a scratch `HERDR_APP_HOME`, update from a local tarball server or a fork release
  - Dependencies: 10. Files: `mods/corral/main.js`. Scope: S

- [ ] **Task 12: First releases and the sandbox check**
  - Acceptance:
    - [ ] With the owner's go-ahead: v0.1.0, then v0.1.1 on GitHub
    - [ ] In a sandbox Herdr, an agent installs v0.1.0 from the gallery link; "Check now" finds v0.1.1; "Update" installs it
    - [ ] `~/.config/herdr-app` did not change; the sandbox is removed
  - Verify: the sandbox steps in the spec
  - Dependencies: 1, 11. Files: `SPEC-settings.md` (results). Scope: S

### Checkpoint: Updates
- [ ] The sandbox updated from v0.1.0 to v0.1.1 with no step by hand

## Phase 5: Close

- [ ] **Task 13: Review and docs**
  - Acceptance:
    - [ ] code-reviewer and security-auditor findings fixed or answered
    - [ ] README: settings, keys, updates; the network sentence changed; RECIPE.md and CAPABILITY-MAP.md current
    - [ ] The spec's success criteria checked off
  - Verify: all checks pass; the owner looks through the form
  - Dependencies: 1–12. Files: `README.md`, `RECIPE.md`, `SPEC-settings.md`. Scope: S
