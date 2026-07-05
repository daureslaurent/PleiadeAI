import { z } from 'zod';

/**
 * Typed, validated environment loader. The process fails fast on boot if a required
 * variable is missing or malformed, so downstream modules can treat `env` as trusted.
 *
 * Required values come from docker-compose (MONGO_URI, QDRANT_URL, LLAMA_API_URL).
 * Secrets (JWT, Telegram) must be supplied via the environment / .env — never defaulted
 * to a real value.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Persistence & inference
  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  QDRANT_URL: z.string().url('QDRANT_URL must be a valid URL'),
  QDRANT_API_KEY: z.string().optional(),
  LLAMA_API_URL: z.string().url('LLAMA_API_URL must be a valid URL'),
  LLAMA_API_KEY: z.string().default('sk-no-key-required'),
  LLAMA_MODEL: z.string().default('local-model'),
  // Model context window (n_ctx) — used only to display session context usage as a fraction.
  LLAMA_CONTEXT_WINDOW: z.coerce.number().int().positive().default(8192),

  // Built-in local fallback (docker-compose `llama-fallback` service). The backend ensures a
  // system-managed endpoint pointing here at boot and auto-discovers its model. The URL is the
  // docker-network hostname (reachable from the backend container, not the operator's browser).
  LLAMA_FALLBACK_URL: z.string().url('LLAMA_FALLBACK_URL must be a valid URL').default('http://llama-fallback:8080'),
  LLAMA_FALLBACK_MODEL: z.string().default('qwen2.5-1.5b-instruct'),

  // Embeddings — a separate (CPU) llama.cpp server started with --embedding. Powers Qdrant
  // vector memory; if unreachable the agent loop degrades gracefully (memory read/write skipped).
  EMBEDDING_API_URL: z.string().url('EMBEDDING_API_URL must be a valid URL').default('http://embeddings:8080'),
  EMBEDDING_API_KEY: z.string().default('sk-no-key-required'),
  EMBEDDING_MODEL: z.string().default('embedding-model'),

  // Auth
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),
  // Single operator credential for the command-center login (override in every real deploy).
  AUTH_USERNAME: z.string().default('admin'),
  AUTH_PASSWORD: z.string().min(1, 'AUTH_PASSWORD is required'),

  // Skill sandbox
  SKILL_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  SKILL_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  SKILL_WORKER_POOL_SIZE: z.coerce.number().int().positive().default(4),

  // Multi-agent recursion guard
  MAX_AGENT_HOPS: z.coerce.number().int().positive().default(3),

  // Working directory for the `bash` terminal tool (inside the container).
  BASH_CWD: z.string().default('/workspace'),

  // Host self-update bridge. The backend drops trigger files here (bind-mounted to the repo's
  // ./.update on the host); a host-side systemd watcher runs update_run.sh / check_run.sh. See
  // tools/updater/install-updater.sh. Override for non-Docker / custom layouts.
  UPDATE_TRIGGER_DIR: z.string().default('/app/.update'),

  // Per-agent Docker isolation. The backend talks to the host daemon via the mounted
  // /var/run/docker.sock using the `docker` CLI. These are defaults for new agents' containers
  // (each agent can override cpus/memory/network/idle in its Isolation panel).
  DOCKER_BIN: z.string().default('docker'),
  AGENT_IMAGE_PREFIX: z.string().default('pleiade_agent'),
  AGENT_CONTAINER_CPUS: z.string().default('1'),
  AGENT_CONTAINER_MEMORY: z.string().default('1g'),
  AGENT_CONTAINER_NETWORK: z.string().default('host'),
  AGENT_CONTAINER_IDLE_MS: z.coerce.number().int().positive().default(1_800_000),
  AGENT_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // VPN (gluetun) for isolation profiles in `vpn` network mode. GLUETUN_IMAGE is pulled per profile
  // that enables VPN; AGENT_VPN_HEALTH_TIMEOUT_MS bounds how long ensureReady waits for the tunnel's
  // healthcheck before throwing IsolationNotReadyError (kill-switch: no traffic leaks meanwhile).
  GLUETUN_IMAGE: z.string().default('qmcgaw/gluetun:latest'),
  AGENT_VPN_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Secret used to encrypt isolation SSH private keys at rest (AES-256-GCM). Falls back to
  // JWT_SECRET when unset; set a dedicated value in production so rotating one doesn't affect both.
  ISOLATION_ENC_KEY: z.string().optional(),

  // Alerts (Telegram) — optional; when absent the Telegram leg of the dual pipeline is skipped.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // Interactive bot. Comma-separated chat ids allowed to drive agents from Telegram; falls back
  // to TELEGRAM_CHAT_ID when unset. TELEGRAM_POLLING gates the inbound long-poll loop.
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
  TELEGRAM_POLLING: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Logging
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Cannot use the Pino logger here: it depends on this module. Fail loud and exit.
    console.error(`[env] Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
