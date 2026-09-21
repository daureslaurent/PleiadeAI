import { createLogger } from '../../config/logger';
import { settingsService } from '../settings/settings.service';
import { connection, projectPath, request, slimIssue, slimMergeRequest } from './gitlab.service';

const log = createLogger('gitlab-review');

/**
 * "Is there anything to do on this project?" — the data half (`GITLAB_PLAN.md` §10).
 *
 * Deliberately no model in this file. The four signals the operator asked for are all plain queries,
 * and computing them here rather than asking an agent to go and look means the answer is the same
 * every time, costs four API calls instead of a dozen tool rounds, and can be rendered in the UI
 * without an inference run at all. The agent's job starts *after* this: reading what it means.
 *
 * What counts as something to do:
 *
 * 1. **Unassigned open issues** — the backlog nobody has claimed.
 * 2. **Assigned but stale** — claimed and then silently dropped, which is the failure mode that
 *    looks like progress from the outside and is the main reason this check exists.
 * 3. **Merge requests waiting** — no reviewer, conflicted, or untouched past the threshold.
 * 4. **A red default branch** — main is broken and nobody has opened anything about it.
 */

export interface ProjectCheck {
  project: string;
  url: string;
  default_branch: string;
  unassigned: ReturnType<typeof slimIssue>[];
  stale: { issue: ReturnType<typeof slimIssue>; days: number }[];
  merge_requests: { mr: ReturnType<typeof slimMergeRequest>; why: string[] }[];
  pipeline: {
    id: number;
    status: string;
    url: string;
    ref: string;
    failed_jobs: { name: string; id: number }[];
    /** Set when the config did not validate — the pipeline never produced a job. */
    yaml_errors: string | null;
  } | null;
  /** Nothing in any of the four buckets. */
  quiet: boolean;
  checked_at: string;
}

