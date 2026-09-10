/**
 * The post contract (spec `FORUM_WORKBOARD_PLAN.md` §4).
 *
 * A post declares what kind of thing it is, and each kind has a shape and a length ceiling. A post
 * that misses either is **refused at write time, with the specific defect named** — which is the
 * whole difference from `assertNotARepeat`. That guard refuses a restatement *after* the inference
 * turn that produced it has been paid for, and the spec says so plainly: it terminates loops rather
 * than preventing them. This runs before the post lands, and the refusal comes back as a tool result
 * the agent can act on inside the same turn.
 *
 * **Why one required field per kind and not four.** `FORUM_AUTORUN_PLAN.md` §RC1 is the governing
 * evidence: `wake` was a structured argument and the fleet's models filled it once in 89 posts. The
 * difference here is that these fields are *required* — omitting one produces a refusal naming it,
 * and re-calling a tool after a validation error is a loop these models do complete inside
 * `MAX_TOOL_ITERATIONS`. Requiring one field survives that evidence; requiring four does not.
 */

/** What a post is for. `note` is the default and the only kind with no shape — including every post written before this existed. */
export const FORUM_POST_KINDS = [
  'note',
  'status',
  'finding',
  'question',
  'handoff',
  'decision',
  'review',
] as const;
export type ForumPostKind = (typeof FORUM_POST_KINDS)[number];

/** The structured half of a post. Every field is optional here and required by exactly one kind. */
export interface ForumPostMeta {
  /** `finding`: is this measured, or is it your reading? The §5 verified-versus-suspected rule, made structural. */
  verified?: boolean;
  /** `question`: what answer would unblock you. A question that does not say gets an essay back. */
  needs?: string;
  /** `decision`: the one line that settles it, separable from the reasoning so a reader can act without reading. */
  decision?: string;
  /** `review`: the verdict. Only a task's reviewer may write this kind. */
  verdict?: 'pass' | 'fail';
  /** `handoff`: what is being handed over — a file id, a handle, a path. */
  deliverable?: string;
}

interface KindSpec {
  /** Characters of `body`, checked on what will actually be stored. */
  ceiling: number;
  /** One line for the tool description and for the refusal message. */
  purpose: string;
  /** Returns the name of the missing field, or null. */
  missing: (meta: ForumPostMeta) => string | null;
}

/**
 * The ceilings are characters rather than tokens on purpose: the number the operator sees in the UI
 * has to be the number the guard used, or every refusal turns into an argument about counting.
 *
 * `status` is the tightest at 400 because it is the kind the runaway exchange was made of — those
 * posts grew from 1,071 to 3,089 characters while saying the same thing. A status update that needs
 * four hundred characters is a `finding` wearing the wrong label.
 */
const SPECS: Record<ForumPostKind, KindSpec> = {
  note: {
    ceiling: 2000,
    purpose: 'ordinary discussion — the default, and what every post written before the contract is',
    missing: () => null,
  },
  status: {
    ceiling: 400,
    purpose: 'where something has got to, in a sentence or two',
    missing: () => null,
  },
  finding: {
    ceiling: 1200,
    purpose: 'something the rest of the fleet should know',
    missing: (m) => (typeof m.verified === 'boolean' ? null : 'verified'),
  },
  question: {
    ceiling: 600,
    purpose: 'something you need answered to go further',
    missing: (m) => (m.needs?.trim() ? null : 'needs'),
  },
  handoff: {
    ceiling: 1000,
    purpose: 'here is the thing, it is yours now',
    missing: (m) => (m.deliverable?.trim() ? null : 'deliverable'),
  },
  decision: {
    ceiling: 800,
    purpose: 'the call that was made, and why',
    missing: (m) => (m.decision?.trim() ? null : 'decision'),
  },
  review: {
    ceiling: 800,
    purpose: "a reviewer's verdict on a submitted task",
    missing: (m) => (m.verdict === 'pass' || m.verdict === 'fail' ? null : 'verdict'),
  },
};

export class PostContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostContractError';
  }
}

export const isPostKind = (value: unknown): value is ForumPostKind =>
  typeof value === 'string' && (FORUM_POST_KINDS as readonly string[]).includes(value);

/**
 * Check a post against its kind. Throws `PostContractError` with a message that says exactly what to
 * fix, because a refusal an agent cannot act on costs the same turn twice.
 *
 * Deliberately **not** applied to operator-authored posts: a human writing on the board is not the
 * failure mode this exists for, and holding them to it would make the operator's own corrections the
 * hardest thing to write on the board.
 */
export function assertPostContract(kind: ForumPostKind, body: string, meta: ForumPostMeta): void {
  const spec = SPECS[kind];
  const missing = spec.missing(meta);
  if (missing) {
    throw new PostContractError(
      `a "${kind}" post must also set \`${missing}\` (${spec.purpose}). Add it and post again.`,
    );
  }
  const length = body.trim().length;
  if (!length) throw new PostContractError('a post needs a body.');
  if (length > spec.ceiling) {
    throw new PostContractError(
      `a "${kind}" post is capped at ${spec.ceiling} characters and yours is ${length} — cut ` +
        `${length - spec.ceiling}. ${spec.purpose}. If it genuinely needs the room it is probably a ` +
        'different kind of post, or two posts.',
    );
  }
}

/** Keep only the fields the kind actually uses, so a post does not carry another kind's leftovers. */
export function normaliseMeta(kind: ForumPostKind, meta: ForumPostMeta): ForumPostMeta {
  switch (kind) {
    case 'finding':
      return { verified: Boolean(meta.verified) };
    case 'question':
      return { needs: meta.needs?.trim() ?? '' };
    case 'handoff':
      return { deliverable: meta.deliverable?.trim() ?? '' };
    case 'decision':
      return { decision: meta.decision?.trim() ?? '' };
    case 'review':
      return { verdict: meta.verdict === 'fail' ? 'fail' : 'pass' };
    default:
      return {};
  }
}

/** The per-kind lines the `forum` tool's `kind` parameter description is built from. */
export const KIND_HELP: string = FORUM_POST_KINDS.map(
  (k) => `${k} (≤${SPECS[k].ceiling} chars) — ${SPECS[k].purpose}`,
).join('; ');

export const ceilingFor = (kind: ForumPostKind): number => SPECS[kind].ceiling;
