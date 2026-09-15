import { env } from '../../config/env';
import { createLogger } from '../../config/logger';

const log = createLogger('git');

/** Control-plane calls go to a container on the same docker network; they answer at once or not at all. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** An operator-fixable git failure: server off, unreachable, refused, or a named thing that is missing. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** The feature is on only when the backend has the admin credential to drive the server with. */
export function gitEnabled(): boolean {
  return !!env.GIT_ADMIN_PASSWORD;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Act as this Forgejo user (admin-only `Sudo` header) — how the backend reads what an agent can see. */
  sudo?: string;
  timeoutMs?: number;
  /** Statuses that are an answer rather than an error (e.g. 404 for "does it exist?"). */
  okStatuses?: number[];
}

/**
 * The single request builder for Forgejo (GIT_SERVER_PLAN.md §2): the routes, the `git_repos` tool,
 * the prompt module's fetch and the boot bootstrap all come through here, so auth, timeouts and error
 * wording cannot drift between them. Always authenticates as the admin (basic auth); the agent's
 * point of view is obtained with `sudo`, never with the agent's own token, which stays in its container.
 */
class ForgejoClient {
  private get base(): string {
    return `${env.GIT_SERVER_URL.replace(/\/+$/, '')}/api/v1`;
  }

  private authHeader(): string {
    const raw = `${env.GIT_ADMIN_USER}:${env.GIT_ADMIN_PASSWORD ?? ''}`;
    return `Basic ${Buffer.from(raw).toString('base64')}`;
  }

  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    if (!gitEnabled()) {
      throw new GitError('The internal git server is not configured: set GIT_ADMIN_PASSWORD in .env and restart.');
    }
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { authorization: this.authHeader(), accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.sudo) headers.sudo = opts.sudo;

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new GitError(`The git server at ${env.GIT_SERVER_URL} ${timedOut ? 'timed out' : 'is unreachable'} (${path}).`);
    }
    if (!res.ok && !(opts.okStatuses ?? []).includes(res.status)) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      let message = detail;
      try {
        message = (JSON.parse(detail) as { message?: string }).message || detail;
      } catch {
        /* not JSON — keep the text */
      }
      log.debug({ path, status: res.status, message }, 'forgejo request refused');
      throw new GitError(`git server ${opts.method ?? 'GET'} ${path} → ${res.status}${message ? `: ${message}` : ''}`, res.status);
    }
    return res;
  }

  async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitError(`git server ${path} returned a malformed body`);
    }
  }

  /** JSON plus the pagination headers Forgejo sets on list endpoints. */
  async page<T>(path: string, opts: RequestOptions = {}): Promise<{ items: T; total: number | null; hasMore: boolean }> {
    const res = await this.request(path, opts);
    const items = (await res.json()) as T;
    const totalHeader = res.headers.get('x-total-count') ?? res.headers.get('x-total');
    return {
      items,
      total: totalHeader !== null ? Number(totalHeader) : null,
      hasMore: res.headers.get('x-hasmore') === 'true',
    };
  }

  async text(path: string, opts: RequestOptions = {}): Promise<string> {
    return (await this.request(path, opts)).text();
  }

  /** Healthz is unauthenticated and outside `/api/v1`. */
  async healthy(timeoutMs = 3_000): Promise<boolean> {
    try {
      const res = await fetch(`${env.GIT_SERVER_URL.replace(/\/+$/, '')}/api/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const forgejo = new ForgejoClient();

/** Path segment encoder — every repo/user/branch name that reaches a URL goes through this. */
export const seg = (s: string): string => encodeURIComponent(s);