function daysSince(iso: string | undefined): number {
  if (!iso) return 0;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/** Gather one project's state. Read-only, and every call is a plain GET. */
export async function checkProject(ref: string): Promise<ProjectCheck> {
  const settings = await settingsService.get();
  const staleDays = Math.max(1, settings.gitlab_stale_days || 3);
  const conn = await connection();
  const id = projectPath(ref, conn);

  const project = await request<Record<string, any>>(`projects/${id}`, { conn });
  const [issues, mrs, pipelines] = await Promise.all([
    request<Record<string, any>[]>(`projects/${id}/issues`, {
      conn,
      paginate: 100,
      query: { state: 'opened', order_by: 'updated_at' },
    }),
    request<Record<string, any>[]>(`projects/${id}/merge_requests`, {
      conn,
      paginate: 50,
      query: { state: 'opened', order_by: 'updated_at' },
    }),
    request<Record<string, any>[]>(`projects/${id}/pipelines`, {
      conn,
      query: { ref: project.default_branch, per_page: 1 },
    }).catch(() => [] as Record<string, any>[]),
  ]);

  const unassigned = issues.filter((i) => !(i.assignees ?? []).length).map(slimIssue);
  const stale = issues
    .filter((i) => (i.assignees ?? []).length && daysSince(i.updated_at) >= staleDays)
    .map((i) => ({ issue: slimIssue(i), days: daysSince(i.updated_at) }));

  const merge_requests = mrs
    .map((m) => {
      const why: string[] = [];
      if (!(m.reviewers ?? []).length) why.push('no reviewer');
      if (m.has_conflicts) why.push('conflicts with its target');
      if (m.head_pipeline?.status === 'failed') why.push('its pipeline is failing');
      if (daysSince(m.updated_at) >= staleDays) why.push(`untouched for ${daysSince(m.updated_at)} days`);
      return { mr: slimMergeRequest(m), why };
    })
    // An MR that is reviewed, clean, green and recent needs nothing said about it.
    .filter((row) => row.why.length > 0);

  let pipeline: ProjectCheck['pipeline'] = null;
  const head = pipelines[0];
  if (head && head.status === 'failed') {
    // Only for a red pipeline, and only the names + ids: the logs are what the agent fetches if it
    // decides the failure is worth chasing, and pulling four of them here would cost more than the
    // whole check.
    let failedJobs: { name: string; id: number }[] = [];
    try {
      const jobs = await request<Record<string, any>[]>(`projects/${id}/pipelines/${head.id}/jobs`, {
        conn,
        query: { scope: 'failed', per_page: 20 },
      });
      failedJobs = jobs.map((j) => ({ name: String(j.name), id: Number(j.id) }));
    } catch {
      /* a project with restricted CI still reports the pipeline itself */
    }
    // The list endpoint omits `yaml_errors`, and that field is the entire explanation when a
    // pipeline failed with no jobs — so the pipeline is re-fetched by id rather than trusted from
    // the listing. Without it the brief could only say "it is red" and point at a log that does
    // not exist, which is exactly what it did in production.
    let yamlErrors: string | null = null;
    try {
      const full = await request<Record<string, any>>(`projects/${id}/pipelines/${head.id}`, { conn });
      yamlErrors = full.yaml_errors ?? null;
    } catch {
      /* the listing's fields are enough to report that it is red */
    }
    pipeline = {
      id: Number(head.id),
      status: head.status,
      url: head.web_url,
      ref: head.ref,
      failed_jobs: failedJobs,
      yaml_errors: yamlErrors,
    };
  }

  const check: ProjectCheck = {
    project: project.path_with_namespace,
    url: project.web_url,
    default_branch: project.default_branch,
    unassigned,
    stale,
    merge_requests,
    pipeline,
    quiet: !unassigned.length && !stale.length && !merge_requests.length && !pipeline,
    checked_at: new Date().toISOString(),
  };
  log.info(
    {
      project: check.project,
      unassigned: unassigned.length,
      stale: stale.length,
      mrs: merge_requests.length,
      red: !!pipeline,
    },
    'project check gathered',
  );
  return check;
}

/**
 * The brief a woken agent reads.
 *
 * The findings are handed over *already gathered*, which is the whole point: an agent that has to
 * discover the state of the project first spends five tool rounds re-deriving something we can
 * fetch in four parallel GETs, and it will discover a slightly different set each time.
 *
 * It is also told to change nothing — but that is now the *second* line of defence, not the only
 * one. Production settled the question (§12): an agent told four times to make no changes posted a
 * merge-request comment anyway, so the run itself is started read-only and a write is refused before
 * it executes. The sentence stays because being told why beats being refused without a reason.
 */
export function checkBrief(check: ProjectCheck): string {
  const lines: string[] = [
    `Review the state of the GitLab project \`${check.project}\` and report back. ` +
      'This is a **read-only** review: do not assign anything, do not comment on GitLab, do not ' +
      'close or merge anything, and do not push. Your answer here is the whole deliverable.',
    '',
    `Here is what the project looks like right now (gathered ${new Date(check.checked_at).toISOString()}):`,
    '',
  ];

  if (check.quiet) {
    lines.push(
      'Nothing stands out: no unclaimed issues, nothing stale, no merge request waiting, and the ' +
        `default branch (\`${check.default_branch}\`) is not red.`,
      '',
      'Say so in one line. Do not go looking for work to invent.',
    );
    return lines.join('\n');
  }

  if (check.unassigned.length) {
    lines.push(`**Open issues nobody has claimed (${check.unassigned.length}):**`);
    for (const i of check.unassigned.slice(0, 20)) {
      lines.push(`- #${(i as any).iid} ${(i as any).title}${(i as any).labels?.length ? ` [${(i as any).labels.join(', ')}]` : ''}`);
    }
    lines.push('');
  }

  if (check.stale.length) {
    lines.push(`**Assigned but untouched (${check.stale.length}):**`);
    for (const { issue, days } of check.stale.slice(0, 20)) {
      lines.push(
        `- #${(issue as any).iid} ${(issue as any).title} — ${(issue as any).assignees?.join(', ') || 'someone'}, ${days} days quiet`,
      );
    }
    lines.push('');
  }

  if (check.merge_requests.length) {
    lines.push(`**Merge requests needing attention (${check.merge_requests.length}):**`);
    for (const { mr, why } of check.merge_requests.slice(0, 20)) {
      lines.push(`- !${(mr as any).iid} ${(mr as any).title} — ${why.join('; ')}`);
    }
    lines.push('');
  }

  if (check.pipeline) {
    const p = check.pipeline;
    lines.push(`**The default branch is red.** Pipeline \`${p.id}\` on \`${p.ref}\` failed.`);
    if (p.yaml_errors) {
      // The config never validated, so there is no job and no log. Saying "read the failing job's
      // log" here is what sent an agent guessing pipeline ids in production — give it the actual
      // error instead, and the tool that prevents a repeat.
      lines.push(
        '',
        `It produced **no jobs at all**: the CI config is invalid — \`${p.yaml_errors}\`.`,
        'There is no job log to read. The fix is in `.gitlab-ci.yml`; validate any correction with ' +
          '`gitlab_ci({action:"lint"})` before it is committed.',
      );
    } else if (p.failed_jobs.length) {
      lines.push(
        '',
        'Failed jobs — read one with `gitlab_ci({action:"job_log", job_id: <id>})` before you say ' +
          'anything about the cause, because a runner timeout and a broken test look identical ' +
          'from here:',
        ...p.failed_jobs.map((j) => `- ${j.name} — \`job_id: ${j.id}\``),
      );
    } else {
      lines.push(
        '',
        'It produced **no jobs**, and GitLab reports no config error — so either no rule matched ' +
          `this ref or no runner picked it up. Check the project's runners; ` +
          `\`gitlab_ci({action:"pipeline", pipeline_id: ${p.id}})\` has the detail.`,
      );
    }
    lines.push('');
  }

  lines.push(
    'Look into whatever needs looking into — read the issues, the diffs, the job logs, the code. ' +
      'Then answer with a short brief for the operator:',
    '',
    '- what actually needs a decision or a person, and why;',
    '- what you would pick up first if you were told to start, and roughly what it involves;',
    '- anything here that is not real work (stale by accident, already handled elsewhere, a ' +
      'duplicate) so it can be cleared.',
    '',
    'Be concrete and short. Nothing you write here changes anything on GitLab — the operator reads ' +
      'this and decides. Again: **make no changes.**',
  );
  return lines.join('\n');
}
