import { createLogger } from '../../config/logger';
import { agentRepository } from '../agents/agent.repository';
import { settingsService } from '../settings/settings.service';
import { gitlabProvision } from './gitlab-provision.service';
import { armedKinds, type PollEventKind, type PollSource } from './gitlab-poll.catalogue';
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
  /**
   * What was read and matched *nothing* armed, counted by shape.
   *
   * The whole reason this field exists: a to-do of an unrecognised shape is consumed by the cursor
   * like any other, so before this a matcher that had gone stale against GitLab's own vocabulary
   * was indistinguishable from a quiet week (§15). "Seen 4 · assigned/WorkItem" is the line that
   * would have found that bug in a minute.
   */
  unmatched: { source: PollSource; action: string; target_type: string; count: number }[];
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

/**
 * What GitLab calls the thing an event or a to-do points at, reduced to what we branch on.
 *
 * **This is the bug of 2026-09-21** (`GITLAB_PLAN.md` §15). GitLab 19 migrated issues onto the work
 * item model, and a to-do or an event about an issue now arrives with `target_type: "WorkItem"` —
 * GitLab's own tracker carries it as a defect (gitlab-org/gitlab#374954, "TODOs APIs failing when
 * todo's target_type is WorkItem"), because the REST API never gained a WorkItem entity to match.
 * An integration that compares against `"Issue"` sees nothing, which is precisely what happened
 * here: an issue assigned to an agent produced a to-do the poller skipped and an event it skipped,
 * and the tick reported `found: 0` with no error.
 *
 * `Task`, `Incident`, `Objective` and `KeyResult` are work item types too, and every one of them is
 * an issue as far as anything in this codebase is concerned — they live at `/issues/:iid` in the
 * REST API and are addressed by the same `iid`. Normalising rather than enumerating is deliberate:
 * the next type GitLab adds should not need a release here.
 */
function targetKind(raw: unknown): 'Issue' | 'MergeRequest' | '' {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value === 'MergeRequest') return 'MergeRequest';
  // Everything else issue-shaped: Issue, WorkItem, Task, Incident, TestCase…
  return 'Issue';
}

function matchTodo(kinds: PollEventKind[], todo: Record<string, any>): PollEventKind | undefined {
  const action = String(todo.action_name ?? '');
  const target = targetKind(todo.target_type);
  return kinds.find(
    (k) => (k.match ?? []).includes(action) && (!k.targetType || k.targetType === target),
  );
}

function matchEvent(kinds: PollEventKind[], event: Record<string, any>): PollEventKind | undefined {
  const action = String(event.action_name ?? '');
  const target = targetKind(event.target_type);
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
      unmatched: [],
      errors: [],
    };
  }

  get exhausted(): boolean {
    return this.budget <= 0;
  }

  /** Record a row nothing armed recognised, aggregated by shape rather than listed one by one. */
  unmatched(source: PollSource, action: unknown, targetType: unknown): void {
    const act = String(action ?? '(none)');
    const type = String(targetType ?? '(none)');
    const row = this.report.unmatched.find(
      (u) => u.source === source && u.action === act && u.target_type === type,
    );
    if (row) row.count += 1;
    else this.report.unmatched.push({ source, action: act, target_type: type, count: 1 });
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
    gitlabWakeQueue.enqueue(
      {
        ...decision,
        agentId: decision.agentId,
        agentName: decision.agentName,
        deliveryId,
      },
      'poll',
    );
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
      // later starts from then instead of replaying whatever has piled up in the meantime. It is
      // counted first: consuming it silently is how a stale matcher hid for a day (§15), and
      // "Catch up" is what replays the pending ones once the matcher is fixed.
      tick.unmatched('todo', todo.action_name, todo.target_type);
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
    // A build failure or a conflict is the one case where the to-do's own body (the merge request's
    // title) tells the agent nothing it can act on, so the state is fetched and quoted instead.
    const detailKind =
      kind.family === 'build' ? 'build' : kind.family === 'conflict' ? 'conflict' : null;
    const detail =
      detailKind && Number.isFinite(Number(iid)) && Number.isFinite(Number(todo.project?.id))
        ? await mrFailureDetail(identity.conn, Number(todo.project.id), Number(iid), detailKind)
        : { text: '', pipelineId: null };
    const marker =
      kind.targetType === 'MergeRequest' || targetKind(todo.target_type) === 'MergeRequest' ? '!' : '#';
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
      body: detail.text || String(todo.body ?? ''),
    } as WakeDecision;

    // Keyed on the *pipeline* when there is one, so that arming both this and `mr_pipeline_failed`
    // — the to-do GitLab may raise and the watch that does not depend on it — cannot wake an agent
    // twice for one red build.
    const deliveryId = detail.pipelineId
      ? `poll:mr-pipeline:${detail.pipelineId}`
      : `poll:todo:${todo.id}`;
    if (!tick.wake(deliveryId, decision)) break;
    cursorId = Number(todo.id);
    // Best effort: the cursor above is what actually prevents a repeat. Marking done is for the
    // human looking at the same todo list, and a GitLab that refuses it must not fail the tick.
    await request(`todos/${todo.id}/mark_as_done`, { conn: identity.conn, method: 'POST' }).catch(
      (err) => log.debug({ todo: todo.id, err: String(err) }, 'could not mark the todo done'),
    );
  }

  if (cursorId !== state.cursorId) await gitlabPollStateRepository.set(stateKey, { cursorId });
}

