import { createLogger } from '../config/logger';

const log = createLogger('llama-introspect');

/** What the introspection probe learned about the models an endpoint serves. */
export interface ModelIntrospection {
  /** Real context size (`n_ctx`) per model id. */
  contexts: Record<string, number>;
  /**
   * Vision (multimodal) capability per model id. `true`/`false` are *confident* readings
   * (`--mmproj` seen / provably absent from the launch args, or `/props` `modalities.vision`);
   * a model absent from the map means the server exposes nothing we can decide from
   * (vLLM, Ollama, older llama.cpp) and the caller should fall back to the manual flag.
   */
  vision: Record<string, boolean>;
}

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
 * Vision capability from a router entry's launch args: `--mmproj <path>` means the model was
 * started with a multimodal projector, i.e. it accepts images. Args being present *without* the
 * flag is a confident "text-only"; no args at all means we can't tell (returns `undefined`).
 */
function visionFromArgs(args: unknown): boolean | undefined {
  if (!Array.isArray(args) || args.length === 0) return undefined;
  return args.some((a) => a === '--mmproj' || (typeof a === 'string' && a.startsWith('--mmproj=')));
}

/**
 * Vision capability from a model entry's `architecture.input_modalities` (recent llama.cpp routers
 * report the *launched* modalities — the same GGUF shows `["text"]` without `--mmproj` and
 * `["text","image"]` with it). Missing/empty means the build doesn't expose it.
 */
function visionFromModalities(modalities: unknown): boolean | undefined {
  if (!Array.isArray(modalities) || modalities.length === 0) return undefined;
  return modalities.includes('image');
}

/**
 * Probe an OpenAI-compatible (llama.cpp) server for the real context size and vision capability of
 * each model it serves.
 *
 * Per model, in priority order:
 *   1. `GET /v1/models` → `data[].status.args` — the exact launch command (`--ctx-size`, `--mmproj`)
 *      — and `data[].architecture.input_modalities` for vision. Authoritative on a llama.cpp
 *      model-router (llama-swap / `--models`), which is the common multi-model case and where
 *      `/props` is useless (see below).
 *   2. `GET /v1/models` → `data[].meta.n_ctx_train` — the model's trained max, when a build exposes it.
 *   3. `GET /props` → `default_generation_settings.n_ctx` + `modalities.vision` — the running slot's
 *      real readings on a plain single-model server. Skipped on a router, which reports
 *      `role: "router"` and `n_ctx: 0`.
 *
 * Best-effort: an unreachable server or one exposing none of the above yields empty maps, and the
 * caller falls back to the configured `context_window` / manual `supports_vision` flag.
 */
export async function introspectModels(baseUrl: string, apiKey: string): Promise<ModelIntrospection> {
  const base = root(baseUrl);
  const contexts: Record<string, number> = {};
  const vision: Record<string, boolean> = {};

  // /v1/models: the OpenAI SDK strips the llama.cpp-specific fields, so fetch raw. A router entry
  // carries `status.args` (the launch command, incl. `--ctx-size`/`--mmproj`); some builds also
  // carry `meta`.
  const models = (await getJson(`${base}/v1/models`, apiKey)) as
    | {
        data?: Array<{
          id?: string;
          meta?: { n_ctx_train?: number };
          status?: { args?: string[] };
          architecture?: { input_modalities?: string[] };
        }>;
      }
    | null;
  if (models?.data) {
    for (const m of models.data) {
      if (!m?.id) continue;
      // The real launched `--ctx-size` wins; the trained max is only a fallback (it's the number that
      // reads as "262k" while the model actually runs at 64k).
      const v = ctxFromArgs(m.status?.args) ?? firstCtx(m.meta?.n_ctx_train);
      if (v) contexts[m.id] = v;
      const vis = visionFromArgs(m.status?.args) ?? visionFromModalities(m.architecture?.input_modalities);
      if (vis !== undefined) vision[m.id] = vis;
    }
  }

  // /props: only meaningful on a plain single-model server (a router reports n_ctx 0). Fill in the
  // running model when /v1/models gave us nothing for it; never override an explicit launch arg.
  const props = (await getJson(`${base}/props`, apiKey)) as
    | {
        role?: string;
        default_generation_settings?: { n_ctx?: number; model?: string };
        n_ctx?: number;
        model_path?: string;
        modalities?: { vision?: boolean };
      }
    | null;
  if (props && props.role !== 'router') {
    // Resolve which discovered model id the running slot corresponds to (the loaded GGUF path
    // usually ends with the id); on a bare single-model server with no /v1/models data, fall back
    // to the file name.
    const loadedPath = props.default_generation_settings?.model ?? props.model_path ?? '';
    const ids = Object.keys(contexts);
    let target = ids.find((id) => loadedPath.endsWith(id) || loadedPath.includes(id));
    if (!target && ids.length === 0) target = loadedPath.split('/').pop() || undefined;

    const runtime = firstCtx(props.default_generation_settings?.n_ctx, props.n_ctx);
    if (runtime && target && !contexts[target]) contexts[target] = runtime;
    if (typeof props.modalities?.vision === 'boolean' && target && vision[target] === undefined) {
      vision[target] = props.modalities.vision;
    }
  }

  return { contexts, vision };
}
