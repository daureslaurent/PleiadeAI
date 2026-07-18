# Agent todo lists — `todowrite` + the live checklist in chat

Gives agents an explicit plan they maintain mid-turn, and the operator a live view of it. The point
is not bookkeeping: it is that a model working a long multi-step task drifts and drops steps, and a
written plan it has to keep ticking is the cheapest known correction.

Modelled on Claude Code's `TodoWrite` and opencode's `todowrite` — both converged on the same shape,
and the reasons are worth recording (see *Why a full-list rewrite* below).

## Decisions (operator-chosen)

| Question | Choice |
|---|---|
| Lifetime | Session-scoped, persisted in Mongo (like the `resources` pool) |
| Tool API | One `todowrite`, full-list rewrite |
| Ownership | Per agent: keyed `(session_id, agent_id)`, so a subagent's list nests in its own bubble |
| Rendering | Sticky panel that updates in place + a collapsed inline marker per write |
| Grant | Auto-granted to every agent, like `guide` / `data` |
| Prompting | JIT directive + unfinished-items carried into the next turn's prompt |
| Operator | Read-only; may collapse/dismiss (client-side preference) |
| Idle | Panel stays while anything is pending/in_progress; hides when all completed |

## Why a full-list rewrite

The agent always sends the complete array. Granular `add`/`complete`/`remove` by id looks cheaper but
loses in practice: models drift on ids, partial updates half-apply, and every mutation needs conflict
handling against a list the model can't see. A full rewrite is idempotent, needs no id bookkeeping,
and makes the tool call self-describing in the trace — you can read the whole plan at each step.

The cost is tokens per call, which is real and accepted.

## Design

**Storage.** New `todos` collection: `session_id`, `agent_id`, `agent_name`, `items[]`, `updated_at`,
unique on `(session_id, agent_id)`. Items are `{ id, content, status }` where status is
`pending | in_progress | completed`. Ids are assigned server-side from the item's position so the
model never has to invent or preserve them.

**Tool.** `todowrite({ todos: [{ content, status }] })` in `tools/core/todo.ts`, registered in
`registry.ts` and auto-granted in `AgentRunner` alongside `data`/`guide`. It replaces the calling
agent's list, persists, and emits `agent:todo_update`.

No `todoread`: the agent's current list is injected into its own prompt each turn (below), so a read
tool would only let it re-fetch what it has already been told.

**Prompt.** `jit-builder.ts` gains `renderTodoBlock()`, injected after the notebook:
- when items exist, the current list with statuses — this *is* the "don't forget a step" mechanism,
  since a turn that ended with items `in_progress` starts the next turn looking at them;
- usage guidance: multi-step work only, exactly one item `in_progress` at a time, tick items as they
  complete rather than in a batch at the end.

**Events.** `agent:todo_update` on the bus → `todo_update` on the wire, carrying `sessionId`, `agent`,
`agentId`, `depth`, `runId`, `items`. Routed exactly like `memory_recall`: depth 0 belongs to the
turn, deeper to the sub-agent's own frame, so nesting rides the existing frame → block plumbing.

**UI.**
- `TodoPanel.tsx` — pinned above the composer, showing the depth-0 agent's list with a progress
  count. Collapse/dismiss persisted to localStorage like the debugger drawer.
- The `todowrite` tool block renders as a one-line collapsed marker (`toolSummary.ts`) rather than
  raw JSON, so scrollback stays readable while history still shows when the plan changed.
- A sub-agent's list renders inside its `ask_agent` bubble.
- On session load, todos are fetched over `GET /api/sessions/:id/todos` so a reload restores the
  panel.

## Work items

1. `domain/todos/` — model + repository.
2. `tools/core/todo.ts`, registered + auto-granted.
3. `agent:todo_update` in `events.types.ts`, mapped in `bridge.ts`.
4. `renderTodoBlock()` in `jit-builder.ts`, wired through `AgentRunner`.
5. `GET /api/sessions/:id/todos`.
6. Migration creating the collection + unique index.
7. Frontend: wire type, store handling, `TodoPanel`, bubble nesting, tool summary, api client.

8. `TurnRecorder` mirrors `todowrite` onto its frame, matching what it already does for `memories`,
   so a sub-agent's checklist survives a reconnect mid-turn.

## Status

Implemented; both sides typecheck. `renderTodoBlock` was exercised directly — the empty, mid-flight
and all-complete renderings are correct, including the carry-over line that names how many items are
still open.

**Not yet exercised against a running stack** (no local stack; prod is remote). Worth watching on the
first real turn:
- the depth routing — a sub-agent's write lands on its frame only while that frame is the open one,
  so a list written as the stack unwinds would be dropped rather than misattributed;
- whether models actually call `todowrite` unprompted at this prompt strength, or need the directive
  sharpened.

## Verification

`npm run typecheck` both sides, then a live multi-step turn: the panel appears and ticks through,
survives a reload mid-turn, a delegated subagent's list nests in its bubble rather than replacing the
parent's, and unfinished items reappear in the next turn's prompt.
