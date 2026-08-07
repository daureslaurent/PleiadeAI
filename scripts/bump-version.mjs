#!/usr/bin/env node
/**
 * Auto-bumps per-app version numbers on every commit — independently.
 *
 * Run from the git `pre-commit` hook (see scripts/hooks/pre-commit). Each of the three apps
 * (frontend / backend / finetune) carries its own `src/version.json`. On commit we look at what
 * is staged and bump **only** the apps whose folder was touched: a frontend-only commit leaves
 * backend and finetune untouched, and vice-versa.
 *
 * Numbering: patch increments by 1 from whatever's committed at HEAD — unless major/minor was
 * hand-rolled (the working copy's major.minor no longer matches HEAD's), in which case patch resets
 * to 0 so a fresh x.y line always starts clean. This is deterministic and self-correcting — it never
 * drifts even across amend/rebase, since it's read from git history rather than tracked separately.
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

/** The version last committed at HEAD for `file`, or null if it doesn't exist there yet. */
function headVersion(file) {
  try {
    const raw = execSync(`git show HEAD:"${file}"`, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    return JSON.parse(raw);
  } catch {
    return null; // no HEAD yet, or file didn't exist at HEAD
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

  // Hand-rolling major/minor in the working copy (ahead of what's committed at HEAD) means a fresh
  // x.y line — patch restarts at 0. Otherwise keep incrementing from HEAD's committed patch.
  const head = headVersion(app.file);
  const [headMajor, headMinor, headPatch] = head
    ? String(head.version || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0)
    : [null, null, -1];
  const patch = major === headMajor && minor === headMinor ? headPatch + 1 : 0;

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
