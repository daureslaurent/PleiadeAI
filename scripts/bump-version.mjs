#!/usr/bin/env node
/**
 * Auto-bumps per-app version numbers on every commit — independently.
 *
 * Run from the git `pre-commit` hook (see scripts/hooks/pre-commit). Each of the three apps
 * (frontend / backend / finetune) carries its own `src/version.json`. On commit we look at what
 * is staged and bump **only** the apps whose folder was touched: a frontend-only commit leaves
 * backend and finetune untouched, and vice-versa.
 *
 * Numbering (DIRECT decision): patch = the number of commits that have touched that app's folder,
 * i.e. `git rev-list --count HEAD -- <path>` + 1 for the commit being created. This is deterministic
 * and self-correcting — it never drifts even across amend/rebase, and cannot run away, because a
 * bump only happens when the app already has non-version changes staged. major/minor are preserved
 * from the existing file so they can be hand-rolled for real releases.
 *
 * The freshly written version.json travels inside the very commit that triggered it (we re-stage it).
 *
 * Surfaced as: the sidebar brand badge (frontend + backend "srv" version), the Settings page, and
 * — for finetune — the Fine-Tuning page (fetched live from each server's GET /health).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each app: the folder that "owns" it and the version file to bump. Only app folders bump. */
const APPS = [
  { key: 'frontend', path: 'frontend', file: 'frontend/src/version.json' },
  { key: 'backend', path: 'backend', file: 'backend/src/version.json' },
  { key: 'finetune', path: 'finetune', file: 'finetune/src/version.json' },
];

/** Files staged for the commit being created. */
function stagedFiles() {
  try {
    return execSync('git diff --cached --name-only', { cwd: root })
      .toString()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Commits already in history that touched `path` (excludes the in-progress commit). */
function historyCount(path) {
  try {
    return parseInt(execSync(`git rev-list --count HEAD -- "${path}"`, { cwd: root }).toString().trim(), 10) || 0;
  } catch {
    return 0; // first commit — no HEAD yet
  }
}

const staged = stagedFiles();
const today = new Date().toISOString().slice(0, 10);
const bumped = [];

for (const app of APPS) {
  const prefix = `${app.path}/`;
  const touched = staged.some((f) => f === app.path || f.startsWith(prefix));
  if (!touched) continue;

  const file = join(root, app.file);
  let current;
  try {
    current = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    current = { version: '1.0.0' };
  }

  const [major, minor] = String(current.version || '1.0.0')
    .split('.')
    .map((n) => parseInt(n, 10) || 0);

  // history + the commit being created now (which, by definition, touches this app).
  const patch = historyCount(app.path) + 1;

  const next = { version: `${major}.${minor}.${patch}`, build: patch, date: today };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  execSync(`git add "${file}"`, { cwd: root });
  bumped.push(`${app.key} ${current.version ?? '?'} → ${next.version}`);
}

if (bumped.length) {
  console.log(`[bump-version] ${bumped.join('  |  ')}`);
} else {
  console.log('[bump-version] no app folders touched — nothing to bump');
}
