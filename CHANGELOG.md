# Changelog

Each release has a `## x.y.z` section; `scripts/release.sh` uses it as the GitHub release notes.

## 0.1.0

- Settings: a gear right of the plan limits opens one dialog with Telegram, Keys and Updates.
- Telegram: a wizard sets up the bridge (token, group, root topic, owners) and runs it under launchd.
- Keys: rebind Board, Files, Log and Changes; a key Herdr uses elsewhere is taken over in Corral only.
- Updates: Corral checks GitHub Releases and updates itself with one click.
- The Telegram bridge: a topic per agent, status icons, replies, questions with buttons, files and photos, `/new`, `/status`, `/stop`, `/close`, `/clear`.
