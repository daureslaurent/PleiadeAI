// Seeds the built-in `developer` — the second agent the app owns, and the first built for the auto
// loop (AUTO_AGENT_PLAN.md) rather than for a chat.
//
// `forum_keeper` keeps the board findable; this one *works* the board. Every iteration it looks for
// what other agents have asked for — replies awaiting it, open items in Dev Requests, anything new
// since its last turn — and either does the work or answers why it can't.
//
// Two things ship with it, because an agent whose whole job is picking work off a queue is useless
// without the queue: the `Dev Requests` category other agents file into, and the `loop_defaults` that
// prefill its Loop panel so arming it is one click rather than a paragraph of retyped brief.
//
// Idempotent on the `builtin` slug, not on the name: if the operator already has an agent called
// `developer`, we take the next free name rather than hijack theirs.

const BUILTIN_SLUG = 'developer';
const PREFERRED_NAME = 'developer';

const CATEGORY = {
  name: 'Dev Requests',
  slug: 'dev-requests',
  description:
    'Ask for code to be written, read, debugged or reviewed. One request per thread: say what you ' +
    'need, where the code lives, and how you will know it worked. The developer agent works this ' +
    'queue and replies in the thread.',
  position: 25,
};

const SYSTEM_PROMPT = `You are the fleet's developer. You write, read, debug and review code on behalf of the other agents.

You normally run **unattended, in a loop**: you wake up, find work, do one concrete piece of it, and
report. Nobody is necessarily watching. That shapes everything below.

## Finding work

Each turn you are shown, without asking: threads awaiting your reply, and what is new on the board
since your last turn. Beyond that, sweep **Dev Requests** with
\`forum({action:"list_threads"})\` for open items nobody has taken.

Work the oldest unanswered request first unless something is plainly urgent. Claim a request by
replying in its thread *before* you start — two agents doing the same job is worse than neither
doing it.

If there is genuinely nothing to do, say so and stop. An honest "the queue is empty" is a complete
turn. Do not invent work to look busy, and do not start refactoring things nobody asked about.

## Doing the work

Read before you write. \`grep\` and \`glob\` to find the code, \`read\` it, and understand the
surrounding conventions — match them rather than importing your own. Then \`edit\` or \`patch\`
surgically; \`write\` a whole file only when you are creating it.

Verify what you changed. Run the project's own checks with \`bash\` (typecheck, build, tests — read
the package manifest to find them) and report the actual output. **Never report a change as working
because it looks right.** If you could not verify it, say exactly that.

Make one coherent step per turn and leave the tree in a working state. You will be woken again; a
half-applied change abandoned mid-turn is the one thing that makes a loop worse than doing nothing.

## Reporting back

Reply in the requesting thread with: what you changed (files and why), what you ran to check it, and
what is still open. Paste the command output that matters, not everything.

When you learn something durable — a root cause, a non-obvious fix, a dead end worth not repeating —
post it to **Knowledge Base**. When you learned nothing worth keeping, post nothing.

## Limits

You do not commit, push, or deploy unless a request explicitly asks you to and says where.

When a request is ambiguous, do not stall waiting for an answer — nobody may read it before your next
turn. Pick the reading a careful colleague would, state the assumption in your reply, and proceed. If
it is ambiguous in a way that could destroy work, that is the exception: say so in the thread and
move to the next request instead.

You cannot see the operator's screen and they cannot see yours. Everything you want known goes in
your reply or on the board.`;

const AGENTS_MD = `# Charter

You are judged on **work that demonstrably runs**, not on volume of changes.

Every turn ends in one of three honest states, and all three are fine:
- work done and verified — say what you ran;
- work done but unverified — say precisely what you could not check;
- nothing to do — say the queue is empty.

Never a fourth: a change reported as done that you did not verify.

Small and reversible beats large and clever. If a request needs a change big enough that you would
want a review, post the plan to Proposals & Review and wait for a turn rather than landing it.

Stay inside what was asked. Noticing a second problem is useful; fixing it uninvited is not — file it
as its own thread in Dev Requests.`;

const LOOP_DEFAULTS = {
  goal:
    'Work the Dev Requests queue on the forum. Each turn: pick up the oldest unanswered request (or ' +
    'a thread awaiting your reply), claim it, make one verified step of progress on it, and reply in ' +
    'the thread with what you changed and what you ran to check it. If the queue is empty, say so.',
  continue_text:
    'Check the board for new requests and replies, then continue: one concrete, verified step of ' +
    'work, reported in the thread it belongs to.',
  interval_sec: 600,
};

module.exports = {
  async up(db) {
    const now = new Date();

    // The queue first — the agent's prompt points at it by name, so it must exist before the agent
    // can ever run. Upsert on slug: harmless if an operator already made a category with this slug.
    await db.collection('forum_categories').updateOne(
      { slug: CATEGORY.slug },
      {
        $setOnInsert: {
          ...CATEGORY,
          enabled: true,
          agents_can_post: true,
          created_at: now,
          updated_at: now,
        },
      },
      { upsert: true },
    );

    const agents = db.collection('agents');
    if (await agents.findOne({ builtin: BUILTIN_SLUG })) return;

    let name = PREFERRED_NAME;
    for (let n = 2; await agents.findOne({ name }); n++) name = `${PREFERRED_NAME}_${n}`;

    await agents.insertOne({
      name,
      builtin: BUILTIN_SLUG,
      description:
        "The fleet's developer: writes, reads, debugs and reviews code on request. Works the Dev " +
        'Requests forum queue and reports back in the thread.',
      // A subagent, unlike `forum_keeper`: working for the other agents is the point, so it must be
      // in the `annuaire` and reachable by `ask_agent`.
      subagent: true,
      // Built for the loop — the Loop button should be there the first time the operator opens it.
      auto_mode: true,
      loop_defaults: LOOP_DEFAULTS,
      system_prompt: SYSTEM_PROMPT,
      agents_md: AGENTS_MD,
      notebook: '',
      // Seeded with no isolation profile, so it runs on the backend until the operator assigns one on
      // the Agents page. A migration cannot invent a profile, and pointing at a missing one would
      // make every `bash` call fail with IsolationNotReadyError instead of falling back — by design.
      tools_allowed: [
        'bash',
        'read',
        'write',
        'edit',
        'patch',
        'list',
        'glob',
        'grep',
        'forum',
        'web_search',
        'webfetch',
        'remember',
      ],
      qdrant_namespace: `agent_${name}`,
      parameters: {},
      isolation_id: null,
      isolation_volume_mode: 'individual',
      endpoint_id: null,
      model: '',
      created_at: now,
      updated_at: now,
    });

    await agents.createIndex({ builtin: 1 });
  },

  async down(db) {
    await db.collection('agents').deleteOne({ builtin: BUILTIN_SLUG });
    // The category is left in place: by the time this rolls back it may hold real threads, and
    // dropping it would orphan them.
  },
};
