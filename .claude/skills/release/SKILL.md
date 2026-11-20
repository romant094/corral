---
name: release
description: Commit and release Corral after the owner approves a change ("commit", "release", "делай коммит и релиз"). Updates the docs, the design canvas and the screenshots, commits, then runs scripts/release.sh for the next version.
---

# Release Corral

Use this when the owner has checked a change live and says "commit" or "commit and release".
Never start it before that word: code first, the owner approves, then this.
All repo text is English. Chat with the owner stays in Russian.

## 1. Check the state

1. Run `git fetch` and compare `main` with `origin/main`. Work on the up-to-date code.
2. Run `node --input-type=module --check < mods/corral/main.js`.
3. Run `herdr-app check mods/corral` (or `./install.sh` and read its `check passed` line).
4. Run `node --test telegram/test/` when `telegram/` changed.
5. Read `git diff` in full. Know every change before you write about it.

## 2. Docs

1. `README.md`: describe each new or changed behavior in the section of its view (Board, Files, Log, Changes, Settings → <section>). Add an image line for each new screenshot.
2. `RECIPE.md`: the brief to rebuild Corral. Add the mechanism (commands, shared keys, sizes) to the matching bullet.
3. `CHANGELOG.md`: a new `## x.y.z` section on top, one line per change, as the user sees it. `scripts/release.sh` uses this section as the GitHub release notes.
4. A new module gets a row in `CAPABILITY-MAP.md` and a `SPEC-<module>.md` only when it was planned that way.

## 3. Design canvas and screenshots

The canvas is https://claude.ai/artifact/3zzJLshQAotketcFykCHma (a Design artifact). The PNGs in `docs/images/` are its artboards rendered at 2×.
Do this in a background subagent (general-purpose), and write the docs while it runs. Brief it with:

1. Each visual change: where it shows, sizes, colors, labels, icon files. Point it at the code (`mods/corral/main.js` method names) and at live screenshots the owner sent (`images/<n>.png` in the session folder).
2. Canvas work: read the artifact first and follow its type instructions; read `project/canvas.json` and each artboard before an edit; publish only changed files from a scratchpad `root`; new artboards get a `boards` entry and an `order` slot in a free spot. Sample data only, never the owner's real projects or names.
3. Rendering: headless Chrome (`/Applications/Google Chrome.app`, `--headless=new --screenshot --window-size=W,H --force-device-scale-factor=2 --hide-scrollbars`), with `support.js` and `artifact-type/dc-runtime.js` read from the artifact into the scratchpad. Keep each PNG's current pixel size. First render an unchanged artboard and compare it with its PNG to prove the pipeline. Look at each PNG before writing it. If a render is not faithful, write nothing and report.
4. Limits: no git, no `.md` edits, no `main.js` edits. Node is under `~/.nvm/versions/node/*/bin/node`. A shell hook blocks commands that contain `.config/herdr-app`.

Check its report and the PNGs yourself before the commit.

## 4. Commit

1. Stage the change, the docs, `docs/images/` and new icons. Leave out scratch files and `tasks/` notes that are not part of the change.
2. Message: a subject that says what the user gets (`Area: what changed`), a blank line, then one `-` line per change. No `Co-Authored-By` line, no Claude attribution.
3. Commit on `main`.

## 5. Release

1. Pick the next patch version (`0.1.12` → `0.1.13`) unless the owner names another.
2. Run `scripts/release.sh x.y.z --dry-run` and read its output.
3. Run `scripts/release.sh x.y.z`. It sets `VERSION` in `main.js`, commits "Release x.y.z", tags `vx.y.z`, then asks before the push and before the GitHub release. It reads y/N from stdin: pipe the answers (`printf 'y\ny\n' | scripts/release.sh x.y.z`) only because the owner asked for the release.
4. If it stops after the tag, run it again: it goes on from the push.
5. Run `./install.sh` so the installed mod has the released `VERSION`.
6. Report to the owner: the commit, the tag, the release link (`gh release view vx.y.z --json url`), and what was not verified.

## Notes

- The installed mod is a copy (`./install.sh`), not a link. Each install reloads the mod in Herdr.
- A reload runs the mod's start code again (updates check, restore at start). Keep start-time work safe to repeat.
