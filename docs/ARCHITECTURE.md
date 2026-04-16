# Architecture

## Overview

The plugin bridges GSD (Get Stuff Done) planning artifacts with Jira project management through a three-stage pipeline: **Hook -> Queue -> Sync**.

```
.planning/ file write
    |
    v
[PostToolUse Hook]  gsd-jira-watch.js
    |  Detects GSD lifecycle event
    |  Writes to data/jira-queue.json
    v
[Event Queue]  data/jira-queue.json
    |
    v
[/jira-sync Skill]  Processes queue, calls Jira API
    |  Creates/updates/transitions cards
    v
[Jira Board]  6-column Kanban
```

## Hook (Event Detection)

The PostToolUse hook (`hooks/gsd-jira-watch.js`) runs after every `Write` or `Edit` tool use in Claude Code. It:

1. Checks if the written file is inside a `.planning/` directory
2. Identifies the repo by parsing the file path (`src/{repo}/.planning/...`)
3. Detects the event type based on the file name and content
4. Compares against a local cache to emit only new/changed events
5. Appends events to `data/jira-queue.json`

The hook never calls the Jira API directly. It is designed to be fast and silent -- failures are swallowed to avoid disrupting the developer workflow.

### Project Root Discovery

The hook walks up from CWD looking for:
- A directory containing `.planning/` directly
- A directory containing `src/*/.planning/`

Fallback: `GSD_PROJECT_ROOT` environment variable or CWD.

### Repo Detection

For monorepo layouts (`src/{repo}/.planning/`), the repo name is extracted from the path segment after `src/`. For single-repo layouts (`.planning/` at root), the parent directory name is used.

## Event Types

| Event | Trigger | Jira Action |
|-------|---------|-------------|
| `milestone_created` | New `**vX.Y ...**` in ROADMAP.md | Create Epic |
| `phase_added` | New `Phase N:` in ROADMAP.md | Create Feature (child of Epic) |
| `plans_created` | New `*-PLAN.md` written | Create Subtask (child of Feature) |
| `phase_planning` | STATE.md status = discussing/planning/researching | Transition to Planning |
| `phase_ready` | STATE.md status = ready_to_execute/planned | Transition to Ready |
| `phase_executing` | STATE.md status = executing or stopped_at changed | Transition to Executing |
| `phase_verifying` | New `*-VERIFICATION.md` written | Transition to Verification |
| `phase_verified` | VERIFICATION.md contains status/score | Transition to Done (if passed) |
| `phase_completed` | ROADMAP.md phase checkbox = [x] | Transition to Done |
| `milestone_completed` | All phases in milestone checked | Transition Epic to Done |

## Card Hierarchy

GSD artifacts map to Jira issue types in a three-level hierarchy:

```
Milestone (v1.0, v2.0)     ->  Epic
  Phase (Phase 1, Phase 2) ->  Feature (child of Epic)
    Plan (Plan 01, Plan 02) ->  Subtask (child of Feature)
```

### Card ID Format

Cards are identified by a slash-separated path:

```
{repo}/{version}                         -> Epic
{repo}/{version}/{phase-slug}            -> Feature
{repo}/{version}/{phase-slug}/plan-{NN}  -> Subtask
```

Examples:
- `core-api/v1.5` (Epic)
- `core-api/v1.5/01-solution-foundation` (Feature)
- `core-api/v1.5/01-solution-foundation/plan-01` (Subtask)

### Mapping File

`data/jira-mapping.json` stores the bidirectional mapping between card IDs and Jira issue keys:

```json
{
  "core-api/v1.5": "PROJ-100",
  "core-api/v1.5/01-solution-foundation": "PROJ-101",
  "core-api/v1.5/01-solution-foundation/plan-01": "PROJ-102"
}
```

## ADF Description Templates

Card descriptions use Atlassian Document Format (ADF). The `enrich-cards.py` script builds ADF from `.planning/` content.

### Epic Description

Extracted from `ROADMAP.md` and `MILESTONES.md`:
- Goal heading
- Phase range and completion count
- Bullet list of phases with status
- Stats from MILESTONES.md

### Feature Description

Extracted from milestone ROADMAP phase section:
- Goal
- Requirements (issue keys)
- Success Criteria (numbered list)
- Plans (bullet list)
- Dependencies

### Subtask Description

Extracted from `*-PLAN.md`:
- Objective (from `<objective>` tag)
- Requirements (issue keys from frontmatter)
- Must-Have Truths (from frontmatter)
- Files Modified (first 15)
- Wave identifier

## Idempotency Rules

1. **Card creation is idempotent.** If a card ID already exists in `jira-mapping.json`, it is updated rather than duplicated.
2. **Event deduplication uses caching.** The hook maintains per-repo cache files (`data/.jira-cache-{repo}.json`) that track known milestones, phases, completed phases, last status, stopped_at position, and completed count. Events are only emitted when the cache detects a state change.
3. **Transitions are idempotent.** Moving a card to a status it already occupies is a no-op in Jira.
4. **Queue processing is atomic per event.** Each event is processed independently. Failed events remain in the queue for retry.
5. **Enrichment is idempotent.** Running `enrich-cards.py` multiple times overwrites descriptions with the latest content from `.planning/` files.

## Cache Files

Located in `data/`:

| File | Purpose |
|------|---------|
| `jira-queue.json` | Pending events awaiting `/jira-sync` |
| `jira-mapping.json` | Card ID to Jira key mapping |
| `.jira-cache-{repo}.json` | Per-repo state for event deduplication |
