import crypto from 'node:crypto';
import { createLogger } from '../../config/logger';
import { agentRepository } from '../agents/agent.repository';
import { settingsService } from '../settings/settings.service';
import type { WakeFamily } from './gitlab-poll.catalogue';

const log = createLogger('gitlab-webhook');

/**
 * Turning a GitLab event into "this agent should take a turn" (`GITLAB_PLAN.md` §5).
 *
 * Three events wake somebody and nothing else does — an issue assigned, a comment naming an agent,
 * a review requested. That restraint is the whole design: the forum learned the hard way
 * (`FORUM_MENTION_LOOP_PLAN.md`) that inferring "you should act" from prose produces agents talking
 * in circles all night, so the rule here is the same one that fixed it — an event wakes somebody
 * only when a *person* directed it at them, by assigning or by naming them.
 *
 * Nothing in this module runs anything. It reads an untrusted payload and returns a decision, which
 * is what makes it safe to expose unauthenticated.
 */

/** What a delivery resolved to. `null` targets mean nothing runs — the honest outcome for "unsure". */
export interface WakeDecision {
  /**
   * What happened, for logging and de-duplication: a webhook kind (`issue`, `note`,
   * `merge_request`) or a poll catalogue id (`mr_merged`, …). Free-form on purpose — the brief
   * reads `family` and `lead`, so a new poll kind needs no case added here.
   */
  kind: string;
  /** Which brief the agent reads, and therefore which finishing move it is told to make. */
  family: WakeFamily;
  /** One sentence naming what happened, in the second person. Opens the brief. */
  lead: string;
  agentId: string | null;
  agentName: string | null;
  project: string;
  title: string;
  url: string;
  /** The text that justifies the wake — quoted into the brief. */
  body: string;
  /** Why nothing was woken, when `agentId` is null. */
  skipped?: string;
}

