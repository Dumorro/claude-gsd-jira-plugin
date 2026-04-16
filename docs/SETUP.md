# Setup Guide

## Prerequisites

- **Claude Code** installed and configured
- **[GSD (Get Shit Done)](https://github.com/gsd-build/get-shit-done)** workflow active in your project (`.planning/` directories)
- **Jira Cloud** instance with project admin access
- **Python 3.8+** (for `enrich-cards.py`)
- **Node.js 18+** (for the PostToolUse hook)

## Environment Variables

Set these before running any plugin commands:

```bash
export JIRA_HOST="https://your-org.atlassian.net"
export JIRA_USERNAME="you@email.com"
export JIRA_API_TOKEN="..."  # Generate at https://id.atlassian.com/manage-profile/security/api-tokens
```

Add them to your shell profile (`~/.zshrc`, `~/.bashrc`) for persistence:

```bash
echo 'export JIRA_HOST="https://your-org.atlassian.net"' >> ~/.zshrc
echo 'export JIRA_USERNAME="you@email.com"' >> ~/.zshrc
echo 'export JIRA_API_TOKEN="your-token"' >> ~/.zshrc
```

## Plugin Installation

### From GitHub

```bash
git clone https://github.com/your-org/claude-gsd-jira-plugin.git
cd claude-gsd-jira-plugin
chmod +x scripts/setup.sh
```

### Manual

Copy the plugin files into your project or a shared location. The hook script (`hooks/gsd-jira-watch.js`) must be registered in your Claude Code settings.

### Hook Registration

Add the PostToolUse hook to your project's `.claude/settings.json`:

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

The hook watches for writes to `.planning/` files and enqueues Jira sync events automatically.

## Validate Setup

Run the setup script to verify everything works:

```bash
./scripts/setup.sh
```

This will:
1. Check that all required environment variables are set
2. Test the Jira API connection
3. List available Jira projects
4. Detect GSD `.planning/` directories in your project

## First Run

### 1. Configure the Kanban Board

```
/jira-setup-kanban
```

This creates a 6-column Kanban board mapped to GSD lifecycle phases. See [KANBAN.md](KANBAN.md) for column details.

### 2. Preview Card Creation

```
/jira-seed --dry-run
```

Reviews your `.planning/` artifacts and shows what cards would be created without making any changes.

### 3. Populate Jira

```
/jira-seed
```

Creates all Epics (milestones), Features (phases), and Subtasks (plans) from your GSD state.

### 4. Enrich Card Descriptions

```bash
python3 scripts/enrich-cards.py --dry-run  # Preview
python3 scripts/enrich-cards.py            # Execute
```

Populates card descriptions with structured content (goals, requirements, success criteria) extracted from your `.planning/` files.

## Troubleshooting

### "ERROR: JIRA_HOST is not set"

Ensure environment variables are exported in your current shell session. Run `echo $JIRA_HOST` to verify.

### "ERROR: Jira connection failed (HTTP 401)"

Your API token may be expired or incorrect. Generate a new one at https://id.atlassian.com/manage-profile/security/api-tokens

### "ERROR: Jira connection failed (HTTP 403)"

Your user may lack project admin permissions. Check your Jira project role assignments.

### "WARNING: No GSD .planning/ directories found"

The plugin expects `.planning/` directories either at the project root or under `src/*/`. Run GSD initialization first (`/gsd-new-project`).

### Hook not firing

Verify the hook is registered in `.claude/settings.json` and the matcher includes `Write` and `Edit` tool names. Check that the path to `gsd-jira-watch.js` is absolute and correct.

### Queue not processing

The queue file lives at `data/jira-queue.json`. Run `/jira-sync` to process pending events. If the file doesn't exist, the hook hasn't detected any `.planning/` writes yet.
