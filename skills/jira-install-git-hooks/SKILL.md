---
name: jira-install-git-hooks
description: "Install git hooks that auto-prefix commit messages with the active GSD phase/plan Jira issue key for full code <-> Jira traceability"
argument-hint: "[target-repo-path] | --all | --uninstall | --strict"
allowed-tools:
  - Bash
  - Read
  - Glob
---

<objective>
Install `prepare-commit-msg` and `commit-msg` hooks in the target git repository so that every commit produced during a GSD phase is automatically prefixed with the Jira issue key of the most-specific active card (Subtask > Feature > Epic). This closes the traceability loop: `git log --grep PROJ-123` lists commits linked to that card, and Jira-GitHub/Bitbucket integrations display the commits on the issue.
</objective>

<context>
Hook sources live in the plugin under `hooks/prepare-commit-msg.js` and `hooks/commit-msg.js`. Both resolve the active card by reading `.planning/STATE.md`, `.planning/ROADMAP.md`, and the plugin's own `data/jira-mapping.json` -- so the mapping must already be populated (via `/jira-seed` or `/jira-sync`) before hooks produce useful output.

Installation is per-repo: the hooks are shell shims written into `${TARGET}/.git/hooks/` that shell out to the plugin's Node scripts. An existing hook file is preserved -- the installer only manages a block delimited by `# BEGIN gsd-jira` / `# END gsd-jira`.

$ARGUMENTS
</context>

<process>

## Mode Detection

Parse `$ARGUMENTS`:
- `--uninstall` -> remove gsd-jira block from hooks (call `scripts/uninstall-git-hooks.sh`)
- `--all` -> install in every repo detected under `src/*/.planning/` plus the project root if it has `.planning/`
- `--strict` -> after install, instruct the user to export `GSD_JIRA_STRICT=1` to reject commits without a key
- Specific path -> install in that repo only
- (empty) -> install in `$PWD`

## Step 1: Pre-flight Check

1. Verify the plugin path resolves: read `${CLAUDE_PLUGIN_ROOT}/hooks/prepare-commit-msg.js` exists.
2. Confirm `data/jira-mapping.json` exists and is non-empty. If missing or empty, warn the user that hooks will no-op until `/jira-seed` or `/jira-sync` populates it.
3. For each target repo, check that `.git/` exists. Skip and warn otherwise.

## Step 2: Install

Run the installer script via Bash:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-git-hooks.sh" "<target>"
```

For `--all`:

```bash
for f in src/*/.planning/ROADMAP.md; do
  repo_dir=$(dirname "$(dirname "$f")")
  bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-git-hooks.sh" "$repo_dir"
done
# Also install at project root if it has .planning/
[ -d .planning ] && bash "${CLAUDE_PLUGIN_ROOT}/scripts/install-git-hooks.sh" "$PWD"
```

For `--uninstall`:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/uninstall-git-hooks.sh" "<target>"
```

## Step 3: Verify

Print a summary and a dry-run invocation the user can run:

```bash
# Simulate what a commit message would look like:
echo "refactor foo" > /tmp/gsd-jira-test-msg
node "${CLAUDE_PLUGIN_ROOT}/hooks/prepare-commit-msg.js" /tmp/gsd-jira-test-msg message
cat /tmp/gsd-jira-test-msg
```

If the file still reads `refactor foo` (no prefix), the resolver returned null. Likely causes:
- `.planning/STATE.md` missing or without `stopped_at: Phase N`
- `data/jira-mapping.json` has no entry for the resolved card id
- the repo layout doesn't match `src/<repo>/.planning/` or `./.planning/`

Report back the exit status of each install and any warnings raised.

## Output

Final message should list:
- Each repo where hooks were installed (or removed)
- Whether `data/jira-mapping.json` is populated
- Strict-mode toggle instruction (`export GSD_JIRA_STRICT=1`)
- Next step: make a small commit to confirm the prefix is injected

</process>
