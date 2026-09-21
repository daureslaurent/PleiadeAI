import crypto from 'node:crypto';
import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { gitlabActivityRepository } from '../../../domain/gitlab/gitlab-activity.repository';
import { gitlabWakeQueue, startGitlabTurn } from '../../../domain/gitlab/gitlab-wake-runner';
import { POLL_EVENT_KINDS } from '../../../domain/gitlab/gitlab-poll.catalogue';
import {
  catchUpTodos,
  inspect,
  lastPollReport,
  pollOnce,
  rebaseline,
} from '../../../domain/gitlab/gitlab-poll.service';
import { syncGitlabPoll } from '../../../autonomy/agenda.setup';
import { checkBrief, checkProject } from '../../../domain/gitlab/gitlab-review.service';
import { agentRepository } from '../../../domain/agents/agent.repository';
import { ACCESS_LEVELS, gitlabProvision } from '../../../domain/gitlab/gitlab-provision.service';
import { decide, verifySecret } from '../../../domain/gitlab/gitlab-webhook.service';
import {
  GitLabError,
  connection,
  request,
  scopedPath,
  slimIssue,
  slimMergeRequest,
  slimPipeline,
  slimProject,
} from '../../../domain/gitlab/gitlab.service';
import {
  GITLAB_DELETE_ACTIONS,
  GITLAB_GIT_TRANSPORTS,
  settingsService,
  type GitLabDeleteAction,
  type GitLabGitTransport,
} from '../../../domain/settings/settings.service';

const log = createLogger('gitlab-routes');

/**
 * GitLab for the operator (`GITLAB_PLAN.md` §6) and for GitLab itself (§5).
 *
 * Two routers, for the same reason the mail routes are two: the webhook is an inbound POST *from
 * GitLab*, which cannot carry a session JWT. It is mounted without `requireAuth` and guarded
 * instead by the shared secret in `X-Gitlab-Token`, compared in constant time.
 *
 * Every read here proxies through the backend rather than letting the browser talk to GitLab, so
 * the token stays where the inference credentials stay: on the server.
 */
export const gitlabRouter = Router();

function fail(res: import('express').Response, err: unknown): void {
  if (err instanceof GitLabError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 400).json({ error: err.message });
    return;
  }
  throw err;
}

/** The connection as the settings page renders it — never the token itself. */
gitlabRouter.get('/connection', async (_req, res) => {
  const s = await settingsService.get();
  res.json({
    url: s.gitlab_url,
    group: s.gitlab_group,
    bot_username: s.gitlab_bot_username,
    default_agent_id: s.gitlab_default_agent_id,
    project_agents: s.gitlab_project_agents,
    wake_issues: s.gitlab_wake_issues,
    wake_reviews: s.gitlab_wake_reviews,
    poll_enabled: s.gitlab_poll_enabled,
    poll_interval_minutes: s.gitlab_poll_interval_minutes,
    poll_events: s.gitlab_poll_events,
    poll_projects: s.gitlab_poll_projects,
    poll_max_wakes: s.gitlab_poll_max_wakes,
    git_transport: s.gitlab_git_transport,
    ssh_host: s.gitlab_ssh_host,
    ssh_port: s.gitlab_ssh_port,
    stale_days: s.gitlab_stale_days,
    auto_provision: s.gitlab_auto_provision,
    member_access_level: s.gitlab_member_access_level,
    on_agent_delete: s.gitlab_on_agent_delete,
    user_email_domain: s.gitlab_user_email_domain,
    admin_token_set: s.gitlab_admin_token_set,
    token_set: s.gitlab_token_set,
    ssh_key_set: s.gitlab_ssh_key_set,
    webhook_secret_set: s.gitlab_webhook_secret_set,
  });
});

/**
 * Save the connection. The three secrets travel as plaintext fields *on the way in only* and are
 * encrypted before they land; an absent field leaves the stored secret alone, so the page can
 * render "configured" without ever holding the value, and `''` clears it.
 */
