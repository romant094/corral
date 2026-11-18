# Capability Map: Corral Telegram and Settings

Work with Herdr agents from a Telegram forum group as at the desk, and set
Corral up from one settings form instead of files and the terminal.

| Module id     | Responsibility                                                                                                                              | Depends on              |
|---------------|---------------------------------------------------------------------------------------------------------------------------------------------|-------------------------|
| tg-bridge     | Daemon between Telegram and herdr-core (`hc`): a topic per agent, status notifications, `/new` `/status` `/stop` `/close` `/clear` `/help`, the command menu, the state file | —                       |
| settings-form | Corral mod: the gear button in the header and the settings popup with a list of sections. Holds no settings of its own                     | —                       |
| tg-settings   | Settings section "Telegram": "Work through Telegram" toggle, wizard (token → group → root topic), Start/Stop daemon through launchd, status | settings-form, tg-bridge |
| auto-update   | Settings section "Updates": version, check of GitHub Releases, the update toast and header badge, update by one click                      | settings-form           |

Contracts at the boundaries:

- `~/.config/herdr-app/corral/telegram.json`: Telegram settings. The mod writes it, the daemon reads it. Owned by `tg-bridge`.
- `~/.config/herdr-app/corral/telegram-state.json`: daemon status, known groups and topics. The daemon writes it, the mod reads it. Owned by `tg-bridge`.
- `~/.config/herdr-app/keys.json`, section `layout:corral`: Herdr's own file. `install.sh` writes only that section.
- `corral.settings` shared key: what the update check remembers. Owned by `auto-update`.

Build order: tg-bridge → settings-form → tg-settings → auto-update

Specs: [SPEC-tg-bridge.md](SPEC-tg-bridge.md), [SPEC-settings.md](SPEC-settings.md) (settings-form, tg-settings, auto-update: one form, one spec, a part per module).

## Files view additions (proposed 2026-11-18)

| Module id       | Responsibility                                                                                              | Depends on    |
|-----------------|-------------------------------------------------------------------------------------------------------------|---------------|
| files-ignore    | Settings section "Files": a list of name patterns (`*.pyc`, `.DS_Store`) the Files tree never shows           | settings-form |
| gitignore-marks | Files tree: names that git ignores (`.gitignore`, `.git/info/exclude`, global excludes) show dimmed          | —             |
| image-preview   | Files: an image file shows as a picture, not as text; a file the text reader cannot read no longer hangs on "Loading…" | —      |

Contracts at the boundaries:

- `corral.settings` shared key gets `files: { ignore: [patterns] }`. Owned by `files-ignore`; read by the Files tree.
- `corral.git` shared key gets `ignored: [paths]` (repo-relative, folders end with `/`). Owned by `gitignore-marks`.

Build order: image-preview → gitignore-marks → files-ignore (each ships alone).

Spec: [SPEC-files.md](SPEC-files.md) (one view, one spec, a part per module).
