---
name: jira-sync
description: "Process pending GSD events and sync Jira cards (create/update epics, features, subtasks)"
argument-hint: "--dry-run | --full | --status"
model: claude-haiku-4-5-20251001
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
---

<objective>
Process the GSD->Jira event queue at `data/jira-queue.json` and synchronize cards in Jira.
Uses the Jira REST API to create/update Epics, Features, and Subtasks matching the GSD state.
</objective>

<context>
Queue file: `data/jira-queue.json`
Mapping file: `data/jira-mapping.json`
Config file: `data/jira-config.json` (transition IDs, project key)

$ARGUMENTS
</context>

<process>

## Mode Detection

Check `$ARGUMENTS`:
- `--status` -> Show queue stats and exit (step 1 only)
- `--dry-run` -> Show what would happen without calling Jira API
- `--full` -> Ignore queue, re-scan all `.planning/` dirs and sync everything
- (empty) -> Process pending queue

## Step 1: Read Current State

1. Read `data/jira-queue.json` -- the pending events
2. Read `data/jira-mapping.json` -- existing card-id -> Jira issue key mapping
3. Read `data/jira-config.json` -- transition IDs and project key (if exists)
4. If `--status`: print summary table of pending events grouped by repo and type, then stop

## Step 2: Load Jira Config

1. Read env vars: `JIRA_HOST`, `JIRA_USERNAME`, `JIRA_API_TOKEN`
2. If any are missing, print error with setup instructions and stop
3. Determine project key:
   - If `JIRA_PROJECT_KEY` env var is set, use it
   - Else if `data/jira-config.json` has `projectKey`, use it
   - Else auto-detect: `GET /rest/api/3/project` and pick the first project (or prompt if multiple)
4. Load transition IDs:
   - If `data/jira-config.json` exists and has `transitions`, use those
   - Else discover via API: `GET /rest/api/3/issue/{any-issue}/transitions` and cache to `data/jira-config.json`

## Step 3: Detect Repos

Auto-detect repos by globbing `src/*/.planning/` directories.
For each match, extract the repo name from the path (e.g., `src/my-api/.planning/` -> `my-api`).

## Step 4: Process Events (or full scan)

### If `--full` mode:
Scan all detected repos and build the full card hierarchy:

For each repo discovered in Step 3:
1. Read `src/{repo}/.planning/ROADMAP.md`
2. Parse all milestones -> create/update **Epics**
3. Parse all phases -> create/update **Features** linked to their Epic
4. Glob `src/{repo}/.planning/phases/*-PLAN.md` and `src/{repo}/.planning/milestones/**/*-PLAN.md`
5. Parse each PLAN.md frontmatter -> create/update **Subtasks** linked to their Feature
6. Read `src/{repo}/.planning/STATE.md` -> update status of active phase/milestone

### If queue mode (default):
Process each event in `data/jira-queue.json` in order:

| Event | Action on Feature | **Cascade on all child Subtasks** |
|-------|-------------------|-----------------------------------|
| `milestone_created` | Create **Epic**: `[{repo}] {version} -- {name}` | — |
| `phase_added` | Create **Feature**: `Phase {N}: {name}`, link to Epic -> **Backlog** | — |
| `plans_created` | Create **Subtask**: `{phase}-{plan}: {objective}`, link to Feature | — (this IS the subtask creation) |
| `phase_planning` | Transition Feature -> **Planejamento** | — (no cascade; subtasks stay in Backlog until execution) |
| `phase_ready` | Transition Feature -> **Pronto** | — |
| `phase_executing` | Transition Feature -> **Executando** | **Transition every Backlog subtask -> Executando** |
| `phase_verifying` | Transition Feature -> **Verificacao** | — (subtasks keep their state until phase result) |
| `phase_completed` | Transition Feature -> **Concluido** | **Transition every non-Concluido subtask -> Concluido** |
| `phase_verified` | If status=passed: Feature -> **Concluido**. If gaps_found: add comment with gaps, stay in **Verificacao** | If passed: **Transition every non-Concluido subtask -> Concluido**. If gaps_found: — |
| `milestone_completed` | Transition Epic -> **Concluido** | — (subtasks already closed via phase_completed/phase_verified) |

All transition IDs are read from `data/jira-config.json`. If the config file is missing, discover transitions via API first (see Step 2).

### Subtask cascade rationale

Observed failure in **Phase 44 Foundation & Safety** (core-api, 2026-04-17): all 7 subtasks stayed in **Backlog** after the phase shipped, because the original skill only transitioned the Feature. Operators had to transition each subtask manually via Jira MCP.

The cascade pattern above mirrors reality: when a phase enters execution, its plans are being worked on; when a phase is verified passed, its plans are done. Subtasks should reflect the parent Feature's state automatically.

