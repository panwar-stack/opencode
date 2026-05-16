#!/usr/bin/env bash
set -euo pipefail

OPENCODE_BIN="${OPENCODE_BIN:-/Users/srpanwar/Documents/workspace/brain/opencode/packages/opencode/dist/opencode-darwin-x64/bin/opencode}"
START="# >>> opencode alias >>>"
END="# <<< opencode alias <<<"

install_alias() {
  local target="$1"
  local tmp

  mkdir -p "$(dirname "$target")"
  touch "$target"
  tmp="$(mktemp)"

  awk -v start="$START" -v end="$END" '
    $0 == start { skip = 1; next }
    $0 == end { skip = 0; next }
    skip != 1 { print }
  ' "$target" > "$tmp"

  if [ -s "$tmp" ]; then
    printf '\n' >> "$tmp"
  fi

  {
    printf '%s\n' "$START"
    printf 'alias opencode=%q\n' "$OPENCODE_BIN"
    printf '%s\n' "$END"
  } >> "$tmp"

  mv "$tmp" "$target"
  printf 'Updated %s\n' "$target"
}

install_alias "$HOME/.zshrc"
install_alias "$HOME/.bashrc"
install_alias "$HOME/.bash_profile"

printf '\nOpen a new terminal session, or run: source ~/.zshrc\n'
