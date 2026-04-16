---
name: jira-setup-kanban
description: "Set up 6-column Kanban board in Jira for GSD workflow (Backlog -> Planejamento -> Pronto -> Executando -> Verificacao -> Concluido)"
argument-hint: "--dry-run"
allowed-tools:
  - Read
  - Write
  - Bash
---

<objective>
Automate Kanban board setup in Jira for the GSD workflow.
Creates/renames statuses to match the 6-column GSD flow, discovers transition IDs,
and saves the full configuration to `data/jira-config.json` for use by jira-sync and jira-seed.
</objective>

<context>
Config file: `data/jira-config.json` (output)
Required env vars: `JIRA_HOST`, `JIRA_USERNAME`, `JIRA_API_TOKEN`
Optional env var: `JIRA_PROJECT_KEY`

$ARGUMENTS
</context>

<process>

## Step 1: Verify Environment

1. Check env vars: `JIRA_HOST`, `JIRA_USERNAME`, `JIRA_API_TOKEN`
2. If any missing, print setup instructions and stop:
   ```
   Missing Jira credentials. Set these env vars:
     export JIRA_HOST=https://yourteam.atlassian.net
     export JIRA_USERNAME=you@example.com
     export JIRA_API_TOKEN=<token from https://id.atlassian.com/manage-profile/security/api-tokens>
   ```
3. Verify connectivity:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" \
     "${JIRA_HOST}/rest/api/3/myself" \
     -H "Authorization: Basic $(echo -n '${JIRA_USERNAME}:${JIRA_API_TOKEN}' | base64)"
   ```
   If not 200, print auth error and stop.

## Step 2: Discover Project

1. If `JIRA_PROJECT_KEY` env var is set, use it
2. Else fetch all projects:
   ```bash
   curl -s "${JIRA_HOST}/rest/api/3/project" \
     -H "Authorization: Basic $(echo -n '${JIRA_USERNAME}:${JIRA_API_TOKEN}' | base64)" \
     | jq '.[].key'
   ```
3. If single project, use it. If multiple, print list and ask user to set `JIRA_PROJECT_KEY`
4. Fetch project details to get project ID:
   ```bash
   curl -s "${JIRA_HOST}/rest/api/3/project/{PROJECT_KEY}" \
     -H "Authorization: Basic ..." \
     | jq '{id, key, name, style}'
   ```
5. Note the project `style` -- `team-managed` (next-gen) vs `company-managed` (classic). API capabilities differ.

## Step 3: Check Current Statuses

Fetch all statuses for the project:
```bash
curl -s "${JIRA_HOST}/rest/api/3/statuses/search?projectId={PROJECT_ID}" \
  -H "Authorization: Basic ..." \
  | jq '.values[] | {id, name, statusCategory}'
```

Print current status inventory:
```
Current statuses for {PROJECT_KEY}:
  - To Do (id: 10000, category: TO_DO)
  - In Progress (id: 10001, category: IN_PROGRESS)
  - In Review (id: 10002, category: IN_PROGRESS)
  - Done (id: 10003, category: DONE)
```

## Step 4: Map GSD Columns to Jira Statuses

Target 6-column layout:

| GSD Column | Jira Status | Category | Source |
|-----------|-------------|----------|--------|
| Backlog | Backlog | TO_DO | Rename "To Do" or create |
| Planejamento | Planejamento | IN_PROGRESS | Create new |
| Pronto | Pronto | TO_DO | Create new |
| Executando | Executando | IN_PROGRESS | Rename "In Progress" or create |
| Verificacao | Verificacao | IN_PROGRESS | Rename "In Review" or create |
| Concluido | Concluido | DONE | Rename "Done" or create |

### Dry Run Check
If `--dry-run`: print the mapping plan and stop without making changes.

## Step 5: Create Missing Statuses

For any GSD status that doesn't exist and can't be mapped from an existing status, create it:

```bash
curl -s -X POST "${JIRA_HOST}/rest/api/3/statuses" \
  -H "Authorization: Basic ..." \
  -H "Content-Type: application/json" \
  -d '{
    "statuses": [
      {
        "name": "Planejamento",
        "statusCategory": "IN_PROGRESS"
      },
      {
        "name": "Pronto",
        "statusCategory": "TODO"
      }
    ],
    "scope": {
      "type": "PROJECT",
      "project": {"id": "{PROJECT_ID}"}
    }
  }'
```

Note: The statuses API requires the project scope for team-managed projects.

## Step 6: Rename Existing Statuses

For statuses that exist with default names, rename them to GSD names:

```bash
curl -s -X PUT "${JIRA_HOST}/rest/api/3/statuses" \
  -H "Authorization: Basic ..." \
  -H "Content-Type: application/json" \
  -d '{
    "statuses": [
      {"id": "10000", "name": "Backlog", "statusCategory": "TODO"},
      {"id": "10001", "name": "Executando", "statusCategory": "IN_PROGRESS"},
      {"id": "10002", "name": "Verificacao", "statusCategory": "IN_PROGRESS"},
      {"id": "10003", "name": "Concluido", "statusCategory": "DONE"}
    ]
  }'
```

**Important**: Only rename statuses that still have their default names. If a status has already been customized, skip it and create a new one instead.

## Step 7: Add Statuses to Workflow

For team-managed projects, ensure all 6 statuses are added to the project's workflow:

```bash
# Get the workflow scheme
curl -s "${JIRA_HOST}/rest/api/3/project/{PROJECT_KEY}/statuses" \
  -H "Authorization: Basic ..."
