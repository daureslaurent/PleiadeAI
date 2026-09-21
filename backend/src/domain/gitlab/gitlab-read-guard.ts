import { GitLabError } from './gitlab.service';
import type { ToolContext } from '../../tools/types';

/**
 * "You have not read this item this turn" (`GITLAB_PLAN.md` §14).
 *
 * The complaint this exists for: an agent commented on an issue without ever having seen the
 * comments already on it, because nothing made it look and nothing stopped it. Telling it to look
 * is necessary and — as §12 established about the read-only review, where an agent told four times
 * to change nothing posted a comment anyway — not sufficient. So the rule is enforced where the
 * forum enforces its post contract: at write time, before the call executes, with a refusal the
 * agent can act on inside the same turn.
 *
 * Scope is the **turn**, not the session: `ctx.turnId` spans every tool round of one user message,
 * so one `get` unlocks the writes that follow it, while the same agent coming back an hour later
 * has to look again — which is the point, since the thing that changed in between is exactly what
 * it would be talking over.
 *
 * Memory, not Mongo: a lost entry costs one extra read, and the set is meaningless once the turn
 * that built it has ended.
 */

/** Turns remembered at once. A fleet does not have two hundred turns in flight; this is the leak stop. */
const MAX_TURNS = 200;

const reads = new Map<string, Set<string>>();

function turnKey(ctx: ToolContext): string {
  return ctx.turnId || ctx.sessionId || 'anonymous';
}

function itemKey(project: string, kind: 'issue' | 'merge_request', iid: number): string {
  return `${project.toLowerCase()}|${kind}|${iid}`;
}

/** Record that this turn has seen the item, with everything said on it. */
export function markItemRead(
  ctx: ToolContext,
  project: string,
  kind: 'issue' | 'merge_request',
  iid: number,
): void {
  if (!Number.isFinite(iid)) return;
  const key = turnKey(ctx);
  let set = reads.get(key);
  if (!set) {
    set = new Set();
    // Re-inserting on every write would defeat the eviction order, so a turn is added once and the
    // oldest is dropped when the map is full — an LRU by first sight, which is the same thing here.
    if (reads.size >= MAX_TURNS) {
      const oldest = reads.keys().next().value;
      if (oldest !== undefined) reads.delete(oldest);
    }
    reads.set(key, set);
  }
  set.add(itemKey(project, kind, iid));
}

/**
 * Refuse a write on an item this turn has not read, naming the call that would fix it.
 *
 * The message carries the *reason*, not just the rule: being told "read it first" without being
 * told that somebody may already have answered produces an agent that reads and then writes the
 * comment it had already decided on.
 */
export function assertItemRead(
  ctx: ToolContext,
  project: string,
  kind: 'issue' | 'merge_request',
  iid: number,
  action: string,
): void {
  if (!Number.isFinite(iid)) return;
  if (reads.get(turnKey(ctx))?.has(itemKey(project, kind, iid))) return;
  const tool = kind === 'issue' ? 'gitlab_issue' : 'gitlab_mr';
  const marker = kind === 'issue' ? '#' : '!';
  throw new GitLabError(
    `you have not read ${marker}${iid} in ${project} this turn, so \`${action}\` is refused. Call ` +
      `\`${tool}({action:"get", project:"${project}", iid:${iid}})\` first — it returns the whole ` +
      'thread, and somebody may already have answered, closed it, or said something that changes ' +
      'what you were about to write.',
  );
}
