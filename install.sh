#!/usr/bin/env bash
# Installs Corral into Herdr: the layout, the mod and the one-dark theme.
# With --statusline it also installs the Claude Code statusline hook that feeds the cards.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STATUSLINE_DIR="$HOME/.claude/scripts"

with_statusline=false
for arg in "$@"; do
  case "$arg" in
    --statusline) with_statusline=true ;;
    -h|--help)
      echo "Usage: ./install.sh [--statusline]"
      echo "  Copies layouts/, mods/corral/ and themes/ into $HERDR_HOME."
      echo "  --statusline  also copies statusline/corral-statusline.py into $STATUSLINE_DIR."
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ ! -d "$HERDR_HOME" ]; then
  echo "Herdr home not found: $HERDR_HOME. Start Herdr once, or set HERDR_APP_HOME." >&2
  exit 1
fi

mkdir -p "$HERDR_HOME/layouts" "$HERDR_HOME/mods/corral/icons" "$HERDR_HOME/themes"
cp "$SRC/layouts/corral.json" "$HERDR_HOME/layouts/corral.json"
cp "$SRC/mods/corral/main.js" "$SRC/mods/corral/mod.json" "$SRC/mods/corral/preview.svg" "$HERDR_HOME/mods/corral/"
cp "$SRC"/mods/corral/icons/*.svg "$HERDR_HOME/mods/corral/icons/"
cp "$SRC/themes/one-dark.json" "$HERDR_HOME/themes/one-dark.json"
echo "Installed the corral layout into $HERDR_HOME."

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
