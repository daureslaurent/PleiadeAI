# Subagents — an agent splits its own work into parallel, fresh-context tasks

**Status:** implemented (2026-09-13) · verified by typecheck + builds of both apps, isolated tests of
`TurnRecorder` routing and module assembly, and an end-to-end run of the real backend against a
scripted mock llama.cpp server (see *Verification results* at the bottom).

## Context

A long agent turn fills the context: every file read, grep or fetch stays in the transcript. The goal
(like opencode's `task` / Claude Code's Agent tool): an agent hands a **self-contained brief to a
copy of itself** that runs with a **fresh context**, possibly on a **different (small, long-context)
model**, and gets back only a **short report**. Independent tasks run **in parallel**, capped by the
subagent endpoint's **Parallel streams** (`parallel_slots`). With 1 slot they run one after another,
the same as today's serial hops. The feature is a **new module** (tool + prompt blocks + settings
behind one switch), plus a **subagent module profile**: per module, whether it also applies inside
a child run, so a small model's prompt stays lean.

Locked decisions (from the user):
- Modules: parent-guidance block + child-contract block, **and** a per-module "In subagent runs" switch.
- Model: **fleet default + per-agent override**, falling back to the agent's own model.
- Child tools: **mode per task**. `explore` = read-only tools, runs in parallel; `work` = full tools, runs serially.
  Children never get `task`, `ask_agent`, `annuaire`, `ask_parent`, `ask_user`, `todowrite`, `loop_done`.
- `ask_agent` **stays serial** (unchanged).

Already exists and gets reused: `RunInput.inference` override + `resolveInference(agent, [], [], override)`
(`inference/inference-resolver.ts`); the N-permit `endpointGate`; `planToolGroups` / `runWithConcurrency`
/ `isParallelSafe` (`orchestrator/AgentRunner.ts`, `tools/parallel-safety.ts`); `AgentRunner.hop`
(events, run ids, depth guard); the FleetPanel endpoint+model picker (`endpointField`/`modelField`,
used by `forum_subagent_*`); `AgentModelSelect`.

**Blocker found:** the chat store (`frontend/src/store/stream.ts`) and `transport/ws/TurnRecorder.ts`
route every event to the **top of a frame stack** ("runs are a strict stack"). Two children streaming
at once would interleave into one bubble. Events must be routed **by run id** instead. This is
step 1, because nothing else can be seen working without it.

---

## 1. Route live events by run id (backend + frontend)

- `core/event-bus/events.types.ts`: `EventContext.runId?: string`. `AgentRunner.run` sets it on `ctx`
  (it already has `runId`). `AskAgentPayload` gains `callId?`, `task?: { description; mode; model }`.
  `AskAgentDonePayload` gains `childRunId`.
- `transport/ws/bridge.ts`: add `runId` (= `ctx.runId`) to `stream_chunk`, `tool_call_stream`,
  `tool_start`, `tool_output`, `tool_end`, `memory_recall`, `todo_update`, `context_usage`. Add
  `parentRunId`, `callId` and `task` to `agent_hop`, and `childRunId` to `agent_hop_done`. Mirror the
  types in `frontend/src/lib` WS event types.
