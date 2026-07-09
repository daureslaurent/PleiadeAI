import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/**
 * Minimal `KEY=value` reader for `.env.prod` (gitignored). Avoids a `dotenv` dependency so both the
 * MCP server and the CLI can run with a bare `node` and no install step. Real environment variables
 * always win, so `PLEIADES_API_URL=… node scripts/prod.mjs` overrides the file.
 */
function loadEnvFile() {
  const file = path.join(REPO_ROOT, '.env.prod');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    // Strip one layer of surrounding quotes, as shells would.
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Look up one variable: the real environment wins, then `.env.prod`, then `fallback`.
 * Used by `scripts/clone-prod.mjs` for the *local* target's URL and operator credentials.
 */
export function envValue(name, fallback = undefined) {
  return process.env[name] || loadEnvFile()[name] || fallback;
}

/** Resolve `{ baseUrl, apiKey }`, or throw an operator-readable error explaining what's missing. */
export function loadConfig() {
  const file = loadEnvFile();
  const baseUrl = process.env.PLEIADES_API_URL || file.PLEIADES_API_URL;
  const apiKey = process.env.PLEIADES_API_KEY || file.PLEIADES_API_KEY;

  if (!baseUrl || !apiKey) {
    const missing = [!baseUrl && 'PLEIADES_API_URL', !apiKey && 'PLEIADES_API_KEY'].filter(Boolean);
    throw new Error(
      `Missing ${missing.join(' and ')}. Set them in ${path.join(REPO_ROOT, '.env.prod')} ` +
        `(see .env.prod.example) or in the environment. Mint a key in the app under Settings → API Keys.`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

export class PleiadesError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PleiadesError';
    this.status = status;
  }
}

/**
 * GET `path` (which must start with `/api/`) with the API key attached.
 *
 * Keys are read-only server-side; we don't expose any other verb here so a bug in a caller can't
 * turn into a write. `query` values that are `undefined`/`null`/`''` are dropped.
 */
export async function apiGet(pathname, query = {}, { timeoutMs = 30_000 } = {}) {
  const { baseUrl, apiKey } = loadConfig();

  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { headers: { 'X-API-Key': apiKey }, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new PleiadesError(`GET ${url.pathname} timed out after ${timeoutMs}ms`);
    throw new PleiadesError(`GET ${url.pathname} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const body = await res.text();
  if (!res.ok) {
    // The backend answers with `{ error: … }`; fall back to the raw body for proxies/edge errors.
    let detail = body.slice(0, 500);
    try {
      detail = JSON.parse(body).error ?? detail;
    } catch {
      /* not JSON — keep the raw snippet */
    }
    throw new PleiadesError(`GET ${url.pathname} → ${res.status}: ${detail}`, res.status);
  }

  try {
    return JSON.parse(body);
  } catch {
    return body; // e.g. the JSONL dataset download
  }
}
