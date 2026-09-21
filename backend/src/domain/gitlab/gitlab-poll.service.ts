import { createLogger } from '../../config/logger';
import { agentRepository } from '../agents/agent.repository';
import { settingsService } from '../settings/settings.service';
import { gitlabProvision } from './gitlab-provision.service';
import { armedKinds, type PollEventKind } from './gitlab-poll.catalogue';
import { gitlabPollStateRepository } from './gitlab-poll-state.repository';
import { gitlabWakeQueue } from './gitlab-wake-runner';
import { route, type WakeDecision } from './gitlab-webhook.service';
import {
  GitLabError,
  connection,
  isConfigured,
  projectPath,
  request,
  scopedPath,
  type GitLabConnection,
} from './gitlab.service';

const log = createLogger('gitlab-poll');

/**
 * Asking GitLab what happened, instead of waiting to be told (`GITLAB_PLAN.md` §13).
 *
 * Group webhooks are a paid feature and project webhooks have to be armed one repository at a time,
 * so on most self-hosted instances §5's inbound hook is not reachable at all. This module produces
 * the same `WakeDecision`s from the other direction and hands them to the same queue — everything
 * after `enqueue` (serial draining, the in-flight guard, the session-lock yield, the recorder, the
 * notification) is untouched.
 *
 * Three rules hold the whole design up:
 *
 * 1. **A disabled kind is never fetched.** No armed event kind means no project is polled at all.
 * 2. **A source's first tick baselines it and wakes nobody.** Arming `mr_merged` on a year-old
 *    project must not start a turn per historical merge.
 * 3. **The backlog is left behind, not dropped.** Past the per-tick cap the cursor stops advancing,
 *    so the next tick continues from the same place instead of losing what it did not have budget
 *    for.
 */

/** Projects polled when the operator has not narrowed the list. */
const MAX_PROJECTS = 20;
/** Events read per project per tick — at a five-minute interval, a wide margin. */
const EVENTS_PER_PROJECT = 50;
/** How long a project's id and default branch are trusted before being re-read. */
const PROJECT_CACHE_MS = 30 * 60_000;

export interface PollReport {
  at: string;
  /** False when nothing was polled, in which case `reason` says why. */
  ran: boolean;
  reason?: string;
  /** Accounts whose todo list was read. */
  identities: string[];
  projects: string[];
  /** Matching rows seen — including the ones a cap or a routing failure stopped. */
  found: number;
  woke: { agent: string; kind: string; title: string }[];
  /** Source keys recorded for the first time. Nothing is woken from a baseline. */
  baselined: string[];
  /** Rows left for the next tick because the per-tick cap was reached. */
  deferred: number;
  /** Rows that matched but routed to nobody, and calls that failed. */
  skipped: string[];
  errors: string[];
}

interface PolledProject {
  id: number;
  path: string;
  defaultBranch: string;
}

const projectCache = new Map<string, { at: number; project: PolledProject }>();

/** The accounts a todo poll reads: the fleet bot, plus every agent that has its own GitLab user. */
async function identities(base: GitLabConnection): Promise<
  { key: string; label: string; conn: GitLabConnection; agentId?: string; agentName?: string }[]
> {
  const rows: { key: string; label: string; conn: GitLabConnection; agentId?: string; agentName?: string }[] = [
    { key: 'fleet', label: base.botUsername || 'the fleet account', conn: base },
  ];
  for (const identity of await gitlabProvision.list()) {
    // `stored`, never `ensure`: a tick must not provision accounts (see the comment there).
    const full = await gitlabProvision.stored(identity.agentId);
    if (!full?.token) continue;
    rows.push({
      key: identity.agentId,
      label: identity.username || identity.agentName,
      conn: { ...base, token: full.token, actingAs: identity.username },
      agentId: identity.agentId,
      agentName: identity.agentName,
    });
  }
  return rows;
}

