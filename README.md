# Corral

An agent board layout for [Herdr](https://herdr.dev). Every Claude Code session is a card, sorted by status. Below the board, the live terminals of the active space. Two more views show the files and the uncommitted changes of the agent you pick.

![Corral](mods/corral/preview.svg)

## Features

- **Board.** Cards in four columns: Needs you, Working, Done, Idle. A card shows the model, the session id (click to copy), the task, context use with tokens, cost, and the project or folder. The focused agent's card is highlighted. A session that has done work asks before it closes.
- **Limits.** 5-hour and 7-day plan usage with reset times. A per-model window (for example Fable) gets its own pill when Claude Code reports one.
- **Projects.** One dropdown lists project folders, with a filter. A row shows its agents, or whether a space is open there. A click goes to the agent, else to the space, else opens a space and starts Claude. A folder where you open a space becomes a project. Add several folders at once (macOS).
- **Filters.** Pick which projects and which statuses the board shows; a status you leave out hides its column.
- **New agent.** "+ Agent" starts Claude in a new tab of the active space.
- **Live workspace.** Plain terminals of the active space as chips: drag to reorder, drop on Right or Below to show one beside the active pane, double-click to rename. Split buttons and context use in each pane header.
- **Files.** The agent's folder as a tree, with git marks (M, A, D). A read-only code view with selection, copy and syntax colors.
- **Changes.** `git status` and `git diff HEAD` of the agent's folder, refreshed every 4 seconds. Pick another worktree of the repository from a searchable list. Changed files show as a folder tree or a flat list ("Group by directory", kept per repository).
- **Paths.** Right-click a file or folder in Files or Changes to copy its relative or absolute path, or press ⌘⇧C / ⌥⇧C (Ctrl+Shift+C / Alt+Shift+C on Linux and Windows).
- **Resizable panels.** Drag the divider in Files and Changes; each agent keeps its own width.
- **Light and dark.** The layout follows the system appearance: `one-light` or `one-dark`. Code colors follow the theme.
- **Agent picker.** In Files and Changes the header lists the active agents. Picking one also focuses its terminal.

## Requirements

- Herdr desktop app (`herdr-app`).
- Claude Code, for the session data on the cards.
- `git`, for Changes and the file marks.

## Install

```sh
git clone https://github.com/romant094/corral.git
cd corral
./install.sh --statusline
herdr-app do layout.switch --name corral
```

`install.sh` copies `layouts/corral.json`, `mods/corral/` and `themes/` into `~/.config/herdr-app` (or `$HERDR_APP_HOME`). Leave out `--statusline` if you only want the layout.

For development, `./install.sh --link` symlinks `main.js` and the layout to the checkout, so edits apply at once. Icons stay copies, because Herdr does not load SVGs through a symlinked folder; run the script again after adding one.

### Session data

Cards read the Claude Code statusline JSON. `statusline/corral-statusline.py` prints one line (`model | context | cost | [folder]`) and saves the JSON to `~/.cache/corral/sessions/<claude pid>.json`. The mod matches each file to its terminal through the terminal's foreground pid.

Set it as the Claude Code statusline in `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "python3 ~/.claude/scripts/corral-statusline.py" }
}
```

If you already have a statusline, call the script from it and pass the same stdin. Without the hook the board still works; the cards then say that no session data is available yet.

## Layout

```
layouts/corral.json            the layout: header, board, live workspace
mods/corral/main.js            one mod; props().role picks the part it draws
mods/corral/icons/             SVG icons
themes/one-dark.json, one-light.json  the themes the layout uses
statusline/corral-statusline.py  Claude Code statusline hook
RECIPE.md                      the brief to rebuild it from scratch
```

Check the mod after a change:

```sh
herdr-app check mods/corral
```

## License

MIT
