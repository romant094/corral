#!/usr/bin/env bash
# Installs Corral into Herdr: the layout, the mod and the one-dark and one-light themes.
# With --statusline it also installs the Claude Code statusline hook that feeds the cards.
# With --link the code and the layout are symlinks to this checkout, so edits apply at once.
# Icons stay copies: Herdr does not load SVGs through a symlinked folder.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STATUSLINE_DIR="$HOME/.claude/scripts"

with_statusline=false
link=false
for arg in "$@"; do
  case "$arg" in
    --statusline) with_statusline=true ;;
    --link) link=true ;;
    -h|--help)
      echo "Usage: ./install.sh [--link] [--statusline]"
      echo "  Copies layouts/, mods/corral/ and themes/ into $HERDR_HOME."
      echo "  --link        symlinks main.js and the layout to this checkout instead of copying them."
      echo "  --statusline  also copies statusline/corral-statusline.py into $STATUSLINE_DIR."
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -d "$HERDR_HOME" ]; then
  echo "Herdr home not found: $HERDR_HOME. Start Herdr once, or set HERDR_APP_HOME." >&2
  exit 1
fi

# A folder-level symlink from an earlier setup would hide the icons; replace it with a real folder.
[ -L "$HERDR_HOME/mods/corral" ] && rm "$HERDR_HOME/mods/corral"
mkdir -p "$HERDR_HOME/layouts" "$HERDR_HOME/mods/corral/icons" "$HERDR_HOME/themes"
rm -f "$HERDR_HOME/layouts/corral.json" "$HERDR_HOME/mods/corral/main.js"
if $link; then
  ln -s "$SRC/layouts/corral.json" "$HERDR_HOME/layouts/corral.json"
  ln -s "$SRC/mods/corral/main.js" "$HERDR_HOME/mods/corral/main.js"
else
  cp "$SRC/layouts/corral.json" "$HERDR_HOME/layouts/corral.json"
  cp "$SRC/mods/corral/main.js" "$HERDR_HOME/mods/corral/main.js"
fi
cp "$SRC/mods/corral/mod.json" "$SRC/mods/corral/preview.svg" "$HERDR_HOME/mods/corral/"
cp "$SRC"/mods/corral/icons/*.svg "$HERDR_HOME/mods/corral/icons/"
cp "$SRC"/themes/*.json "$HERDR_HOME/themes/"
echo "Installed the corral layout into $HERDR_HOME$($link && echo " (main.js and the layout linked to $SRC)")."

# Corral's keys go into the person's keys.json, in its own section; a key they already bind stays theirs.
# Herdr writes keys.json with its defaults, so without one the keys are left for them to add.
if [ -f "$HERDR_HOME/keys.json" ]; then
  python3 - "$SRC/mods/corral/keys.json" "$HERDR_HOME/keys.json" <<'PY'
import json, sys
ours, theirs_path = json.load(open(sys.argv[1])), sys.argv[2]
try:
    theirs = json.load(open(theirs_path))
except ValueError:
    print(f"Couldn't read {theirs_path}; add the keys from mods/corral/keys.json by hand.")
    sys.exit(0)
added, kept = [], []
for section, keys in ours.items():
    have = theirs.setdefault(section, {})
    for key, action in keys.items():
        if key not in have:
            have[key] = action
            added.append(key)
        elif have[key] != action:
            kept.append(f"{key} ({have[key]})")
if added:
    json.dump(theirs, open(theirs_path, "w"), indent=2, ensure_ascii=False)
    open(theirs_path, "a").write("\n")
    print("Added keys:", ", ".join(added))
if kept:
    print("Kept your own keys:", ", ".join(kept))
PY
else
  echo "No keys.json in $HERDR_HOME: add the keys from mods/corral/keys.json to it."
fi

if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check "$HERDR_HOME/mods/corral"
  echo "Switch to it: herdr-app do layout.switch --name corral"
fi

if $with_statusline; then
  mkdir -p "$STATUSLINE_DIR"
  cp "$SRC/statusline/corral-statusline.py" "$STATUSLINE_DIR/corral-statusline.py"
  chmod +x "$STATUSLINE_DIR/corral-statusline.py"
  echo
  echo "Installed $STATUSLINE_DIR/corral-statusline.py."
  echo "Point Claude Code at it in ~/.claude/settings.json:"
  echo "  \"statusLine\": { \"type\": \"command\", \"command\": \"python3 $STATUSLINE_DIR/corral-statusline.py\" }"
fi
