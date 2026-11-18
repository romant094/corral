# Implementation Plan: Files View Additions

Source spec: [SPEC-files.md](../SPEC-files.md). Tasks: [files-todo.md](files-todo.md).

## Overview

Three changes to the Files view in `mods/corral/main.js`: show images, dim what git ignores, and hide names
that match patterns from a new Settings section "Files". Each ships alone; order: image-preview →
gitignore-marks → files-ignore.

## Architecture Decisions

- Everything stays in `main.js`, as all of Corral's mod code does. Pure helpers sit near the top with the other
  helpers (`namePattern`, `isImage`, `imageSize`), so they can be copied into a scratch test.
- `openFile` branches on the extension before any read: an image never goes through `readTextFile`.
  The read is wrapped in try/catch, so a refusal ends in "Binary file." instead of a task that dies silently.
- The ignored list comes from the board copy's existing 4-second git read (one more `git` in its `Promise.all`)
  and travels in `corral.git`, like `files`. The tree builds a `Set` once per render and checks the path and
  its parent folders.
- The patterns live in `corral.settings.files.ignore`; `treeRows()` compiles them once per render.
- The Files section copies the Owners step's pieces (`field`, `smallButton`, `xButton`), so it looks like the
  rest of the dialog.

## Task List

### Phase 1: image-preview
- [x] Task 1: Spike — PNG hang, `image()` with an absolute path, image size, `git ls-files` speed
- [x] Task 2: Image panel and the binary-file fix

### Checkpoint: image-preview
- [ ] `herdr-app check` passes; PNG, JPEG, SVG, broken PNG, binary file look as the spec says

### Phase 2: gitignore-marks
- [x] Task 3: Ignored paths in `corral.git` and dimmed tree rows

### Checkpoint: gitignore-marks
- [ ] `node_modules`, `dist`, `.turbo` dimmed in a Turbo monorepo; nothing dimmed outside git

### Phase 3: files-ignore
- [x] Task 4: Name patterns hide tree rows (defaults, no UI yet)
- [x] Task 5: Settings section "Files"

### Checkpoint: Complete
- [ ] All success criteria of SPEC-files.md met in the owner's Herdr
- [ ] Code review done; docs, canvas and screenshots wait for the owner's "commit"

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `image()` takes only paths under the app root | Med | Copy the file to `~/.config/herdr-app/corral/cache/` and show the copy (Task 1 decides) |
| `git ls-files --ignored` is slow on a big repo | Med | `--directory` folds ignored folders; measure in Task 1; if slow, read it every 4th tick |
| A big `ignored` list makes `corral.git` writes heavy | Low | `--directory` keeps it to folders; the write is skipped when nothing changed |

## Open Questions

None.
