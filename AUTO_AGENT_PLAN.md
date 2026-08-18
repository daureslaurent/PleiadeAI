# AUTO_AGENT_PLAN.md — Auto agent mode (self-driving conversations)

## 1. What this is

A per-agent flag (`agents.auto_mode`) that unlocks, in the Workspace composer, a **Loop** panel:
the operator hands the agent a **goal**, a **kickoff message** (turn 1 only), a **continue
message** (every later turn) and a **loop time**, hits start, and the agent then drives its own
conversation — one turn every `interval`, forever, until it decides the goal is met or the operator
stops it.

It is the timed sibling of the existing composer controls: **Continue** (manual nudge) and **Auto**
(re-nudge when a turn is truncated, `ChatPanel.tsx`). Those are client-side and reactive. This one is
**backend-driven** and proactive: the loop is server state, so it keeps ticking with the browser
closed, survives a reload/restart, and can work the forum unattended.

Not a cron job (`autonomy/`): a cron run is a fresh stateless session each time. A loop is *one
conversation* that grows — the agent keeps its history, its todo list, its session resources.

## 2. Decisions (operator-chosen)

| Question | Decision |
|---|---|
| Where the loop runs | **Backend.** A Mongo doc + in-process scheduler, rehydrated at boot. |
| Where the shared goal lives | **Per-loop `goal` field**, injected into *every* iteration. Kickoff `seed` text stays separate (turn 1 only). |
| How it ends | **The agent declares itself done** via a `loop_done` tool — plus the operator's stop. No iteration cap. |
| Injected each tick | Forum **unanswered replies** (forced on), a forum **activity digest** since the last tick, and the **goal + progress recap**. |

Added as a safety measure (not asked for, stated plainly): after `MAX_CONSECUTIVE_ERRORS` (5)
back-to-back failed turns the loop parks itself in `error` instead of hammering a dead endpoint
forever. Every other stop is deliberate.

## 3. Data

### `agents.auto_mode: boolean` (default `false`)
The toggle on the Agents page. Gates the Loop button in the composer; nothing else.

### `auto_loops` collection — one doc per session
```
session_id      unique      the conversation this loop drives (a loop IS a session)
agent_id / agent_name
status          idle | running | waiting | done | stopped | error
goal            the standing objective, injected every iteration
seed            kickoff text, sent as the user turn of iteration 1 only
continue_text   the user turn of every later iteration
interval_sec    delay between the END of one turn and the start of the next
iteration       turns completed so far
progress[]      { n, at, summary } — rolling recap fed back into the prompt
forum_seen_at   watermark for the "new on the forum since last tick" digest
done_reason     the agent's own summary when it called `loop_done`
last_error / consecutive_errors
next_run_at     when the next tick fires (drives the UI countdown)
```

Interval is measured **after** a turn ends, not on a wall clock — a turn that takes longer than the
interval can therefore never overlap itself, which removes the whole class of "tick while still
streaming" bugs.

Migration `20260819xxxxxx-auto-agent-loops.js`: create `auto_loops` (+ unique `session_id`, index on
`status`), `$set` `auto_mode: false` on every existing agent.

## 4. Backend

- **`autonomy/AutoLoopRunner.ts`** — the engine. `setTimeout` per active loop, keyed by session id.
  A tick: yields to `sessionLock` (a live operator chat with that agent wins), persists the user turn
  (`seed` or `continue_text`), runs `agentRunner.run` with the session's history, mirrors it through
  `TurnRecorder` + `liveRuns` so a subscribed Workspace streams it live and a *closed* browser still
  gets the rich persisted turn, appends a progress entry, then re-arms unless the status changed.
  `resume()` at boot re-arms every `running`/`waiting` loop.
- **`domain/auto-loops/`** — model + repository (`auto-loop.model.ts`, `auto-loop.repository.ts`).
- **`tools/core/loopDone.ts`** — `loop_done({ summary })`. Auto-granted (like `data`/`guide`) *only*
  when the running session has an active loop, so an ordinary chat never sees it. Marks the loop
  `done`, cancels the pending timer, and returns to the agent that its loop has ended.
- **Prompt block** — `renderAutoLoopBlock()` in `jit-builder.ts`: the goal, the iteration number, the
  rolling progress recap, and the standing instruction to call `loop_done` when the goal is met (and
  to act rather than ask, since nobody may be watching). Folded into the single leading system
  message like every other JIT block.
- **Forum digest** — `forumRecall.digest(since)`: threads with activity since the watermark, rendered
  as a third section of the existing forum block. Pointers only (id + title + last author), same
  discipline as `FORUM_PLAN.md` §8 — the agent still has to call `forum` to read anything.
  Loop turns also force `forumReplies: true`.
- **Events** — `autoloop:state` on the EventBus → `auto_loop` on the wire (`bridge.ts`), scoped to
  the session room, so the panel shows status/iteration/countdown live.
- **Routes** — `/api/auto-loops`: `GET /:sessionId`, `POST /:sessionId/start`, `POST /:sessionId/stop`.

## 5. Frontend

- **AgentsView** — "Auto mode" checkbox beside "Subagent".
- **ChatPanel** — a **Loop** button next to Send, shown only when `agent.auto_mode`. It opens a panel:
  loop time, goal, continue text, kickoff text (first turn only), Start/Stop, and a live status line
  (`running · iteration 7 · next in 42s`).
- **store/stream.ts** — `autoLoop` slice fed by the `auto_loop` WS event; REST client in `lib/api.ts`.

## 6. Files

```
backend/migrations/20260819xxxxxx-auto-agent-loops.js      new
backend/src/domain/auto-loops/auto-loop.model.ts           new
backend/src/domain/auto-loops/auto-loop.repository.ts      new
backend/src/autonomy/AutoLoopRunner.ts                     new
backend/src/tools/core/loopDone.ts                         new
backend/src/transport/http/routes/auto-loops.routes.ts     new
backend/src/domain/agents/agent.model.ts                   + auto_mode
backend/src/domain/agents/agent.repository.ts              + auto_mode in create/update
backend/src/transport/http/routes/agents.routes.ts         + auto_mode passthrough
backend/src/domain/agents/jit-builder.ts                   + renderAutoLoopBlock
backend/src/domain/forum/forum-recall.service.ts           + digest() + digest section
backend/src/orchestrator/AgentRunner.ts                    + autoLoop block, forced forumReplies, loop_done grant
backend/src/tools/registry.ts                              + loopDone
backend/src/core/event-bus/events.types.ts                 + autoloop:state
backend/src/transport/ws/bridge.ts                         + auto_loop
backend/src/index.ts                                       + route + resume()
frontend/src/lib/api.ts                                    + autoLoopsApi
frontend/src/lib/ws-events.types.ts                        + AutoLoopEvent
frontend/src/store/stream.ts                               + autoLoop slice
frontend/src/components/workspace/ChatPanel.tsx            + Loop panel
frontend/src/views/AgentsView.tsx                          + auto_mode toggle
frontend/src/views/AgentWorkspace.tsx                      + agent passthrough
```
