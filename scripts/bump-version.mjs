#!/usr/bin/env node
/**
 * Bumps the app version on every commit.
 *
 * Run from the git `pre-commit` hook (see scripts/hooks/pre-commit). It increments the
 * patch number, refreshes the build counter + date, then re-stages the file so the new
 * version travels inside the very commit that triggered it.
 *
 * Single source of truth: frontend/src/version.json — consumed by the UI
 * (frontend/src/version.ts) and surfaced as a badge in the sidebar + the Settings page,
 * and compared against origin/master by check_run.sh to show "v1.0.2 → v1.0.5".
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'frontend', 'src', 'version.json');

const current = JSON.parse(readFileSync(file, 'utf8'));

const [major, minor, patch] = String(current.version || '0.0.0')
  .split('.')
  .map((n) => parseInt(n, 10) || 0);

// Commits already in history + the one being created right now.
let commitCount = 0;
try {
  commitCount = parseInt(execSync('git rev-list --count HEAD', { cwd: root }).toString().trim(), 10) || 0;
} catch {
  /* first commit — no HEAD yet */
}

const next = {
  version: `${major}.${minor}.${patch + 1}`,
  build: commitCount + 1,
  date: new Date().toISOString().slice(0, 10),
};

writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
execSync(`git add "${file}"`, { cwd: root });

console.log(`[bump-version] ${current.version} → ${next.version} (build ${next.build})`);
