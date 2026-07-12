# Conversation Generator

Synthetic conversation harvesting: an **interviewer** agent talks to selected agents on a schedule,
producing a large pool of real multi-turn conversations for future SFT training. It sits in front of
the existing pipeline — generated sessions are ordinary `sessions`/`messages` rows, so they flow into
the Conversation Quality Scorer and the fine-tune dataset builder (`dataset_source: 'scored'`) with
no extra plumbing.

## Decisions (operator, 2026-07-12)

| Question | Decision |
| --- | --- |
| Question source | A **real PleiadesAI agent** is the interviewer. A seeded `Interviewer` agent is the default; any agent can be picked per row. |
| Depth | **Multi-turn**, `turns` configurable per generator (interviewer reads the reply and follows up). |
| Storage | Normal `sessions`/`messages`, flagged `origin: 'synthetic'`. They appear in the Workspace alongside the operator's own chats, with the interviewer named on the "user" side. |
| Scoring | No dedicated hook — synthetic runs are normal runs, so the existing global `scoring_enabled` auto-scorer already covers them. |
| Memory | **Suppressed.** Synthetic turns must not be distilled into the target's Qdrant namespace (recall still works, so the agent behaves normally). |
| Model | The **interviewer** always runs on the fleet default endpoint+model. The **target** keeps its own configured model — otherwise we'd be generating data for the wrong model. |
| Interviewer cost | A **plain inference call** (system prompt + transcript → next question). No tool loop, no recall, no delegation. The expensive half is the target's full `AgentRunner` run — that is the data we want. |
| Scheduling | One row per target agent in `conversation_generators`, driven by the existing **Agenda** scheduler, yielding to a live user chat via `SessionLock`. |

## Backend

### `domain/conversation-gen/`

**`generator.model.ts`** — `conversation_generators` collection, one doc per target agent:

- `target_agent_id` (unique), `target_agent_name` (denormalised for listing)
- `interviewer_agent_id` — defaults to the seeded `Interviewer`
- `enabled` (default `false`), `interval_minutes` (default 60), `turns` (default 3)
- `topics: string[]` — optional seed topics to steer the interviewer
- Stats: `last_run_at`, `last_error`, `conversations_count`

**`interviewer.ts`** — one plain call, modelled on `domain/sessions/session-titler.ts`:
system = the interviewer agent's `system_prompt` + a briefing describing the target (name,
description, its charter) and the topic drawn for this conversation; user = the conversation so far,
rendered as a **labelled transcript** (`YOU:` / `AGENT:`) ending in "write your next message".
Resolved with `resolveInference({})` (→ fleet default endpoint + model) and wrapped in
`runWithCaptureContext({ source: 'interview' })` so it shows up in LLM Debug. `<think>` blocks,
leaked speaker labels, and any attempt to ventriloquise the agent's reply are stripped.

> The transcript-in-one-user-turn shape is load-bearing. Replaying the interviewer's own questions as
> `assistant` turns and the agent's answers as `user` turns reads to the model as "you are the
> assistant, answer the user" — it drops the interviewer persona and *answers its own question*.
> Observed, then fixed; don't reintroduce the role-inverted history.

**`conversation-gen.service.ts`** — `runOnce(generatorId)`:

1. Load generator + both agents; `sessionLock.waitUntilFree(targetAgentId)` (a live user chat wins).
2. Create a session with `origin: 'synthetic'`, `generator_id`.
3. Loop `turns` times: interviewer produces a question → persist as the `user` message → run the
   target through `agentRunner.run({ …, persistMemory: false })` with a `TurnRecorder` attached →
   persist the rich assistant turn (blocks/reasoning/trace, exactly like the client-gone path in
   `socket.ts`) → append both to the transcript fed back to the interviewer.
4. Record stats / `last_error`.

### Touch points

- **`orchestrator/AgentRunner.ts`** — new `persistMemory?: boolean` on `RunInput` (default `true`);
  guards the `memoryDistiller.distillTurn` call. Recall is untouched.
- **`domain/sessions/session.model.ts`** — new `origin: 'user' | 'synthetic'` (default `user`,
  indexed) and `generator_id`.
- **`transport/http/routes/sessions.routes.ts`** — the per-agent list takes an `origin` filter
  (`user` | `synthetic` | `all`; defaults to `user` for API consumers). The Workspace asks for `all`:
  a generated conversation is meant to be *read* like any other chat, so it sits in the session list
  under its agent, marked with a mic. `ChatPanel` names and re-tints the right-hand bubbles as the
  **Interviewer** in such a session, so they can never be mistaken for something the operator said.
- **`autonomy/agenda.setup.ts`** — new `conversation:generate` job; `syncSchedules()` at boot
  re-registers every enabled generator; create/update/enable re-schedules, disable/delete cancels.
- **`transport/http/routes/conversation-gen.routes.ts`** — CRUD on generators, `POST /:id/run-now`,
  and a listing of generated sessions.
- **Migration** — adds `origin: 'user'` to existing sessions and seeds the `Interviewer` agent
  (`subagent: false` so nothing can delegate to it; no tools).
- **`core/event-bus/events.types.ts`** — `LlamaCallSource` gains `'interview'`, so interviewer calls
  are filterable on the LLM Debug page. (`llama-logs`' own enum was missing `'memory'` as well — it
  rejected every memory-distillation capture on insert. Both are now listed.)

## Live streaming

A generated conversation has no client driving it, so the two halves a chat client normally supplies
itself have to come off the EventBus instead — otherwise the Workspace only shows the conversation
after a reload. `conversation-gen.service` emits, and `bridge.ts` maps:

| Internal event | Wire event | Why |
| --- | --- | --- |
| `conversation:session_created` | `session:created` (broadcast) | No client can be in the new session's room yet; every open Workspace adds the row to the agent's list. |
| `chat:user_message` | `chat:user` + `chat:running` | The interviewer's question, as a `user` turn, and the target starting work. |
| `conversation:turn_complete` | `chat:done` (`persisted: true`) | Settles the live buffer into a finished turn. Already persisted server-side, so the client must not save it again. |

The agent's tokens need no new plumbing: the bridge is room-scoped by `sessionId`, so `stream_chunk`
already reaches whoever is watching. The error path emits `conversation:turn_complete` with empty
blocks too — otherwise a failed run leaves the watching UI spinning forever.

## Operational note

The interviewer runs on the **fleet default endpoint**. If that default is the built-in 1.5B CPU
fallback, the generated conversations are worth very little as training data — the interviewer parrots
the agent and the agent parrots it back. Point the default at a real model before enabling a
generator.

Its call suppresses the model's thinking channel (`enable_thinking: false`, retried unconstrained if
the endpoint rejects the kwarg). Without that, a reasoning default model spends the entire token
budget inside `<think>`, returns empty content (`finish: 'length'`), and every conversation dies with
`interviewer produced no question`. If that error ever reappears, that is the first thing to check.

## Frontend

New `views/ConversationsView.tsx` + a **Conversations** nav item in the *Model* group (next to
Scoring and Fine-Tuning — it is the head of the same data pipeline). `MasterDetail` layout:

- **List** — one row per generator: target agent, enabled dot, interval, conversations generated.
- **Detail** — target agent picker, interviewer agent picker, enable toggle, interval, turns per
  conversation, topic seeds, *Run now*, last-run/error, and the recent generated sessions (opening
  one deep-links into the Workspace).
