#!/usr/bin/env bash
# install-git-hooks.sh — install prepare-commit-msg + commit-msg hooks
# that prefix/validate Jira keys in commit messages.
#
# Usage:
#   scripts/install-git-hooks.sh [target-repo]
#
# If target-repo is omitted, installs in $PWD.
# Idempotent: re-running replaces only the gsd-jira block delimited by
# BEGIN/END markers, preserving any other content in existing hooks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET="${1:-$PWD}"

if [ ! -d "${TARGET}/.git" ]; then
  echo "ERROR: ${TARGET} is not a git repository (no .git/ found)"
  exit 1
fi

HOOKS_DIR="${TARGET}/.git/hooks"
mkdir -p "${HOOKS_DIR}"

install_hook() {
  local name="$1"
  local source_script="${PLUGIN_ROOT}/hooks/${name}.js"
  local target_hook="${HOOKS_DIR}/${name}"
  local block_start="# BEGIN gsd-jira"
  local block_end="# END gsd-jira"
  local shim_cmd="node \"${source_script}\" \"\$@\""

  if [ ! -f "${source_script}" ]; then
    echo "ERROR: plugin hook missing: ${source_script}"
    exit 1
  fi

  if [ -f "${target_hook}" ]; then
    if grep -q "${block_start}" "${target_hook}"; then
      # Replace existing block
      awk -v start="${block_start}" -v end="${block_end}" -v cmd="${shim_cmd}" '
        BEGIN { inside = 0 }
        $0 ~ start { print start; print cmd; print end; inside = 1; next }
        $0 ~ end   { inside = 0; next }
        inside == 0 { print }
      ' "${target_hook}" > "${target_hook}.tmp"
      mv "${target_hook}.tmp" "${target_hook}"
    else
      # Append block to existing hook
      printf '\n%s\n%s\n%s\n' "${block_start}" "${shim_cmd}" "${block_end}" >> "${target_hook}"
    fi
  else
    # Create new hook
    cat > "${target_hook}" <<EOF
#!/usr/bin/env bash
${block_start}
${shim_cmd}
${block_end}
EOF
  fi

  chmod +x "${target_hook}"
  echo "  installed: ${target_hook}"
}

echo "Installing gsd-jira git hooks in: ${TARGET}"
install_hook "prepare-commit-msg"
install_hook "commit-msg"
echo ""
echo "Done. Next commit will auto-prefix the active Jira key when present in data/jira-mapping.json."
echo "Strict mode (reject commits without a key): export GSD_JIRA_STRICT=1"
