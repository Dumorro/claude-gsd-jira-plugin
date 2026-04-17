#!/usr/bin/env node

/**
 * prepare-commit-msg — git hook
 *
 * Auto-prefixes the commit message with the Jira issue key of the active
 * GSD card (Subtask > Feature > Epic, most specific wins). If the message
 * already contains a Jira key or the hook cannot resolve one, it silently
 * does nothing.
 *
 * Invocation (from git):
 *   prepare-commit-msg <msg-file> [<source> [<sha>]]
 *
 * Where <source> is one of: message, template, merge, squash, commit.
 * We only rewrite on: "" (from -F or -t default), "message", or "template".
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolveActiveCard } = require('./lib/resolve-active-card');

const KEY_REGEX = /\b[A-Z][A-Z0-9_]+-\d+\b/;

function main() {
  const [, , msgFile, source] = process.argv;
  if (!msgFile) process.exit(0);

  // Skip commit types we must not touch
  if (source === 'merge' || source === 'squash' || source === 'commit') process.exit(0);

  let content = '';
  try {
    content = fs.readFileSync(msgFile, 'utf-8');
  } catch {
    process.exit(0);
  }

  // Message body excluding comment lines
  const effective = content
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();

  if (effective && KEY_REGEX.test(effective)) process.exit(0);

  const stagedFiles = getStagedFiles();
  const card = resolveActiveCard({ cwd: process.cwd(), stagedFiles });
  if (!card) process.exit(0);

  // Prepend key only to the first non-comment, non-empty line
  const lines = content.split('\n');
  let rewritten = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#')) continue;
    if (lines[i].trim() === '' && !rewritten) continue;
    lines[i] = `${card.issueKey}: ${lines[i]}`;
    rewritten = true;
    break;
  }

  if (!rewritten) {
    // Empty template — prepend at the very top
    lines.unshift(`${card.issueKey}: `);
  }

  try {
    fs.writeFileSync(msgFile, lines.join('\n'));
  } catch {
    // Silent fail — never block the commit
  }
  process.exit(0);
}

function getStagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).map((f) => path.join(process.cwd(), f));
  } catch {
    return [];
  }
}

main();