/**
 * What actually broke, fetched at wake time (`GITLAB_PLAN.md` §16).
 *
 * A `build_failed` to-do says "the pipeline of your merge request failed" and carries the merge
 * request's *title* as its body — no pipeline id, no job id, no error. §12 already settled what an
 * agent does with that: it guesses pipeline ids, 404s, and walks the id space looking for a log.
 * The fix there was to put the ids in the brief, and this is the same fix on the path that was
 * added later and did not inherit it.
 *
 * Three calls, only when a build-failure wake is about to be spent anyway, and every one of them is
 * a call the agent would otherwise have to make from a worse starting point.
 */
async function mrFailureDetail(
  conn: GitLabConnection,
  projectId: number,
  iid: number,
  kind: 'build' | 'conflict',
): Promise<{ text: string; pipelineId: number | null }> {
  const mr = await request<Record<string, any>>(`projects/${projectId}/merge_requests/${iid}`, {
    conn,
  }).catch(() => null);
  if (!mr) return { text: '', pipelineId: null };

  if (kind === 'conflict') {
    const status = String(mr.detailed_merge_status ?? mr.merge_status ?? 'unknown');
    return {
      text: [
        `\`${mr.source_branch}\` → \`${mr.target_branch}\`, merge status \`${status}\`` +
          (mr.has_conflicts ? ' — GitLab reports real conflicts with the target branch.' : '.'),
        '',
        'The target branch has moved since this branch was cut; what has to be reconciled is whatever ' +
          'landed on it in the meantime.',
      ].join('\n'),
      pipelineId: null,
    };
  }

  const pipelineId = Number(mr.head_pipeline?.id);
  if (!Number.isFinite(pipelineId)) {
    return {
      text: `\`${mr.source_branch}\` → \`${mr.target_branch}\`. GitLab reports no pipeline on the head commit, so the failure is on an earlier one — list them with \`gitlab_ci({action:"pipelines", ref:"${mr.source_branch}"})\`.`,
      pipelineId: null,
    };
  }

  const [full, jobs] = await Promise.all([
    request<Record<string, any>>(`projects/${projectId}/pipelines/${pipelineId}`, { conn }).catch(
      () => null,
    ),
    request<Record<string, any>[]>(`projects/${projectId}/pipelines/${pipelineId}/jobs`, {
      conn,
      query: { scope: 'failed', per_page: 20 },
    }).catch(() => [] as Record<string, any>[]),
  ]);

  const lines = [
    `\`${mr.source_branch}\` → \`${mr.target_branch}\`. Pipeline **${pipelineId}** on commit ` +
      `\`${String(mr.sha ?? '').slice(0, 8)}\` failed.`,
  ];

  if (full?.yaml_errors) {
    // The case with no job and no log at all. Naming a log to read here is what sent an agent
    // guessing pipeline ids in production (§12).
    lines.push(
      '',
      `It produced **no jobs at all**: the CI config is invalid — \`${full.yaml_errors}\`.`,
      'There is no job log to read. The fix is in `.gitlab-ci.yml`, and `gitlab_ci({action:"lint"})` ' +
        'validates a correction before it is committed.',
    );
  } else if (jobs.length) {
    lines.push(
      '',
      'Failed jobs — read one before you conclude anything, because a runner timeout and a broken ' +
        'build look identical from here:',
      ...jobs.map(
        (j) =>
          `- **${j.name}** (${j.stage}) — \`job_id: ${j.id}\`` +
          (j.failure_reason ? `, failure_reason \`${j.failure_reason}\`` : ''),
      ),
    );
  } else {
    lines.push(
      '',
      'It produced **no failed jobs**, and GitLab reports no config error — so either nothing ' +
        `matched this ref or no runner picked it up. \`gitlab_ci({action:"pipeline", pipeline_id: ${pipelineId}})\` has the detail.`,
    );
  }
  return { text: lines.join('\n'), pipelineId };
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
      // Only an unrecognised shape is worth reporting; a merge *we* performed is working as
      // intended and would otherwise bury the signal under our own activity.
      if (!kind && !ours.has(author)) tick.unmatched('event', event.action_name, event.target_type);
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
  const marker = targetKind(event.target_type) === 'MergeRequest' ? '!' : '#';
  return `${marker}${event.target_iid ?? ''} ${String(event.target_title ?? '').slice(0, 120)}`.trim();
}

