#!/usr/bin/env node

/**
 * gsd-jira-drain.js — Stop hook / safety-net drain
 *
 * Lightweight counterpart to the /jira-sync skill. Processes TRANSITION-type
 * events from data/jira-queue.json by calling the Jira REST transitions API
 * directly (no Claude roundtrip). Creation events (milestone_created,
 * phase_added, plans_created) are LEFT in the queue for the richer /jira-sync
 * skill, which can build ADF descriptions.
 *
 * Intended to be wired as a Stop hook so the Jira board drains automatically
 * when a `/gsd-autonomous` session ends. Safe to run any time — idempotent.
 *
 * Requires env: JIRA_HOST, JIRA_USERNAME, JIRA_API_TOKEN.
 * Silent no-op if any are missing (hook must not block session exit).
 *
 * Transition IDs (Kanban board):
 *   phase_planning     →  2 (Planejamento)
 *   phase_ready        →  3 (Pronto)
 *   phase_executing    → 21 (Executando)
 *   phase_verifying    → 31 (Verificação)
 *   phase_verified     → 41 (Concluído) if status=passed, else skip
 *   phase_completed    → 41 (Concluído)
 *   milestone_completed→ 41 (Concluído) on the Epic
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const { findProjectRoot, readFileSafe, slugify } = require('./lib/path-utils');

const PROJECT_ROOT = findProjectRoot();
const QUEUE_PATH = path.join(PROJECT_ROOT, 'data', 'jira-queue.json');
const MAPPING_PATH = path.join(PROJECT_ROOT, 'data', 'jira-mapping.json');

const TRANSITIONS = {
  phase_planning: '2',
  phase_ready: '3',
  phase_executing: '21',
  phase_verifying: '31',
  phase_completed: '41',
  milestone_completed: '41',
};

const CREATION_EVENTS = new Set(['milestone_created', 'phase_added', 'plans_created']);

main().catch((err) => {
  // Never throw — hook must not block
  console.error(`[jira-drain] error: ${err.message}`);
  process.exit(0);
});

async function main() {
  const { JIRA_HOST, JIRA_USERNAME, JIRA_API_TOKEN } = process.env;
  if (!JIRA_HOST || !JIRA_USERNAME || !JIRA_API_TOKEN) {
    // No creds — silent no-op
    return;
  }

  const queue = loadJson(QUEUE_PATH) || [];
  if (queue.length === 0) return;

  const mapping = loadJson(MAPPING_PATH) || {};
  if (Object.keys(mapping).length === 0) {
    console.error('[jira-drain] mapping empty — run /jira-seed first');
    return;
  }

  const auth = 'Basic ' + Buffer.from(`${JIRA_USERNAME}:${JIRA_API_TOKEN}`).toString('base64');
  const remaining = [];
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of queue) {
    if (CREATION_EVENTS.has(event.event)) {
      remaining.push(event);
      skipped++;
      continue;
    }

    const transitionId = TRANSITIONS[event.event];
    if (!transitionId) {
      remaining.push(event);
      skipped++;
      continue;
    }

    if (event.event === 'phase_verified') {
      const status = (event.data && event.data.status) || '';
      if (!/passed/i.test(status)) {
        remaining.push(event);
        skipped++;
        continue;
      }
    }

    const issueKey = resolveIssueKey(event, mapping);
    if (!issueKey) {
      remaining.push({ ...event, error: 'issue key not found in mapping' });
      failed++;
      continue;
    }

    try {
      await transitionIssue(JIRA_HOST, auth, issueKey, transitionId);
      processed++;
    } catch (err) {
      remaining.push({ ...event, error: `transition failed: ${err.message}` });
      failed++;
    }
  }

  writeJson(QUEUE_PATH, remaining);

  console.error(
    `[jira-drain] processed=${processed} skipped(deferred)=${skipped} failed=${failed} remaining=${remaining.length}`
  );
}

// --- Issue key resolution ---

function resolveIssueKey(event, mapping) {
  const repo = event.repo;
  const phaseNumber = event.data && (event.data.phase_number || extractNumberFromPhaseId(event.data.phase));

  if (event.event === 'milestone_completed') {
    const milestone = event.data && event.data.milestone;
    if (!repo || !milestone) return null;
    return mapping[`${repo}/${milestone}`] || null;
  }

  if (!repo || !phaseNumber) return null;

  // Scan mapping for a Feature card matching `{repo}/*/` + phase prefix
  const prefix = `${repo}/`;
  const phasePattern = new RegExp(`^${escape(repo)}/v\\d+\\.\\d+/${escape(phaseNumber)}-`);
  for (const key of Object.keys(mapping)) {
    if (!key.startsWith(prefix)) continue;
    if (key.split('/').length !== 3) continue; // Feature only (epic=2, feature=3, subtask=4)
    if (phasePattern.test(key)) return mapping[key];
  }
  return null;
}

function extractNumberFromPhaseId(phaseId) {
  if (!phaseId) return null;
  const m = String(phaseId).match(/^(\d+(?:\.\d+)?)-/);
  return m ? m[1] : null;
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- Jira API ---

function transitionIssue(host, auth, issueKey, transitionId) {
  const url = new URL(`/rest/api/3/issue/${issueKey}/transitions`, host);
  const body = JSON.stringify({ transition: { id: transitionId } });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname + url.search,
        port: url.port || 443,
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          reject(new Error(`HTTP ${res.statusCode} ${data.slice(0, 160)}`));
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

// --- Helpers ---

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJson(p, data) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
