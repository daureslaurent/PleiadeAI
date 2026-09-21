import { createLogger } from '../../config/logger';
import { GitLabActivityModel, type GitLabActivityDoc } from './gitlab-activity.model';
import type { ToolContext } from '../../tools/types';

const log = createLogger('gitlab-activity');

export interface ActivityInput {
  project: string;
  action: string;
  target?: string;
  title?: string;
  url?: string;
}

export const gitlabActivityRepository = {
  /**
   * Record one write.
   *
   * Fire-and-forget by design, like the memory persist after a turn: a feed row is an observation
   * *about* work that already happened on GitLab. Failing the tool call — and so telling the agent
   * its merge did not happen when it did — would be strictly worse than losing a row.
   */
  record(ctx: ToolContext, input: ActivityInput): void {
    void GitLabActivityModel.create({
      agent_id: ctx.agentId,
      agent_name: ctx.agentName,
      session_id: ctx.sessionId,
      project: input.project,
      action: input.action,
      target: input.target ?? '',
      title: (input.title ?? '').slice(0, 300),
      url: input.url ?? '',
      at: new Date(),
    }).catch((err) => log.warn({ err: String(err), action: input.action }, 'could not record gitlab activity'));
  },

  async list(opts: { project?: string; agentId?: string; limit?: number } = {}): Promise<GitLabActivityDoc[]> {
    const filter: Record<string, unknown> = {};
    if (opts.project) filter.project = opts.project;
    if (opts.agentId) filter.agent_id = opts.agentId;
    return GitLabActivityModel.find(filter)
      .sort({ at: -1 })
      .limit(Math.min(500, opts.limit ?? 100))
      .lean<GitLabActivityDoc[]>();
  },
};
