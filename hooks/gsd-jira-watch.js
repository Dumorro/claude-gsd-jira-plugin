#!/usr/bin/env node

/**
 * gsd-jira-watch.js — PostToolUse hook
 *
 * Detects GSD lifecycle events by watching writes to .planning/ files
 * and enqueues Jira sync events in data/jira-queue.json.
 *
 * Events detected (Kanban 6-column board):
 *   - milestone_created   (ROADMAP.md: new milestone added)
 *   - phase_added         (ROADMAP.md: new phase added) -> Backlog
 *   - plans_created       (new *-PLAN.md written)
 *   - phase_planning      (STATE.md: status = discussing/planning/researching) -> Planning
 *   - phase_ready         (STATE.md: status = ready_to_execute) -> Ready
 *   - phase_executing     (STATE.md: stopped_at changed + executing) -> Executing
 *   - phase_completed     (STATE.md: completed_phases incremented) -> Done
 *   - phase_verifying     (new *-VERIFICATION.md being written) -> Verification
 *   - phase_verified      (*-VERIFICATION.md: status result) -> Done
 *   - milestone_completed (ROADMAP.md: all phases checked) -> Done
 *
 * Does NOT call Jira API — only writes to the queue.
 * The /jira-sync skill processes the queue.
 */

const fs = require('fs');
const path = require('path');
const { findProjectRoot, detectRepo, readFileSafe, slugify } = require('./lib/path-utils');

const PROJECT_ROOT = findProjectRoot();
const QUEUE_PATH = path.join(PROJECT_ROOT, 'data', 'jira-queue.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const filePath = data.tool_input?.file_path || data.tool_input?.path || '';

    if (!filePath.includes('.planning/')) return;

    const repo = detectRepo(filePath);
    if (!repo) return;

    const fileName = path.basename(filePath);
    const events = [];

    if (fileName === 'ROADMAP.md') {
      const content = readFileSafe(filePath);
      if (content) {
        events.push(...detectRoadmapEvents(content, repo));
      }
    } else if (fileName === 'STATE.md') {
      const content = readFileSafe(filePath);
      if (content) {
        events.push(...detectStateEvents(content, repo));
      }
    } else if (fileName.endsWith('-PLAN.md')) {
      events.push(makePlanEvent(filePath, fileName, repo));
    } else if (fileName.endsWith('-VERIFICATION.md')) {
      events.push(...makeVerificationEvent(filePath, fileName, repo));
    }

    if (events.length > 0) {
      enqueueEvents(events);
      const summary = events.map((e) => e.event).join(', ');
      output(`Jira queue: +${events.length} event(s) [${summary}]`);
    }
  } catch {
    // Silent fail — hooks must not break the workflow
  }
});

// --- Event Detectors ---

function detectRoadmapEvents(content, repo) {
  const events = [];
  const cache = loadCache(repo);

  // Detect milestones
  const milestoneRegex = /\*\*v(\d+\.\d+)\s+(.+?)\*\*/g;
  let match;
  while ((match = milestoneRegex.exec(content)) !== null) {
    const version = `v${match[1]}`;
    const name = match[2].replace(/[—–-]\s*Phases?.*$/i, '').trim();
    if (!cache.milestones?.includes(version)) {
      events.push({
        timestamp: now(),
        repo,
        event: 'milestone_created',
        data: { milestone: version, milestone_name: name },
      });
    }
  }

  // Detect phases
  const phaseRegex = /\[([x ])\]\s+\*\*Phase\s+(\d+(?:\.\d+)?):?\s+(.+?)\*\*/g;
  while ((match = phaseRegex.exec(content)) !== null) {
    const done = match[1] === 'x';
    const phaseNum = match[2];
    const phaseName = match[3].replace(/\s*\(\d+\/\d+ plans?\).*$/, '').trim();
    const phaseId = `${phaseNum}-${slugify(phaseName)}`;

    if (!cache.phases?.includes(phaseId)) {
      events.push({
        timestamp: now(),
        repo,
        event: 'phase_added',
        data: { phase: phaseId, phase_number: phaseNum, phase_name: phaseName, done },
      });
    }

    // Check if all phases in a milestone are done
    if (done && !cache.completedPhases?.includes(phaseId)) {
      events.push({
        timestamp: now(),
        repo,
        event: 'phase_completed',
        data: { phase: phaseId, phase_number: phaseNum, phase_name: phaseName },
      });
    }
  }

  updateCache(repo, content);
  return events;
}

