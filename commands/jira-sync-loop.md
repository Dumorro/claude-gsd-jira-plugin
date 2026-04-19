---
description: "Start a background loop that runs /jira-sync every 10 minutes — use in a parallel session while /gsd-autonomous executes"
argument-hint: "[interval]"
---

Start an automatic Jira queue drainer in this session. Invoke the loop skill now with a 10-minute interval (or the interval in `$ARGUMENTS` if provided) targeting `/jira-sync`:

/loop ${ARGUMENTS:-10m} /jira-sync

After the loop starts, remind the user they can stop it with Ctrl+C or by closing this tab.
