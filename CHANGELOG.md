# Changelog

Each release has a `## x.y.z` section; `scripts/release.sh` uses it as the GitHub release notes.

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
