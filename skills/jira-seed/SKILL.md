---
name: jira-seed
description: "Populate Jira with the full GSD state from all repos (one-time initial sync)"
argument-hint: "--dry-run"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - Agent
---

<objective>
One-time population of Jira with the complete GSD state from all repositories.
Reads all ROADMAP.md, STATE.md, and PLAN.md files to build the full Epic -> Feature -> Subtask hierarchy
with correct statuses based on what's already been completed.
</objective>

<context>
Mapping file: `data/jira-mapping.json`
Config file: `data/jira-config.json` (transition IDs, project key)

Repos: auto-detected via `src/*/.planning/` glob

$ARGUMENTS
</context>

<process>

## Step 0: Validate GSD Dependencies

Before doing anything, verify GSD is set up in this project:

1. Glob `src/*/.planning/ROADMAP.md` -- if zero matches, abort with:
   ```
   ERROR: No GSD repos found. Expected src/{repo}/.planning/ROADMAP.md files.
   Run /gsd-new-project first to initialize GSD planning.
   ```
2. For each match, verify `ROADMAP.md` has at least one milestone defined
3. Print discovered repos:
   ```
   GSD repos found:
     - src/my-api/.planning/ (3 milestones, 12 phases)
     - src/my-pwa/.planning/ (2 milestones, 8 phases)
   ```

## Step 1: Verify Prerequisites

1. Check env vars: `JIRA_HOST`, `JIRA_USERNAME`, `JIRA_API_TOKEN`
2. If any missing, print setup instructions and stop:
   ```
   Missing Jira credentials. Set these env vars:
     export JIRA_HOST=https://yourteam.atlassian.net
     export JIRA_USERNAME=you@example.com
     export JIRA_API_TOKEN=<token from https://id.atlassian.com/manage-profile/security/api-tokens>
   ```
3. Determine project key:
   - If `JIRA_PROJECT_KEY` env var is set, use it
   - Else if `data/jira-config.json` has `projectKey`, use it
   - Else auto-detect: `GET /rest/api/3/project` and pick the first project (or prompt if multiple)
4. Read `data/jira-mapping.json` -- if non-empty, warn that cards already exist and ask to confirm `--force` or abort
5. Load transition IDs from `data/jira-config.json` if exists; otherwise discover via API and save

## Step 2: Scan All Repos (parallel agents)

Launch N Explore agents in parallel, one per detected repo:

### Per-repo agent pattern:
```
Read src/{repo}/.planning/ROADMAP.md
Read src/{repo}/.planning/STATE.md
Glob src/{repo}/.planning/phases/**/*-PLAN.md
Glob src/{repo}/.planning/milestones/**/*-PLAN.md

For each milestone found in ROADMAP.md:
  - Extract: version, name, phase range, completion status

For each phase:
  - Extract: number, name, slug, done/pending, plan count

For each PLAN.md:
  - Extract: phase, plan number, objective (from <objective> tag), requirements

Return structured JSON with the full hierarchy.
```

## Step 3: Build Card Hierarchy

Merge results from all agents into a single card list:

```
For each repo:
  For each milestone:
    -> Epic card: "[{repo}] {version} -- {name}"
       status: Done if all phases complete, else In Progress

    For each phase in milestone:
      -> Feature card: "Phase {N}: {name}"
         status:
           - Concluido if [x] in ROADMAP
           - Executando if stopped_at and status=executing
           - Planejamento if stopped_at and status=planning/discussing
           - Pronto if ready to execute
           - Backlog (default) if not started
         link: parent Epic

      For each PLAN.md in phase:
        -> Subtask card: "{phase}-{plan}: {objective}"
           status: inherit parent Feature status
           link: parent Feature
```

## Step 4: Dry Run Check

If `--dry-run`:
  Print the full card hierarchy as a table:
  ```
  | Type    | Card ID                              | Summary                          | Status      |
  |---------|--------------------------------------|----------------------------------|-------------|
  | Epic    | my-api/v2.0                          | [my-api] v2.0 -- Onboarding     | Concluido   |
  | Feature | my-api/v2.0/32-iam-foundation        | Phase 32: IAM Foundation         | Concluido   |
  | Subtask | my-api/v2.0/32-iam-foundation/01     | 32-01: Register + Login handlers | Concluido   |
  ```
  Print totals: X epics, Y features, Z subtasks
  Stop here.

## Step 4.5: Build Card Descriptions (ADF)

When creating cards, ALWAYS include a structured description in Atlassian Document Format (ADF).
Extract content from the GSD artifacts found in Step 2.