**Rules for the cascade:**
- Only cascade to subtasks whose label includes `gsd-managed` (do not touch manually-created subtasks).
- Only move **forward** in the lifecycle (never re-open a `Concluido` subtask).
- If any subtask transition fails, log the error and continue — do not abort the whole sync.

## Step 4.5: Build Card Description (ADF)

When CREATING a card, always include a structured description in Atlassian Document Format (ADF).
Extract content from the GSD artifact that triggered the event.

### Epic Description
Source: `src/{repo}/.planning/ROADMAP.md` + `milestones/{version}-ROADMAP.md`

```
## Goal
{milestone name/goal from ROADMAP.md}

## Phases
{phase range} -- {done}/{total} complete
- Phase N: Name [done/pending]
...

## Stats
{from MILESTONES.md if available: accomplishments, test counts}
```

### Feature Description
Source: `milestones/{version}-ROADMAP.md` section `### Phase N:`

```
## Goal
{**Goal**: line from phase section}

## Requirements
- {requirement codes: AUTH-01, etc.}

## Success Criteria
- {numbered criteria from **Success Criteria** block}

## Plans
- {plan list from **Plans**: block}

## Dependencies
{**Depends on**: line}
```

### Subtask Description
Source: `{phase-dir}/{NN}-{PP}-PLAN.md` (YAML frontmatter + <objective> tag)

```
## Objective
{first line of <objective> tag}

## Requirements
- {requirements from frontmatter}

## Must-Haves
- {truths from must_haves.truths}

## Files Modified
- {files_modified list, max 15}

Wave: {wave number}
```

### ADF Format Reference
```json
{
  "type": "doc", "version": 1,
  "content": [
    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Goal"}]},
    {"type": "paragraph", "content": [{"type": "text", "text": "..."}]},
    {"type": "bulletList", "content": [
      {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "..."}]}]}
    ]}
  ]
}
```

## Step 5: Jira API Calls

For each card operation, use `bash` with `curl` to call Jira REST API v3:

### Create Issue
```bash
PROJECT_KEY=$(cat data/jira-config.json | jq -r '.projectKey')

curl -s -X POST \
  "${JIRA_HOST}/rest/api/3/issue" \
  -H "Authorization: Basic $(echo -n '${JIRA_USERNAME}:${JIRA_API_TOKEN}' | base64)" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "project": {"key": "'${PROJECT_KEY}'"},
      "summary": "...",
      "description": {ADF document from Step 4.5},
      "issuetype": {"name": "Epic|Feature|Subtask"},
      "labels": ["gsd-managed", "{repo-label}"],
      "priority": {"name": "High"}
    }
  }'
```

### Transition Issue
```bash
# First get available transitions
curl -s "${JIRA_HOST}/rest/api/3/issue/{key}/transitions" ...

# Then transition using ID from data/jira-config.json
TRANSITION_ID=$(cat data/jira-config.json | jq -r '.transitions.executando')
curl -s -X POST "${JIRA_HOST}/rest/api/3/issue/{key}/transitions" \
  -d '{"transition": {"id": "'${TRANSITION_ID}'"}}'
```

### Link Feature to Epic
Use the Epic Link field (discover via `/rest/api/3/field` -- typically `customfield_10014`).

### List Subtasks of a Feature (for cascade)

When processing `phase_executing`, `phase_completed`, or `phase_verified:passed`, list the Feature's subtasks and transition each one:

```bash
FEATURE_KEY="PIB-401"
TARGET_TRANSITION=$(cat data/jira-config.json | jq -r '.transitions.concluido.transitionId')
AUTH="$(echo -n "${JIRA_USERNAME}:${JIRA_API_TOKEN}" | base64)"

# JQL: parent=<feature> AND labels=gsd-managed — do not touch manually-created subtasks
SUBTASK_KEYS=$(curl -s -G "${JIRA_HOST}/rest/api/3/search" \
  --data-urlencode "jql=parent=${FEATURE_KEY} AND labels=gsd-managed" \
  --data-urlencode "fields=status" \
  -H "Authorization: Basic ${AUTH}" \
  | jq -r '.issues[] | select(.fields.status.name != "Concluido") | .key')

for KEY in ${SUBTASK_KEYS}; do
  curl -s -X POST "${JIRA_HOST}/rest/api/3/issue/${KEY}/transitions" \
    -H "Authorization: Basic ${AUTH}" \
    -H "Content-Type: application/json" \
    -d "{\"transition\": {\"id\": \"${TARGET_TRANSITION}\"}}" \
    || echo "WARN: failed to transition ${KEY} (continuing)"
done
```

