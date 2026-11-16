# Implementation Plan: Corral Settings

Source spec: [SPEC-settings.md](../SPEC-settings.md). Modules: settings-form, tg-settings, keys-settings, auto-update.
Tasks: [todo.md](todo.md). The finished bridge plan: [tg-bridge-plan.md](tg-bridge-plan.md).

## Overview

A gear in Corral's header opens one settings popup with three sections: Telegram (a wizard that sets up and
runs the bridge under launchd), Keys (the four view keys) and Updates (GitHub Releases, update by one click).
The bridge gets the Telegram and launchd work; the mod only draws the form and calls the bridge.

## Architecture Decisions

- **The bridge does all Telegram and launchd work.** The mod runs `node bridge.mjs --check|--discover|--create-topic|--service … --json`
  and reads one JSON line. Reason: the Bot API code stays tested in one place; the token never goes on a command line;
  the mod cannot write `~/Library/LaunchAgents` anyway.
- **The form has no settings file of its own.** Telegram → `telegram.json`, keys → `keys.json` (`layout:corral` only),
  updates → shared key `corral.settings`.
- **Sections are entries in one `SECTIONS` list** in `main.js`; the popup draws the list and the selected one.
- **Pure helpers in `main.js` stay small and free of GPUI** (version compare, chord format, keys merge, status from the
  state file), so a later move to a tested module is cheap. The mod is checked with `herdr-app check` and by hand.
- **The update runs `install.sh` from the release tarball** with the mod's folder name, so a renamed install updates in place.
- **Releases start at v0.1.0.** The repo has no tags yet; the sandbox check needs two releases.

## Dependency Graph

```
spike (facts) ──► settings-form ──┬──► tg section ◄── bridge: partial settings ◄── bridge: --json modes ◄── bridge: --service
                                  ├──► keys section
                                  └──► updates section ◄── VERSION + release.sh + install.sh --name
                                                           └──► update action ──► releases v0.1.0, v0.1.1 ──► sandbox check
```

## Phases and Checkpoints

1. **Foundation:** Task 1 spike, Task 2 settings form. Checkpoint: the gear opens an empty form in all four views.
2. **Telegram:** Tasks 3–7. Checkpoint: the wizard moves the owner's bridge from a terminal tab to launchd, here on this Mac.
3. **Keys:** Task 8. Checkpoint: `cmd-1…4` switch the views in Corral and still switch tabs in other layouts.
4. **Updates:** Tasks 9–12. Checkpoint: the sandbox install updates from v0.1.0 to v0.1.1.
5. **Close:** Task 13 review and docs.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| A second Herdr instance with another `HERDR_APP_HOME` cannot run beside the owner's | Med | Spike first. Fallback: the sandbox is a macOS user account or a quit-and-swap of the home folder, with the owner's consent |
| `exec` does not find Node 20+ | Med | Spike first; fallback `zsh -lc 'command -v node'`; the form shows "Node 20 needed" |
| The mod cannot tell a `--link` install (main.js is a symlink, the folder is not) | Low | `exec("test", ["-L", path])` |
| launchd keeps restarting a bridge with a bad token | Med | Exit 0 on bad settings; error in the state file (Task 3) |
| A release goes out broken and every user gets it | High | `release.sh` runs the tests and `herdr-app check` first; the sandbox check before the gallery sees it |
| Publishing a release and moving the owner's bridge to launchd are outward-facing | — | Ask the owner before each (Tasks 7 and 12) |

## Open Questions

None.