- `TurnRecorder.ts` and `store/stream.ts` (same change in both): replace `top`/`frameStack` routing with
  `frameFor(depth, runId)`. Depth 0 → `root`. Otherwise → the frame whose `runId` matches. If none
  matches, fall back to the last open frame, which keeps old snapshots working.
  - Hop: the parent frame = `frameFor(parentDepth, parentRunId)`. Done: close the frame by `childRunId`.
  - Tool events: match on `(frame, callId)`. Fallback ids like `fallback_0_0` repeat across parallel children.
  - `tool_call_stream` `reset` removes drafts of **that frame only** (today it wipes every frame's drafts).
  - Snapshot keeps `frameStack` for shape compatibility, but routing no longer reads it.
- **Task bubble inside its tool card:** a hop carrying `callId` is attached to that tool block instead
  of becoming a sibling item. Siblings would break the batch card's adjacency rule in `Blocks.tsx`.
  `buildBlocks` (both copies) sets `tool.subagent = <agent block>`, and the `Block` tool type gains
  `subagent?`. ask_agent hops carry no `callId`, so they render exactly as today.

## 2. Backend: the `task` tool and the child run

**`tools/core/task.ts`** (register in `tools/registry.ts` `CORE_TOOLS`):
- Params:
  - `description`: 3–7 words, the UI label.
  - `prompt`: a complete brief. The child sees nothing else.
  - `mode`: `explore` | `work`, default `explore`.
- `parallelSafe: (args) => args.mode !== 'work'`, so explore calls group together and a work call
  runs alone.
- Calls `ctx.invokeTask({description, prompt, mode})` (new optional field on `ToolContext` in
  `tools/types.ts`, same thin-adapter pattern as `askAgent.ts`).
- Returns `{ ok, description, mode, model, report, truncated, cut_off }`, or `{ ok:false, error }`.

**`AgentRunner`:**
- `RunInput.task?: { mode; description; reportMaxChars }`. `RunResult.truncated` (= `!finishedCleanly`).
- Per parent run, a lazy **subagent runtime**, resolved on first `task` call:
  - Model override: `agent.subagent_endpoint_id/model` → `settings.subagent_endpoint_id/model` → none (the agent's own model).
  - `childInference = resolveInference(agent, [], [], override)`.
  - `limiter` = a semaphore sized `childInference.parallelSlots`, further capped by `tool_parallel_max`
    when > 0. **This lock is held for the child's whole run**, so with 1 slot children run strictly one
    after another, not interleaved round by round. `tool_parallel_enabled: false` → the planner already runs everything serially.
- `executeToolCall` injects `invokeTask` only when `canSpawn && !input.task` and the `task` tool is resolved.
  It is built by `makeTaskInvoker`, which:
  1. acquires the limiter;
  2. calls `hop()` with a new, separate optional `extra` arg `{ inference, task, callId }`. `hop`'s
     `Pick` allowlist for ask_agent stays untouched.
  3. The child gets `userText: prompt`, no history, `persistMemory: false`, same `signal`/`turnId`.
  4. The report is the child's `fullText`, cut to `reportMaxChars` with a visible `[…report truncated]`
     marker.
- **`reportMaxChars`** = clamp( (contextWindow − parent's last promptTokens) × 0.5 ÷ tasks in this
  batch × 3.5 chars/token, 1500, `settings.subagent_report_max_chars` ). It comes from the parent's
  real `n_ctx`, so N reports can't overflow a small-context parent.
- `run()` when `input.task` is set:
  - Tools: skip the orchestration auto-grant and remove the excluded names above.
  - `explore`: keep only tools where `isParallelSafe` could be true (boolean `true`, a predicate, or
    `UNDECLARED_READ_ONLY`). In the tool loop, a call whose `isParallelSafe(tool,args)` is false gets
    `{ok:false, error:'read-only task: …'}` without executing. That catches `forum post_thread` and
    similar verb-style tools.
  - Modules: resolve with scope `subagent` (step 3), for both the blocks and `resolveTools`.
  - `promptCtx.task` = `{ mode, description, reportMaxChars, parentName }`.
- `promptCtx.subagents` (for the parent block) = `{ available, slots, model, parallel }`. It needs no
  DB hit if the runtime isn't resolved: read slots from the resolved override up front, since
  `resolveInference` is cheap and already used per turn.
- Grant `task` to every non-task run (like `data`/`guide`), subject to the module switch and the
  Tools-page kill switch.

## 3. Modules: the Subagents module + subagent profile

- `modules/types.ts`:
  - `PromptModule.subagentDefault?: boolean` (default true).
  - `PromptContext.task` and `PromptContext.subagents`.
  - `ModuleScope = 'turn' | 'subagent'`.
- `modules/state.service.ts`:
  - Read `settings.modules_disabled_subagent` (ids flipped from `subagentDefault`, same semantics as `modules_disabled`).
  - `enabled(id, scope='turn')`: in subagent scope = enabled globally **and** in the profile. Mandatory modules are always on.
  - `toolsDisabledByModules(state, scope)`.
- `tools/registry.ts` `resolveTools(names, scope?)` passes the scope through.
- `modules/assemble.ts`: `assembleSystemMessage`/`assembleUserText` take the scope. Custom modules follow the profile as well (default on).
- **`modules/definitions/work.ts` → `subagentsModule`**:
  - `id:'subagents'`, `group:'work'`, `tools:['task']`.
  - `settingsKeys: ['subagent_endpoint_id','subagent_model','subagent_report_max_chars','tool_parallel_max']`.
  - Block **"Subagents"** (`system_head`, order 55): rendered when `!ctx.task && ctx.subagents?.available`.
    - Covers when to delegate (broad, read-heavy work with a short answer) and when not (small tasks, or ones needing the conversation).
    - Tells the agent to write complete briefs and state the expected report shape.
    - Explains `explore` vs `work`.
    - One live sentence from `slots`: "up to N run at the same time" vs "they run one after another".
    - Tells the agent to issue independent tasks in **one reply** and to verify cited evidence before acting on it.
  - Block **"Subagent task"** (`system_head`, order 15): rendered when `ctx.task`.
    - "You are a subagent working for <parentName>'s run; nobody can answer questions."
    - "Do only the brief."
    - Mode rules: in `explore`, never modify anything.
    - "Finish with a report ≤ ~N chars: findings, each with evidence (file:line, URL, exact quote), then open issues."
  - `renderOrchestrationBlock` returns null when `ctx.task`. The Environment block's role line says
    "subagent task" when `ctx.task`.
- Subagent defaults (`subagentDefault: false`): `memory`, `forum`, `board`, `auto-loop`, `todo`,
  `orchestration`. All others default on.
- Register in `modules/registry.ts`. Update `modules/preview.ts` with sample `task`/`subagents` data and a `scope` arg.
- `modules/admin.service.ts`: `setModuleSubagentEnabled(id, on)` (refuses mandatory modules).
  `listModules` returns `subagentEnabled`/`subagentDefault`.
- `transport/http/routes/modules.routes.ts`: `PUT /:id` accepts `subagent`, and `POST /preview` accepts `scope`.
- `domain/llama-logs/prompt-usage.ts` needs nothing, since titles come from the registry.

## 4. Settings, agent fields, migration

- `domain/settings/settings.model.ts` + `settings.service.ts`:
  - `subagent_endpoint_id: ''`, `subagent_model: ''`, `subagent_report_max_chars: 6000`, `modules_disabled_subagent: []`.
  - **Add the three scalar keys to the `settings.routes.ts` PUT whitelist** (otherwise they silently don't
    persist). `modules_disabled_subagent` is validated like `modules_disabled`.
- `domain/agents/agent.model.ts`: `subagent_endpoint_id: ObjectId|null`, `subagent_model: ''`. In
  `agents.routes.ts` PATCH, empty `subagent_endpoint_id` → null (same as `endpoint_id`).
- New `backend/migrations/<ts>-subagents.js`: backfill the settings fields and the agents'
  `subagent_endpoint_id: null, subagent_model: ''`, with a `down` that unsets them.

## 5. Frontend

- **Settings → Fleet** (`views/settings/panels/FleetPanel.tsx`): a "Subagents" section reusing the
  existing endpoint+model picker (`endpointField="subagent_endpoint_id"`, `modelField="subagent_model"`),
  plus a report-size number. The hint names the chosen endpoint's Parallel streams ("up to N at once").
  `lib/api.ts` settings type.
- **Agents page** (`views/AgentsView.tsx`): a "Subagent model" picker under the model picker.
  `AgentModelSelect` is generalised with `endpointKey`/`modelKey` props, an "Inherit fleet default"
  empty option, and a note showing the effective endpoint's Parallel streams.
- **Settings → Modules** (`views/settings/ModulesSettings.tsx`): an "In subagent runs" toggle per row
  (disabled when the module is off or mandatory), and a preview scope switch "Parent turn / Subagent run".
- **Chat**:
  - `Block` tool type gets `subagent?`.
  - `components/workspace/Blocks.tsx` / `ToolCall`: a `task` card renders its nested agent bubble,
    reusing the existing agent panel component; in a batch card, expanding the row shows the bubble.
  - `lib/toolSummary.ts`: a `task` case (icon, description, mode chip).
  - Store routing changes are in step 1.
- Theme rule: Tailwind classes only, no hex values.

## 6. Docs

- `SUBAGENT_PLAN.md` at the repo root (this plan as the durable handle), plus a **Subagents** bullet
  in `CLAUDE.md` Architecture and a note in `TOOL_PARALLEL_PLAN.md` about run-id routing.

## Order of work

1 run-id routing (backend + store + recorder) → 2 `task` tool + runner → 3 modules/profile →
4 settings/agent/migration → 5 frontend pickers, modules toggle, task card → 6 docs.
Typecheck after each step.

## Verification

- `npm run typecheck` in `backend/` and `frontend/`, then `npm run build` in `backend/`. Restart the backend;
  it runs from `dist/`, and the migration auto-applies at boot.
- Settings → Connections: set the small-model endpoint's Parallel streams to 2. Settings → Fleet: pick it as the subagent model.
- In chat, ask an agent to research 3 independent things. Expect:
  - one reply with 3 `task` calls, and one batch card with 3 nested bubbles streaming **separately**;
  - LLM activity page showing 2 active + 1 queued on that endpoint;
  - the parent's next pass receiving 3 capped reports.
- Set Parallel streams to 1 and repeat: the bubbles run strictly one after another.
- Reload the page mid-run: the snapshot restores all bubbles in the right places. After the turn,
  reopen the session: the persisted turn renders identically.
- An `explore` child trying `write`/`bash`/`forum post_thread` gets the read-only refusal. A `work`
  task runs alone, not grouped.
- Settings → Modules: turn Memory off for subagent runs. The preview's "Subagent run" scope drops the
  block, and the LLM Debug context breakdown of a child call shows no Memory block and no embedding call.
- `ask_agent` behaviour unchanged (serial, bubble as a sibling as before). Stop during a parallel batch
  aborts all children.

---

## Implementation notes (where the build differs from, or adds to, the plan above)

- **Slots are reserved in emission order.** The first E2E run showed children taking slots in the
  order their async setup happened to resolve (C, B, A). `executeToolCall` now calls
  `limiter.acquire()` *before its first await*, so a batch's `task` calls queue in the order the model
  issued them. The slot is released when the child ends, and again (idempotently) when the call ends.
- **Pre-existing bug fixed along the way:** a call to a tool the agent does not hold returned its
  `unknown tool` error without appending it to the transcript. The assistant `tool_call` had no answer,
  and the model re-issued the same call. The result is now pushed like any other.
- **Two layers of read-only enforcement for `explore`:** the toolset is narrowed with `mayRead`
  (`tools/parallel-safety.ts`), and each call is re-checked with `isParallelSafe` before it runs. That
  refuses verb-style writes such as `data save` or `forum post_thread`.
- **Rendering:** a task bubble lives in the tool block (`tool.subagent`) in both `buildBlocks`. The
  chat draws the card (or the batch's group card) and then the bubble(s) under it, so `ToolBatch` and
  `ToolCall` needed no changes. `activityLabel` hands the spinner to running bubbles, and
  `attachScoreToBubble` descends into `tool.subagent`.
- **Children are seeded with the session's prior resource handles** (like a depth-0 run), so a brief
  can name `blob_3`.
- **Picker fallback order on the Agents page** mirrors the runner: the agent's own override, else the
  fleet subagent default, else the agent's own endpoint + model.

## Verification results

Mock llama.cpp server (1.2 s per stream), parent issues 3 `explore` tasks; child B tries `write` and
`data save`; child A answers with 8000 characters; endpoint `context_window` 8192.

| Check | Result |
|---|---|
| Parallel streams = 2 | max 2 concurrent child streams; A and B start together, C waits for a slot |
| Parallel streams = 1 | strictly serial: A, then B (both its passes), then C |
| Report budget | A cut to 4195 chars (= (8192−1000)·0.5÷3·3.5) with a visible marker |
| `explore` child toolset | `read,list,analyze_image,data,guide` — no `write`, `task`, `ask_*`, `todowrite` |
| `explore` refusal | `write` → unknown tool; `data save` → "read-only task" error; no file created |
| Prompts | parent has *Subagents* + *Orchestration*; child has *Subagent task*, no Orchestration/Memory |
| Events | every `stream_chunk` carries `runId`; `agent_hop` carries `callId`/`parentRunId`/`task` |
| Fleet subagent model | children ran on `mock-small` while the parent used `mock-model` |
| Settings / agent / modules API | whitelist persists; empty agent endpoint → null; mandatory profile switch → 409 |
| Migration | `20260913120000-subagents.js` applies cleanly on a fresh DB |

Not verified here: a real model's behaviour (inference boxes unreachable from the dev host), and a
visual pass over the chat/Modules/Agents UI in a browser.