gitlabRouter.put('/connection', async (req, res) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof b.url === 'string') patch.gitlab_url = b.url.trim().replace(/\/+$/, '');
  if (typeof b.group === 'string') patch.gitlab_group = b.group.trim().replace(/^\/+|\/+$/g, '');
  if (typeof b.bot_username === 'string') patch.gitlab_bot_username = b.bot_username.trim().replace(/^@/, '');
  if (typeof b.default_agent_id === 'string') patch.gitlab_default_agent_id = b.default_agent_id;
  if (Array.isArray(b.project_agents)) {
    patch.gitlab_project_agents = b.project_agents
      .filter((r: any) => r && typeof r.project === 'string' && typeof r.agent_id === 'string')
      .map((r: any) => ({ project: r.project.trim(), agent_id: r.agent_id }))
      .filter((r: any) => r.project && r.agent_id);
  }
  if (b.wake_issues !== undefined) patch.gitlab_wake_issues = Boolean(b.wake_issues);
  if (b.wake_reviews !== undefined) patch.gitlab_wake_reviews = Boolean(b.wake_reviews);
  if (b.poll_enabled !== undefined) patch.gitlab_poll_enabled = Boolean(b.poll_enabled);
  if (b.poll_interval_minutes !== undefined) {
    patch.gitlab_poll_interval_minutes = Math.max(1, Math.min(1440, Number(b.poll_interval_minutes) || 5));
  }
  if (Array.isArray(b.poll_events)) {
    // Only catalogue ids land: an unknown id would be a checkbox that silently matches nothing, and
    // the catalogue is the one place a kind is declared (`GITLAB_PLAN.md` §13.2).
    const known = new Set(POLL_EVENT_KINDS.map((k) => k.id));
    patch.gitlab_poll_events = [...new Set(b.poll_events.filter((id: unknown) => known.has(String(id))))];
  }
  if (Array.isArray(b.poll_projects)) {
    patch.gitlab_poll_projects = b.poll_projects
      .map((p: unknown) => String(p ?? '').trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
  }
  if (b.poll_max_wakes !== undefined) {
    patch.gitlab_poll_max_wakes = Math.max(1, Math.min(50, Number(b.poll_max_wakes) || 5));
  }
  if (GITLAB_GIT_TRANSPORTS.includes(b.git_transport as GitLabGitTransport)) {
    patch.gitlab_git_transport = b.git_transport;
  }
  if (typeof b.ssh_host === 'string') patch.gitlab_ssh_host = b.ssh_host.trim();
  if (b.ssh_port !== undefined) patch.gitlab_ssh_port = Math.max(1, Number(b.ssh_port) || 22);
  if (b.stale_days !== undefined) patch.gitlab_stale_days = Math.max(1, Number(b.stale_days) || 3);
  if (b.auto_provision !== undefined) patch.gitlab_auto_provision = Boolean(b.auto_provision);
  if (b.member_access_level !== undefined) {
    const level = Number(b.member_access_level);
    if (ACCESS_LEVELS[level]) patch.gitlab_member_access_level = level;
  }
  if (GITLAB_DELETE_ACTIONS.includes(b.on_agent_delete as GitLabDeleteAction)) {
    patch.gitlab_on_agent_delete = b.on_agent_delete;
  }
  if (typeof b.user_email_domain === 'string') {
    patch.gitlab_user_email_domain = b.user_email_domain.trim().replace(/^@/, '');
  }
  await settingsService.update(patch as never);

  if (typeof b.token === 'string') await settingsService.setGitlabSecret('token', b.token.trim());
  if (typeof b.admin_token === 'string') {
    await settingsService.setGitlabSecret('adminToken', b.admin_token.trim());
  }
  if (typeof b.ssh_key === 'string') await settingsService.setGitlabSecret('sshKey', b.ssh_key);
  if (typeof b.webhook_secret === 'string') {
    await settingsService.setGitlabSecret('webhookSecret', b.webhook_secret.trim());
  }
  // The clock has to match the switch the operator just flipped, without a restart — the same
  // re-registration a conversation generator does on save.
  await syncGitlabPoll().catch((err) => log.warn({ err: String(err) }, 'could not reschedule the gitlab poll'));
  const s = await settingsService.get();
  res.json({
    ok: true,
    token_set: s.gitlab_token_set,
    webhook_secret_set: s.gitlab_webhook_secret_set,
    admin_token_set: s.gitlab_admin_token_set,
  });
});

/** Mint a webhook secret. Returned once, in this response, and stored encrypted. */
gitlabRouter.post('/webhook-secret', async (_req, res) => {
  const secret = crypto.randomBytes(24).toString('base64url');
  await settingsService.setGitlabSecret('webhookSecret', secret);
  res.json({ secret });
});