/** The projects an event or pipeline poll covers. */
async function pollProjects(conn: GitLabConnection, wanted: string[]): Promise<PolledProject[]> {
  if (wanted.length) {
    const out: PolledProject[] = [];
    for (const ref of wanted.slice(0, MAX_PROJECTS)) {
      const cached = projectCache.get(ref);
      if (cached && Date.now() - cached.at < PROJECT_CACHE_MS) {
        out.push(cached.project);
        continue;
      }
      // `projectPath` re-checks the group on every tick, exactly as a tool call does: a row typed
      // into the settings page is an argument like any other and must not walk the poller out of
      // the namespace the fleet is confined to.
      const raw = await request<Record<string, any>>(`projects/${projectPath(ref, conn)}`, { conn });
      const project: PolledProject = {
        id: Number(raw.id),
        path: String(raw.path_with_namespace),
        defaultBranch: String(raw.default_branch ?? 'main'),
      };
      projectCache.set(ref, { at: Date.now(), project });
      out.push(project);
    }
    return out;
  }

  const rows = await request<Record<string, any>[]>(scopedPath(conn, 'projects', 'projects'), {
    conn,
    paginate: MAX_PROJECTS,
    query: {
      order_by: 'last_activity_at',
      membership: conn.group ? undefined : true,
      include_subgroups: conn.group ? true : undefined,
    },
  });
  return rows.map((p) => ({
    id: Number(p.id),
    path: String(p.path_with_namespace),
    defaultBranch: String(p.default_branch ?? 'main'),
  }));
}

/** Usernames the fleet itself acts as — the footprints a poll must not wake anybody about. */
async function ourUsernames(conn: GitLabConnection): Promise<Set<string>> {
  const names = new Set<string>();
  if (conn.botUsername) names.add(conn.botUsername.toLowerCase());
  for (const agent of await agentRepository.list()) {
    if (agent.gitlab_username) names.add(agent.gitlab_username.toLowerCase());
  }
  return names;
}

/** Is this project inside the configured group? Todos span every project an account can see. */
function inScope(conn: GitLabConnection, path: string): boolean {
  if (!conn.group) return true;
  const scope = conn.group.toLowerCase();
  const lower = path.toLowerCase();
  return lower === scope || lower.startsWith(`${scope}/`);
}

/** A routing result as a `WakeDecision` carries it — `why` becomes the reason nothing ran. */
async function routed(
  project: string,
  body = '',
): Promise<Pick<WakeDecision, 'agentId' | 'agentName' | 'skipped'>> {
  const hit = await route(project, body, []);
  return { agentId: hit.agentId, agentName: hit.agentName, skipped: hit.why };
}

function matchTodo(kinds: PollEventKind[], todo: Record<string, any>): PollEventKind | undefined {
  const action = String(todo.action_name ?? '');
  const target = String(todo.target_type ?? '');
  return kinds.find(
    (k) => (k.match ?? []).includes(action) && (!k.targetType || k.targetType === target),
  );
}

function matchEvent(kinds: PollEventKind[], event: Record<string, any>): PollEventKind | undefined {
  const action = String(event.action_name ?? '');
  const target = String(event.target_type ?? '');
  return kinds.find(
    (k) =>
      // GitLab writes a push as "pushed to" / "pushed new", so a prefix rather than an equality.
      (k.match ?? []).some((m) => action === m || action.startsWith(`${m} `)) &&
      (k.targetType ? k.targetType === target : !target),
  );
}

/** Shared tail: route, budget-check and hand to the queue. Returns false when the cap is reached. */
class Tick {
  readonly report: PollReport;
  private budget: number;

  constructor(maxWakes: number) {
    this.budget = Math.max(1, maxWakes);
    this.report = {
      at: new Date().toISOString(),
      ran: true,
      identities: [],
      projects: [],
      found: 0,
      woke: [],
      baselined: [],
      deferred: 0,
      skipped: [],
      errors: [],
    };
  }

  get exhausted(): boolean {
    return this.budget <= 0;
  }

  /**
   * Enqueue one wake. `false` means the cap stopped it — the caller must then leave the cursor
   * where it is, so the row is picked up by the next tick rather than lost.
   */
  wake(deliveryId: string, decision: WakeDecision): boolean {
    this.report.found += 1;
    if (!decision.agentId || !decision.agentName) {
      this.report.skipped.push(`${decision.kind} on ${decision.project}: ${decision.skipped ?? 'no agent matched'}`);
      return true;
    }
    if (this.exhausted) {
      this.report.deferred += 1;
      return false;
    }
    if (gitlabWakeQueue.isDuplicate(deliveryId)) return true;
    this.budget -= 1;
    gitlabWakeQueue.enqueue({
      ...decision,
      agentId: decision.agentId,
      agentName: decision.agentName,
      deliveryId,
    });
    this.report.woke.push({ agent: decision.agentName, kind: decision.kind, title: decision.title });
    return true;
  }
}

