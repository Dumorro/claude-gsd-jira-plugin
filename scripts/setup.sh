#!/bin/bash
# claude-gsd-jira-plugin setup
# Validates environment, tests Jira connection, discovers configuration

echo "=== claude-gsd-jira-plugin setup ==="

# Check env vars
for var in JIRA_HOST JIRA_USERNAME JIRA_API_TOKEN; do
  if [ -z "${!var}" ]; then
    echo "ERROR: $var is not set"
    echo "  export JIRA_HOST=\"https://your-org.atlassian.net\""
    echo "  export JIRA_USERNAME=\"you@email.com\""
    echo "  export JIRA_API_TOKEN=\"...\"  # https://id.atlassian.com/manage-profile/security/api-tokens"
    exit 1
  fi
done

# Test connection
AUTH=$(echo -n "${JIRA_USERNAME}:${JIRA_API_TOKEN}" | base64)
RESPONSE=$(curl -s -w "\n%{http_code}" "${JIRA_HOST}/rest/api/3/myself" -H "Authorization: Basic ${AUTH}")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
if [ "$HTTP_CODE" != "200" ]; then
  echo "ERROR: Jira connection failed (HTTP $HTTP_CODE)"
  exit 1
fi
USER=$(echo "$RESPONSE" | head -1 | python3 -c "import sys,json; print(json.load(sys.stdin)['displayName'])" 2>/dev/null)
echo "Connected as: $USER"

# Discover projects
echo ""
echo "Available projects:"
curl -s "${JIRA_HOST}/rest/api/3/project" -H "Authorization: Basic ${AUTH}" | python3 -c "
import sys,json
for p in json.load(sys.stdin):
    print(f'  {p[\"key\"]}: {p[\"name\"]}')
"

# Check GSD
if ls src/*/.planning/ROADMAP.md 1>/dev/null 2>&1; then
  echo ""
  echo "GSD repos detected:"
  for f in src/*/.planning/ROADMAP.md; do
    repo=$(echo "$f" | sed 's|src/||;s|/.planning.*||')
    echo "  - $repo"
  done
elif ls .planning/ROADMAP.md 1>/dev/null 2>&1; then
  echo ""
  echo "GSD repo detected (root .planning/)"
else
  echo ""
  echo "WARNING: No GSD .planning/ directories found in src/*/ or ./"
fi

echo ""
echo "Setup complete. Next steps:"
echo "  1. /jira-setup-kanban    # Configure Kanban board"
echo "  2. /jira-seed --dry-run  # Preview card creation"
echo "  3. /jira-seed            # Create cards in Jira"
