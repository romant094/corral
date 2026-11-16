#!/usr/bin/env bash
# Installs Corral into Herdr: the layout, the mod, the one-dark and one-light themes and the Telegram bridge.
# With --statusline it also installs the Claude Code statusline hook that feeds the cards.
# With --link the code and the layout are symlinks to this checkout, so edits apply at once.
# Icons stay copies: Herdr does not load SVGs through a symlinked folder.
set -euo pipefail
# [a-z] in the --name check means ASCII letters only in the C locale.
export LC_ALL=C

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STATUSLINE_DIR="$HOME/.claude/scripts"

with_statusline=false
link=false
name=corral
while [ $# -gt 0 ]; do
  case "$1" in
    --statusline) with_statusline=true ;;
    --link) link=true ;;
    --name)
      name="${2:-}"; shift
      if ! [[ "$name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then echo "--name needs a folder name like corral-2" >&2; exit 1; fi ;;
    -h|--help)
      echo "Usage: ./install.sh [--link] [--statusline] [--name <mod folder>]"
      echo "  Copies layouts/, mods/corral/, themes/ and telegram/ into $HERDR_HOME."
      echo "  --link        symlinks main.js, the layout and telegram/ to this checkout instead of copying them."
      echo "  --statusline  also copies statusline/corral-statusline.py into $STATUSLINE_DIR (an installed one is always updated)."
      echo "  --name        the mod's folder, when a gallery install had to rename it (Corral's update passes it)."
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
if $link && [ "$name" != corral ]; then echo "--link installs as corral only" >&2; exit 1; fi
# A statusline hook installed before is kept current, quietly.
had_statusline=false
[ -f "$STATUSLINE_DIR/corral-statusline.py" ] && with_statusline=true && had_statusline=true
MOD_DIR="$HERDR_HOME/mods/$name"

if [ ! -d "$HERDR_HOME" ]; then
  echo "Herdr home not found: $HERDR_HOME. Start Herdr once, or set HERDR_APP_HOME." >&2
  exit 1
fi

# A folder-level symlink from an earlier setup would hide the icons; replace it with a real folder.
[ -L "$MOD_DIR" ] && rm "$MOD_DIR"
mkdir -p "$HERDR_HOME/layouts" "$MOD_DIR/icons" "$HERDR_HOME/themes"
rm -f "$HERDR_HOME/layouts/corral.json" "$MOD_DIR/main.js"
if $link; then
  ln -s "$SRC/layouts/corral.json" "$HERDR_HOME/layouts/corral.json"
  ln -s "$SRC/mods/corral/main.js" "$MOD_DIR/main.js"
else
  # A renamed mod gets its own name in its code and in the layout that shows it.
  sed "s/^const MOD = \"corral\";/const MOD = \"$name\";/" "$SRC/mods/corral/main.js" > "$MOD_DIR/main.js"
  sed -e "s/\"mod\": \"corral\"/\"mod\": \"$name\"/" -e "s#mods/corral/#mods/$name/#" "$SRC/layouts/corral.json" > "$HERDR_HOME/layouts/corral.json"
fi
cp "$SRC/mods/corral/mod.json" "$SRC/mods/corral/preview.svg" "$MOD_DIR/"
cp "$SRC"/mods/corral/icons/*.svg "$MOD_DIR/icons/"
cp "$SRC"/themes/*.json "$HERDR_HOME/themes/"
# The Telegram bridge: a folder of Node modules, linked whole or copied without its tests.
rm -rf "$HERDR_HOME/corral/telegram"
# corral/ also holds the bot token and the bridge's state: the owner's only.
mkdir -p "$HERDR_HOME/corral"
chmod 700 "$HERDR_HOME/corral"
if $link; then
  ln -s "$SRC/telegram" "$HERDR_HOME/corral/telegram"
else
  mkdir -p "$HERDR_HOME/corral/telegram"
  cp "$SRC"/telegram/*.mjs "$HERDR_HOME/corral/telegram/"
fi
echo "Installed the corral layout into $HERDR_HOME$([ "$name" != corral ] && echo " (mod folder: $name)")$($link && echo " (main.js, the layout and telegram/ linked to $SRC)")."

# Corral's keys go into the person's keys.json, in its own section; a key they already bind stays theirs.
# Herdr writes keys.json with its defaults, so without one the keys are left for them to add.
if [ -f "$HERDR_HOME/keys.json" ]; then
  python3 - "$SRC/mods/corral/keys.json" "$HERDR_HOME/keys.json" "$name" <<'PY'
import json, sys
ours, theirs_path, name = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
try:
    theirs = json.load(open(theirs_path))
except ValueError:
    print(f"Couldn't read {theirs_path}; add the keys from mods/corral/keys.json by hand.")
    sys.exit(0)
added, kept = [], []
for section, keys in ours.items():
    have = theirs.setdefault(section, {})
    for key, action in keys.items():
        action = name + action[len("corral"):] if action.startswith("corral.") else action
        # An action already on another key was rebound in Corral's settings: it stays there.
        if action in have.values() and have.get(key) != action:
            continue
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
  herdr-app check "$MOD_DIR"
  echo "Switch to it: herdr-app do layout.switch --name corral"
fi

# A bridge running under launchd picks up the new code.
if [ "$(uname)" = Darwin ] && launchctl print "gui/$(id -u)/dev.corral.telegram" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/dev.corral.telegram" && echo "Restarted the Telegram bridge."
fi

if $with_statusline; then
  mkdir -p "$STATUSLINE_DIR"
  cp "$SRC/statusline/corral-statusline.py" "$STATUSLINE_DIR/corral-statusline.py"
  chmod +x "$STATUSLINE_DIR/corral-statusline.py"
  $had_statusline && { echo "Updated $STATUSLINE_DIR/corral-statusline.py."; exit 0; }
  echo
  echo "Installed $STATUSLINE_DIR/corral-statusline.py."
  echo "Point Claude Code at it in ~/.claude/settings.json:"
  echo "  \"statusLine\": { \"type\": \"command\", \"command\": \"python3 $STATUSLINE_DIR/corral-statusline.py\" }"
fi