function eventUrl(conn: GitLabConnection, project: PolledProject, event: Record<string, any>): string {
  const base = `${conn.url}/${project.path}/-`;
  const kind = targetKind(event.target_type);
  if (kind === 'MergeRequest') return `${base}/merge_requests/${event.target_iid}`;
  // `/-/issues/:iid` still resolves in GitLab 19 — it is the same object the UI now shows at
  // `/-/work_items/:iid`, and the redirect is GitLab's own.
  if (kind === 'Issue' && event.target_iid) return `${base}/issues/${event.target_iid}`;
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
 * A merge request whose pipeline is red, found by **watching** rather than by being told (§16.4).
 *
 * `mr_build_failed` depends on GitLab raising a `build_failed` to-do, and GitLab does not raise one
 * for every shape of failure — a branch pipeline that is not the merge request's own event
 * pipeline, a author who is not the one GitLab notifies, a project where the feature is off. This
 * path asks the question directly instead: which recent pipelines failed, and is the branch one of
 * them belongs to the source branch of an open merge request?
 *
 * Two calls per project, and it wakes the merge request's **own author** when that author is one of
 * our agents — which is the point of the feature ("so the agent can repair the pipeline of his
 * MR") — falling back to the project's routing row when the author is a human.
 *
 * De-duplicated with the to-do path on the pipeline id, so arming both is safe.
 */
async function pollMrPipelines(
  tick: Tick,
  conn: GitLabConnection,
  project: PolledProject,
  kind: PollEventKind,
): Promise<void> {
  const stateKey = `mr-pipelines:${project.path}`;
  const [failed, open] = await Promise.all([
    request<Record<string, any>[]>(`projects/${project.id}/pipelines`, {
      conn,
      query: { status: 'failed', order_by: 'id', sort: 'desc', per_page: 20 },
    }),
    request<Record<string, any>[]>(`projects/${project.id}/merge_requests`, {
      conn,
      paginate: 50,
      query: { state: 'opened', order_by: 'updated_at' },
    }),
  ]);

  const state = await gitlabPollStateRepository.get(stateKey);
  const newest = failed.reduce((max, p) => Math.max(max, Number(p.id) || 0), 0);
  if (!state) {
    await gitlabPollStateRepository.set(stateKey, { cursorId: newest });
    tick.report.baselined.push(stateKey);
    return;
  }

  // Branch → the open merge request it belongs to. The default branch is deliberately absent: a red
  // `main` is `pipeline_failed`'s job, and it has a different brief because nobody owns it.
  const byBranch = new Map<string, Record<string, any>>();
  for (const mr of open) {
    if (String(mr.source_branch) !== project.defaultBranch) byBranch.set(String(mr.source_branch), mr);
  }

  const agents = await agentRepository.list();
  let cursorId = state.cursorId;
  for (const pipeline of failed.filter((p) => Number(p.id) > state.cursorId).sort((a, b) => a.id - b.id)) {
    const mr = byBranch.get(String(pipeline.ref));
    if (!mr) {
      cursorId = Number(pipeline.id);
      continue;
    }
    const author = String(mr.author?.username ?? '').toLowerCase();
    // The author's *own* agent, because this is their branch to fix. `ours` is not an exclusion
    // here the way it is for events — quite the opposite, it is how the right agent is found.
    const owner = agents.find((a) => a.gitlab_username && a.gitlab_username.toLowerCase() === author);
    const detail = await mrFailureDetail(conn, project.id, Number(mr.iid), 'build');
    const target = owner
      ? { agentId: String(owner._id), agentName: owner.name }
      : await routed(project.path);

    const decision: WakeDecision = {
      kind: kind.id,
      family: 'build',
      lead:
        `The pipeline of merge request **!${mr.iid} ${mr.title}** in \`${project.path}\` failed` +
        (owner ? ' — it is yours.' : ` (opened by @${author || 'someone'}).`),
      ...target,
      project: project.path,
      title: `!${mr.iid} ${mr.title}`,
      url: String(mr.web_url ?? ''),
      body: detail.text,
    } as WakeDecision;

    if (!tick.wake(`poll:mr-pipeline:${detail.pipelineId ?? pipeline.id}`, decision)) break;
    cursorId = Number(pipeline.id);
  }

  if (cursorId !== state.cursorId) await gitlabPollStateRepository.set(stateKey, { cursorId });
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
  const pipelineKinds = armedKinds(armed, 'pipeline');
  const defaultBranchKind = pipelineKinds.find((k) => k.id === 'pipeline_failed');
  const mrPipelineKind = pipelineKinds.find((k) => k.id === 'mr_pipeline_failed');
  if (!todoKinds.length && !eventKinds.length && !pipelineKinds.length) {
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

  if (eventKinds.length || pipelineKinds.length) {
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
      if (defaultBranchKind && !tick.exhausted) {
        try {
          await pollPipelines(tick, conn, project, defaultBranchKind);
        } catch (err) {
          tick.report.errors.push(`pipelines for ${project.path}: ${errorText(err)}`);
        }
      }
      if (mrPipelineKind && !tick.exhausted) {
        try {
          await pollMrPipelines(tick, conn, project, mrPipelineKind);
        } catch (err) {
          tick.report.errors.push(`merge-request pipelines for ${project.path}: ${errorText(err)}`);
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

/**
 * What GitLab is actually sending — the read-only answer to "the poller sees nothing" (§15).
 *
 * Without it that sentence is unfalsifiable from outside the box: the tick reports what it matched,
 * and a matcher that has gone stale against GitLab's own vocabulary matches nothing and looks
 * exactly like a quiet instance. This returns the raw shapes — never a body, never a token — so an
 * operator (or a read-only API key) can see `assigned/WorkItem` sitting in the list and know within
 * a minute which side is wrong.
 */
export async function inspect(): Promise<{
  configured: boolean;
  reason?: string;
  armed: string[];
  identities: {
    account: string;
    agent: string | null;
    error?: string;
    pending: {
      id: number;
      action_name: string;
      target_type: string;
      project: string;
      iid: number | null;
      from: string;
      /** Whether an armed kind recognises it — the whole point of the page. */
      matches: string | null;
    }[];
  }[];
  projects: {
    project: string;
    error?: string;
    events: { action_name: string; target_type: string; author: string; at: string; matches: string | null }[];
  }[];
}> {
  const settings = await settingsService.get();
  const armed = settings.gitlab_poll_events ?? [];
  if (!(await isConfigured())) {
    return { configured: false, reason: 'GitLab is not configured on this instance', armed, identities: [], projects: [] };
  }
  const conn = await connection();
  const todoKinds = armedKinds(armed, 'todo');
  const eventKinds = armedKinds(armed, 'event');

  const identityRows = [];
  for (const identity of await identities(conn)) {
    try {
      const todos = await request<Record<string, any>[]>('todos', {
        conn: identity.conn,
        paginate: 50,
        query: { state: 'pending' },
      });
      identityRows.push({
        account: identity.label,
        agent: identity.agentName ?? null,
        pending: todos.map((t) => ({
          id: Number(t.id),
          action_name: String(t.action_name ?? ''),
          target_type: String(t.target_type ?? ''),
          project: String(t.project?.path_with_namespace ?? ''),
          iid: t.target?.iid ?? null,
          from: String(t.author?.username ?? ''),
          matches: matchTodo(todoKinds, t)?.id ?? null,
        })),
      });
    } catch (err) {
      identityRows.push({ account: identity.label, agent: identity.agentName ?? null, error: errorText(err), pending: [] });
    }
  }

  const projectRows = [];
  for (const project of await pollProjects(conn, settings.gitlab_poll_projects ?? []).catch(() => [])) {
    try {
      const events = await request<Record<string, any>[]>(`projects/${project.id}/events`, {
        conn,
        query: { per_page: 20, sort: 'desc' },
      });
      projectRows.push({
        project: project.path,
        events: events.map((e) => ({
          action_name: String(e.action_name ?? ''),
          target_type: String(e.target_type ?? ''),
          author: String(e.author?.username ?? e.author_username ?? ''),
          at: String(e.created_at ?? ''),
          matches: matchEvent(eventKinds, e)?.id ?? null,
        })),
      });
    } catch (err) {
      projectRows.push({ project: project.path, error: errorText(err), events: [] });
    }
  }

  return { configured: true, armed, identities: identityRows, projects: projectRows };
}

/**
 * Reconsider every to-do still pending, without replaying event history.
 *
 * The repair for a matcher that was wrong: the to-dos it skipped were consumed by the cursor, but
 * GitLab still holds them as *pending* — that is the definition of the backlog, since anything the
 * poller acted on was marked done. Rewinding only the to-do cursors replays exactly the unacted
 * ones, and the per-tick cap keeps that from becoming a stampede. Event and pipeline cursors are
 * left alone: they have no "pending" and rewinding them would replay a year of activity, which is
 * the mistake baselining exists to prevent.
 */
export async function catchUpTodos(): Promise<void> {
  await gitlabPollStateRepository.rewindTodos();
  log.info('gitlab poll todo cursors rewound — the next tick reconsiders every pending to-do');
}

/** Forget every cursor: the next tick re-baselines and wakes nobody. */
export async function rebaseline(): Promise<void> {
  await gitlabPollStateRepository.clear();
  projectCache.clear();
  log.info('gitlab poll cursors cleared — the next tick baselines');
}
