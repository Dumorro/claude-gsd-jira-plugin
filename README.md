# claude-gsd-jira-plugin

Jira integration for [GSD (Get Shit Done)](https://github.com/gsd-build/get-shit-done) projects in Claude Code. A PostToolUse hook detects GSD lifecycle events (milestone creation, phase transitions, plan authoring, verification) as they happen, enqueues them locally, and syncs them to a 6-column Kanban board in Jira -- automatically creating Epics, Features, and Subtasks that mirror your `.planning/` directory structure.

## Quick Start

1. Set environment variables:
   ```bash
   export JIRA_HOST="https://your-org.atlassian.net"
   export JIRA_USERNAME="you@email.com"
   export JIRA_API_TOKEN="..."  # https://id.atlassian.com/manage-profile/security/api-tokens
   ```

2. Clone and validate:
   ```bash
   git clone https://github.com/your-org/claude-gsd-jira-plugin.git
   cd claude-gsd-jira-plugin
   chmod +x scripts/setup.sh
   ./scripts/setup.sh
   ```

3. Register the hook in `.claude/settings.json`:
   ```json
   {
     "hooks": {
       "PostToolUse": [
         {
           "matcher": "Write|Edit",
           "command": "node /path/to/claude-gsd-jira-plugin/hooks/gsd-jira-watch.js"
         }
       ]
     }
   }
   ```

4. Configure the Kanban board:
   ```
   /jira-setup-kanban
   ```

5. Seed Jira with your current GSD state:
   ```
   /jira-seed --dry-run   # Preview
   /jira-seed             # Create cards
   ```

6. Enrich card descriptions from `.planning/` content:
   ```bash
   python3 scripts/enrich-cards.py --dry-run  # Preview
   python3 scripts/enrich-cards.py            # Execute
   ```

7. Install git hooks so every commit auto-prefixes the active Jira key:
   ```
   /jira-install-git-hooks        # Current repo
   /jira-install-git-hooks --all  # Every detected GSD repo
   ```

## Skills

| Skill | Description |
|-------|-------------|
| `/jira-sync` | Incremental event-based sync. Processes `data/jira-queue.json` and creates/updates/transitions Jira cards. |
| `/jira-seed` | One-time full population. Reads all `.planning/` artifacts and creates the complete card hierarchy in Jira. |
| `/jira-setup-kanban` | Automated Kanban board setup. Creates statuses, configures columns, and sets WIP limits. |
| `/jira-install-git-hooks` | Install `prepare-commit-msg` + `commit-msg` hooks that auto-prefix commits with the active phase/plan Jira key. |

## Kanban Board

```
| Backlog | Planning | Ready | Executing | Verification | Done |
|---------|----------|-------|-----------|--------------|------|
|  phase  | discuss  | plan  |   build   |    verify    | ship |
|  added  | research | ready |   test    |     UAT      |      |
```

**Card hierarchy:**
- Milestone (v1.0, v2.0) -> Epic
- Phase (Phase 1, Phase 2) -> Feature (child of Epic)
- Plan (Plan 01, Plan 02) -> Subtask (child of Feature)

## Requirements

- [GSD (Get Shit Done)](https://github.com/gsd-build/get-shit-done) workflow active in your project
- Jira Cloud (API v3)
- Node.js 18+
- Python 3.8+

## Documentation

- [Setup Guide](docs/SETUP.md) -- Installation, configuration, first run
- [Architecture](docs/ARCHITECTURE.md) -- Hook/queue/sync pipeline, event types, idempotency
- [Kanban Reference](docs/KANBAN.md) -- Column definitions, status IDs, WIP limits

## License

MIT