function detectStateEvents(content, repo) {
  const events = [];
  const cache = loadCache(repo);

  // Parse YAML frontmatter
  const stoppedMatch = content.match(/^stopped_at:\s*Phase\s+(\d+)/m);
  const completedMatch = content.match(/completed_phases:\s*(\d+)/m);
  const statusMatch = content.match(/^status:\s*(.+)/m);
  const status = statusMatch ? statusMatch[1].trim().toLowerCase() : '';

  // Determine granular event based on status field
  const PLANNING_STATUSES = ['discussing', 'context_ready', 'researching', 'planning', 'plan_checking'];
  const READY_STATUSES = ['ready to execute', 'ready_to_execute', 'planned'];
  const EXECUTING_STATUSES = ['executing', 'post_merge_testing', 'code_reviewing', 'regression_checking'];

  if (statusMatch && cache.lastStatus !== status) {
    if (PLANNING_STATUSES.some((s) => status.includes(s))) {
      events.push({
        timestamp: now(),
        repo,
        event: 'phase_planning',
        data: { phase_number: stoppedMatch ? stoppedMatch[1] : 'unknown', status },
      });
    } else if (READY_STATUSES.some((s) => status.includes(s))) {
      events.push({
        timestamp: now(),
        repo,
        event: 'phase_ready',
        data: { phase_number: stoppedMatch ? stoppedMatch[1] : 'unknown', status },
      });
    } else if (EXECUTING_STATUSES.some((s) => status.includes(s))) {
      events.push({
        timestamp: now(),
        repo,
        event: 'phase_executing',
        data: { phase_number: stoppedMatch ? stoppedMatch[1] : 'unknown', status },
      });
    }
  }

  // Fallback: if stopped_at changed but no status matched, emit phase_executing
  if (stoppedMatch && cache.stoppedAt !== stoppedMatch[1] && events.length === 0) {
    events.push({
      timestamp: now(),
      repo,
      event: 'phase_executing',
      data: { phase_number: stoppedMatch[1] },
    });
  }

  if (completedMatch) {
    const completed = parseInt(completedMatch[1], 10);
    if (cache.completedCount !== undefined && completed > cache.completedCount) {
      events.push({
        timestamp: now(),
        repo,
        event: 'phase_completed',
        data: { completed_phases: completed, previous: cache.completedCount },
      });
    }
  }

  // Update cache
  const newCache = { ...cache };
  if (stoppedMatch) newCache.stoppedAt = stoppedMatch[1];
  if (completedMatch) newCache.completedCount = parseInt(completedMatch[1], 10);
  if (status) newCache.lastStatus = status;
  saveCacheRaw(repo, newCache);

  return events;
}

function makePlanEvent(filePath, fileName, repo) {
  const planMatch = fileName.match(/^(\d+(?:\.\d+)?)-(\d+)(?:-.*?)?-PLAN\.md$/);
  const phase = planMatch ? planMatch[1] : 'unknown';
  const planNum = planMatch ? planMatch[2] : '01';

  // Try to read objective from plan
  let objective = '';
  const content = readFileSafe(filePath);
  if (content) {
    const objMatch = content.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/);
    if (objMatch) objective = objMatch[1].trim().split('\n')[0];
  }

  return {
    timestamp: now(),
    repo,
    event: 'plans_created',
    data: { phase, plan: planNum, file: fileName, objective },
  };
}

function makeVerificationEvent(filePath, fileName, repo) {
  let status = 'unknown';
  let score = '';
  const content = readFileSafe(filePath);
  if (content) {
    const statusMatch = content.match(/^status:\s*(.+)/m);
    const scoreMatch = content.match(/^score:\s*(.+)/m);
    if (statusMatch) status = statusMatch[1].trim();
    if (scoreMatch) score = scoreMatch[1].trim();
  }

  const phaseMatch = fileName.match(/^(\d+(?:\.\d+)?)-/);
  const phase = phaseMatch ? phaseMatch[1] : 'unknown';

  const events = [];

  // Always emit phase_verifying first (moves card to Verification column)
  events.push({
    timestamp: now(),
    repo,
    event: 'phase_verifying',
    data: { phase, file: fileName },
  });

  // Then emit phase_verified with the result
  events.push({
    timestamp: now(),
    repo,
    event: 'phase_verified',
    data: { phase, status, score, file: fileName },
  });

  return events;
}

// --- Queue Management ---

function enqueueEvents(events) {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let queue = [];
  if (fs.existsSync(QUEUE_PATH)) {
    try {
      queue = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
    } catch {
      queue = [];
    }
  }

  queue.push(...events);
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

// --- Cache (tracks last-known state to detect diffs) ---

function cacheDir() {
  return path.join(PROJECT_ROOT, 'data');
}

function cachePath(repo) {
  return path.join(cacheDir(), `.jira-cache-${repo}.json`);
}

function loadCache(repo) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(repo), 'utf-8'));
  } catch {
    return {};
  }
}

function saveCacheRaw(repo, data) {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath(repo), JSON.stringify(data, null, 2));
}

function updateCache(repo, roadmapContent) {
  const cache = loadCache(repo);

  const milestones = [];
  const phases = [];
  const completedPhases = [];

  const milestoneRegex = /\*\*v(\d+\.\d+)\s+/g;
  let m;
  while ((m = milestoneRegex.exec(roadmapContent)) !== null) {
    milestones.push(`v${m[1]}`);
  }

  const phaseRegex = /\[([x ])\]\s+\*\*Phase\s+(\d+(?:\.\d+)?):?\s+(.+?)\*\*/g;
  while ((m = phaseRegex.exec(roadmapContent)) !== null) {
    const name = m[3].replace(/\s*\(\d+\/\d+ plans?\).*$/, '').trim();
    const id = `${m[2]}-${slugify(name)}`;
    phases.push(id);
    if (m[1] === 'x') completedPhases.push(id);
  }

  saveCacheRaw(repo, { ...cache, milestones, phases, completedPhases });
}

// --- Helpers ---

function now() {
  return new Date().toISOString();
}

function output(message) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: message,
    },
  };
  console.log(JSON.stringify(result));
}
