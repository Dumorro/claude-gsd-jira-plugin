/**
 * resolve-active-card.js
 *
 * Given a repo cwd (where a git commit is happening) and optional list of
 * staged files, resolve the most-specific Jira issue key for the current
 * GSD context:
 *
 *   Subtask (plan) > Feature (phase) > Epic (milestone) > null
 *
 * Inputs:
 *   - cwd: directory where the git command is running (the target repo)
 *   - stagedFiles: array of absolute or repo-relative paths staged for commit
 *   - pluginRoot: absolute path to claude-gsd-jira-plugin (holds data/jira-mapping.json)
 *
 * Output:
 *   { issueKey, level: 'subtask'|'feature'|'epic', source: '<card-id>' }
 *   or null when nothing can be resolved.
 *
 * Contract:
 *   - Never throws. Returns null on any failure.
 *   - Never calls the Jira API. Reads only local files.
 *   - Must complete in < 100ms on a warm filesystem.
 */

const fs = require('fs');
const path = require('path');
const { findProjectRoot, detectRepo, planningRoot, readFileSafe, slugify } = require('./path-utils');

function resolveActiveCard({ cwd, stagedFiles = [], pluginRoot } = {}) {
  try {
    const targetCwd = cwd || process.cwd();
    const pluginDir = pluginRoot || resolvePluginRoot();
    if (!pluginDir) return null;

    const mapping = loadMapping(pluginDir);
    if (!mapping || Object.keys(mapping).length === 0) return null;

    const projectRoot = findProjectRoot(targetCwd);
    const repo = detectRepoForCommit(targetCwd, stagedFiles, projectRoot);
    if (!repo) return null;

    const planningDir = planningRoot(projectRoot, repo);
    if (!planningDir) return null;

    const stateContent = readFileSafe(path.join(planningDir, 'STATE.md'));
    const roadmapContent = readFileSafe(path.join(planningDir, 'ROADMAP.md'));

    const phaseNumber = extractPhaseNumber(stateContent);
    const milestone = extractActiveMilestone(stateContent, roadmapContent);
    const phaseSlug = phaseNumber && roadmapContent ? extractPhaseSlug(roadmapContent, phaseNumber) : null;
    const planNumber = extractPlanNumber(stagedFiles, stateContent);

    // Build lookup keys in specificity order
    const keys = [];
    if (milestone && phaseSlug && planNumber) {
      keys.push({
        id: `${repo}/${milestone}/${phaseSlug}/plan-${planNumber}`,
        level: 'subtask',
      });
    }
    if (milestone && phaseSlug) {
      keys.push({
        id: `${repo}/${milestone}/${phaseSlug}`,
        level: 'feature',
      });
    }
    if (milestone) {
      keys.push({
        id: `${repo}/${milestone}`,
        level: 'epic',
      });
    }

    for (const { id, level } of keys) {
      if (mapping[id]) {
        return { issueKey: mapping[id], level, source: id };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function resolvePluginRoot() {
  if (process.env.GSD_PLUGIN_ROOT) return process.env.GSD_PLUGIN_ROOT;
  // The module lives at <pluginRoot>/hooks/lib/resolve-active-card.js
  return path.resolve(__dirname, '..', '..');
}

function loadMapping(pluginDir) {
  const mappingPath = path.join(pluginDir, 'data', 'jira-mapping.json');
  const raw = readFileSafe(mappingPath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectRepoForCommit(cwd, stagedFiles, projectRoot) {
  // 1. Staged file under src/{repo}/ — strongest signal
  for (const file of stagedFiles) {
    const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
    const repo = detectRepo(abs);
    if (repo) return repo;
  }

  // 2. cwd itself contains /src/{repo}/
  const cwdRepo = detectRepo(cwd + '/');
  if (cwdRepo) return cwdRepo;

  // 3. Single-repo layout: .planning/ at projectRoot → use projectRoot basename
  if (fs.existsSync(path.join(projectRoot, '.planning'))) {
    return path.basename(projectRoot);
  }

  // 4. Monorepo with a single src/* directory
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

function extractPhaseNumber(stateContent) {
  if (!stateContent) return null;
  const m = stateContent.match(/^stopped_at:\s*Phase\s+(\d+(?:\.\d+)?)/m);
  return m ? m[1] : null;
}

function extractActiveMilestone(stateContent, roadmapContent) {
  // Prefer STATE.md active_milestone or current_milestone if present
  if (stateContent) {
    const direct = stateContent.match(/^(?:active_milestone|current_milestone|milestone):\s*v?(\d+\.\d+)/m);
    if (direct) return `v${direct[1]}`;
  }

  // Fallback: first milestone in ROADMAP that isn't fully completed
  if (roadmapContent) {
    const sections = splitMilestones(roadmapContent);
    for (const section of sections) {
      if (hasIncompletePhase(section.body)) return section.version;
    }
    // All complete — return the latest
    if (sections.length > 0) return sections[sections.length - 1].version;
  }

  return null;
}

function splitMilestones(roadmap) {
  const result = [];
  const regex = /\*\*v(\d+\.\d+)\s+.+?\*\*/g;
  const matches = [...roadmap.matchAll(regex)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : roadmap.length;
    result.push({
      version: `v${matches[i][1]}`,
      body: roadmap.slice(start, end),
    });
  }
  return result;
}

function hasIncompletePhase(section) {
  const regex = /\[([x ])\]\s+\*\*Phase\s+\d/g;
  let m;
  while ((m = regex.exec(section)) !== null) {
    if (m[1] === ' ') return true;
  }
  return false;
}

function extractPhaseSlug(roadmap, phaseNumber) {
  // Match: [ ] **Phase N: Name** or [x] **Phase N: Name**
  const escaped = phaseNumber.replace('.', '\\.');
  const re = new RegExp(`\\[[x ]\\]\\s+\\*\\*Phase\\s+${escaped}:?\\s+(.+?)\\*\\*`);
  const m = roadmap.match(re);
  if (!m) return null;
  const name = m[1].replace(/\s*\(\d+\/\d+ plans?\).*$/, '').trim();
  return `${phaseNumber}-${slugify(name)}`;
}

function extractPlanNumber(stagedFiles, stateContent) {
  // 1. Staged PLAN.md file: NN-name-MM-PLAN.md → MM
  for (const file of stagedFiles) {
    const base = path.basename(file);
    const m = base.match(/^\d+(?:\.\d+)?-.*?-(\d+)-PLAN\.md$/);
    if (m) return m[1];
  }

  // 2. Staged file inside plan-NN directory
  for (const file of stagedFiles) {
    const m = file.match(/\/plan-(\d+)\//);
    if (m) return m[1];
  }

  // 3. STATE.md may declare current_plan
  if (stateContent) {
    const m = stateContent.match(/^(?:current_plan|active_plan):\s*(?:plan-)?(\d+)/m);
    if (m) return m[1].padStart(2, '0');
  }

  return null;
}

module.exports = { resolveActiveCard };
