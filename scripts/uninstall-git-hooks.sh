#!/usr/bin/env bash
# uninstall-git-hooks.sh — remove the gsd-jira block from git hooks.
#
# Usage:
#   scripts/uninstall-git-hooks.sh [target-repo]
#
# Idempotent: safe to run when hooks were never installed.

set -euo pipefail

TARGET="${1:-$PWD}"

if [ ! -d "${TARGET}/.git" ]; then
  echo "ERROR: ${TARGET} is not a git repository"
  exit 1
fi

HOOKS_DIR="${TARGET}/.git/hooks"

remove_block() {
  local name="$1"
  local hook="${HOOKS_DIR}/${name}"
  [ -f "${hook}" ] || return 0

  if ! grep -q "# BEGIN gsd-jira" "${hook}"; then
    return 0
  fi

  awk '
    BEGIN { inside = 0 }
    /# BEGIN gsd-jira/ { inside = 1; next }
    /# END gsd-jira/   { inside = 0; next }
    inside == 0 { print }
  ' "${hook}" > "${hook}.tmp"

  # If nothing meaningful remains (only shebang + blank lines), remove entirely
  if [ "$(grep -cv '^\s*$\|^#!' "${hook}.tmp")" -eq 0 ]; then
    rm -f "${hook}" "${hook}.tmp"
    echo "  removed: ${hook}"
  else
    mv "${hook}.tmp" "${hook}"
    echo "  cleaned: ${hook}"
  fi
}

echo "Uninstalling gsd-jira git hooks from: ${TARGET}"
remove_block "prepare-commit-msg"
remove_block "commit-msg"
echo "Done."