/**
 * Todos — GitLab's own per-account inbox.
 *
 * This is the source that justifies the whole feature. §11 gave every agent a real GitLab user, so
 * "who should act on this" is a question GitLab has already answered per account, and reading a
 * todo with that account's own token needs no name matched out of a comment body. Marking it done
 * is the acknowledgement, which is why this source cannot double-wake even across a restart.
 */
async function pollTodos(
  tick: Tick,
  kinds: PollEventKind[],
  identity: { key: string; label: string; conn: GitLabConnection; agentId?: string; agentName?: string },
  ours: Set<string>,
): Promise<void> {
  const stateKey = `todos:${identity.key}`;
  const todos = await request<Record<string, any>[]>('todos', {
    conn: identity.conn,
    paginate: 100,
    query: { state: 'pending' },
  });
  tick.report.identities.push(identity.label);

  const state = await gitlabPollStateRepository.get(stateKey);
  const highest = todos.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0);
  if (!state) {
    await gitlabPollStateRepository.set(stateKey, { cursorId: highest });
    tick.report.baselined.push(stateKey);
    return;
  }

  // Oldest first: a cursor that stops half way through has to leave a contiguous tail behind it.
  const fresh = todos
    .filter((t) => Number(t.id) > state.cursorId)
    .sort((a, b) => Number(a.id) - Number(b.id));

  let cursorId = state.cursorId;
  for (const todo of fresh) {
    const project = String(todo.project?.path_with_namespace ?? '');
    if (!inScope(identity.conn, project)) {
      cursorId = Number(todo.id);
      continue;
    }
    const kind = matchTodo(kinds, todo);
    if (!kind) {
      // A todo of a kind nobody armed is *consumed* rather than left pending, so arming that kind
      // later starts from then instead of replaying whatever has piled up in the meantime.
      cursorId = Number(todo.id);
      continue;
    }
    const author = String(todo.author?.username ?? '').toLowerCase();
    if (kind.id === 'mentioned' && ours.has(author)) {
      // The comment-answers-comment loop `FORUM_MENTION_LOOP_PLAN.md` documents, and the one kind
      // where it exists: an assignment or a review request does not regenerate itself, so those
      // wake whoever they name regardless of which account created them.
      cursorId = Number(todo.id);
      continue;
    }

    const title = String(todo.target?.title ?? todo.body ?? kind.label);
    const iid = todo.target?.iid;
    const marker = kind.targetType === 'MergeRequest' || String(todo.target_type) === 'MergeRequest' ? '!' : '#';
    const decision: WakeDecision = {
      kind: kind.id,
      family: kind.family,
      lead: leadForTodo(kind, project, iid ? `${marker}${iid} ${title}` : title, author),
      // An agent's own todo names its agent; the fleet account's todos route like a webhook did.
      ...(identity.agentId
        ? { agentId: identity.agentId, agentName: identity.agentName ?? '' }
        : await routed(project, String(todo.body ?? ''))),
      project,
      title: iid ? `${marker}${iid} ${title}` : title,
      url: String(todo.target_url ?? ''),
      body: String(todo.body ?? ''),
    } as WakeDecision;

    if (!tick.wake(`poll:todo:${todo.id}`, decision)) break;
    cursorId = Number(todo.id);
    // Best effort: the cursor above is what actually prevents a repeat. Marking done is for the
    // human looking at the same todo list, and a GitLab that refuses it must not fail the tick.
    await request(`todos/${todo.id}/mark_as_done`, { conn: identity.conn, method: 'POST' }).catch(
      (err) => log.debug({ todo: todo.id, err: String(err) }, 'could not mark the todo done'),
    );
  }

  if (cursorId !== state.cursorId) await gitlabPollStateRepository.set(stateKey, { cursorId });
}

