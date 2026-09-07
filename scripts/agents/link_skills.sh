#!/bin/sh
# Link canonical skills into Claude's native discovery directory.
set -eu
mode=write
case "${1-}" in
  '') ;;
  --check) mode=check ;;
  *) echo 'Usage: sh scripts/agents/link_skills.sh [--check]' >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || exit 2
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
cd "$repo"
canonical=.agents/skills
links=.claude/skills
[ -d "$canonical" ] || { echo "Missing $canonical" >&2; exit 1; }
# Never traverse a redirected adapter root.
for dir in .claude "$links"; do
  [ ! -L "$dir" ] || { echo "Refusing symlink directory $dir" >&2; exit 1; }
  if [ ! -d "$dir" ]; then
    [ "$mode" = write ] || { echo "Missing $dir" >&2; exit 1; }
    mkdir -p "$dir"
  fi
done
failed=0
count=0
# Preflight all real entries before any mutation. No trailing slash: dangling links count.
for entry in "$links"/* "$links"/.[!.]* "$links"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  [ -L "$entry" ] && continue
  name=${entry##*/}
  target="../../.agents/skills/$name"
  # Only exact Git symlink text stubs are replaceable; no arbitrary regular files.
  if [ -f "$entry" ] && [ -f "$canonical/$name/SKILL.md" ] &&
     [ "$(cat "$entry")" = "$target" ] && [ "$(wc -c < "$entry" | tr -d ' ')" -eq "${#target}" ]; then
    continue
  fi
  echo "Refusing real file or directory: $entry" >&2
  failed=1
done
[ "$failed" -eq 0 ] || exit 1
for src in "$canonical"/*; do
  [ -f "$src/SKILL.md" ] || continue
  name=${src##*/}
  target="../../.agents/skills/$name"
  entry="$links/$name"
  count=$((count + 1))
  if [ -L "$entry" ] && [ "$(readlink "$entry")" = "$target" ] && [ -f "$entry/SKILL.md" ]; then
    continue
  fi
  if [ "$mode" = check ]; then
    echo "Missing, wrong or dangling link: $entry" >&2; failed=1; continue
  fi
  [ ! -e "$entry" ] && [ ! -L "$entry" ] || rm -- "$entry"
  # Git Bash must not silently copy directories instead of creating native links.
  MSYS=winsymlinks:nativestrict ln -s "$target" "$entry"
  [ -L "$entry" ] && [ -f "$entry/SKILL.md" ] || { echo "Link creation failed: $entry" >&2; exit 1; }
done
[ "$count" -gt 0 ] || { echo 'No canonical skills found' >&2; exit 1; }
for entry in "$links"/* "$links"/.[!.]* "$links"/..?*; do
  [ -L "$entry" ] || continue
  name=${entry##*/}
  [ ! -f "$canonical/$name/SKILL.md" ] || continue
  if [ "$mode" = check ]; then
    echo "Stale or dangling link: $entry" >&2; failed=1
  else
    rm -- "$entry"
  fi
done
[ "$failed" -eq 0 ] || exit 1
printf 'Verified %s Claude skill links.\n' "$count"
