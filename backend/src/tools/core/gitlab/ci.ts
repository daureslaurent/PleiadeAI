import { createLogger } from '../../../config/logger';
import { GitLabError, request, slimPipeline } from '../../../domain/gitlab/gitlab.service';
import {
  PROJECT_PARAM,
  actionParam,
  guard,
  logWrite,
  project,
  readOnly,
  tail,
  unknownAction,
} from './shared';
import type { Tool } from '../../types';

const log = createLogger('tool:gitlab');

/** Default lines of a job log fed back. A failed Node build's log is ~400 KB; the end is the part that matters. */
const DEFAULT_LOG_LINES = 200;

const CI_ACTIONS = ['pipelines', 'pipeline', 'jobs', 'job_log', 'run', 'retry', 'cancel', 'variables'];

/**
 * `gitlab_ci` — watch the pipelines, and read why one failed.
 *
 * `job_log` is the reason this tool exists. Everything else here is a status field an agent could
 * live without; a failed job's log is the one artifact that turns "the pipeline is red" into a
 * diagnosis, and it is also the one payload that will happily eat a whole context window — hence the
 * tail, which keeps the end (where the error is) and says how much it dropped.
 *
 * The retry rule in the prompt module follows from the same place: retrying a failed job without
 * reading its log is the one move that is always wrong, because nothing about the build changed.
 */