/** Constant-time secret comparison: an early-exit compare leaks the prefix one request at a time. */
export function verifySecret(provided: unknown, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(String(provided ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Every `@name` in a body, lowercased — GitLab usernames and agent names share the syntax. */
function mentionedNames(body: string): string[] {
  return [...body.matchAll(/@([A-Za-z0-9._-]{2,40})/g)].map((m) => m[1]!.toLowerCase());
}

/**
 * Pick the agent, most specific first: a name in the text, then the per-project row, then the fleet
 * default. A delivery that matches none of the three wakes **nobody** — picking an agent at random
 * for an event that named none is how an inbound endpoint turns into a random inference bill.
 */
export async function route(
  project: string,
  body: string,
  assignedUsernames: string[],
): Promise<{ agentId: string | null; agentName: string | null; why?: string }> {
  const settings = await settingsService.get();
  const agents = await agentRepository.list();
  const byName = new Map(agents.map((a) => [a.name.toLowerCase(), a]));
  // Agents that have their own GitLab account are resolvable by that account's username, which is
  // the whole point of provisioning them (`GITLAB_PLAN.md` §11): "assigned to `scout`" stops being
  // a name read out of prose and becomes an assignee field GitLab filled in itself.
  const byGitlabUser = new Map(
    agents.filter((a) => a.gitlab_username).map((a) => [a.gitlab_username!.toLowerCase(), a]),
  );

  // 1. Named in the text, or assigned to an agent — by its GitLab username first, since that is the
  //    identity GitLab actually recorded, then by the agent's own name for an unprovisioned fleet.
  for (const raw of [...assignedUsernames, ...mentionedNames(body)]) {
    const name = raw.toLowerCase();
    const hit = byGitlabUser.get(name) ?? byName.get(name);
    if (hit) return { agentId: String(hit._id), agentName: hit.name };
  }

  // 2. A per-project routing row.
  const row = settings.gitlab_project_agents.find(
    (r) => r.project.trim().toLowerCase() === project.toLowerCase(),
  );
  if (row) {
    const agent = agents.find((a) => String(a._id) === row.agent_id);
    if (agent) return { agentId: String(agent._id), agentName: agent.name };
  }

  // 3. The fleet default.
  if (settings.gitlab_default_agent_id) {
    const agent = agents.find((a) => String(a._id) === settings.gitlab_default_agent_id);
    if (agent) return { agentId: String(agent._id), agentName: agent.name };
  }

  return {
    agentId: null,
    agentName: null,
    why:
      'no agent was named, no routing row matches this project, and no default agent is set ' +
      '(Settings → Connections → GitLab)',
  };
}

/**
 * Read one delivery. Returns `null` for the many events we do not act on (pushes, tags, pipelines,
 * every update that changed a label) — GitLab sends a project's whole activity to one hook URL, so
 * *most* deliveries are correctly ignored.
 */
export async function decide(payload: Record<string, any>): Promise<WakeDecision | null> {
  const settings = await settingsService.get();
  const kind = String(payload?.object_kind ?? '');
  const project = String(payload?.project?.path_with_namespace ?? '');
  const bot = settings.gitlab_bot_username.trim().toLowerCase();

  /** Usernames an event newly directed at somebody — an assignee added, a reviewer set. */
  const addedUsers = (field: string): string[] =>
    (payload?.changes?.[field]?.current ?? [])
      .filter((u: any) => !(payload?.changes?.[field]?.previous ?? []).some((p: any) => p.id === u.id))
      .map((u: any) => String(u.username ?? ''));

  // GitLab 19 emits `work_item` beside `issue` for the same object (`GITLAB_PLAN.md` §15). A hook
  // that only knows `issue` silently ignores half its deliveries, which is the webhook-shaped
  // version of the bug that hid the poller's to-dos.
  if ((kind === 'issue' || kind === 'work_item') && settings.gitlab_wake_issues) {
    const attrs = payload.object_attributes ?? {};
    // Only a *new* assignment, not every edit of an already-assigned issue: GitLab re-sends the
    // whole object on any change, and without this a typo fix in the description wakes somebody.
    const assigned = addedUsers('assignees');
    if (!assigned.length) return null;
    const routed = await route(project, `${attrs.title ?? ''}\n${attrs.description ?? ''}`, assigned);
    return {
      kind: 'issue',
      family: 'issue',
      lead: `You have been assigned an issue on GitLab: **#${attrs.iid} ${attrs.title ?? ''}** in \`${project}\`.`,
      agentId: routed.agentId,
      agentName: routed.agentName,
      project,
      title: `#${attrs.iid} ${attrs.title ?? ''}`,
      url: String(attrs.url ?? ''),
      body: String(attrs.description ?? ''),
      skipped: routed.why,
    };
  }

  if (kind === 'note' && settings.gitlab_wake_issues) {
    const attrs = payload.object_attributes ?? {};
    const body = String(attrs.note ?? '');
    const names = mentionedNames(body);
    if (!names.length) return null;
    // A comment one of *our own* accounts wrote, naming somebody, would otherwise wake that agent —
    // and its reply would name the first one back. That is the loop, and this is where it stops. It
    // has to cover every provisioned agent, not just the fleet bot, or giving agents their own
    // accounts would quietly re-open the loop the check was written to close.
    const writer = String(payload?.user?.username ?? '').toLowerCase();
    const ours = await agentRepository.list();
    if (
      (bot && writer === bot) ||
      ours.some((a) => a.gitlab_username && a.gitlab_username.toLowerCase() === writer)
    ) {
      log.debug({ project, writer }, 'ignoring a note written by one of our own GitLab accounts');
      return null;
    }
    const routed = await route(project, body, []);
    if (!routed.agentId) return null;
    const subject = payload.issue ?? payload.merge_request ?? {};
    return {
      kind: 'note',
      family: 'note',
      lead: `You were named in a comment on GitLab, on **${String(subject.title ?? 'a comment')}** in \`${project}\`.`,
      agentId: routed.agentId,
      agentName: routed.agentName,
      project,
      title: String(subject.title ?? 'a comment'),
      url: String(attrs.url ?? ''),
      body,
      skipped: routed.why,
    };
  }

  if (kind === 'merge_request' && settings.gitlab_wake_reviews) {
    const attrs = payload.object_attributes ?? {};
    const reviewers = addedUsers('reviewers');
    if (!reviewers.length) return null;
    const routed = await route(project, `${attrs.title ?? ''}\n${attrs.description ?? ''}`, reviewers);
    return {
      kind: 'merge_request',
      family: 'merge_request',
      lead:
        'You have been asked to review a merge request on GitLab: ' +
        `**!${attrs.iid} ${attrs.title ?? ''}** in \`${project}\`.`,
      agentId: routed.agentId,
      agentName: routed.agentName,
      project,
      title: `!${attrs.iid} ${attrs.title ?? ''}`,
      url: String(attrs.url ?? ''),
      body: String(attrs.description ?? ''),
      skipped: routed.why,
    };
  }

  return null;
}
