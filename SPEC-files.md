# Spec: Corral Files View Additions — V1

Status: approved

Modules: `image-preview`, `gitignore-marks`, `files-ignore` (see [CAPABILITY-MAP.md](CAPABILITY-MAP.md)).
One view, so one spec; each module has its own part and its own success criteria. Each part ships alone.

## Objective

The Files view shows the agent's folder as a tree and a file's text beside it. Three things are missing,
compared with an IDE such as WebStorm:

1. **An image is not shown.** A press on `icon/128.png` shows "Loading…" and stays there.
2. **Git-ignored files look like any other file.** `node_modules`, `dist`, `.turbo`, `.env` read the same as `src`.
3. **Junk files cannot be hidden.** `.DS_Store` sits in every folder of a Mac project. "Hidden files: off"
   hides every dotfile, also `.gitignore` and `.env`, which the person wants to see.

### User stories

- As the owner, I press a PNG in the tree and see the picture, scaled to the panel, with its size in pixels.
- As the owner, I see at a glance which files and folders git ignores: they are dimmed in the tree.
- As the owner, I open Settings → Files, add `.DS_Store` to "Ignored files and folders", and it is gone
  from every folder of every project in the tree.
- As the owner, I remove a pattern, and those files come back.

## Facts and things to verify

Verified in `mods/corral/main.js` (main at `3f9a19e`):

- `openFile(path)` reads with `readTextFile(path)`. `null` → "Can't show this file: it is gone or over 1 MiB.";
  a NUL in the text → "Binary file."; else the text goes into a read-only `Editor`.
- `treeRows()` walks `this.dirs` (filled by `loadDir`, `fs.readdir` with an `ls -1Ap` fallback). It always skips `.git`,
  and skips every name that starts with `.` unless "Hidden files" is on (`corral.hidden`).
- The board copy reads git every 4 s (`GIT_MS`) for the target agent's folder and publishes
  `{ folder, root, branch, files, worktrees }` as `corral.git`. It skips the write when nothing changed.
- `corral.settings` holds `{ section, updates, … }`; `setSettings(change)` merges at the top level.
- A settings section is one `SECTIONS` entry `{ id, title, badge, render }` and a render method on the view.
- `image(path)` (gpui-kit) draws PNG, JPEG, SVG "and other GPUI image formats" in full color. Its docs say the
  path resolves against the application root.

Spike results (Task 1, 2026-11-18):

- **Why a PNG hangs on "Loading…".** `readTextFile` "reads UTF-8 text" (`herdr` typings); on other bytes its promise
  rejects, the spawned task ends, and `this.file` keeps "Loading…". The read now catches the rejection.
- **`image()` with an absolute path does not work.** The live check showed the header with the right size and an
  empty panel. So the mod writes a copy of the bytes to `corral/cache/preview-<time>-<n>.<ext>` in Herdr's home and
  passes that relative path, as icons are passed. A new name for each open keeps GPUI's cache from showing old
  pixels; each open deletes the copies before it.
- **The size in pixels** comes from the file's header (`fs.readFile` returns the bytes): PNG, GIF, BMP, ICO, JPEG
  (first start-of-frame) and WebP (VP8, VP8L, VP8X). A scratch `node --test` on files made with `sips` and `cwebp`
  gave the same sizes as `sips`. The file size comes from `stat -f %z` before any read.
- **Speed.** `git ls-files -z --full-name --others --ignored --exclude-standard --directory`: 40 ms and 81 entries
  on the xnms monorepo. It runs in the same `Promise.all` as the other git reads. `--full-name` makes the paths
  repo-relative, as `git status` gives them, also when the agent's folder is below the root.
- **No `object_fit` and no background images** in the mod's GPUI API, so no checkerboard (see Deferred).
- The mod cannot be imported by Node (`herdr` and `gpui-*` exist only in Herdr), so the helpers are tested by a
  scratch copy, as SPEC-settings.md does.

## Part 1: image-preview

- A file with one of these extensions (any case) is an image: `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico`, `svg`.
- A press on an image in the tree shows it in the right panel instead of the editor:
  - centered, scaled down to fit the panel with its proportions kept, never scaled up;
  - the panel header shows "128 × 128 px · 4.2 KB" where the line count is for text.
- An SVG shows as a picture too. Its text stays one press away: an "Open as text" button in the panel header.
- The header buttons stay: "Copy path", "Open" (default app), and "View diff" when the file is changed.
- A file the reader refuses, and that is not an image, shows "Binary file." at once. "Loading…" never stays
  longer than the read takes.
- A picture whose header is not a valid one of its format shows "Can't show this image." and the header buttons.
  An SVG has no fixed size: it fills the panel, and the header shows only its KB.
- An image over 20 MiB shows "Image is over 20 MiB." with the "Open" button, and is not decoded.

## Part 2: gitignore-marks

- With each 4-second git read, the board copy also asks git which paths it ignores, in one call:
  `git ls-files --others --ignored --exclude-standard --directory`. A folder that is ignored as a whole comes back
  once, as `node_modules/`, so the answer stays short.
  Tracked files that also match `.gitignore` are not dimmed: git tracks them, so they are part of the project.
- `corral.git` gets `ignored: [paths]`, relative to the repository root. An ignored file in a tracked folder
  comes back one entry per file (`*.o` beside the sources), so the list is capped at 2000: past that, only the
  folder entries are kept.
- An untracked folder that holds only ignored files (a new package after `npm install`, before its first source
  file) is dimmed as a whole, as `git status` treats it.
- An agent folder inside an ignored folder: git refuses the listing, and nothing is dimmed.
- A tree row is dimmed when its path or a folder above it is in that list: the name, the icon and the chevron
  take the theme's `dim` color. Selection, hover and the change mark (`A`, `M`, `D`) look as today.
