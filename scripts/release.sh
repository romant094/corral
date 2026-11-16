#!/usr/bin/env bash
# Releases Corral: checks, sets VERSION in main.js, commits, tags, pushes and makes the GitHub release
# that installed copies update to. The notes are the version's section in CHANGELOG.md.
#   scripts/release.sh 0.2.0            asks before each step that leaves this machine
#   scripts/release.sh 0.2.0 --dry-run  checks everything, changes nothing
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
version="${1:-}"
dry=false
[ "${2:-}" = "--dry-run" ] && dry=true

die() { echo "release: $*" >&2; exit 1; }
ask() { $dry && { echo "(dry run) would: $1"; return 1; }; read -r -p "$1? [y/N] " a; [ "$a" = y ] || [ "$a" = Y ]; }

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: scripts/release.sh x.y.z [--dry-run]"
last="$(git tag --list 'v*' --sort=-v:refname | head -n1)"
last="${last#v}"
if [ -n "$last" ]; then
  [ "$(printf '%s\n%s\n' "$last" "$version" | sort -V | tail -n1)" = "$version" ] && [ "$last" != "$version" ] \
    || die "$version is not above the last release $last"
fi
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || $dry || die "release from main"
[ -z "$(git status --porcelain)" ] || die "commit or set aside your changes first"

# The notes: the lines under "## x.y.z" up to the next section.
notes="$(awk -v v="## $version" '$0 == v { on = 1; next } /^## / { on = 0 } on' CHANGELOG.md | sed '/./,$!d')"
[ -n "$notes" ] || die "CHANGELOG.md has no '## $version' section"

echo "Checking…"
node --test telegram/test/ >/dev/null || die "bridge tests fail: node --test telegram/test/"
if command -v herdr-app >/dev/null; then herdr-app check mods/corral >/dev/null || die "herdr-app check mods/corral fails"; fi

if ! $dry; then
  sed -i '' -e "s/^const VERSION = \"[^\"]*\";/const VERSION = \"$version\";/" mods/corral/main.js
  grep -q "^const VERSION = \"$version\";" mods/corral/main.js || die "could not set VERSION in main.js"
  if [ -n "$(git status --porcelain)" ]; then git commit -q -am "Release $version"; fi
  git tag -a "v$version" -m "Corral $version"
  echo "Tagged v$version."
fi

if ask "Push main and v$version to origin"; then git push origin main "v$version"; fi
if ask "Create the GitHub release v$version"; then gh release create "v$version" --title "Corral $version" --notes "$notes"; fi
echo "Notes for v$version:"
echo "$notes"
