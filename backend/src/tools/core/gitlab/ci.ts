import { createLogger } from '../../../config/logger';
import { cleanJobLog } from '../../../domain/gitlab/gitlab-log';
import { GitLabError, request, seg, slimPipeline } from '../../../domain/gitlab/gitlab.service';
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

const CI_ACTIONS = [
  'pipelines',
  'pipeline',
  'jobs',
  'job_log',
  'lint',
  'run',
  'retry',
  'cancel',
  'variables',
];

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
    '`lint` (`content`, or nothing to check the committed `.gitlab-ci.yml`) → validate a CI config ' +
    'BEFORE you commit it; an invalid one produces a pipeline that fails instantly with no jobs at ' +
    'all. `run` (`ref`, optional `variables`) → trigger a pipeline. `retry` / `cancel` (`pipeline_id` ' +
    'or `job_id`). `variables` → the project\'s CI variables (masked values are hidden by GitLab). ' +
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
      content: {
        type: 'string',
        description:
          '`lint`: the `.gitlab-ci.yml` text to validate. Omit to validate the one already committed ' +
          'on the default branch.',
      },
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
          return { pipeline: slimPipeline(p), jobs: jobs.map(slimJob), ...noJobsNote(p, jobs.length) };
        }

        case 'jobs': {
          if (!Number.isFinite(pipelineId)) throw new GitLabError('`pipeline_id` is required');
          const rows = await request<Record<string, any>[]>(
            `projects/${id}/pipelines/${pipelineId}/jobs`,
            { conn, paginate: 100, query: { scope: args.scope } },
          );
          // An empty list is the single most misleading answer this tool can give: it reads as
          // "nothing failed" when it usually means the pipeline never started. Fetch the pipeline
          // and say which it is.
          if (!rows.length) {
            const p = await request<Record<string, any>>(`projects/${id}/pipelines/${pipelineId}`, { conn });
            return { count: 0, jobs: [], pipeline: slimPipeline(p), ...noJobsNote(p, 0) };
          }
          return { count: rows.length, jobs: rows.map(slimJob) };
        }

        case 'lint': {
          const content = typeof args.content === 'string' ? args.content : null;
          // No content given: validate what is committed, by reading it first. An agent asking "is
          // my config valid" almost always means the one in the repo.
          const yaml =
            content ??
            (await request<string>(`projects/${id}/repository/files/${seg('.gitlab-ci.yml')}/raw`, {
              conn,
              raw: true,
            }));
          const res = await request<Record<string, any>>(`projects/${id}/ci/lint`, {
            conn,
            method: 'POST',
            body: { content: yaml, dry_run: false },
          });
          return {
            valid: res.valid === true,
            errors: res.errors ?? [],
            warnings: res.warnings ?? [],
            jobs: (res.jobs ?? []).map((j: any) => j.name ?? j),
            checked: content ? 'the content you passed' : 'the committed .gitlab-ci.yml',
            hint: res.valid
              ? undefined
              : 'Fix these before committing — an invalid config produces a pipeline that fails ' +
                'instantly with no jobs, which looks identical to a broken build.',
          };
        }

        case 'job_log': {
          if (!Number.isFinite(jobId)) throw new GitLabError('`job_id` is required — get it from `jobs`');
          const raw = await request<string>(`projects/${id}/jobs/${jobId}/trace`, { conn, raw: true });
          const lines = Math.min(2000, Math.max(10, Number(args.lines) || DEFAULT_LOG_LINES));
          // A job trace is a terminal recording: timestamps, stream markers, erase-line escapes and
          // progress-bar redraws are most of the bytes and none of the meaning (`cleanJobLog`).
          const out = tail(cleanJobLog(raw), lines);
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

/**
 * Explain a pipeline that produced no jobs.
 *
 * This is the case that cost a production afternoon: four pipelines `failed` with `duration: null`
 * and zero jobs, because the `.gitlab-ci.yml` did not validate. Every "read the failing job's log"
 * instruction finds nothing to read, and the reason lives in `yaml_errors` — which nothing surfaced.
 */
function noJobsNote(pipeline: Record<string, any>, jobCount: number): Record<string, unknown> {
  if (jobCount > 0) return {};
  if (pipeline.yaml_errors) {
    return {
      never_started: true,
      reason:
        `This pipeline produced no jobs because the CI config is invalid: ${pipeline.yaml_errors}. ` +
        'There is no job log to read — fix the config and validate it with ' +
        '`gitlab_ci({action:"lint"})` before committing again.',
    };
  }
  return {
    never_started: true,
    reason:
      'This pipeline has no jobs. Either no rule matched this ref, or no runner picked it up — ' +
      'check the project’s runners. There is no job log to read.',
  };
}

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
