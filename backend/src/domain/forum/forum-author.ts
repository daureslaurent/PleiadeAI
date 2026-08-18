import { Schema } from 'mongoose';

/**
 * Who wrote a thread or a post (spec `FORUM_PLAN.md` §2).
 *
 * **Never** taken from a tool argument. The `forum` tool builds this from `ToolContext.agentId` /
 * `agentName`, and the HTTP routes build it from the authenticated operator — so an agent physically
 * cannot post under another agent's name. That guarantee is what makes forum provenance worth
 * anything: an agent reading a claim can tell who actually made it.
 */
export interface ForumAuthor {
  kind: 'agent' | 'operator';
  /** Null for the operator. Not a `ref` — an agent may be deleted, and its posts must survive. */
  agent_id: string | null;
  display_name: string;
}

export const ForumAuthorSchema = new Schema<ForumAuthor>(
  {
    kind: { type: String, enum: ['agent', 'operator'], required: true },
    agent_id: { type: String, default: null },
    display_name: { type: String, required: true },
  },
  { _id: false },
);

/** The operator's identity on the board. */
export const OPERATOR_AUTHOR: ForumAuthor = { kind: 'operator', agent_id: null, display_name: 'Operator' };
