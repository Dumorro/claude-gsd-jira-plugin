# Changelog

## [1.3.1] - 2026-04-19

Cost/latency optimization. `/jira-sync` roda em loop (a cada 10 min durante `/gsd-autonomous`) — pinning o skill em Haiku 4.5 corta custo ~10x e latência ~3x sem comprometer qualidade pro tipo de trabalho do skill (parsing estruturado, montagem de ADF, chamadas REST).

### Changed
- **`skills/jira-sync/SKILL.md`** — adicionado `model: claude-haiku-4-5-20251001` no frontmatter. O skill agora roda em Haiku independente do modelo da conversa. Transições continuam no `gsd-jira-drain.js` (Node puro, sem modelo). Quando precisar re-scan completo ou debug, rodar em Opus via override explícito.

## [1.3.0] - 2026-04-18

Autonomous-mode support. `/gsd-autonomous` roda dezenas de transições sem intervenção humana; sem flush automático, a fila `data/jira-queue.json` acumulava por horas e o quadro Kanban ficava estático. Esta release adiciona um drain leve disparado no fim de cada sessão e um atalho pra rodar `/jira-sync` em loop paralelo.

### Added
- **`hooks/gsd-jira-drain.js`** — script Node que processa apenas eventos de transição (`phase_planning`, `phase_ready`, `phase_executing`, `phase_verifying`, `phase_verified:passed`, `phase_completed`, `milestone_completed`) chamando a REST API do Jira diretamente, sem roundtrip pelo Claude. Eventos de criação (`milestone_created`, `phase_added`, `plans_created`) ficam deferidos na fila pro `/jira-sync` rico (que monta ADF descriptions). Resolve `phase_number + repo → PIB-XXX` via `data/jira-mapping.json`. Silent no-op se faltarem env vars (`JIRA_HOST/USERNAME/API_TOKEN`).
- **`hooks/hooks.json` Stop hook** — registra o drain pra rodar ao encerrar qualquer sessão Claude (timeout 30s, `|| true` pra não travar o exit).
- **`commands/jira-sync-loop.md`** — slash command `/jira-sync-loop [interval]` que dispara `/loop 10m /jira-sync` (ou intervalo customizado). Atalho pro workflow paralelo usado com `/gsd-autonomous`.

### Workflow recomendado com `/gsd-autonomous`
1. Aba paralela: `/jira-sync-loop` (drena fila completa, inclusive creations, a cada 10 min).
2. Aba principal: `/gsd-autonomous --from N`.
3. No encerramento, o Stop hook drena transições residuais automaticamente.

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
