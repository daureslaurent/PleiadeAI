import { createLogger } from '../config/logger';

const log = createLogger('llama-introspect');

/** Strip a trailing slash so we can append server paths cleanly. */
function root(url: string): string {
  return url.replace(/\/$/, '');
}

function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function getJson(url: string, apiKey: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: authHeaders(apiKey) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch (err) {
    log.debug({ url, err: err instanceof Error ? err.message : String(err) }, 'introspect fetch failed');
    return null;
  }
}

/** Pull the first positive integer out of a set of candidate values. */
function firstCtx(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

/**
 * The real launch context size from a llama.cpp model-router entry's `status.args` — the exact
 * `--ctx-size` (or `-c`) the model was started with. This is authoritative on a router (llama-swap /
 * `llama-server --models`), where `/props` reports `n_ctx: 0` and `/v1/models` has no `meta`. A
 * `--ctx-size 0` means "use the model's trained max", so we treat 0 as absent and fall back.
 */
function ctxFromArgs(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined;
  for (const flag of ['--ctx-size', '-c']) {
    const i = args.indexOf(flag);
    if (i >= 0 && i + 1 < args.length) {
      const v = firstCtx(args[i + 1]);
      if (v) return v;
    }
  }
  return undefined;
}

/**
 * Probe an OpenAI-compatible (llama.cpp) server for the real context size of each model it serves.
 *
 * Per model, in priority order:
 *   1. `GET /v1/models` → `data[].status.args` `--ctx-size` — the exact size the model was launched
 *      with. Authoritative on a llama.cpp model-router (llama-swap / `--models`), which is the common
 *      multi-model case and where `/props` is useless (see below).
 *   2. `GET /v1/models` → `data[].meta.n_ctx_train` — the model's trained max, when a build exposes it.
 *   3. `GET /props` → `default_generation_settings.n_ctx` — the running slot's real n_ctx on a plain
 *      single-model server. Skipped on a router, which reports `role: "router"` and `n_ctx: 0`.
 *
 * Returns a `{ modelId: n_ctx }` map. Best-effort: an unreachable server or one exposing none of the
 * above yields `{}`, and the caller falls back to the configured `context_window`.
 */
export async function fetchModelContexts(
  baseUrl: string,
  apiKey: string,
): Promise<Record<string, number>> {
  const base = root(baseUrl);
  const out: Record<string, number> = {};

  // /v1/models: the OpenAI SDK strips the llama.cpp-specific fields, so fetch raw. A router entry
  // carries `status.args` (the launch command, incl. `--ctx-size`); some builds also carry `meta`.
  const models = (await getJson(`${base}/v1/models`, apiKey)) as
    | {
        data?: Array<{
          id?: string;
          meta?: { n_ctx_train?: number };
          status?: { args?: string[] };
        }>;
      }
    | null;
  if (models?.data) {
    for (const m of models.data) {
      if (!m?.id) continue;
      // The real launched `--ctx-size` wins; the trained max is only a fallback (it's the number that
      // reads as "262k" while the model actually runs at 64k).
      const v = ctxFromArgs(m.status?.args) ?? firstCtx(m.meta?.n_ctx_train);
      if (v) out[m.id] = v;
    }
  }

  // /props: only meaningful on a plain single-model server (a router reports n_ctx 0). Fill in the
  // running model when /v1/models gave us nothing for it; never override an explicit `--ctx-size`.
  const props = (await getJson(`${base}/props`, apiKey)) as
    | {
        role?: string;
        default_generation_settings?: { n_ctx?: number; model?: string };
        n_ctx?: number;
        model_path?: string;
      }
    | null;
  if (props && props.role !== 'router') {
    const runtime = firstCtx(props.default_generation_settings?.n_ctx, props.n_ctx);
    if (runtime) {
      const loadedPath = props.default_generation_settings?.model ?? props.model_path ?? '';
      const ids = Object.keys(out);
      const matched = ids.find((id) => loadedPath.endsWith(id) || loadedPath.includes(id));
      if (matched && !out[matched]) out[matched] = runtime;
      else if (ids.length === 0) {
        const name = loadedPath.split('/').pop() || loadedPath;
        if (name) out[name] = runtime;
      }
    }
  }

  return out;
}