### Epic Description
Source: `ROADMAP.md` + `milestones/{version}-ROADMAP.md` + `MILESTONES.md`
```
## Goal -> milestone name/goal
## Phases -> list with [done/pending] status
## Stats -> from MILESTONES.md (accomplishments, test counts)
```

### Feature Description
Source: `milestones/{version}-ROADMAP.md` section `### Phase N:`
```
## Goal -> **Goal**: line
## Requirements -> requirement codes (AUTH-01, etc.)
## Success Criteria -> numbered criteria from **Success Criteria** block
## Plans -> plan list from **Plans**: block
## Dependencies -> **Depends on**: line
```

### Subtask Description
Source: `{phase-dir}/{NN}-{PP}-PLAN.md` (YAML frontmatter + <objective> tag)
```
## Objective -> first line of <objective> tag
## Requirements -> requirements from frontmatter
## Must-Haves -> truths from must_haves.truths
## Files Modified -> files_modified list (max 15)
Wave: {wave number}
```

### ADF Format
Use `{"type": "doc", "version": 1, "content": [...]}` with heading, paragraph, and bulletList nodes.

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

## Step 5: Discover Jira Fields

Before creating cards, discover the Epic Link custom field:
```bash
curl -s "${JIRA_HOST}/rest/api/3/field" \
  -H "Authorization: Basic ..." | jq '.[] | select(.name == "Epic Link") | .id'
```
Store the field ID (typically `customfield_10014`) for linking features to epics.

Also discover available transitions (if not already in `data/jira-config.json`):
```bash
curl -s "${JIRA_HOST}/rest/api/3/issue/{any-issue-key}/transitions" \
  -H "Authorization: Basic ..."
```
Save discovered IDs to `data/jira-config.json`.

## Step 6: Create Cards (Epics first, then Features, then Subtasks)

Read the project key from `data/jira-config.json` or `JIRA_PROJECT_KEY` env var.

### Phase A: Create Epics
For each epic card:
1. Create issue via Jira API (type: Epic)
2. Save mapping: `{repo}/{milestone}` -> `{PROJECT_KEY}-XXX`
3. If status is Concluido: transition to done

### Phase B: Create Features
For each feature card:
1. Look up parent Epic key from mapping
2. Create issue via Jira API (type: Feature, Epic Link: parent key)
3. Save mapping: `{repo}/{milestone}/{phase}` -> `{PROJECT_KEY}-XXX`
4. Transition to correct column based on GSD state:
   - Concluido -> done transition
   - Executando -> executing transition
   - Planejamento -> planning transition
   - Pronto -> ready transition
   - Backlog -> no transition needed (default)

### Phase C: Create Subtasks
For each subtask card:
1. Look up parent Feature key from mapping
2. Create issue via Jira API (type: Subtask)
3. Link to parent Feature (issue link type: "is child of" or similar)
4. Save mapping: `{repo}/{milestone}/{phase}/plan-{N}` -> `{PROJECT_KEY}-XXX`
5. Inherit parent Feature status and apply same transition

Write `data/jira-mapping.json` after each batch (A, B, C) for crash recovery.

## Step 7: Report

Print summary:
```
Jira Seed Complete
  Repos scanned: N ({repo1}, {repo2}, ...)
  Epics created: X (Y concluido, Z in progress)
  Features created: X (Y concluido, Z executando, W planejamento, V pronto, U backlog)
  Subtasks created: X
  Total cards: X
  Mapping saved: data/jira-mapping.json
```

## Error Handling

- If a Jira API call fails, log the error but continue with next card
- After all cards processed, print failed cards with error messages
- Failed cards are NOT added to mapping (will be retried on next run)
- Rate limit: add 200ms delay between API calls to avoid Jira throttling

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

## Labels

Auto-detected repos get labels derived from their directory name.
All cards also get `gsd-managed`.

Common mappings (customize in `data/jira-config.json` `repoLabels` if needed):
| Repo Directory | Default Label |
|---------------|---------------|
| *-api, *-backend, *-server | `backend` |
| *-pwa, *-web, *-frontend | `frontend` |
| *-infra, *-terraform, *-iac | `infra` |
| (other) | directory name |

## Naming Convention

| Type | Format |
|------|--------|
| Epic | `[{repo}] v{N}.{N} -- {milestone_name}` |
| Feature | `Phase {N}: {phase_name}` |
| Subtask | `{phase_num}-{plan_num}: {objective_first_line}` |

</process>
