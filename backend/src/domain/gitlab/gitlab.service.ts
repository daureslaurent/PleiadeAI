import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';

const log = createLogger('gitlab');

/**
 * The GitLab client (`GITLAB_PLAN.md` §1).
 *
 * One bot account for the whole fleet: the token lives in the settings singleton, encrypted, and is
 * decrypted here and nowhere else in the request path. Every tool, every UI route and the webhook
 * router share this one request builder for the same reason `api-caller.service.ts` is shared by the
 * `api` tool and the settings page's Test button — two builders drift, and the one that drifts is
 * always the one holding the credential.
 */

/** A configuration or GitLab-side failure the *agent* should read, not an exception to propagate. */
export class GitLabError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'GitLabError';
  }
}

export interface GitLabConnection {
  url: string;
  token: string;
  /** Namespace every call is confined to, or '' for the whole instance. */
  group: string;
  botUsername: string;
}

/**
 * Resolve the connection, or explain precisely what is missing.
 *
 * The message matters: it is what an agent reads back when a tool fails, and "GitLab is not
 * configured" sends it into a retry loop, while naming the page sends the *operator* to the fix.
 */
export async function connection(): Promise<GitLabConnection> {
  const settings = await settingsService.get();
  const url = settings.gitlab_url.trim().replace(/\/+$/, '');
  if (!url) {
    throw new GitLabError('GitLab is not configured on this instance (Settings → Connections → GitLab).');
  }
  const { token } = await settingsService.gitlabSecrets();
  if (!token) {
    throw new GitLabError(
      'GitLab has a URL but no access token (Settings → Connections → GitLab). Nothing can be read until one is pasted.',
    );
  }
  return { url, token, group: settings.gitlab_group.trim(), botUsername: settings.gitlab_bot_username.trim() };
}

/** Whether the instance has a usable GitLab connection — the module/tool-grant predicate. */
export async function isConfigured(): Promise<boolean> {
  const settings = await settingsService.get();
  return !!settings.gitlab_url.trim() && settings.gitlab_token_set;
}

/**
 * A project reference as the agent wrote it (`group/project`, or a numeric id), percent-encoded for
 * GitLab's `:id` path segment — and checked against the configured group first.
 *
 * The check is the point. `api-caller.service.ts` re-resolves an origin after substituting a path
 * parameter so no argument can walk a call onto another host; the same hazard here is a project path
 * walking out of the namespace the operator confined the fleet to. A numeric id is refused under
 * group scoping precisely because it cannot be checked from its own text — the caller resolves it to
 * a path through `gitlab_search` first.
 */
export function projectPath(ref: unknown, conn: GitLabConnection): string {
  const raw = String(ref ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!raw) throw new GitLabError('a `project` is required — a path like "group/project", or its numeric id');
  const numeric = /^\d+$/.test(raw);
  if (conn.group) {
    if (numeric) {
      throw new GitLabError(
        `this instance is confined to the "${conn.group}" group, so a project must be given by path ` +
          '(e.g. "' + conn.group + '/app"), not by numeric id — find it with `gitlab_search({action:"projects"})`.',
      );
    }
    const scope = conn.group.toLowerCase();
    const lower = raw.toLowerCase();
    if (lower !== scope && !lower.startsWith(`${scope}/`)) {
      throw new GitLabError(`"${raw}" is outside the "${conn.group}" group this instance is confined to.`);
    }
  }
  return numeric ? raw : encodeURIComponent(raw);
}

/** GitLab's `:id` encoding for any other path segment (branch names carry slashes too). */
export function seg(value: unknown): string {
  return encodeURIComponent(String(value ?? ''));
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, unknown>;
  body?: unknown;
  /** Return the raw text instead of parsing JSON (raw file contents, job logs). */
  raw?: boolean;
  /** Follow `X-Next-Page` until this many items are collected. */
  paginate?: number;
  conn?: GitLabConnection;
}

