# Tasks: Files View Additions

Plan: [files-plan.md](files-plan.md). Spec: [SPEC-files.md](../SPEC-files.md).
Checks: `herdr-app check mods/corral` and a look in the app.

## Phase 1: image-preview

- [x] **Task 1: Spike the facts the code depends on**
  - Acceptance:
    - [ ] The spec says why a PNG stays on "Loading…"
    - [ ] The spec says if `image()` takes an absolute path, or how the copy fallback works
    - [ ] The spec says how the mod gets the size in pixels, and how long `git ls-files --ignored` takes here
  - Verify: the facts are in `SPEC-files.md` with what showed them
  - Dependencies: None. Files: `SPEC-files.md`. Scope: XS

- [x] **Task 2: Image panel and the binary-file fix**
  - Acceptance:
    - [ ] PNG, JPEG, GIF, WebP, SVG show fitted, never scaled up; the header shows "W × H px · KB"
    - [ ] A broken image shows "Can't show this image."; a non-image the reader refuses shows "Binary file."
    - [ ] An SVG has "Open as text"; over 20 MiB shows "Image is over 20 MiB."
  - Verify: `herdr-app check mods/corral`; open each kind in the app
  - Dependencies: 1. Files: `mods/corral/main.js`. Scope: S

### Checkpoint: image-preview
- [ ] The mod check passes; no file stays on "Loading…"

## Phase 2: gitignore-marks

- [x] **Task 3: Ignored paths in `corral.git` and dimmed tree rows**
  - Acceptance:
    - [ ] `corral.git.ignored` lists the repo's ignored paths, folders once with `/`
    - [ ] A row whose path or parent folder is ignored shows name, icon and chevron in `dim`
    - [ ] Tracked files and folders outside git are not dimmed
  - Verify: `herdr-app check mods/corral`; a Turbo monorepo and a folder outside git in the app
  - Dependencies: None. Files: `mods/corral/main.js`. Scope: S

### Checkpoint: gitignore-marks
- [ ] A new `.gitignore` line dims its rows within 5 s

## Phase 3: files-ignore

- [x] **Task 4: Name patterns hide tree rows**
  - Acceptance:
    - [ ] `namePattern` matches `*` and `?` against the whole name, case-sensitive
    - [ ] With no `files` key, the defaults hide `.DS_Store` everywhere in the tree; a matching folder hides its content
    - [ ] Changes and Log are not filtered
  - Verify: a scratch `node` check of `namePattern`; the tree in the app
  - Dependencies: None. Files: `mods/corral/main.js`. Scope: S

- [x] **Task 5: Settings section "Files"**
  - Acceptance:
    - [ ] "Files" sits between "Telegram" and "Updates"; rows with ×, a field with "Add" and Enter, "Reset to defaults"
    - [ ] Empty, `/` and duplicate patterns are refused with the reason
    - [ ] A change applies to the tree at once and survives a restart
  - Verify: `herdr-app check mods/corral`; add `*.log`, remove it, reset, restart Herdr
  - Dependencies: 4. Files: `mods/corral/main.js`. Scope: S

### Checkpoint: Complete
- [ ] All success criteria of SPEC-files.md met
- [ ] Code review done
