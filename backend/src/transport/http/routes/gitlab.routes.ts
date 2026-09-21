import crypto from 'node:crypto';
import { Router } from 'express';
import { createLogger } from '../../../config/logger';
import { gitlabActivityRepository } from '../../../domain/gitlab/gitlab-activity.repository';
import { gitlabWakeQueue } from '../../../domain/gitlab/gitlab-wake-runner';
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
import { GITLAB_GIT_TRANSPORTS, settingsService, type GitLabGitTransport } from '../../../domain/settings/settings.service';

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
    git_transport: s.gitlab_git_transport,
    ssh_host: s.gitlab_ssh_host,
    ssh_port: s.gitlab_ssh_port,
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
  if (GITLAB_GIT_TRANSPORTS.includes(b.git_transport as GitLabGitTransport)) {
    patch.gitlab_git_transport = b.git_transport;
  }
  if (typeof b.ssh_host === 'string') patch.gitlab_ssh_host = b.ssh_host.trim();
  if (b.ssh_port !== undefined) patch.gitlab_ssh_port = Math.max(1, Number(b.ssh_port) || 22);
  await settingsService.update(patch as never);

  if (typeof b.token === 'string') await settingsService.setGitlabSecret('token', b.token.trim());
  if (typeof b.ssh_key === 'string') await settingsService.setGitlabSecret('sshKey', b.ssh_key);
  if (typeof b.webhook_secret === 'string') {
    await settingsService.setGitlabSecret('webhookSecret', b.webhook_secret.trim());
  }
  const s = await settingsService.get();
  res.json({ ok: true, token_set: s.gitlab_token_set, webhook_secret_set: s.gitlab_webhook_secret_set });
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
