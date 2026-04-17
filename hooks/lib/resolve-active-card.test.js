/**
 * Tests for resolve-active-card.
 *
 * Run: node --test hooks/lib/resolve-active-card.test.js
 *
 * Fixtures are built on-the-fly in os.tmpdir() so tests don't depend on
 * the plugin's real data/ or .planning/ state.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveActiveCard } = require('./resolve-active-card');

function makeFixture({ mapping, repo, state, roadmap, layout = 'flat' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-jira-test-'));
  const pluginRoot = path.join(dir, 'plugin');
  fs.mkdirSync(path.join(pluginRoot, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'data', 'jira-mapping.json'),
    JSON.stringify(mapping, null, 2)
  );

  const projectRoot =
    layout === 'monorepo' ? path.join(dir, 'project') : path.join(dir, repo);
  const planningDir =
    layout === 'monorepo'
      ? path.join(projectRoot, 'src', repo, '.planning')
      : path.join(projectRoot, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  if (state !== null) fs.writeFileSync(path.join(planningDir, 'STATE.md'), state);
  if (roadmap !== null) fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap);

  return { dir, pluginRoot, projectRoot, planningDir };
}

const ROADMAP_SAMPLE = `# Roadmap

**v1.5 Core API**

- [ ] **Phase 1: Solution Foundation**
- [x] **Phase 2: Storage Layer**
- [ ] **Phase 3: API Surface**
`;

const STATE_EXECUTING_P1 = `---
status: executing
stopped_at: Phase 1
completed_phases: 0
---
`;

const STATE_IDLE = `---
status: idle
completed_phases: 0
---
`;

test('resolves Subtask key when a PLAN file is staged', () => {
  const { pluginRoot, projectRoot } = makeFixture({
    mapping: {
      'core-api/v1.5': 'PROJ-100',
      'core-api/v1.5/1-solution-foundation': 'PROJ-101',
      'core-api/v1.5/1-solution-foundation/plan-02': 'PROJ-150',
    },
    repo: 'core-api',
    state: STATE_EXECUTING_P1,
    roadmap: ROADMAP_SAMPLE,
    layout: 'flat',
  });

  const result = resolveActiveCard({
    cwd: projectRoot,
    stagedFiles: [path.join(projectRoot, '.planning', '1-solution-foundation', '1-solution-foundation-02-PLAN.md')],
    pluginRoot,
  });

  assert.ok(result, 'expected a resolution');
  assert.equal(result.issueKey, 'PROJ-150');
  assert.equal(result.level, 'subtask');
});

test('falls back to Feature key when plan cannot be determined', () => {
  const { pluginRoot, projectRoot } = makeFixture({
    mapping: {
      'core-api/v1.5': 'PROJ-100',
      'core-api/v1.5/1-solution-foundation': 'PROJ-101',
    },
    repo: 'core-api',
    state: STATE_EXECUTING_P1,
    roadmap: ROADMAP_SAMPLE,
    layout: 'flat',
  });

  const result = resolveActiveCard({
    cwd: projectRoot,
    stagedFiles: [path.join(projectRoot, 'src', 'foo.ts')],
    pluginRoot,
  });

  assert.ok(result);
  assert.equal(result.issueKey, 'PROJ-101');
  assert.equal(result.level, 'feature');
});

test('falls back to Epic when neither phase nor plan resolves', () => {
  const { pluginRoot, projectRoot } = makeFixture({
    mapping: {
      'core-api/v1.5': 'PROJ-100',
    },
    repo: 'core-api',
    state: STATE_IDLE,
    roadmap: ROADMAP_SAMPLE,
    layout: 'flat',
  });

  const result = resolveActiveCard({
    cwd: projectRoot,
    stagedFiles: [],
    pluginRoot,
  });

  assert.ok(result);
  assert.equal(result.issueKey, 'PROJ-100');
  assert.equal(result.level, 'epic');
});

test('returns null when no .planning/ exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-jira-test-'));
  const pluginRoot = path.join(dir, 'plugin');
  fs.mkdirSync(path.join(pluginRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'data', 'jira-mapping.json'), '{}');

  const result = resolveActiveCard({
    cwd: dir,
    stagedFiles: [],
    pluginRoot,
  });
  assert.equal(result, null);
});

test('returns null when mapping is empty', () => {
  const { pluginRoot, projectRoot } = makeFixture({
    mapping: {},
    repo: 'core-api',
    state: STATE_EXECUTING_P1,
    roadmap: ROADMAP_SAMPLE,
    layout: 'flat',
  });

  const result = resolveActiveCard({
    cwd: projectRoot,
    stagedFiles: [],
    pluginRoot,
  });
  assert.equal(result, null);
});

test('monorepo layout: picks repo from staged file', () => {
  const { pluginRoot, projectRoot } = makeFixture({
    mapping: {
      'core-api/v1.5/1-solution-foundation': 'PROJ-101',
    },
    repo: 'core-api',
    state: STATE_EXECUTING_P1,
    roadmap: ROADMAP_SAMPLE,
    layout: 'monorepo',
  });

  const result = resolveActiveCard({
    cwd: projectRoot,
    stagedFiles: [path.join(projectRoot, 'src', 'core-api', 'lib', 'foo.ts')],
    pluginRoot,
  });

  assert.ok(result);
  assert.equal(result.issueKey, 'PROJ-101');
});