function leadForTodo(kind: PollEventKind, project: string, target: string, author: string): string {
  const by = author ? ` (by @${author})` : '';
  switch (kind.id) {
    case 'issue_assigned':
      return `You have been assigned an issue on GitLab: **${target}** in \`${project}\`${by}.`;
    case 'mr_assigned':
      return `A merge request on GitLab has been assigned to you: **${target}** in \`${project}\`${by}. It is yours to land.`;
    case 'mr_review_requested':
      return `You have been asked to review a merge request on GitLab: **${target}** in \`${project}\`${by}.`;
    case 'mr_approval_required':
      return `Your approval is required on a merge request: **${target}** in \`${project}\`${by}.`;
    case 'mentioned':
      return `You were named on GitLab, on **${target}** in \`${project}\`${by}.`;
    case 'mr_build_failed':
      return `The pipeline of your merge request **${target}** in \`${project}\` failed.`;
    case 'mr_unmergeable':
      return `Your merge request **${target}** in \`${project}\` can no longer be merged — most likely it now conflicts with its target branch.`;
    default:
      return `${kind.label} — **${target}** in \`${project}\`${by}.`;
  }
}

/**
 * Project events — the state changes GitLab notifies nobody about.
 *
 * An MR being **merged** is the one the operator asked for by name, and it has no todo: GitLab
 * considers the matter closed, so unless somebody is watching the project nothing says the work
 * landed. Routing here is deliberately *only* by project row and then fleet default: the event
 * names nobody, and reading a name out of its title would be exactly the guess §5 refuses to make.
 */
async function pollEvents(
  tick: Tick,
  kinds: PollEventKind[],
  conn: GitLabConnection,
  project: PolledProject,
  ours: Set<string>,
): Promise<void> {
  const stateKey = `events:${project.path}`;
  const events = await request<Record<string, any>[]>(`projects/${project.id}/events`, {
    conn,
    query: { per_page: EVENTS_PER_PROJECT, sort: 'desc' },
  });

  const state = await gitlabPollStateRepository.get(stateKey);
  if (!state) {
    await gitlabPollStateRepository.set(stateKey, { cursor: new Date(), cursorIds: [] });
    tick.report.baselined.push(stateKey);
    return;
  }

  const since = state.cursor?.getTime() ?? 0;
  const fresh = events
    .filter((e) => {
      const at = new Date(e.created_at).getTime();
      if (at > since) return true;
      return at === since && !state.cursorIds.includes(String(e.id));
    })
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  let cursor = state.cursor ?? new Date(0);
  let cursorIds = state.cursorIds;
  for (const event of fresh) {
    const at = new Date(event.created_at);
    const author = String(event.author?.username ?? event.author_username ?? '').toLowerCase();
    const kind = matchEvent(kinds, event);
    const advance = () => {
      if (at.getTime() === cursor.getTime()) cursorIds = [...cursorIds, String(event.id)];
      else {
        cursor = at;
        cursorIds = [String(event.id)];
      }
    };

    // Our own footprint. Without this, an agent merging a merge request wakes an agent to go and
    // look at the merge — which then comments, which is another event.
    if (!kind || ours.has(author)) {
      advance();
      continue;
    }
    if (kind.id === 'pushed' && String(event.push_data?.ref ?? '') !== project.defaultBranch) {
      advance();
      continue;
    }

    const decision: WakeDecision = {
      kind: kind.id,
      family: kind.family,
      lead: leadForEvent(kind, project, event, author),
      ...(await routed(project.path)),
      project: project.path,
      title: eventTitle(kind, project, event),
      url: eventUrl(conn, project, event),
      body: '',
    } as WakeDecision;

    if (!tick.wake(`poll:event:${event.id}`, decision)) break;
    advance();
  }

  if (cursor.getTime() !== (state.cursor?.getTime() ?? 0) || cursorIds !== state.cursorIds) {
    await gitlabPollStateRepository.set(stateKey, { cursor, cursorIds });
  }
}

function eventTitle(kind: PollEventKind, project: PolledProject, event: Record<string, any>): string {
  if (kind.id === 'pushed') return `push to ${project.defaultBranch}`;
  const marker = String(event.target_type) === 'MergeRequest' ? '!' : '#';
  return `${marker}${event.target_iid ?? ''} ${String(event.target_title ?? '').slice(0, 120)}`.trim();
}

