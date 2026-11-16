# Capability Map: Corral Telegram

Work with Herdr agents from a Telegram forum group as at the desk: a root topic
to start agents and see them all, one topic per agent for the work itself.

| Module id   | Responsibility                                                                                                                              | Depends on |
|-------------|---------------------------------------------------------------------------------------------------------------------------------------------|------------|
| tg-bridge   | Daemon between Telegram and herdr-core (`hc`): a topic per agent, status notifications, `/new` `/status` `/screen` `/stop` `/close` `/help`, the command menu, the state file | —          |
| tg-settings | Corral mod: gear button, "Work through Telegram" toggle, wizard (token → group → root topic), Start/Stop daemon through launchd, daemon status | tg-bridge  |

Contract at the boundary, owned by `tg-bridge`:

- `~/.config/herdr-app/corral/telegram.json`: settings. The mod writes it, the daemon reads it.
- `~/.config/herdr-app/corral/telegram-state.json`: daemon status, known groups and topics. The daemon writes it, the mod reads it.

Build order: tg-bridge → tg-settings

Specs: [SPEC-tg-bridge.md](SPEC-tg-bridge.md), SPEC-tg-settings.md (after tg-bridge).