- A folder outside git, or git not installed: nothing is dimmed, nothing else changes.
- The file panel of a dimmed file looks as for any file.

## Part 3: files-ignore

### The section

- A new `SECTIONS` entry `{ id: "files", title: "Files" }`, after "Telegram", before "Updates".
- One block, "Ignored files and folders", with the line under it: "The Files tree does not show these names.
  `*` matches any characters, `?` matches one."
- The list shows one pattern per row, in the order added, in a mono font. A row has a × button; a press removes
  the pattern at once.
- Under the list: a field and an "Add" button (Enter adds too). Empty text, text with `/`, and a pattern that is
  already in the list are refused with one line in red under the field: why.
- A "Reset to defaults" link puts the default list back.
- Each change saves at once, as the other sections do. There is no "Save" button.

### Matching

- A pattern is matched against the name of a file or folder, never against a path, and is case-sensitive,
  as WebStorm does. `*` matches any characters, also none; `?` matches one character. Nothing else is special.
- A folder that matches is hidden with everything in it.
- The patterns apply only to the Files tree. Changes, Log and the Changes count are not filtered: they show what
  git sees.
- "Hidden files" (the chip in the Files bar) stays and works as today. A name is shown only when both allow it.
- `.git` stays hidden always, as today; it is not in the list.

### Defaults

`.DS_Store`, `Thumbs.db`, `*.pyc`, `*.pyo`, `__pycache__`, `*~`, `.hg`, `.svn`, `CVS`.
A person who never opened the section gets these. A person who removed all of them gets an empty list
(an empty list is not "use defaults").

### What it remembers

The shared key `corral.settings` gets `files: { ignore: [patterns] }`. No `files` key means the defaults.

## Commands

```
Check (mod):    herdr-app check mods/corral        (install.sh runs it too)
Install (dev):  ./install.sh --link
Helpers:        a scratch copy of namePattern and imageSize under node --test (the mod cannot be imported by Node)
```

## Project Structure

```
mods/corral/main.js        openFile and the image panel, the git read, treeRows, the Files section
mods/corral/icons/         a new icon only if the section needs one
README.md, RECIPE.md       the Files part and the Settings part
docs/images/files.png      retaken; docs/images/settings-files.png new
```

## Code Style

As in `main.js` today: plain functions that return GPUI elements, short comments on why, shared keys for state
between copies. The matcher is a small pure function:

```js
// A WebStorm-style name pattern: `*` any characters, `?` one; matched against the whole name.
const namePattern = (p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
```

## Testing Strategy

- Pure helpers (`namePattern`, the ignored-path lookup, the image-size header read) are small functions.
  If the mod can import a local module (Task 1), they move into one and get `node --test`. If not, they are checked
  once by a scratch script on a copy, and the pilot covers them.
- `herdr-app check mods/corral` after each task.
- Manual pilot in the owner's Herdr on a real monorepo (this one and a Turbo monorepo with `node_modules`):
  PNG, JPEG, SVG, a broken PNG, a big file; dimmed `node_modules` and `.turbo`; `.DS_Store` added and removed.

## Boundaries

- Always: keep the tree as fast as today on a large folder; keep "Hidden files" working as it does.
- Ask first: a new dependency; writing files outside `~/.config/herdr-app`; a git call that reads the whole
  working tree more often than every 4 s.
- Never: change what Changes and Log show; change the files the person browses; send file contents anywhere.

## Success Criteria

image-preview:
- [ ] A press on a PNG, JPEG, GIF, WebP and SVG shows the picture within 1 s, fitted to the panel, proportions kept.
- [x] The size helper gives the same width and height as `sips` for PNG, JPEG, GIF, BMP and the three WebP kinds.
- [ ] A small icon (16 × 16) is not scaled up; the header shows its size in pixels and KB.
- [ ] A broken PNG shows "Can't show this image."; a binary non-image shows "Binary file."; no file stays on "Loading…".
- [ ] "Open as text" on an SVG shows its text in the editor.

gitignore-marks:
- [ ] In a repo with `node_modules/`, `dist/` and `.env` in `.gitignore`, those rows are dimmed, and so is
      everything inside an expanded `node_modules`.
- [ ] A tracked file is not dimmed, even when a `.gitignore` pattern matches it.
- [ ] A folder outside git shows nothing dimmed and no error.
- [ ] A new line in `.gitignore` dims the matching rows within 5 s.

files-ignore:
- [ ] Settings shows "Files" between "Telegram" and "Updates".
- [ ] A fresh install hides `.DS_Store` in every folder of the tree.
- [ ] Adding `*.log` hides every `.log` file at once; removing it brings them back at once.
- [ ] `node_modules` added hides the folder and its content; Changes still lists a changed file in it.
- [ ] `a/b` is refused with the reason; a duplicate is refused with the reason.
- [ ] "Reset to defaults" gives the default list back; the list survives a restart of Herdr.

## Out of Scope (Deferred)

- WebStorm's "excluded" folders (orange `dist`, `node_modules` "library root") — a project-model idea, not git's.
- File-type icons (JSON, TS, JS badges in the tree) — a separate visual change.
- Patterns per project — one global list first, as WebStorm has.
- Patterns with paths or `**` — names only, as WebStorm.
- Zoom and pan in the image panel; video, PDF and audio preview.
- A checkerboard behind transparent pictures — the mod's GPUI API has no background images; many small divs would
  cost more than it gives.
- Dimmed rows in the Changes tree — Changes shows only files git sees as changed; ignored ones are not there.

## Open Questions

None that blocks the plan. Task 1 may change how the picture is loaded (direct path or a copy), not what the person sees.