function eventUrl(conn: GitLabConnection, project: PolledProject, event: Record<string, any>): string {
  const base = `${conn.url}/${project.path}/-`;
  if (String(event.target_type) === 'MergeRequest') return `${base}/merge_requests/${event.target_iid}`;
  if (String(event.target_type) === 'Issue') return `${base}/issues/${event.target_iid}`;
  return `${base}/commits/${project.defaultBranch}`;
}

function leadForEvent(
  kind: PollEventKind,
  project: PolledProject,
  event: Record<string, any>,
  author: string,
): string {
  const by = author ? `@${author}` : 'someone';
  const target = eventTitle(kind, project, event);
  switch (kind.id) {
    case 'mr_merged':
      return `A merge request was merged on GitLab: **${target}** in \`${project.path}\`, by ${by}. Nobody was notified — you are being woken because this project is watched.`;
    case 'mr_opened':
      return `${by} opened a merge request on GitLab: **${target}** in \`${project.path}\`.`;
    case 'mr_closed':
      return `${by} closed a merge request **without merging it**: **${target}** in \`${project.path}\`.`;
    case 'issue_opened':
      return `${by} opened an issue on GitLab: **${target}** in \`${project.path}\`.`;
    case 'issue_closed':
      return `${by} closed an issue on GitLab: **${target}** in \`${project.path}\`.`;
    case 'pushed': {
      const commits = Number(event.push_data?.commit_count ?? 0);
      const latest = String(event.push_data?.commit_title ?? '').slice(0, 120);
      return `${by} pushed ${commits || 'some'} commit${commits === 1 ? '' : 's'} to \`${project.defaultBranch}\` in \`${project.path}\`${latest ? ` — latest: “${latest}”` : ''}.`;
    }
    default:
      return `${kind.label} in \`${project.path}\`.`;
  }
}

/**
 * A red default branch.
 *
 * GitLab's `build_failed` todo only ever reaches the merge request's own author, and nobody owns
 * `main` — so without this source the branch everything is cut from can sit broken indefinitely.
 * The pipeline is re-fetched by id and its failed jobs listed, because §12 settled that a brief
 * saying only "it is red" sends the agent guessing pipeline ids.
 */
async function pollPipelines(
  tick: Tick,
  conn: GitLabConnection,
  project: PolledProject,
  kind: PollEventKind,
): Promise<void> {
  const stateKey = `pipelines:${project.path}`;
  const pipelines = await request<Record<string, any>[]>(`projects/${project.id}/pipelines`, {
    conn,
    query: { ref: project.defaultBranch, status: 'failed', order_by: 'updated_at', per_page: 5 },
  });

  const state = await gitlabPollStateRepository.get(stateKey);
  const newest = pipelines.reduce(
    (max, p) => Math.max(max, new Date(p.created_at).getTime()),
    0,
  );
  if (!state) {
    await gitlabPollStateRepository.set(stateKey, { cursor: new Date(newest || Date.now()), cursorIds: [] });
    tick.report.baselined.push(stateKey);
    return;
  }

  const since = state.cursor?.getTime() ?? 0;
  const fresh = pipelines
    .filter((p) => new Date(p.created_at).getTime() > since)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  // Only the newest failure matters: three red pipelines in a row are one broken branch, and waking
  // an agent per push would bury the first (correct) investigation under two duplicates.
  const head = fresh[fresh.length - 1];
  if (!head) return;

  let detail = '';
  try {
    const full = await request<Record<string, any>>(`projects/${project.id}/pipelines/${head.id}`, { conn });
    if (full.yaml_errors) {
      detail =
        `It produced **no jobs at all**: the CI config is invalid — \`${full.yaml_errors}\`. There ` +
        'is no job log to read. The fix is in `.gitlab-ci.yml`; validate any correction with ' +
        '`gitlab_ci({action:"lint"})` before committing it.';
    }
  } catch {
    /* the listing's fields are enough to report that it is red */
  }
  if (!detail) {
    try {
      const jobs = await request<Record<string, any>[]>(`projects/${project.id}/pipelines/${head.id}/jobs`, {
        conn,
        query: { scope: 'failed', per_page: 20 },
      });
      if (jobs.length) {
        detail = ['Failed jobs:', ...jobs.map((j) => `- ${j.name} — \`job_id: ${j.id}\``)].join('\n');
      }
    } catch {
      /* a project with restricted CI still reports the pipeline itself */
    }
  }

  const decision: WakeDecision = {
    kind: kind.id,
    family: kind.family,
    lead:
      `The default branch of \`${project.path}\` is red: pipeline **${head.id}** on ` +
      `\`${project.defaultBranch}\` failed (commit \`${String(head.sha ?? '').slice(0, 8)}\`).`,
    ...(await routed(project.path)),
    project: project.path,
    title: `pipeline ${head.id} failed on ${project.defaultBranch}`,
    url: String(head.web_url ?? ''),
    body: detail,
  } as WakeDecision;

  if (tick.wake(`poll:pipeline:${head.id}`, decision)) {
    await gitlabPollStateRepository.set(stateKey, {
      cursor: new Date(head.created_at),
      cursorIds: [String(head.id)],
    });
  }
}

