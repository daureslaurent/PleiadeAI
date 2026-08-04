import { createLogger } from '../../config/logger';
import { settingsService } from '../../domain/settings/settings.service';
import { ComfyError } from './errors';
import type {
  ComfyGraph,
  ComfyFileRef,
  ComfyHistory,
  ComfyHistoryEntry,
  ComfyNodeSchema,
  ComfyQueueInfo,
  ComfySubmitResult,
  ComfySystemStats,
  ComfyUploadResult,
} from './types';

const log = createLogger('comfy-http');

/** Control-plane calls (status, submit, history) are local-network and should answer immediately. */
const CONTROL_TIMEOUT_MS = 15_000;
/** Artifact downloads: a 10s video can be tens of MB over a LAN. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** ComfyUI 0.30.0's `/features` reports `max_upload_size: 104857600`. Mirrored so we fail early. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Node schemas are large and effectively static for a running server, but they *do* change when the
 * operator drops a new model file into `models/` (the loader enums are how we validate that a
 * workflow's checkpoint still exists). A short TTL keeps validation honest without re-fetching per node.
 */
const OBJECT_INFO_TTL_MS = 60_000;
const objectInfoCache = new Map<string, { at: number; schema: ComfyNodeSchema | null }>();

/**
 * HTTP client for one ComfyUI server (verified against 0.30.0). Every method throws {@link ComfyError}
 * on an operator-fixable failure — unreachable host, non-2xx, malformed body — so callers can turn it
 * into a readable tool error instead of a stack trace.
 *
 * ComfyUI serves every route both bare and under `/api` (the frontend uses the latter). We use the
 * bare form throughout, which is what a `--listen` server exposes by default.
 */
