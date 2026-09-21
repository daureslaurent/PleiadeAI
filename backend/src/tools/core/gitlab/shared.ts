import { GitLabError, connection, projectPath, type GitLabConnection } from '../../../domain/gitlab/gitlab.service';
import { gitlabActivityRepository } from '../../../domain/gitlab/gitlab-activity.repository';
import type { ToolContext, ToolResult } from '../../types';

/**
 * What every `gitlab_*` tool shares (`GITLAB_PLAN.md` §2).
 *
 * The nine tools are **verb tools**: one `action` argument, a handful of shapes behind it — the
 * `forum`/`api` shape rather than forty endpoints. That choice is what makes the prompt surface
 * affordable (nine descriptions instead of forty) and it is why the parallel-safety decision has to
 * be made per *call*: `gitlab_mr({action:'list'})` is a read that may overlap anything, and
 * `gitlab_mr({action:'merge'})` very much is not.
 */

/** Actions that only read. `Tool.parallelSafe`'s predicate form consults this per call. */
export function readOnly(...actions: string[]) {
  const set = new Set(actions);
  return (args: Record<string, unknown>) => set.has(String(args.action ?? ''));
}

/**
 * Run a tool body, turning an expected GitLab/config failure into a result the *agent* reads.
 *
 * Same contract as the mail tools': a misconfigured instance or a 403 is information the model can
 * act on (ask the operator, pick another project, stop trying), while anything else is a bug and
 * must keep propagating to the runner.
 */
export async function guard(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { result: { ok: true, ...(await fn() as object) } };
  } catch (err) {
    if (err instanceof GitLabError) return { result: { ok: false, error: err.message } };
    throw err;
  }
}

/** Resolve the connection and the project argument together — the opening move of most actions. */
export async function project(args: Record<string, unknown>): Promise<{ conn: GitLabConnection; id: string; path: string }> {
  const conn = await connection();
  const raw = String(args.project ?? '').trim().replace(/^\/+|\/+$/g, '');
  return { conn, id: projectPath(args.project, conn), path: raw };
}

/** Refuse an action the tool doesn't have, naming the ones it does — the model self-corrects. */
export function unknownAction(action: unknown, known: string[]): never {
  throw new GitLabError(
    `unknown action "${String(action)}" — this tool takes: ${known.join(', ')}`,
  );
}

/** Record a write in the fleet's activity feed. Reads are deliberately not logged (§4). */
export function logWrite(ctx: ToolContext, projectPathStr: string, action: string, input: {
  target?: string;
  title?: string;
  url?: string;
}): void {
  gitlabActivityRepository.record(ctx, { project: projectPathStr, action, ...input });
}

/** The `action` property every tool declares, with its own list spliced into the description. */
export function actionParam(description: string, actions: string[]) {
  return {
    type: 'string',
    enum: actions,
    description: `${description} One of: ${actions.join(', ')}.`,
  };
}

/** The `project` property, worded once. */
export const PROJECT_PARAM = {
  type: 'string',
  description:
    'Project path like "group/project" (or its numeric id when the instance is not group-confined). ' +
    'Find one with `gitlab_search({action:"projects"})` if you were not given it.',
};

/**
 * Cut a long text to a budget, saying so.
 *
 * Used on file contents, diffs and job logs — the three payloads that routinely exceed what a turn
 * can afford. A silent truncation is the dangerous one: an agent that reads 200 of 900 lines and is
 * not told will happily conclude the function it was looking for does not exist.
 */
export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n…[cut: ${text.length - max} more characters]`,
    truncated: true,
  };
}

/** The last N lines of a log — the useful end of a failed build. */
export function tail(text: string, lines: number): { text: string; truncated: boolean } {
  const all = text.split('\n');
  if (all.length <= lines) return { text, truncated: false };
  const kept = all.slice(-lines).join('\n');
  return { text: `…[${all.length - lines} earlier lines cut]\n${kept}`, truncated: true };
}