/** Does the token work, and who is it? The settings page's Test button. */
gitlabRouter.post('/test', async (_req, res) => {
  try {
    const conn = await connection();
    const user = await request<Record<string, any>>('user', { conn });
    const projects = await request<Record<string, any>[]>(
      scopedPath(conn, 'projects', 'projects'),
      { conn, paginate: 1, query: { membership: conn.group ? undefined : true } },
    );
    res.json({
      ok: true,
      user: { username: user.username, name: user.name, id: user.id },
      group: conn.group || null,
      reachable_projects: projects.length > 0,
      // The bot account's own name is what the webhook router compares assignees against, so the
      // page can offer to fill it in rather than making the operator type it twice.
      suggested_bot_username: user.username,
    });
  } catch (err) {
    if (err instanceof GitLabError) {
      res.status(200).json({ ok: false, error: err.message });
      return;
    }
    throw err;
  }
});

/** Projects overview tab. */
gitlabRouter.get('/projects', async (req, res) => {
  try {
    const conn = await connection();
    const rows = await request<Record<string, any>[]>(scopedPath(conn, 'projects', 'projects'), {
      conn,
      paginate: Math.min(100, Number(req.query.limit) || 50),
      query: {
        search: req.query.search,
        order_by: 'last_activity_at',
        membership: conn.group ? undefined : true,
        include_subgroups: conn.group ? true : undefined,
      },
    });
    // The default branch's latest pipeline is what the status dot needs, and it is one call per
    // project — capped, because the overview must not fan out fifty requests on a slow instance.
    const withStatus = await Promise.all(
      rows.slice(0, 30).map(async (p) => {
        let pipeline: Record<string, unknown> | null = null;
        try {
          const pipes = await request<Record<string, any>[]>(`projects/${p.id}/pipelines`, {
            conn,
            query: { ref: p.default_branch, per_page: 1 },
          });
          pipeline = pipes[0] ? slimPipeline(pipes[0]) : null;
        } catch {
          // A project with CI disabled 403s here; that is not an error about the project.
        }
        return { ...slimProject(p), pipeline };
      }),
    );
    res.json([...withStatus, ...rows.slice(30).map((p) => ({ ...slimProject(p), pipeline: null }))]);
  } catch (err) {
    fail(res, err);
  }
});

/** Issue board tab — across every project unless one is named. */
gitlabRouter.get('/issues', async (req, res) => {
  try {
    const conn = await connection();
    const rows = await request<Record<string, any>[]>(scopedPath(conn, 'issues', 'issues'), {
      conn,
      paginate: Math.min(200, Number(req.query.limit) || 100),
      query: {
        state: req.query.state === 'all' ? undefined : (req.query.state ?? 'opened'),
        scope: 'all',
        order_by: 'updated_at',
      },
    });
    res.json(rows.map((i) => ({ ...slimIssue(i), project: i.references?.full?.split('#')[0] ?? '' })));
  } catch (err) {
    fail(res, err);
  }
});