export const gitlabCi: Tool = {
  name: 'gitlab_ci',
  parallelSafe: readOnly('pipelines', 'pipeline', 'jobs', 'job_log', 'variables'),
  description:
    'Inspect and drive GitLab CI/CD. `pipelines` (optional `ref`, `status`) → recent pipelines. ' +
    '`pipeline` (`pipeline_id`) → one, with its jobs and their statuses. `jobs` (`pipeline_id`, ' +
    'optional `scope: failed`) → the jobs. `job_log` (`job_id`, optional `lines`) → a job\'s output, ' +
    'tailed to the last 200 lines by default — this is how you find out why a build failed. ' +
    '`run` (`ref`, optional `variables`) → trigger a pipeline. `retry` / `cancel` (`pipeline_id` or ' +
    '`job_id`). `variables` → the project\'s CI variables (values are hidden by GitLab for masked ones). ' +
    'Always read the failing job\'s log before retrying anything: a retry runs the same code again.',
  parameters: {
    type: 'object',
    properties: {
      action: actionParam('What to do.', CI_ACTIONS),
      project: PROJECT_PARAM,
      pipeline_id: { type: 'number', description: 'Pipeline id (from `pipelines`).' },
      job_id: { type: 'number', description: 'Job id (from `jobs`).' },
      ref: { type: 'string', description: 'Branch or tag — filter for `pipelines`, target for `run`.' },
      status: {
        type: 'string',
        description: '`pipelines`: filter by status (running, pending, success, failed, canceled).',
      },
      scope: { type: 'string', description: '`jobs`: e.g. "failed" to see only the jobs that broke.' },
      lines: { type: 'number', description: '`job_log`: how many trailing lines (default 200, max 2000).' },
      variables: {
        type: 'object',
        description: '`run`: CI variables for this run, as {NAME: value}.',
        additionalProperties: { type: 'string' },
      },
      limit: { type: 'number', description: '`pipelines`: how many (default 20, max 100).' },
    },
    required: ['action', 'project'],
    additionalProperties: false,
  },

  async execute(args, ctx) {
    return guard(async () => {
      const action = String(args.action ?? '');
      const { conn, id, path } = await project(args, ctx);
      const pipelineId = Number(args.pipeline_id);
      const jobId = Number(args.job_id);
      log.info({ agent: ctx.agentName, action, project: path }, 'gitlab_ci');

      switch (action) {
        case 'pipelines': {
          const rows = await request<Record<string, any>[]>(`projects/${id}/pipelines`, {
            conn,
            paginate: Math.min(100, Math.max(1, Number(args.limit) || 20)),
            query: { ref: args.ref, status: args.status, order_by: 'id', sort: 'desc' },
          });
          return { count: rows.length, pipelines: rows.map(slimPipeline) };
        }

        case 'pipeline': {
          if (!Number.isFinite(pipelineId)) throw new GitLabError('`pipeline_id` is required');
          const [p, jobs] = await Promise.all([
            request<Record<string, any>>(`projects/${id}/pipelines/${pipelineId}`, { conn }),
            request<Record<string, any>[]>(`projects/${id}/pipelines/${pipelineId}/jobs`, {
              conn,
              paginate: 100,
            }),
          ]);
          return { pipeline: slimPipeline(p), jobs: jobs.map(slimJob) };
        }

        case 'jobs': {
          if (!Number.isFinite(pipelineId)) throw new GitLabError('`pipeline_id` is required');
          const rows = await request<Record<string, any>[]>(
            `projects/${id}/pipelines/${pipelineId}/jobs`,
            { conn, paginate: 100, query: { scope: args.scope } },
          );
          return { count: rows.length, jobs: rows.map(slimJob) };
        }

        case 'job_log': {
          if (!Number.isFinite(jobId)) throw new GitLabError('`job_id` is required — get it from `jobs`');
          const raw = await request<string>(`projects/${id}/jobs/${jobId}/trace`, { conn, raw: true });
          const lines = Math.min(2000, Math.max(10, Number(args.lines) || DEFAULT_LOG_LINES));
          // CI logs carry ANSI colour and GitLab's own section markers, which are pure noise once
          // the text reaches a model rather than a terminal.
          const clean = raw
            // eslint-disable-next-line no-control-regex
            .replace(/\u001b\[[0-9;]*m/g, '')
            .replace(/section_(start|end):\d+:[^\r\n]*/g, '');
          const out = tail(clean, lines);
          return { job_id: jobId, truncated: out.truncated, log: out.text };
        }

        case 'run': {
          const ref = String(args.ref ?? '').trim();
          if (!ref) throw new GitLabError('`ref` is required — the branch or tag to run the pipeline on');
          const vars = args.variables && typeof args.variables === 'object'
            ? Object.entries(args.variables as Record<string, unknown>).map(([key, value]) => ({
                key,
                value: String(value),
              }))
            : undefined;
          const p = await request<Record<string, any>>(`projects/${id}/pipeline`, {
            conn,
            method: 'POST',
            query: { ref },
            body: vars ? { variables: vars } : undefined,
          });
          logWrite(ctx, path, 'gitlab_ci.run', { target: ref, title: `pipeline #${p.id}`, url: p.web_url });
          return { pipeline: slimPipeline(p) };
        }

        case 'retry':
        case 'cancel': {
          const isJob = Number.isFinite(jobId);
          if (!isJob && !Number.isFinite(pipelineId)) {
            throw new GitLabError('pass either `job_id` or `pipeline_id`');
          }
          const target = isJob
            ? `projects/${id}/jobs/${jobId}/${action}`
            : `projects/${id}/pipelines/${pipelineId}/${action}`;
          const res = await request<Record<string, any>>(target, { conn, method: 'POST' });
          logWrite(ctx, path, `gitlab_ci.${action}`, {
            target: isJob ? `job ${jobId}` : `pipeline ${pipelineId}`,
            title: `${action}ed`,
            url: res.web_url,
          });
          return { [isJob ? 'job' : 'pipeline']: isJob ? slimJob(res) : slimPipeline(res) };
        }

        case 'variables': {
          const rows = await request<Record<string, any>[]>(`projects/${id}/variables`, {
            conn,
            paginate: 100,
          });
          return {
            count: rows.length,
            // Values are echoed for unmasked variables only: a masked one is masked because somebody
            // decided it should not be read back, and a tool result is exactly a read-back.
            variables: rows.map((v) => ({
              key: v.key,
              masked: v.masked,
              protected: v.protected,
              environment: v.environment_scope,
              value: v.masked ? '[masked]' : v.value,
            })),
          };
        }

        default:
          return unknownAction(action, CI_ACTIONS);
      }
    });
  },
};

function slimJob(j: Record<string, any>): Record<string, unknown> {
  return {
    id: j.id,
    name: j.name,
    stage: j.stage,
    status: j.status,
    allow_failure: j.allow_failure,
    duration: j.duration,
    ref: j.ref,
    url: j.web_url,
    // The one field that decides whether a red job is worth investigating: a job that failed on a
    // runner timeout or a lost connection says nothing about the code.
    failure_reason: j.failure_reason ?? null,
    started_at: j.started_at,
    finished_at: j.finished_at,
  };
}