/**
 * One tick.
 *
 * Never throws: it is called by an Agenda job every few minutes and by a button, and a GitLab that
 * is down for an hour must produce a report saying so rather than a failed job every five minutes.
 */
export async function pollOnce(opts: { force?: boolean } = {}): Promise<PollReport> {
  const settings = await settingsService.get();
  const tick = new Tick(settings.gitlab_poll_max_wakes);

  const off = (reason: string): PollReport => ({ ...tick.report, ran: false, reason });
  if (!settings.gitlab_poll_enabled && !opts.force) return off('polling is switched off');
  if (!(await isConfigured())) return off('GitLab is not configured on this instance');

  const armed = settings.gitlab_poll_events ?? [];
  const todoKinds = armedKinds(armed, 'todo');
  const eventKinds = armedKinds(armed, 'event');
  const pipelineKind = armedKinds(armed, 'pipeline')[0];
  if (!todoKinds.length && !eventKinds.length && !pipelineKind) {
    return off('no event is armed — tick the ones that should wake an agent');
  }

  let conn: GitLabConnection;
  try {
    conn = await connection();
  } catch (err) {
    return off(err instanceof GitLabError ? err.message : String(err));
  }
  const ours = await ourUsernames(conn);

  if (todoKinds.length) {
    for (const identity of await identities(conn)) {
      if (tick.exhausted) break;
      try {
        await pollTodos(tick, todoKinds, identity, ours);
      } catch (err) {
        tick.report.errors.push(`todos for ${identity.label}: ${errorText(err)}`);
      }
    }
  }

  if (eventKinds.length || pipelineKind) {
    let projects: PolledProject[] = [];
    try {
      projects = await pollProjects(conn, settings.gitlab_poll_projects ?? []);
    } catch (err) {
      tick.report.errors.push(`projects: ${errorText(err)}`);
    }
    for (const project of projects) {
      if (tick.exhausted) break;
      tick.report.projects.push(project.path);
      if (eventKinds.length) {
        try {
          await pollEvents(tick, eventKinds, conn, project, ours);
        } catch (err) {
          tick.report.errors.push(`events for ${project.path}: ${errorText(err)}`);
        }
      }
      if (pipelineKind && !tick.exhausted) {
        try {
          await pollPipelines(tick, conn, project, pipelineKind);
        } catch (err) {
          tick.report.errors.push(`pipelines for ${project.path}: ${errorText(err)}`);
        }
      }
    }
  }

  lastReport = tick.report;
  log.info(
    {
      found: tick.report.found,
      woke: tick.report.woke.length,
      deferred: tick.report.deferred,
      errors: tick.report.errors.length,
    },
    'gitlab poll tick',
  );
  return tick.report;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The last tick's report, for the settings page. In memory — it is a diagnostic, not a record. */
let lastReport: PollReport | null = null;

export function lastPollReport(): PollReport | null {
  return lastReport;
}

/** Forget every cursor: the next tick re-baselines and wakes nobody. */
export async function rebaseline(): Promise<void> {
  await gitlabPollStateRepository.clear();
  projectCache.clear();
  log.info('gitlab poll cursors cleared — the next tick baselines');
}
