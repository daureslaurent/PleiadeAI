/**
 * Agents the application ships and owns (spec `FORUM_PLAN.md` §9).
 *
 * Identified by a stable role slug rather than by name, so the operator can rename… nothing, in fact:
 * built-ins are name-locked precisely *because* privileged tools authorise against the slug and the
 * name is the human-facing half of that identity. The slug is what code compares; the name is what
 * appears on the board.
 */
export const BUILTIN_FORUM_MODERATOR = 'forum_moderator';

/** The moderator's agent name. Seeded by migration; the routes refuse to change it. */
export const FORUM_MODERATOR_NAME = 'forum_keeper';