Only transition subtasks that are **not already** in the target state (see Idempotency Rules below).

## Step 6: Update Mapping

After each successful create:
1. Add entry to `data/jira-mapping.json`: `"{repo}/{milestone}/{phase}/{plan}": "{PROJECT_KEY}-XXX"`
2. Write the updated mapping file

## Step 7: Clear Processed Events

Remove processed events from `data/jira-queue.json`. Keep failed events with an `error` field.

## Step 8: Report

Print summary:
```
Jira Sync Complete
  Created: 2 features, 4 subtasks
  Updated: 1 epic (status -> Concluido)
  Failed: 0
  Remaining in queue: 0
```

## Idempotency Rules

1. Before creating: check `jira-mapping.json` -- if card-id exists, UPDATE instead of CREATE
2. Status only moves forward: Backlog -> Planejamento -> Pronto -> Executando -> Verificacao -> Concluido (never backward)
3. If Jira issue already has target status, skip the transition
4. Labels always include `gsd-managed` -- this identifies managed cards

## Card ID Format

`{repo}/{milestone}/{phase}/{plan}`

Examples:
- `my-api/v2.0` -> Epic
- `my-api/v2.0/32-iam-foundation` -> Feature
- `my-api/v2.0/32-iam-foundation/plan-01` -> Subtask

## Transition IDs

Transition IDs vary per Jira project. They are stored in `data/jira-config.json`:

```json
{
  "projectKey": "PROJ",
  "transitions": {
    "backlog": { "transitionId": "11", "statusId": "10000" },
    "planejamento": { "transitionId": "2", "statusId": "10036" },
    "pronto": { "transitionId": "3", "statusId": "10037" },
    "executando": { "transitionId": "21", "statusId": "10001" },
    "verificacao": { "transitionId": "31", "statusId": "10002" },
    "concluido": { "transitionId": "41", "statusId": "10003" }
  }
}
```

If `data/jira-config.json` does not exist, discover transitions by calling:
```bash
curl -s "${JIRA_HOST}/rest/api/3/issue/{any-issue-key}/transitions" \
  -H "Authorization: Basic $(echo -n '${JIRA_USERNAME}:${JIRA_API_TOKEN}' | base64)"
```
Then save the discovered IDs to `data/jira-config.json` for future runs.

### Kanban Column Reference

| Column | Status Name | Flow Direction |
|--------|------------|----------------|
| Backlog | Backlog | Start |
| Planejamento | Planejamento | -> |
| Pronto | Pronto | -> |
| Executando | Executando | -> |
| Verificacao | Verificacao | -> |
| Concluido | Concluido | End |

## Label Convention

Auto-detected repos get labels derived from their directory name.
All cards also get `gsd-managed`.

Common mappings (customize in `data/jira-config.json` `repoLabels` if needed):
| Repo Directory | Default Label |
|---------------|---------------|
| *-api, *-backend, *-server | `backend` |
| *-pwa, *-web, *-frontend | `frontend` |
| *-infra, *-terraform, *-iac | `infra` |
| (other) | directory name |

## Step 9: MCP fallback (optional, v1.2.0+)

If the Claude Code session has the **Atlassian MCP server** loaded and authenticated (`mcp__atlassian__*` tools available), you can use those tools instead of `curl` + env vars. This is useful when:

- `JIRA_HOST` / `JIRA_USERNAME` / `JIRA_API_TOKEN` env vars are not set.
- The Jira cloud uses OAuth (cleaner than API tokens for long-lived setups).
- You want to avoid shell-quoting issues with ADF JSON.

**Equivalent MCP calls:**

| curl operation | MCP tool |
|---|---|
| `POST /rest/api/3/issue` (create) | `mcp__atlassian__createJiraIssue` |
| `PUT /rest/api/3/issue/{key}` (edit) | `mcp__atlassian__editJiraIssue` |
| `GET /rest/api/3/issue/{key}` | `mcp__atlassian__getJiraIssue` |
| `POST /rest/api/3/issue/{key}/transitions` | `mcp__atlassian__transitionJiraIssue` |
| `GET /rest/api/3/issue/{key}/transitions` | `mcp__atlassian__getTransitionsForJiraIssue` |
| `GET /rest/api/3/search?jql=...` | `mcp__atlassian__searchJiraIssuesUsingJql` |

**Cloud ID:** the first MCP call should discover the cloud ID once: `mcp__atlassian__getAccessibleAtlassianResources` returns the site UUID. Cache in `data/jira-config.json` under `cloudId`.

**Default strategy:** prefer `curl` when env vars are present (no session dependency, scriptable). Fall back to MCP when env vars are missing or curl fails with auth errors. Both paths are idempotent per the rules above.

</process>
