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
      echo "  --statusline  also copies statusline/corral-statusline.py into $STATUSLINE_DIR (an installed one is always updated)"
      echo "                and checks that statusLine in ~/.claude/settings.json runs it."
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
rm -f "$HERDR_HOME/layouts/corral.json"
if $link; then
  ln -s "$SRC/layouts/corral.json" "$HERDR_HOME/layouts/corral.json"
else
  # A renamed mod gets its own name in the layout that shows it (and in main.js, below).
  sed -e "s/\"mod\": \"corral\"/\"mod\": \"$name\"/g" -e "s#mods/corral/#mods/$name/#g" "$SRC/layouts/corral.json" > "$HERDR_HOME/layouts/corral.json"
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
    # Decided before adding anything: did the person's section already have Corral's keys?
    had = any(v.startswith(name + ".") for v in have.values())
    for key, action in keys.items():
        action = name + action[len("corral"):] if action.startswith("corral.") else action
        # An action already on another key was rebound in Corral's settings: it stays there.
        if action in have.values() and have.get(key) != action:
            continue
        # Once the person's section has Corral's keys, a view without one was cleared on purpose.
        view = action.split(".", 1)[1] if "." in action else ""
        if view in ("board", "files", "log", "changes") and had:
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

if $with_statusline; then
  mkdir -p "$STATUSLINE_DIR"
  cp "$SRC/statusline/corral-statusline.py" "$STATUSLINE_DIR/corral-statusline.py"
  chmod +x "$STATUSLINE_DIR/corral-statusline.py"
  if $had_statusline; then
    echo "Updated $STATUSLINE_DIR/corral-statusline.py."
  else
    echo "Installed $STATUSLINE_DIR/corral-statusline.py."
  fi
  # Claude Code runs one statusLine command: without this hook the cards get no session data.
  # "check" exits 0 when it runs the hook, 1 when it doesn't, 2 when settings.json can't be read.
  # "set" points it at the hook, after a timestamped backup; another command stays, chained.
  SETTINGS="$HOME/.claude/settings.json"
  # read stops at the end of the text with status 1; the text is all there.
  read -r -d '' statusline_py <<'PY' || true
import datetime, json, os, shlex, shutil, sys
mode, path, script = sys.argv[1:4]
# The ~ form, as in the README; Claude Code runs the command in a shell.
home = os.path.expanduser("~") + "/"
want = "python3 " + ("~/" + shlex.quote(script[len(home):]) if script.startswith(home) else shlex.quote(script))

def runs_hook(command):
    """Does the command run a corral-statusline.py that exists?"""
    try:
        words = shlex.split(command)
    except ValueError:
        words = command.split()
    for word in words:
        if word.endswith("corral-statusline.py"):
            return os.path.isfile(os.path.expanduser(os.path.expandvars(word)))
    return False

try:
    settings = json.load(open(path)) if os.path.exists(path) else {}
    if not isinstance(settings, dict):
        raise ValueError
except ValueError:
    print(f"Couldn't read {path}; set statusLine in it by hand:")
    print(f'  "statusLine": {{ "type": "command", "command": {json.dumps(want)} }}')
    sys.exit(2)
line = settings.get("statusLine")
command = line.get("command") if isinstance(line, dict) else None
# A command of the person's own, not an older Corral hook: it is kept as the chained one.
theirs = command.strip() if isinstance(command, str) and "corral-statusline.py" not in command else ""
if mode == "check":
    if isinstance(command, str) and runs_hook(command):
        print(f"Claude Code's statusLine runs the hook ({path}).")
        sys.exit(0)
    print("Warning: Claude Code's statusLine does not run the hook, so the cards get no session data.")
    print(f"  Now in {path}: {json.dumps(line) if line is not None else 'no statusLine'}")
    print(f'  Set it to: "statusLine": {{ "type": "command", "command": {json.dumps(want)} }}')
    if theirs:
        print("  To keep your status line, chain it: "
              + json.dumps(f"CORRAL_STATUSLINE_CHAIN={shlex.quote(theirs)} {want}"))
    sys.exit(1)
if os.path.exists(path):
    backup = f"{path}.bak-{datetime.datetime.now():%Y%m%d-%H%M%S}"
    shutil.copy2(path, backup)
    print(f"Saved a backup: {backup}")
line = line if isinstance(line, dict) else {}
line["type"] = "command"
line["command"] = f"CORRAL_STATUSLINE_CHAIN={shlex.quote(theirs)} {want}" if theirs else want
settings["statusLine"] = line
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(settings, open(path, "w"), indent=2, ensure_ascii=False)
open(path, "a").write("\n")
print(f"Set statusLine in {path}{' (your status line is chained)' if theirs else ''}.")
PY
  statusline_check=0
  python3 -c "$statusline_py" check "$SETTINGS" "$STATUSLINE_DIR/corral-statusline.py" || statusline_check=$?
  # Set it only with the person's yes: never in a run without a terminal, such as Corral's own update.
  if [ "$statusline_check" = 1 ] && [ -t 0 ]; then
    read -r -p "Set statusLine in $SETTINGS now (a backup is kept)? [y/N] " answer || answer=
    if [[ "$answer" =~ ^[yY] ]]; then
      python3 -c "$statusline_py" set "$SETTINGS" "$STATUSLINE_DIR/corral-statusline.py"
    fi
  fi
fi

# A bridge running under launchd picks up the new code, if it is this install's bridge (not one of another home).
PLIST="$HOME/Library/LaunchAgents/dev.corral.telegram.plist"
if [ "$(uname)" = Darwin ] && [ -f "$PLIST" ] && grep -qF "$HERDR_HOME/corral/telegram/bridge.mjs" "$PLIST" \
  && launchctl print "gui/$(id -u)/dev.corral.telegram" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/dev.corral.telegram" && echo "Restarted the Telegram bridge."
fi

# main.js goes in last and whole (temp file, then rename): Herdr reloads the mod as soon as it changes,
# and Corral's own update waits in that mod for everything above to be done.
if $link; then
  rm -f "$MOD_DIR/main.js"
  ln -s "$SRC/mods/corral/main.js" "$MOD_DIR/main.js"
else
  sed "s/^const MOD = \"corral\";/const MOD = \"$name\";/" "$SRC/mods/corral/main.js" > "$MOD_DIR/.main.js.tmp"
  mv "$MOD_DIR/.main.js.tmp" "$MOD_DIR/main.js"
fi

if command -v herdr-app >/dev/null 2>&1; then
  herdr-app check "$MOD_DIR"
  echo "Switch to it: herdr-app do layout.switch --name corral"
fi
