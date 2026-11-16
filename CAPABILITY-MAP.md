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
