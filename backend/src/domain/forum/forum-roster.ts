import { agentRepository } from '../agents/agent.repository';

/**
 * The agent roster, in its own leaf module.
 *
 * It is read from two directions: the write path resolves `@name` against it
 * (`forum-mention.service.ts`), and the read path folds it into every forum-holding agent's prompt
 * so a name is spellable without a tool call (`forum-recall.service.ts`). Both must see the *same*
 * list — a roster that offers a name mentions would not match is worse than no roster — but the
 * write path reaches `AgentRunner` (a mention can run an agent) and `AgentRunner` reaches the read
 * path, so importing one from the other closes a require cycle. Living here, it is a leaf both can
 * depend on.
 */

/** The operator's handle on the board. Matches `OPERATOR_AUTHOR.display_name`, case-insensitively. */
export const OPERATOR_HANDLE = 'Operator';

/** How long the agent roster is reused before being re-read. Mentions are written on a hot path. */
const ROSTER_TTL_MS = 30_000;

export interface MentionTarget {
  kind: 'agent' | 'operator';
  agentId: string | null;
  name: string;
  /** False when the agent has `forum_mentions` off — the row is written, nothing is dispatched. */
  notify: boolean;
  /** False when this target may not be run automatically: the operator, or an agent opted out. */
  autoReply: boolean;
  /**
   * The agent's own one-line description. Carried here so the roster folded into every forum-holding
   * agent's prompt (`forum-recall.service.ts`) is built from the *same* list that resolves mentions —
   * a roster that can name somebody `parseMentions` would not match is worse than no roster.
   */
  description?: string;
}

export interface Roster {
  /** Lower-cased name → target, so resolution is case-insensitive but the stored name is canonical. */
  byName: Map<string, MentionTarget>;
  /** Names longest-first: `@image smith` must win over an agent literally called `image`. */
  names: string[];
  at: number;
}

let cached: Roster | null = null;

/**
 * Resolution runs against the live agent roster, not a `@\w+` pattern.
 *
 * Agent names are operator-chosen and may contain spaces or punctuation, so a pattern would both
 * miss `@image smith` and invent mentions out of `user@host`. Matching known names instead means an
 * unknown `@foo` is simply prose — there is no such thing on this board as a mention that goes
 * nowhere to be delivered.
 */
export async function loadRoster(force = false): Promise<Roster> {
  if (!force && cached && Date.now() - cached.at < ROSTER_TTL_MS) return cached;
  const agents = await agentRepository.list();
  const byName = new Map<string, MentionTarget>([
    [
      OPERATOR_HANDLE.toLowerCase(),
      // The operator is addressable but never runnable — @Operator is a question for a person.
      { kind: 'operator', agentId: null, name: OPERATOR_HANDLE, notify: true, autoReply: false },
    ],
  ]);
  for (const agent of agents) {
    byName.set(agent.name.toLowerCase(), {
      kind: 'agent',
      agentId: String(agent._id),
      name: agent.name,
      notify: agent.forum_mentions !== false,
      autoReply: agent.forum_auto_reply !== false,
      description: agent.description || '',
    });
  }
  cached = {
    byName,
    names: [...byName.values()].map((t) => t.name).sort((a, b) => b.length - a.length),
    at: Date.now(),
  };
  return cached;
}

/** Drop the roster cache — called when an agent is created, renamed or deleted. */
export function invalidateRoster(): void {
  cached = null;
}

