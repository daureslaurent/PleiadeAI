import { createLogger } from '../../config/logger';
import { decryptSecret } from '../../isolation/ssh.service';
import { apiSourceRepository } from './api-source.repository';
import type { ApiOperation, ApiParam, ApiSourceDoc, HttpMethod } from './api-source.model';

const log = createLogger('api-caller');

/** Heuristic characters-per-token for the response budget (no tokenizer in this layer). */
const CHARS_PER_TOKEN = 4;
/** Array item caps tried, largest first, when a JSON payload overruns its budget. */
const ARRAY_CAPS = [200, 50, 20, 5, 1];

/** An expected failure the agent (or the Test button) should read as text, not a thrown exception. */
export class ApiCallError extends Error {
  constructor(
    message: string,
    /** HTTP status when the failure came from the remote service rather than from validation. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

export interface ApiCallOutcome {
  status: number;
  /** Parsed JSON body, shrunk to the budget if the service returned more than fits in a context. */
  data: unknown;
  /** Set when the payload was reduced, naming what was dropped. */
  truncated?: string;
  url: string;
  method: HttpMethod;
  duration_ms: number;
}

/** Split `weather.forecast` into its two halves; the dot is the only separator. */
export function splitOperationId(raw: string): { api: string; operation: string } | null {
  const value = String(raw ?? '').trim();
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  return { api: value.slice(0, dot).toLowerCase(), operation: value.slice(dot + 1) };
}

/** Coerce one supplied value to the type its parameter declares, refusing what cannot convert. */
function coerceParam(param: ApiParam, value: unknown): unknown {
  switch (param.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ApiCallError(`parameter "${param.name}" must be a number`);
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw new ApiCallError(`parameter "${param.name}" must be a boolean`);
    case 'object':
    case 'array': {
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          throw new ApiCallError(`parameter "${param.name}" must be valid JSON`);
        }
      }
      return value;
    }
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** A declared default is stored as text; parse it back through the parameter's own type. */
function defaultFor(param: ApiParam): unknown | undefined {
  if (!param.default) return undefined;
  return coerceParam(param, param.default);
}

/** Query/body values go on the wire as text; objects and arrays as JSON. */
function toWire(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Validate the agent's arguments against the operation's declared parameters, refusing unknown
 * names outright. A silently ignored argument is worse than an error: the model reads the response
 * as if its filter had been applied.
 */
function bindParams(
  operation: ApiOperation,
  supplied: Record<string, unknown>,
): Map<string, { param: ApiParam; value: unknown }> {
  const declared = new Map(operation.params.map((p) => [p.name, p]));
  for (const name of Object.keys(supplied)) {
    if (!declared.has(name)) {
      const known = operation.params.map((p) => p.name).join(', ') || 'none';
      throw new ApiCallError(`unknown parameter "${name}" — this operation takes: ${known}`);
    }
  }

  const bound = new Map<string, { param: ApiParam; value: unknown }>();
  for (const param of operation.params) {
    const raw = supplied[param.name];
    const value = raw === undefined || raw === null || raw === '' ? defaultFor(param) : coerceParam(param, raw);
    if (value === undefined) {
      if (param.required) throw new ApiCallError(`missing required parameter "${param.name}"`);
      continue;
    }
    bound.set(param.name, { param, value });
  }
  return bound;
}

/**
 * Build the request URL. Path parameters are percent-encoded and the resolved origin is checked
 * against the configured base — a path argument must not be able to walk the call onto another
 * host, which is the one way an agent could otherwise choose its own destination.
 */
function buildUrl(
  source: ApiSourceDoc,
  operation: ApiOperation,
  bound: Map<string, { param: ApiParam; value: unknown }>,
  secret: string | null,
): URL {
  let path = operation.path || '/';
  for (const [name, { param, value }] of bound) {
    if (param.in !== 'path') continue;
    path = path.split(`{${name}}`).join(encodeURIComponent(toWire(value)));
  }
  const unresolved = /\{([^}]+)\}/.exec(path);
  if (unresolved) throw new ApiCallError(`path placeholder "{${unresolved[1]}}" has no parameter bound to it`);

  let base: URL;
  try {
    base = new URL(source.base_url);
  } catch {
    throw new ApiCallError(`"${source.name}" has an invalid base URL — fix it in Settings → APIs`);
  }
  // Join without letting a leading slash discard the base's own path prefix (…/v2 + /users).
  const joined = `${base.pathname.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  const url = new URL(base.origin);
  url.pathname = joined;

  if (url.origin !== base.origin) throw new ApiCallError('resolved URL left the configured host');

  for (const pair of operation.query) if (pair.key) url.searchParams.set(pair.key, pair.value);
  for (const [name, { param, value }] of bound) {
    if (param.in === 'query') url.searchParams.set(name, toWire(value));
  }
  if (source.auth_type === 'query' && secret) url.searchParams.set(source.auth_query || 'api_key', secret);

  return url;
}

/** Headers: the operator's static pairs, the agent's `in: 'header'` params, then auth. */
function buildHeaders(
  source: ApiSourceDoc,
  bound: Map<string, { param: ApiParam; value: unknown }>,
  secret: string | null,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const pair of source.headers) if (pair.key) headers[pair.key] = pair.value;
  for (const [name, { param, value }] of bound) {
    if (param.in === 'header') headers[name] = toWire(value);
  }
  if (hasBody) headers['Content-Type'] = 'application/json';

  if (secret) {
    if (source.auth_type === 'header') headers[source.auth_header || 'X-API-Key'] = secret;
    else if (source.auth_type === 'bearer') headers.Authorization = `Bearer ${secret}`;
    else if (source.auth_type === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${source.auth_username}:${secret}`).toString('base64')}`;
    }
  }
  return headers;
}

/**
 * Assemble the JSON body from `in: 'body'` parameters — flat by default, or through the operator's
 * `body_template` when the API wants a shape the flat form can't express (nesting, wrappers).
 */
function buildBody(
  operation: ApiOperation,
  bound: Map<string, { param: ApiParam; value: unknown }>,
): string | undefined {
  const bodyParams = [...bound].filter(([, b]) => b.param.in === 'body');
  if (operation.body_template) {
    let filled = operation.body_template;
    for (const [name, { value }] of bound) {
      const json = JSON.stringify(value === undefined ? null : value);
      filled = filled.split(`"{${name}}"`).join(json).split(`{${name}}`).join(toWire(value));
    }
    try {
      JSON.parse(filled);
    } catch {
      throw new ApiCallError(`the body template for "${operation.id}" did not produce valid JSON`);
    }
    return filled;
  }
  if (!bodyParams.length) return undefined;
  return JSON.stringify(Object.fromEntries(bodyParams.map(([name, b]) => [name, b.value])));
}

/** Cap every array in the payload at `cap` items, reporting how many were dropped. */
function capArrays(value: unknown, cap: number, dropped: { count: number }): unknown {
  if (Array.isArray(value)) {
    const kept = value.slice(0, cap).map((v) => capArrays(v, cap, dropped));
    if (value.length > cap) {
      dropped.count += value.length - cap;
      kept.push(`[… ${value.length - cap} more items omitted …]`);
    }
    return kept;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, capArrays(v, cap, dropped)]),
    );
  }
  return value;
}

/**
 * Fit a parsed payload into the response budget.
 *
 * Eliding the middle of serialized JSON — what `webfetch` does to text — would hand the model a
 * string that no longer parses. So the shrink happens on the *structure*: long arrays lose their
 * tail (the head of a result list is nearly always the useful part), and only if that still doesn't
 * fit does the payload degrade to a truncated string preview.
 */
export function shrinkJson(data: unknown, charBudget: number): { data: unknown; truncated?: string } {
  let serialized = JSON.stringify(data) ?? 'null';
  if (serialized.length <= charBudget) return { data };

  for (const cap of ARRAY_CAPS) {
    const dropped = { count: 0 };
    const capped = capArrays(data, cap, dropped);
    serialized = JSON.stringify(capped) ?? 'null';
    if (serialized.length <= charBudget) {
      return {
        data: capped,
        truncated: `${dropped.count} array items omitted to fit the response budget — narrow the request to see them`,
      };
    }
  }

  return {
    data: { preview: serialized.slice(0, charBudget) },
    truncated: `response was ${serialized.length} characters and could not be reduced structurally; a raw prefix is shown`,
  };
}

export interface CallOptions {
  /** Response budget in tokens (~4 chars each). */
  maxResponseTokens: number;
  /** Overrides the API's own timeout (used by the Test button). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run one configured operation and return its parsed JSON.
 *
 * Every refusal is an {@link ApiCallError}: a disabled API, a method the operator hasn't allowed, a
 * bad argument, a non-2xx status, a body that isn't JSON. The caller turns those into a tool result
 * the agent reads — a 404 from a third party is information, not a crash.
 */
export async function callOperation(
  operationId: string,
  params: Record<string, unknown>,
  opts: CallOptions,
): Promise<ApiCallOutcome> {
  const split = splitOperationId(operationId);
  if (!split) {
    throw new ApiCallError(`"${operationId}" is not an operation id — use "<api>.<operation>", e.g. "weather.forecast"`);
  }

  const source = await apiSourceRepository.findByNameWithSecret(split.api);
  if (!source) {
    const available = (await apiSourceRepository.listEnabled()).map((s) => s.name).join(', ') || 'none configured';
    throw new ApiCallError(`no API named "${split.api}" — available: ${available}`);
  }
  if (!source.enabled) throw new ApiCallError(`the "${source.name}" API is switched off`);

  const operation = source.operations.find((o) => o.id === split.operation);
  if (!operation || !operation.enabled) {
    const ops = source.operations.filter((o) => o.enabled).map((o) => `${source.name}.${o.id}`).join(', ') || 'none';
    throw new ApiCallError(`"${source.name}" has no operation "${split.operation}" — it offers: ${ops}`);
  }

  const method = operation.method as HttpMethod;
  if (!source.methods_allowed.includes(method)) {
    throw new ApiCallError(
      `"${source.name}" is configured to allow ${source.methods_allowed.join('/')} only, and ${operation.id} is a ${method}`,
    );
  }

  const secret = source.secret_enc ? decryptSecret(source.secret_enc) : null;
  if (source.auth_type !== 'none' && !secret) {
    throw new ApiCallError(`"${source.name}" needs a credential — add it in Settings → APIs`);
  }

  const bound = bindParams(operation, params ?? {});
  const url = buildUrl(source, operation, bound, secret);
  const body = method === 'GET' || method === 'HEAD' ? undefined : buildBody(operation, bound);
  const headers = buildHeaders(source, bound, secret, body !== undefined);

  const timeout = opts.timeoutMs ?? source.timeout_ms ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const started = Date.now();

  try {
    const res = await fetch(url.toString(), { method, headers, body, signal: controller.signal });
    const text = await res.text();
    const duration = Date.now() - started;

    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : null;
    } catch {
      if (!res.ok) {
        throw new ApiCallError(`${source.name}.${operation.id} failed: HTTP ${res.status} — ${text.slice(0, 400)}`, res.status);
      }
      throw new ApiCallError(
        `${source.name}.${operation.id} returned ${res.headers.get('content-type') ?? 'an unknown type'}, not JSON — first bytes: ${text.slice(0, 200)}`,
        res.status,
      );
    }

    if (!res.ok) {
      // The service's own JSON error is far more useful to the agent than the status alone.
      const detail = JSON.stringify(parsed).slice(0, 600);
      throw new ApiCallError(`${source.name}.${operation.id} failed: HTTP ${res.status} — ${detail}`, res.status);
    }

    const budget = Math.max(200, opts.maxResponseTokens) * CHARS_PER_TOKEN;
    const { data, truncated } = shrinkJson(parsed, budget);
    void apiSourceRepository.noteResult(String(source._id), '');
    return { status: res.status, data, truncated, url: url.toString(), method, duration_ms: duration };
  } catch (err) {
    if (err instanceof ApiCallError) {
      void apiSourceRepository.noteResult(String(source._id), err.message);
      throw err;
    }
    const aborted = (err as Error)?.name === 'AbortError';
    const message = aborted
      ? `${source.name}.${operation.id} timed out after ${timeout}ms`
      : `${source.name}.${operation.id} could not be reached: ${String((err as Error)?.message ?? err)}`;
    log.warn({ api: source.name, operation: operation.id, err: String(err) }, 'api call failed');
    void apiSourceRepository.noteResult(String(source._id), message);
    throw new ApiCallError(message);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
