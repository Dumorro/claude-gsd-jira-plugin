# Kanban Board Configuration

## 6-Column Board

The plugin configures a Kanban board with 6 columns mapped to the GSD lifecycle:

```
| Backlog | Planning | Ready | Executing | Verification | Done |
|---------|----------|-------|-----------|--------------|------|
| New     | Discuss  | Plan  | Build     | Verify       | Ship |
| phases  | +research| ready | +test     | UAT          |      |
```

## Columns

### 1. Backlog

- **Status ID:** `10000` (or your project's "To Do" status)
- **GSD states:** Phase added to ROADMAP but not yet started
- **Events:** `phase_added`
- **WIP limit:** None

### 2. Planning

- **Status ID:** `10001` (custom status)
- **GSD states:** `discussing`, `context_ready`, `researching`, `planning`, `plan_checking`
- **Events:** `phase_planning`
- **WIP limit:** 3

### 3. Ready

- **Status ID:** `10002` (custom status)
- **GSD states:** `ready_to_execute`, `planned`
- **Events:** `phase_ready`
- **WIP limit:** 5

### 4. Executing

- **Status ID:** `10003` (custom status, or "In Progress")
- **GSD states:** `executing`, `post_merge_testing`, `code_reviewing`, `regression_checking`
- **Events:** `phase_executing`
- **WIP limit:** 2

### 5. Verification

- **Status ID:** `10004` (custom status)
- **GSD states:** Verification file being written, UAT in progress
- **Events:** `phase_verifying`
- **WIP limit:** 2

### 6. Done

- **Status ID:** `10005` (or your project's "Done" status)
- **GSD states:** Phase completed, verification passed
- **Events:** `phase_completed`, `phase_verified` (passed), `milestone_completed`
- **WIP limit:** None

## Status IDs

Status IDs vary per Jira instance. The `/jira-setup-kanban` skill will detect your project's actual status IDs. To find them manually:

```bash
# List all statuses
curl -s "${JIRA_HOST}/rest/api/3/status" \
  -H "Authorization: Basic $(echo -n ${JIRA_USERNAME}:${JIRA_API_TOKEN} | base64)" \
  | python3 -c "import sys,json; [print(f'{s[\"id\"]}: {s[\"name\"]}') for s in json.load(sys.stdin)]"
```

## Transition IDs

Transitions connect columns. The `/jira-sync` skill uses transition IDs to move cards between columns. To list available transitions for an issue:

```bash
curl -s "${JIRA_HOST}/rest/api/3/issue/PROJ-123/transitions" \
  -H "Authorization: Basic $(echo -n ${JIRA_USERNAME}:${JIRA_API_TOKEN} | base64)" \
  | python3 -c "import sys,json; [print(f'{t[\"id\"]}: {t[\"name\"]} -> {t[\"to\"][\"name\"]}') for t in json.load(sys.stdin)['transitions']]"
```

## WIP Limits

| Column | Limit | Rationale |
|--------|-------|-----------|
| Backlog | - | Unbounded intake |
| Planning | 3 | Limit context-switching during research/design |
| Ready | 5 | Buffer of planned work ready for execution |
| Executing | 2 | Focus on active implementation |
| Verification | 2 | Prompt feedback on completed work |
| Done | - | Accumulates completed items |

WIP limits are enforced visually on the Jira board. The plugin does not block transitions when limits are exceeded.

## Column Reorder

After `/jira-setup-kanban` creates the statuses, you may need to reorder columns manually in Jira:

1. Open your Jira board
2. Click **Board settings** (gear icon)
3. Go to **Columns**
4. Drag columns into the correct order: Backlog, Planning, Ready, Executing, Verification, Done
5. Map each status to its column
6. Set WIP limits in the column settings

This is a one-time manual step because the Jira REST API does not support column ordering.

## GSD Lifecycle to Kanban Mapping

```
GSD State              | Kanban Column  | Event
-----------------------|----------------|------------------
Phase in ROADMAP       | Backlog        | phase_added
discussing             | Planning       | phase_planning
context_ready          | Planning       | phase_planning
researching            | Planning       | phase_planning
planning               | Planning       | phase_planning
plan_checking          | Planning       | phase_planning
ready_to_execute       | Ready          | phase_ready
planned                | Ready          | phase_ready
executing              | Executing      | phase_executing
post_merge_testing     | Executing      | phase_executing
code_reviewing         | Executing      | phase_executing
regression_checking    | Executing      | phase_executing
verification started   | Verification   | phase_verifying
verification complete  | Done           | phase_verified
phase checked [x]      | Done           | phase_completed
all phases checked     | Done           | milestone_completed
```
