# Changelog

## [1.2.1] - 2026-04-17

Post-Phase 44 re-verification patch. Plan `44-08-PLAN.md` (gap-closure G-05) surfaced a parser bug: the `plans_created` event landed in the queue with `phase: "unknown"` and `plan: "01"`, causing `/jira-sync` to skip subtask creation.

### Fixed
- **`hooks/gsd-jira-watch.js` plan filename regex** — the previous pattern `^(\d+(?:\.\d+)?)-.*?-(\d+)-PLAN\.md$` required a middle segment between phase and plan numbers (e.g., `44-01-iam-foundation-PLAN.md`). Short-form filenames like `44-08-PLAN.md` (no middle) fell through to the `unknown`/`01` fallback. New regex `^(\d+(?:\.\d+)?)-(\d+)(?:-.*?)?-PLAN\.md$` makes the middle segment optional — works with both forms (`44-08-PLAN.md` and `44-01-iam-foundation-PLAN.md`) and preserves decimal-phase support (`72.1-03-PLAN.md`).

## [1.2.0] - 2026-04-17

Post-Phase 44 hardening. Phase 44 Foundation & Safety was the first phase where a real (non-no-op) execution ran end-to-end. Two issues surfaced that this release addresses.

### Changed
- **`/jira-sync` — subtask cascade** — when a Feature transitions to `Executando`, `Concluido`, or `phase_verified:passed`, the skill now transitions all its `gsd-managed` subtasks in the same direction. Fixes the Phase 44 failure mode where 7 subtasks stayed in **Backlog** even after the phase shipped (they had to be transitioned manually via Jira MCP).
- **`/jira-sync` Step 4 table** reformulated to explicitly show the cascade column (Feature + Subtask actions side-by-side).
- **`/jira-sync` Step 5** — new code snippet showing how to list and transition subtasks in a single loop (idempotent, safe to re-run).

### Added
- **Step 9 — MCP fallback** — documented the Atlassian MCP tool equivalents for every curl operation. Useful when env vars (`JIRA_HOST/USERNAME/API_TOKEN`) are absent or the session uses OAuth.

### Fixed
- **Version mismatch** — `plugin.json` was stuck at `1.0.0` even though `CHANGELOG.md` already showed `1.1.0`. Both now aligned at `1.2.0`.
- **Cascade idempotency rule** — explicit "never re-open a Concluido subtask" rule added to the cascade description.

### Unchanged
- `hooks/gsd-jira-watch.js` — the hook already emits `phase_verifying` + `phase_verified` with `status: passed` + `score: X/Y` correctly (confirmed against the Phase 44 queue dump). No changes needed.

## [1.1.0] - 2026-04-16

### Added
- Git commit traceability: `prepare-commit-msg` + `commit-msg` hooks that auto-prefix every commit with the active GSD phase/plan Jira issue key (Subtask > Feature > Epic precedence).
- `/jira-install-git-hooks` skill with `--all` / `--uninstall` / `--strict` modes.
- `scripts/install-git-hooks.sh` and `scripts/uninstall-git-hooks.sh` (idempotent via `# BEGIN gsd-jira` / `# END gsd-jira` markers).
- `scripts/setup.sh --install-git-hooks` flag to wire hooks into every detected repo during setup.
- `hooks/lib/resolve-active-card.js` shared resolver (reads `STATE.md` + `ROADMAP.md` + `data/jira-mapping.json`, no Jira API call at commit time).
- Strict mode via `GSD_JIRA_STRICT=1` rejects commits without a Jira key.
- Unit tests: `hooks/lib/resolve-active-card.test.js` (`node --test`).

### Changed
- Extracted `findProjectRoot`, `detectRepo`, `readFileSafe`, `slugify` from `hooks/gsd-jira-watch.js` into `hooks/lib/path-utils.js` for reuse.

### Planned (out of scope for 1.1)
- `commit_linked` event + Jira remote-link back to commit URL.

## [1.0.0] - 2026-04-16

### Added
- Initial release
- `/jira-sync` skill: incremental event-based sync
- `/jira-seed` skill: one-time full population
- `/jira-setup-kanban` skill: automated Kanban board setup
- PostToolUse hook for automatic GSD event detection
- Card enrichment script with ADF descriptions
- Jira MCP server configuration
- Documentation: SETUP, ARCHITECTURE, KANBAN guides