export class ComfyHttpClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** `http://host:8188` → `ws://host:8188/ws?clientId=…`. Used by {@link ComfyProgressSocket}. */
  wsUrl(clientId: string): string {
    return `${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
  }

  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = CONTROL_TIMEOUT_MS, ...rest } = init;
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ComfyError(
        `ComfyUI at ${this.baseUrl} ${timedOut ? 'timed out' : 'is unreachable'} (${path}). ` +
          'Check the server is running and the URL in Settings → Connections.',
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ComfyError(`ComfyUI ${path} returned ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return res;
  }

  private async getJson<T>(path: string, timeoutMs?: number): Promise<T> {
    const res = await this.request(path, { timeoutMs });
    try {
      return (await res.json()) as T;
    } catch {
      throw new ComfyError(`ComfyUI ${path} returned a body that isn't JSON.`);
    }
  }

  /** Version, RAM and per-GPU VRAM. Doubles as the connectivity probe behind "Test connection". */
  systemStats(): Promise<ComfySystemStats> {
    return this.getJson<ComfySystemStats>('/system_stats');
  }

  /** How many jobs are queued (running + pending). ComfyUI executes one at a time. */
  async queueRemaining(): Promise<number> {
    const info = await this.getJson<{ exec_info?: { queue_remaining?: number } }>('/prompt');
    return Number(info.exec_info?.queue_remaining ?? 0);
  }

  queueInfo(): Promise<ComfyQueueInfo> {
    return this.getJson<ComfyQueueInfo>('/queue');
  }

  /**
   * The full run history — every entry carries the **API-format graph** that produced it, which is
   * what workflow discovery imports. Note ComfyUI keeps this in memory only: it is emptied by a
   * restart, which is exactly why discovery snapshots into Mongo.
   */
  history(): Promise<ComfyHistory> {
    return this.getJson<ComfyHistory>('/history', 30_000);
  }

  /** One run, or `null` while it is still queued/running (ComfyUI only files it on completion). */
  async historyEntry(promptId: string): Promise<ComfyHistoryEntry | null> {
    const all = await this.getJson<ComfyHistory>(`/history/${encodeURIComponent(promptId)}`);
    return all[promptId] ?? null;
  }

  /**
   * Queue a graph. `clientId` must match the websocket already listening, otherwise the run's progress
   * frames go to a socket nobody is holding.
   */
  async submit(graph: ComfyGraph, clientId: string): Promise<ComfySubmitResult> {
    const res = await this.request('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
    });
    const json = (await res.json().catch(() => ({}))) as ComfySubmitResult;
    if (!json.prompt_id) {
      // ComfyUI validates the graph up front and answers 400 with `node_errors`; a 200 without an id
      // would mean the shape changed under us.
      throw new ComfyError('ComfyUI accepted the request but returned no prompt_id.');
    }
    return json;
  }

  /** Download a produced (or uploaded) file. Mime comes from the response — ComfyUI sets it correctly. */
  async view(ref: ComfyFileRef): Promise<{ bytes: Buffer; mime: string }> {
    const qs = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type || 'output',
    });
    const res = await this.request(`/view?${qs}`, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    const bytes = Buffer.from(await res.arrayBuffer());
    const header = res.headers.get('content-type') || 'application/octet-stream';
    const mime = (header.split(';')[0] ?? header).trim();
    return { bytes, mime };
  }

  /**
   * Push an image into ComfyUI's `input/` folder so a `LoadImage` node can reference it by name.
   * `overwrite` is on so retrying a job reuses the same filename instead of accumulating
   * `photo (1).png`, `photo (2).png`… in the operator's input directory.
   */
  async uploadImage(bytes: Buffer, filename: string, mime: string): Promise<ComfyUploadResult> {
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new ComfyError(
        `Image is ${(bytes.length / 1024 / 1024).toFixed(1)}MB — ComfyUI accepts at most ` +
          `${MAX_UPLOAD_BYTES / 1024 / 1024}MB.`,
      );
    }
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.append('type', 'input');
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', {
      method: 'POST',
      body: form,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    const json = (await res.json().catch(() => ({}))) as ComfyUploadResult;
    if (!json.name) throw new ComfyError('ComfyUI accepted the upload but returned no filename.');
    return json;
  }

  /**
   * The operator's saved workflow filenames (`GET /api/userdata?dir=workflows`).
   *
   * These files are the *editor's* format — they reference subgraph definitions by UUID and can't be
   * submitted — so they are useless as an import source. What they do carry is the name the operator
   * actually gave each workflow, which beats guessing one from a checkpoint filename.
   */
  async listUserWorkflows(): Promise<string[]> {
    const files = await this.getJson<unknown[]>('/api/userdata?dir=workflows');
    return files.filter((f): f is string => typeof f === 'string');
  }

  /** One saved workflow file. Only its top-level `id` matters to us — it keys runs back to a name. */
  async userWorkflow(filename: string): Promise<{ id?: string } | null> {
    try {
      return await this.getJson<{ id?: string }>(
        `/api/userdata/${encodeURIComponent(`workflows/${filename}`)}`,
      );
    } catch {
      return null;
    }
  }

  /** Drop a *pending* job. Safe and targeted — unlike `/interrupt`, it can't touch a running one. */
  async queueDelete(promptId: string): Promise<void> {
    await this.request('/queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  /**
   * Interrupt whatever is *currently executing*. ComfyUI has no "interrupt job X" — the caller must
   * first confirm the running job is its own, or this kills another agent's (or the operator's) run.
   */
  async interrupt(): Promise<void> {
    await this.request('/interrupt', { method: 'POST' });
  }

  /**
   * One node class's schema, cached briefly. Returns `null` for a class this server doesn't have
   * (that's a real answer — it means an imported workflow needs a custom node pack that isn't here).
   */
  async objectInfo(className: string): Promise<ComfyNodeSchema | null> {
    const key = `${this.baseUrl}::${className}`;
    const hit = objectInfoCache.get(key);
    if (hit && Date.now() - hit.at < OBJECT_INFO_TTL_MS) return hit.schema;

    let schema: ComfyNodeSchema | null = null;
    try {
      const json = await this.getJson<Record<string, ComfyNodeSchema>>(
        `/object_info/${encodeURIComponent(className)}`,
      );
      schema = json[className] ?? null;
    } catch (err) {
      // A 404 here means "no such node class", which is information, not an outage. Anything else
      // (unreachable host) still surfaces on the next call that matters.
      log.debug({ className, err: String(err) }, 'object_info lookup failed');
      schema = null;
    }
    objectInfoCache.set(key, { at: Date.now(), schema });
    return schema;
  }
}

/**
 * The client for the operator-configured ComfyUI server, or a {@link ComfyError} explaining that none
 * is set. Every media tool and route funnels through this so there is exactly one place that decides
 * "which ComfyUI".
 */
export async function comfyClient(): Promise<ComfyHttpClient> {
  const settings = await settingsService.get();
  const url = (settings.comfy_url || '').trim();
  if (!url) {
    throw new ComfyError(
      'No ComfyUI server is configured. Set one in Settings → Connections → ComfyUI server.',
    );
  }
  return new ComfyHttpClient(url);
}