```

If any GSD status is missing from the workflow, it needs to be added via the board settings UI (API limitation for team-managed projects -- see Step 10 manual instructions).

## Step 8: Discover Transition IDs

Create a temporary issue (or use an existing one) to discover transitions:

```bash
# Find any existing issue
ISSUE_KEY=$(curl -s "${JIRA_HOST}/rest/api/3/search?jql=project=${PROJECT_KEY}&maxResults=1" \
  -H "Authorization: Basic ..." | jq -r '.issues[0].key')

# If no issues exist, create a temporary one
if [ "$ISSUE_KEY" = "null" ]; then
  ISSUE_KEY=$(curl -s -X POST "${JIRA_HOST}/rest/api/3/issue" \
    -H "Authorization: Basic ..." \
    -H "Content-Type: application/json" \
    -d '{
      "fields": {
        "project": {"key": "'${PROJECT_KEY}'"},
        "summary": "[GSD Setup] Temporary issue for transition discovery",
        "issuetype": {"name": "Task"},
        "labels": ["gsd-setup-temp"]
      }
    }' | jq -r '.key')
fi

# Get transitions from each status by walking the board
curl -s "${JIRA_HOST}/rest/api/3/issue/${ISSUE_KEY}/transitions" \
  -H "Authorization: Basic ..." | jq '.transitions[] | {id, name, to: .to.name}'
```

Walk through each status to discover all transition IDs:
1. From Backlog: get transitions -> record IDs for Planejamento, Pronto, etc.
2. Transition to each status in turn and record available transitions from that status
3. Build the complete transition map

## Step 9: Save Configuration

Write `data/jira-config.json`:

```json
{
  "projectKey": "PROJ",
  "projectId": "10001",
  "projectStyle": "team-managed",
  "statuses": {
    "backlog": { "id": "10000", "name": "Backlog", "category": "TODO" },
    "planejamento": { "id": "10036", "name": "Planejamento", "category": "IN_PROGRESS" },
    "pronto": { "id": "10037", "name": "Pronto", "category": "TODO" },
    "executando": { "id": "10001", "name": "Executando", "category": "IN_PROGRESS" },
    "verificacao": { "id": "10002", "name": "Verificacao", "category": "IN_PROGRESS" },
    "concluido": { "id": "10003", "name": "Concluido", "category": "DONE" }
  },
  "transitions": {
    "backlog": { "transitionId": "11", "statusId": "10000" },
    "planejamento": { "transitionId": "2", "statusId": "10036" },
    "pronto": { "transitionId": "3", "statusId": "10037" },
    "executando": { "transitionId": "21", "statusId": "10001" },
    "verificacao": { "transitionId": "31", "statusId": "10002" },
    "concluido": { "transitionId": "41", "statusId": "10003" }
  },
  "epicLinkField": "customfield_10014",
  "repoLabels": {},
  "setupTimestamp": "2026-04-16T00:00:00Z"
}
```

Also initialize `data/jira-mapping.json` as `{}` if it doesn't exist.
Also initialize `data/jira-queue.json` as `[]` if it doesn't exist.

## Step 10: Manual Instructions

Print instructions for steps that require the Jira UI:

```
=== Manual Steps Required ===

The Jira API cannot reorder board columns or set WIP limits for team-managed projects.
Complete these steps in the Jira UI:

1. COLUMN ORDER
   Go to: {JIRA_HOST}/jira/software/projects/{PROJECT_KEY}/boards/{BOARD_ID}/settings
   Drag columns into this order (left to right):
     Backlog | Planejamento | Pronto | Executando | Verificacao | Concluido

2. WIP LIMITS (recommended)
   In the same board settings, click each column header to set limits:
     - Planejamento: max 2
     - Pronto: max 3
     - Executando: max 3
     - Verificacao: max 2

3. BOARD FILTERS (optional)
   Add a quick filter for GSD-managed cards:
     JQL: labels = "gsd-managed"

4. SWIMLANES (optional)
   Add swimlanes by Label to separate repos:
     - backend
     - frontend
     - infra

=== Setup Complete ===
Config saved: data/jira-config.json
Run /jira-seed --dry-run to preview initial card population.
```

## Step 11: Cleanup

If a temporary issue was created in Step 8:
```bash
curl -s -X DELETE "${JIRA_HOST}/rest/api/3/issue/${TEMP_ISSUE_KEY}" \
  -H "Authorization: Basic ..."
```

## Error Handling

- If status creation fails (e.g., name conflict), skip and note in output
- If rename fails (e.g., status in use by another workflow), skip and suggest manual rename
- If transition discovery is incomplete, save what was found and note missing transitions
- All errors are non-fatal -- save partial config and report what needs manual attention

## Verification

After setup, verify by printing a status check:
```
Kanban Board Status:
  [OK] Backlog (id: 10000, transitions: 2 outbound)
  [OK] Planejamento (id: 10036, transitions: 2 outbound)
  [OK] Pronto (id: 10037, transitions: 2 outbound)
  [OK] Executando (id: 10001, transitions: 2 outbound)
  [OK] Verificacao (id: 10002, transitions: 2 outbound)
  [OK] Concluido (id: 10003, transitions: 0 outbound)
  [!!] Column order -- verify manually in board settings
```

</process>