/** Merge requests, for the issues tab's companion column. */
gitlabRouter.get('/merge-requests', async (req, res) => {
  try {
    const conn = await connection();
    const rows = await request<Record<string, any>[]>(
      scopedPath(conn, 'merge_requests', 'merge_requests'),
      {
        conn,
        paginate: Math.min(200, Number(req.query.limit) || 50),
        query: { state: req.query.state ?? 'opened', scope: 'all', order_by: 'updated_at' },
      },
    );
    res.json(rows.map((m) => ({ ...slimMergeRequest(m), project: m.references?.full?.split('!')[0] ?? '' })));
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Pipelines tab. GitLab has no instance-wide pipeline listing, so this fans out over the most
 * recently active projects — which is also the only order in which the answer is useful.
 */
gitlabRouter.get('/pipelines', async (req, res) => {
  try {
    const conn = await connection();
    const projects = await request<Record<string, any>[]>(scopedPath(conn, 'projects', 'projects'), {
      conn,
      paginate: 12,
      query: {
        order_by: 'last_activity_at',
        membership: conn.group ? undefined : true,
        include_subgroups: conn.group ? true : undefined,
      },
    });
    const perProject = Math.max(1, Math.min(10, Number(req.query.per_project) || 5));
    const rows: Record<string, unknown>[][] = await Promise.all(
      projects.map(async (p) => {
        try {
          const pipes = await request<Record<string, any>[]>(`projects/${p.id}/pipelines`, {
            conn,
            query: { per_page: perProject },
          });
          return pipes.map((pipe) => ({ ...slimPipeline(pipe), project: p.path_with_namespace }));
        } catch {
          return [];
        }
      }),
    );
    res.json(
      rows
        .flat()
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 60),
    );
  } catch (err) {
    fail(res, err);
  }
});

/** One pipeline's jobs — the click-through from the pipelines tab. */
gitlabRouter.get('/pipelines/:projectId/:pipelineId/jobs', async (req, res) => {
  try {
    const conn = await connection();
    const rows = await request<Record<string, any>[]>(
      `projects/${encodeURIComponent(req.params.projectId)}/pipelines/${req.params.pipelineId}/jobs`,
      { conn, paginate: 100 },
    );
    res.json(
      rows.map((j) => ({
        id: j.id,
        name: j.name,
        stage: j.stage,
        status: j.status,
        duration: j.duration,
        url: j.web_url,
        failure_reason: j.failure_reason ?? null,
      })),
    );
  } catch (err) {
    fail(res, err);
  }
});

/** A job's log, tailed — the operator reads the same thing the agent does. */
gitlabRouter.get('/jobs/:projectId/:jobId/log', async (req, res) => {
  try {
    const conn = await connection();
    const raw = await request<string>(
      `projects/${encodeURIComponent(req.params.projectId)}/jobs/${req.params.jobId}/trace`,
      { conn, raw: true },
    );
    const lines = raw
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/section_(start|end):\d+:[^\r\n]*/g, '')
      .split('\n');
    res.json({ log: lines.slice(-400).join('\n'), truncated: lines.length > 400 });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * "Is there anything to do on this project?" — the **Check now** button (`GITLAB_PLAN.md` §10).
 *
 * Two steps, and they are separable on purpose. `GET .../check` gathers the four signals and
 * returns them: no inference, no session, instant, and enough on its own to answer "is this project
 * quiet" from the UI. `POST .../check` does the same gather and then hands it to an agent, which
 * reads what it means and reports back.
 *
 * The POST returns the session id straight away and leaves the turn running — the operator is meant
 * to watch it arrive in the Workspace, not wait on an HTTP request for the length of an inference
 * call.
 */
gitlabRouter.get('/projects/:project/check', async (req, res) => {
  try {
    res.json(await checkProject(req.params.project));
  } catch (err) {
    fail(res, err);
  }
});

gitlabRouter.post('/projects/:project/check', async (req, res) => {
  try {
    const check = await checkProject(req.params.project);

    // Who runs it: the agent the operator picked on the button, else the fleet's default. With
    // neither, nothing is started — the same rule the webhook router follows, for the same reason:
    // picking an agent at random to spend a turn is not a sensible default.
    const settings = await settingsService.get();
    const wantedId = String(req.body?.agent_id ?? '').trim() || settings.gitlab_default_agent_id;
    const agent = wantedId ? await agentRepository.findById(wantedId) : null;
    if (!agent) {
      res.status(400).json({
        error:
          'no agent to run this check — pick one on the button, or set a default agent in ' +
          'Settings → Connections → GitLab.',
        check,
      });
      return;
    }

    const { sessionId } = await startGitlabTurn({
      agentId: String(agent._id),
      agentName: agent.name,
      title: `GitLab · check ${check.project}`,
      brief: checkBrief(check),
      notify: `${agent.name} reviewed ${check.project}`,
      // The brief says "change nothing" and production showed that is not enough — an agent told
      // four times not to comment posted a merge-request comment anyway. The toolset enforces it.
      readOnly: true,
    });
    log.info({ project: check.project, agent: agent.name, session: sessionId }, 'project check started');
    res.json({ sessionId, agent: agent.name, check });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Per-agent GitLab identities (`GITLAB_PLAN.md` §11).
 *
 * `GET` lists what exists — usernames and token expiry, never a token. `POST /:agentId` provisions
 * one on demand with `force`, which is the path that *reports its failure*: ordinary provisioning is
 * best-effort and falls back to the fleet account silently, so without an explicit route the
 * operator would have no way to find out why an agent has no account.
 */
gitlabRouter.get('/identities', async (_req, res) => {
  res.json({
    available: await gitlabProvision.available(),
    access_levels: ACCESS_LEVELS,
    identities: await gitlabProvision.list(),
  });
});

gitlabRouter.post('/identities/:agentId', async (req, res) => {
  try {
    const agent = await agentRepository.findById(req.params.agentId);
    if (!agent) {
      res.status(404).json({ error: 'no such agent' });
      return;
    }
    const identity = await gitlabProvision.ensure(req.params.agentId, { force: true });
    if (!identity) {
      res.status(400).json({ error: 'provisioning produced no identity' });
      return;
    }
    res.json({
      agentId: req.params.agentId,
      agentName: agent.name,
      username: identity.username,
      userId: identity.userId,
      expiresAt: identity.expiresAt,
    });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Polling (`GITLAB_PLAN.md` §13) — how an instance with no webhooks wakes agents.
 *
 * The catalogue is served rather than duplicated in the frontend: the settings page renders its
 * checkboxes from these rows and the poller matches GitLab objects against the same ones, so a
 * checkbox cannot come to mean something the poller never looks for.
 */
gitlabRouter.get('/poll', async (_req, res) => {
  const s = await settingsService.get();
  res.json({
    catalogue: POLL_EVENT_KINDS,
    enabled: s.gitlab_poll_enabled,
    interval_minutes: s.gitlab_poll_interval_minutes,
    events: s.gitlab_poll_events,
    projects: s.gitlab_poll_projects,
    max_wakes: s.gitlab_poll_max_wakes,
    last: lastPollReport(),
  });
});

/**
 * Run one tick now, and answer with its report.
 *
 * `force` so the button works while polling is switched off: a GitLab that answers 403 on `/todos`
 * is otherwise indistinguishable from a quiet one, and the operator needs to find that out before
 * arming anything rather than by noticing nothing ever happens.
 */
gitlabRouter.post('/poll', async (_req, res) => {
  res.json(await pollOnce({ force: true }));
});

/** Forget every cursor: the next tick baselines and wakes nobody. */
gitlabRouter.post('/poll/rebaseline', async (_req, res) => {
  await rebaseline();
  res.json({ ok: true });
});

/** Reconsider every to-do still pending — the repair after a matcher was wrong (§15). */
gitlabRouter.post('/poll/catch-up', async (_req, res) => {
  await catchUpTodos();
  res.json({ ok: true });
});

/**
 * What GitLab is actually sending, matched against what is armed.
 *
 * A **`GET`**, deliberately: "the poller sees nothing" has to be answerable by a read-only API key
 * from outside the box, which is exactly how the `WorkItem` mismatch was found. It returns shapes
 * and ids, never a to-do body and never a token.
 */
gitlabRouter.get('/poll/inspect', async (_req, res) => {
  try {
    res.json(await inspect());
  } catch (err) {
    fail(res, err);
  }
});

/** The fleet's own activity feed — Mongo, not GitLab: this is the association GitLab cannot make. */
gitlabRouter.get('/activity', async (req, res) => {
  res.json(
    await gitlabActivityRepository.list({
      project: typeof req.query.project === 'string' ? req.query.project : undefined,
      agentId: typeof req.query.agent === 'string' ? req.query.agent : undefined,
      limit: Number(req.query.limit) || 100,
    }),
  );
});

/**
 * The inbound hook (§5). Mounted **without** `requireAuth`.
 *
 * It can only ever *enqueue*. Everything it might cause an agent to do, that agent could already do
 * with the tools it holds — so the blast radius of a forged delivery is one wasted inference turn,
 * not a new capability. It still answers 401 on a bad secret, and 200 on everything it decides to
 * ignore, because a hook that returns errors for normal traffic gets disabled by GitLab.
 */
export const gitlabWebhookRouter = Router();

gitlabWebhookRouter.post('/', async (req, res) => {
  const { webhookSecret } = await settingsService.gitlabSecrets();
  if (!verifySecret(req.get('X-Gitlab-Token'), webhookSecret)) {
    log.warn({ ip: req.ip, event: req.get('X-Gitlab-Event') }, 'gitlab webhook rejected: bad token');
    res.status(401).json({ error: 'bad token' });
    return;
  }

  const deliveryId = req.get('X-Gitlab-Event-UUID') ?? '';
  if (gitlabWakeQueue.isDuplicate(deliveryId)) {
    res.json({ ok: true, ignored: 'duplicate delivery' });
    return;
  }

  const decision = await decide(req.body ?? {});
  if (!decision) {
    res.json({ ok: true, ignored: 'nothing in this event wakes anybody' });
    return;
  }
  if (!decision.agentId || !decision.agentName) {
    log.info({ project: decision.project, why: decision.skipped }, 'gitlab event routed to nobody');
    res.json({ ok: true, ignored: decision.skipped ?? 'no agent matched' });
    return;
  }

  gitlabWakeQueue.enqueue({
    ...decision,
    agentId: decision.agentId,
    agentName: decision.agentName,
    deliveryId,
  });
  res.json({ ok: true, woke: decision.agentName, queued: gitlabWakeQueue.depth() });
});
