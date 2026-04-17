#!/usr/bin/env node

/**
 * commit-msg — git hook
 *
 * Validates that the commit message carries a Jira issue key when a GSD
 * phase is actively executing. Default mode warns; strict mode blocks.
 *
 * Strict mode is opt-in via env: GSD_JIRA_STRICT=1
 *
 * Exit codes:
 *   0  — commit may proceed
 *   1  — commit rejected (strict mode only)
 */

const fs = require('fs');
const path = require('path');
const { findProjectRoot, detectRepo, planningRoot, readFileSafe } = require('./lib/path-utils');

const KEY_REGEX = /\b[A-Z][A-Z0-9_]+-\d+\b/;
const EXECUTING_STATUSES = [
  'executing',
  'post_merge_testing',
  'code_reviewing',
  'regression_checking',
];

function main() {
  const [, , msgFile] = process.argv;
  if (!msgFile) process.exit(0);

  const content = readFileSafe(msgFile);
  if (!content) process.exit(0);

  const effective = content
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();

  if (!effective) process.exit(0); // git will abort empty message itself
  if (KEY_REGEX.test(effective)) process.exit(0);

  const strict = process.env.GSD_JIRA_STRICT === '1';
  const active = isPhaseExecuting();

  if (strict) {
    process.stderr.write(
      '[gsd-jira] commit rejected: message must include a Jira issue key (e.g. PROJ-123).\n' +
        '           Disable strict mode by unsetting GSD_JIRA_STRICT.\n'
    );
    process.exit(1);
  }

  if (active) {
    process.stderr.write(
      '[gsd-jira] warning: active GSD phase but commit message has no Jira key.\n' +
        '           Run `/jira-install-git-hooks` and re-try, or prefix manually (e.g. PROJ-123: ...).\n'
    );
  }
  process.exit(0);
}

function isPhaseExecuting() {
  try {
    const projectRoot = findProjectRoot(process.cwd());
    const repo = detectRepoFromCwd(projectRoot);
    if (!repo) return false;
    const planning = planningRoot(projectRoot, repo);
    if (!planning) return false;
    const state = readFileSafe(path.join(planning, 'STATE.md'));
    if (!state) return false;
    const m = state.match(/^status:\s*(.+)/m);
    if (!m) return false;
    const status = m[1].trim().toLowerCase();
    return EXECUTING_STATUSES.some((s) => status.includes(s));
  } catch {
    return false;
  }
}

function detectRepoFromCwd(projectRoot) {
  const fromPath = detectRepo(process.cwd() + '/');
  if (fromPath) return fromPath;

  // Single-repo layout fallback
  if (fs.existsSync(path.join(projectRoot, '.planning'))) return path.basename(projectRoot);

  const srcDir = path.join(projectRoot, 'src');
  if (fs.existsSync(srcDir)) {
    try {
      const dirs = fs
        .readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(srcDir, e.name, '.planning')))
        .map((e) => e.name);
      if (dirs.length === 1) return dirs[0];
    } catch {
      // ignore
    }
  }
  return null;
}

main();
