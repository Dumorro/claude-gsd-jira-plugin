/**
 * path-utils.js — shared helpers for locating the GSD project root,
 * identifying the repo a file belongs to, and safe filesystem ops.
 *
 * Used by hooks/gsd-jira-watch.js and hooks/lib/resolve-active-card.js.
 */

const fs = require('fs');
const path = require('path');

function findProjectRoot(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.planning'))) return dir;

    const srcDir = path.join(dir, 'src');
    if (fs.existsSync(srcDir)) {
      try {
        const entries = fs.readdirSync(srcDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && fs.existsSync(path.join(srcDir, entry.name, '.planning'))) {
            return dir;
          }
        }
      } catch {
        // ignore
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.env.GSD_PROJECT_ROOT || startDir || process.cwd();
}

function detectRepo(filePath) {
  const srcMatch = filePath.match(/\/src\/([^/]+)\//);
  if (srcMatch) return srcMatch[1];

  const planningMatch = filePath.match(/\/([^/]+)\/\.planning\//);
  if (planningMatch) return planningMatch[1];

  return null;
}

function planningRoot(projectRoot, repo) {
  const scoped = path.join(projectRoot, 'src', repo, '.planning');
  if (fs.existsSync(scoped)) return scoped;
  const flat = path.join(projectRoot, '.planning');
  if (fs.existsSync(flat)) return flat;
  return null;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = {
  findProjectRoot,
  detectRepo,
  planningRoot,
  readFileSafe,
  slugify,
};
