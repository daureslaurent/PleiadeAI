# Bidirectional agent communication: `ask_parent` + `ask_user`

Today delegation is strictly one-shot: a parent calls `ask_agent` → the subagent runs its whole
turn to completion → returns one answer string. While the subagent runs, the parent is frozen inside
the `tool.execute` promise (`AgentRunner.makeInvoker`). There is no back-channel.

This adds two back-channels:

1. **`ask_parent`** — a subagent (any delegated run) can pose a clarifying question to the agent that
   delegated to it. The **parent LLM answers** by re-running as an inference turn, seeded with the
   **parent's original conversation context** so it remembers the task it delegated. Symmetric to
   `ask_agent`; reuses the existing hop event/visualisation.
2. **`ask_user`** — **any** agent (top-level or subagent, any depth) can ask the **human operator** a
   question. The run **blocks** while a modal is shown in the UI (opencode-style); the typed answer
   is returned to the agent, which continues its loop.

Bound by the existing `HopGuard` (`MAX_AGENT_HOPS`): `ask_parent` consumes a hop (parent answers at
`depth+1`), so ping-pong is capped. The parent, when answering a clarification, is **not** given an
`ask_parent` of its own (no `caller` propagated) → no infinite ladder.

## Backend

### Threading caller context (`orchestrator/AgentRunner.ts`)
- `RunInput` gains `caller?: { agentName: string; task: string; history: ChatMessage[] }`.
- In `run()`, capture the parent's clean conversational context once:
  `callerHistory = [...(input.history ?? []), buildUserMessage(input.userText, input.images)]`
  (the parent's turn *minus* its in-flight tool call, so it's a well-formed history).
- Effective toolset: add `ask_user` for **every** agent; add `ask_parent` only when `input.caller`
  is present.
- `executeToolCall` gains `caller` + `callerHistory`; builds the toolCtx with:
  - `invokeSubAgent: canSpawn ? makeInvoker(ctx, callerHistory) : undefined`
  - `askParent: (caller && canSpawn) ? makeParentAsker(ctx, caller) : undefined`
  - `askUser: (q) => askUserBroker.ask(ctx, q)`
- `makeInvoker(ctx, callerHistory)` now sets `caller` on the child run:
  `caller: { agentName: ctx.agentName, task: query, history: callerHistory }`.
- New `makeParentAsker(childCtx, caller)`: guards `canHop(depth+1)`, emits `agent:ask_agent`
  (from=child, to=parent) so the UI nests a parent bubble under the child, runs the parent with
  `history: caller.history` and a framed question, emits `agent:ask_agent_done`. Passes **no**
  `caller` (parent can't ask its own parent while answering).

### `ask_parent` / `ask_user` tools (`tools/core/askParent.ts`, `tools/core/askUser.ts`)
Thin adapters over `ctx.askParent` / `ctx.askUser`, mirroring `askAgent.ts`. Register both in
`tools/registry.ts` `CORE_TOOLS`. `ToolContext` (`tools/types.ts`) gains
`askParent?` and `askUser?` dispatchers.

### AskUser broker (`transport/ws/AskUserBroker.ts`)
Singleton mapping `requestId → { sessionId, resolve, reject, timer }`.
- `ask(ctx, question): Promise<string>` → new `requestId`, store resolver, emit `agent:ask_user`
  (payload `{ ctx, requestId, question }`), arm a timeout (`ASK_USER_TIMEOUT_MS`, 15 min) that
  rejects. Returns the promise.
- `resolve(requestId, answer)` — clears timer, resolves.
- `cancelSession(sessionId)` — rejects every pending request for a disconnected session.

### Events + bridge
- `events.types.ts`: `AskUserPayload { ctx; requestId; question }`, add
  `'agent:ask_user'` to `EventMap`. (`ask_parent` reuses `agent:ask_agent`/`_done`.)
- `bridge.ts`: `agent:ask_user` → wire `ask_user { requestId, agent, question }`.
- `socket.ts`: track this connection's joined sessions; `socket.on('ask_user:response', …)` →
  `askUserBroker.resolve`; on `disconnect` → `cancelSession` for each.

## Frontend

- `lib/ws-events.types.ts`: add `AskUserEvent { type:'ask_user'; requestId; agent; question }` to the
  `WsEvent` union.
- `store/stream.ts`: state `pendingAsk: { requestId; agent; question } | null`; `socket.on('ask_user')`
  sets it; `answerAsk(answer)` emits `ask_user:response` + clears; clear it on `chat:done`,
  `send`, `clearActive`, `hydrate`.
- `components/workspace/ChatPanel.tsx`: when `pendingAsk` is set, render a modal (agent name +
  question + textarea + Send) that calls `answerAsk`.

## Verify
`npm run typecheck` in both `backend/` and `frontend/`. Manual: agent chain where a subagent calls
`ask_parent`; agent calls `ask_user` → modal appears → answer flows back.
</content>
</invoke>