function buildUrl(conn: GitLabConnection, path: string, query?: Record<string, unknown>): string {
  const url = new URL(`${conn.url}/api/v4/${path.replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(`${key}[]`, String(item));
    } else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * GitLab's error bodies are inconsistent — `{message}` as a string, as an object of field errors, or
 * `{error}`. An agent handed `[object Object]` cannot correct itself, so they are flattened here.
 */
function explain(status: number, body: string): string {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.message ?? parsed?.error;
    if (typeof message === 'string') detail = message;
    else if (message && typeof message === 'object') {
      detail = Object.entries(message)
        .map(([field, errs]) => `${field}: ${Array.isArray(errs) ? errs.join(', ') : String(errs)}`)
        .join('; ');
    }
  } catch {
    /* not JSON — the truncated body is the best we have */
  }
  if (status === 401) return `GitLab rejected the token (401): ${detail}`;
  if (status === 403) return `the bot account is not allowed to do this (403): ${detail}`;
  if (status === 404) {
    return `not found (404) — wrong path, or the bot account cannot see it: ${detail}`;
  }
  return `GitLab returned ${status}: ${detail}`;
}

/** One authenticated call. `paginate` walks `X-Next-Page` for list endpoints. */
export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const conn = opts.conn ?? (await connection());
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': conn.token,
    Accept: opts.raw ? 'text/plain' : 'application/json',
  };
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  const collected: unknown[] = [];
  let url = buildUrl(conn, path, {
    ...opts.query,
    ...(opts.paginate ? { per_page: Math.min(100, opts.paginate) } : {}),
  });

  for (let page = 1; ; page += 1) {
    const res = await fetch(url, { method, headers, body: payload });
    const text = await res.text();
    if (!res.ok) {
      log.warn({ path, status: res.status, method }, 'gitlab call failed');
      throw new GitLabError(explain(res.status, text), res.status);
    }
    if (opts.raw) return text as T;
    const parsed = text ? JSON.parse(text) : null;
    if (!opts.paginate || !Array.isArray(parsed)) return parsed as T;

    collected.push(...parsed);
    const next = res.headers.get('x-next-page');
    if (!next || collected.length >= opts.paginate || page >= 20) break;
    url = buildUrl(conn, path, { ...opts.query, per_page: Math.min(100, opts.paginate), page: next });
  }
  return collected.slice(0, opts.paginate) as T;
}

/**
 * Group scoping for the endpoints that take no project: a search or a project listing runs against
 * `/groups/<group>/…` when confined, and against the instance root otherwise. Without this, "list
 * the projects" quietly returns every repository on the server.
 */
export function scopedPath(conn: GitLabConnection, groupSuffix: string, instancePath: string): string {
  return conn.group ? `groups/${encodeURIComponent(conn.group)}/${groupSuffix}` : instancePath;
}

/** Trim GitLab's very wide objects down to what an agent can act on. */
export function slimProject(p: Record<string, any>): Record<string, unknown> {
  return {
    id: p.id,
    path: p.path_with_namespace,
    name: p.name,
    description: p.description || null,
    default_branch: p.default_branch,
    visibility: p.visibility,
    url: p.web_url,
    last_activity: p.last_activity_at,
    archived: p.archived,
    topics: p.topics ?? p.tag_list ?? [],
    open_issues: p.open_issues_count,
    stars: p.star_count,
  };
}

export function slimIssue(i: Record<string, any>): Record<string, unknown> {
  return {
    iid: i.iid,
    project_id: i.project_id,
    title: i.title,
    state: i.state,
    author: i.author?.username,
    assignees: (i.assignees ?? []).map((a: any) => a.username),
    labels: i.labels ?? [],
    milestone: i.milestone?.title ?? null,
    due_date: i.due_date ?? null,
    url: i.web_url,
    created_at: i.created_at,
    updated_at: i.updated_at,
    comments: i.user_notes_count,
    description: i.description || null,
  };
}

export function slimMergeRequest(m: Record<string, any>): Record<string, unknown> {
  return {
    iid: m.iid,
    project_id: m.project_id,
    title: m.title,
    state: m.state,
    draft: m.draft ?? m.work_in_progress,
    source_branch: m.source_branch,
    target_branch: m.target_branch,
    author: m.author?.username,
    assignees: (m.assignees ?? []).map((a: any) => a.username),
    reviewers: (m.reviewers ?? []).map((a: any) => a.username),
    labels: m.labels ?? [],
    url: m.web_url,
    // `cannot_be_merged` vs `unchecked` is the difference between "fix the conflict" and "ask again
    // in a second", and an agent that can merge needs to tell them apart.
    merge_status: m.detailed_merge_status ?? m.merge_status,
    has_conflicts: m.has_conflicts,
    pipeline: m.head_pipeline ? { status: m.head_pipeline.status, id: m.head_pipeline.id } : null,
    created_at: m.created_at,
    updated_at: m.updated_at,
    description: m.description || null,
  };
}

export function slimPipeline(p: Record<string, any>): Record<string, unknown> {
  return {
    id: p.id,
    iid: p.iid,
    status: p.status,
    ref: p.ref,
    sha: p.sha?.slice(0, 8),
    source: p.source,
    url: p.web_url,
    created_at: p.created_at,
    updated_at: p.updated_at,
    duration: p.duration ?? null,
  };
}

export function slimCommit(c: Record<string, any>): Record<string, unknown> {
  return {
    id: c.id?.slice(0, 8),
    full_sha: c.id,
    title: c.title,
    message: c.message,
    author: c.author_name,
    authored_at: c.authored_date ?? c.created_at,
    url: c.web_url,
    stats: c.stats ?? null,
  };
}
