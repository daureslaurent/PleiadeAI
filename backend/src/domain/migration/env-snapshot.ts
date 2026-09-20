import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * The host-level configuration that lives in `.env` rather than in the database (spec §5).
 *
 * It rides *inside* the encrypted archive but is never applied: the backend does not mount the
 * host's `.env`, and a value that only takes effect on restart cannot be written by the process
 * that would have to restart to see it. So the import page shows this as a diff against the
 * target's live environment and lets the operator paste what matters — which is also the only
 * honest way to handle `AUTH_PASSWORD`, where silently adopting the source's value would change
 * the login out from under whoever is doing the migration.
 */

/** Vars whose value is a credential: shown behind a reveal, and flagged in the diff. */
const SECRET_VARS = new Set([
  'JWT_SECRET',
  'AUTH_PASSWORD',
  'ISOLATION_ENC_KEY',
  'LLAMA_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'QDRANT_API_KEY',
]);

/**
 * What a target instance genuinely needs to behave like the source. Deliberately not `process.env`
 * wholesale: that would sweep in the container's own PATH/HOSTNAME and the compose-wired service
 * hostnames, which are *correct* on the target already and would be actively wrong to copy.
 */
const CARRIED_VARS = [
  'LLAMA_API_URL',
  'LLAMA_API_KEY',
  'LLAMA_MODEL',
  'LLAMA_CONTEXT_WINDOW',
  'EMBEDDING_MODEL',
  'SCHEDULE_TZ',
  'JWT_SECRET',
  'AUTH_USERNAME',
  'AUTH_PASSWORD',
  'ISOLATION_ENC_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'TELEGRAM_POLLING',
  'SEARXNG_SECRET',
  'LOG_LEVEL',
  'DOCKER_BIN',
  'AGENT_IMAGE_PREFIX',
  'AGENT_CONTAINER_CPUS',
  'AGENT_CONTAINER_MEMORY',
  'AGENT_CONTAINER_NETWORK',
  'AGENT_CONTAINER_IDLE_MS',
  'GLUETUN_IMAGE',
] as const;

export interface EnvVarSnapshot {
  name: string;
  value: string;
  secret: boolean;
  /** Absent on the source too — carried so the target doesn't think it lost something. */
  unset: boolean;
}

export interface EnvSnapshot {
  taken_at: string;
  vars: EnvVarSnapshot[];
}

export function takeEnvSnapshot(includeSecrets: boolean): EnvSnapshot {
  const vars: EnvVarSnapshot[] = CARRIED_VARS.map((name) => {
    const raw = process.env[name] ?? '';
    const secret = SECRET_VARS.has(name);
    return {
      name,
      value: secret && !includeSecrets ? '' : raw,
      secret,
      unset: raw === '',
    };
  });
  return { taken_at: new Date().toISOString(), vars };
}

export interface EnvDiffRow {
  name: string;
  secret: boolean;
  /** `same` | `differs` | `only_source` | `only_target`. */
  status: 'same' | 'differs' | 'only_source' | 'only_target';
  source_value: string;
  target_value: string;
}

/** Compare a carried snapshot against this instance's live environment, for the preflight table. */
export function diffEnv(snapshot: EnvSnapshot): EnvDiffRow[] {
  const rows: EnvDiffRow[] = [];
  for (const v of snapshot.vars) {
    const target = process.env[v.name] ?? '';
    const status: EnvDiffRow['status'] =
      v.value === target ? 'same' : v.value === '' ? 'only_target' : target === '' ? 'only_source' : 'differs';
    rows.push({
      name: v.name,
      secret: v.secret,
      status,
      source_value: v.value,
      target_value: target,
    });
  }
  return rows;
}

/** The isolation key this instance actually decrypts with — reported so a mismatch is visible. */
export function activeEncKeyFingerprint(): string {
  const key = env.ISOLATION_ENC_KEY || env.JWT_SECRET;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}
