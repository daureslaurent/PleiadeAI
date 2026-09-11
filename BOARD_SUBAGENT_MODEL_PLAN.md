# Board subagent mode — a small model does the work, the manager stays big

**Status:** planned · **Touches:** `inference/endpoint-gate.ts`, `inference/inference-resolver.ts`,
`orchestrator/AgentRunner.ts`, `domain/forum/forum-task-runner.ts`, `domain/forum/forum-plan.*`,
`domain/endpoints/*`, `domain/settings/*`, Connections / Fleet / Plan pages.

## 1. The ask, in one line

A project's **work turns** run on a cheap model; its **planning and review turns** stay on the
model the agent was configured with. The board already dispatches several tasks per tick — this
plan makes the inference layer actually able to stream them at once, and gives the board a model
of its own to send them to.

## 2. Why it is three changes and not one

The board's `forum_max_parallel` setting has existed since `FORUM_WORKBOARD_PLAN.md` §5, and its
own UI hint admits the problem: *"1 unless your inference endpoint genuinely serves concurrent
streams."* `endpoint-gate.ts` takes **one** FIFO lock per base URL — "a single llama.cpp slot can't
stream two turns at once". So raising the board's parallelism today buys nothing: four dispatches
queue behind one stream, and each one spends its project's turn allowance while it waits.

Three independent things therefore have to be true at once:

1. **The endpoint can serve N streams** — the gate becomes an N-permit semaphore, sized per
   endpoint (`parallel_slots`, mirroring llama.cpp's `--parallel`). This is not a board feature:
   it fixes queuing for chat, cron, flows and `ask_agent` hops in the same stroke.
2. **A run can be pointed at a model that is not its agent's** — `AgentRunner` has never had a
   per-run inference override; it resolves from `agent.endpoint_id` / `agent.model` and nothing else.
3. **The board knows which turns get the override** — work only.

## 3. Decisions taken

| Question | Decision |
| --- | --- |
| Where the subagent model is configured | Fleet setting **+ per-project override** on the plan |
| Which turns use it | **Work dispatches only.** Reviews, `ask_agent` hops and the PM keep the agent's own model |
| How parallelism is modelled | **Per-endpoint `parallel_slots`** (default 1), gate becomes an N-permit semaphore |
| Same agent, two dispatches at once | **Allowed** — no new scheduler restriction |
| Parallel-safe planning | **Prompt guidance only** in `planBrief`; no new task field, nothing enforced |
| Manual Run button | Uses the subagent model too — `dispatchNow` goes through the same `dispatch()` |

### Why reviews keep the big model

A reviewer that rubber-stamps costs more than it saves: on this board a passed-but-wrong
deliverable becomes the input of every task that depends on it, and a wrongly-failed one costs the
owner a whole turn against the project's leash. The judgement call is the cheap turn in tokens and
the expensive one in consequences, so it stays where it is.

### Why `ask_agent` hops are not overridden

The override is a property of *this dispatch*, not of the agent. An agent that delegates is asking
a specialist a question, and the specialist was configured with the model it needs. Threading the
override down hops would also quietly re-model every sub-agent in the fleet the moment a board task
touched it. `AgentRunner.hop` therefore does not propagate `input.inference` — the same rule the
picked inference modes already follow (depth 0 only).

## 4. Resolution order for a work dispatch

```
plan.subagent_endpoint_id / plan.subagent_model   (per project, optional)
  └→ settings.forum_subagent_endpoint_id / _model (fleet, optional)
      └→ nothing → the agent's own endpoint_id / model, exactly as today
```

Each level is *independent per field*: a plan may override only the model and inherit the endpoint.
An empty string / null at a level means "not set here", never "clear it".

## 5. Work items

### 5.1 Parallel slots (`inference/`, `domain/endpoints/`)

- `endpoint.model.ts` — `parallel_slots: { type: Number, default: 1 }`, documented as the llama.cpp
  `--parallel` / `-np` value.
- `endpoint-gate.ts` — replace the single promise-tail per URL with an N-permit semaphore:
  - `acquire(url, model, slots)` takes the slot count from the caller (the resolver carries it).
  - `EndpointStat.current: GateCall | null` → **`running: GateCall[]`**; `active` becomes the
    running length and may exceed 1. `waiting` keeps its FIFO meaning.
  - A slot count that *shrinks* while calls are in flight must not strand permits: the semaphore
    reads its limit on each release, so lowering it simply stops admitting until the extra calls drain.
- `inference-resolver.ts` — `ResolvedInference.parallelSlots`, read from the endpoint (default 1),
  so `LlamaClient` never has to look an endpoint up mid-stream.
- `endpoint.service.ts` / `llm.routes.ts` / `EndpointBadge.tsx` — `running` is now a list.
  The badge renders each streaming call with its own pulse and keeps the FIFO numbering for the queue.
- Connections page — a "Parallel streams" number per endpoint, with the warning that it must match
  what the server was launched with: over-declaring queues *inside* llama.cpp instead, where this
  app cannot see it.

### 5.2 The run override (`orchestrator/`, `inference/`)

- `resolveInference(agent, modeIds, modesOff, override?)` where
  `override = { endpointId?: string | null; model?: string }`. The override replaces the agent's
  fields *before* endpoint lookup, so modes, context window, vision and samplers all resolve against
  the model that will actually run — a small model's smaller `n_ctx` must be the meter's denominator,
  or the context bar lies about the turn that is at risk.
- `RunInput.inference?: { endpointId?: string | null; model?: string }` on `AgentRunner`.
  Not propagated by `hop`.
- Failover is unchanged: `resolveFallbacks(inference.url)` still excludes whatever URL resolved,
  so a dead subagent endpoint falls back down the ordinary chain rather than failing the task.

### 5.3 The board (`domain/forum/`, `domain/settings/`)

- `settings.model.ts` + `settings.service.ts` + `settings.routes.ts` —
  `forum_subagent_endpoint_id: String` and `forum_subagent_model: String`, both `''` by default
  (off → today's behaviour). **The whitelist in `settings.routes.ts` is mandatory**, or the keys
  silently never persist.
- `forum-plan.model.ts` — `subagent_endpoint_id` / `subagent_model`, same empty default.
- `forum-task-runner.ts` — `dispatch()` resolves the override for `kind === 'work'` only and passes
  it through `drive()` into `agentRunner.run`. `drive()` gains an optional last argument so
  `forumPlanService.runManager`, which shares it, is untouched and keeps the default model.
- `forum-plan.service.ts` — `planBrief` asks for a *wide* graph: independent tasks, `depends_on`
  only for genuine ordering, and no two concurrent tasks writing the same file or workspace. It also
  tells the manager the tasks will be executed by a smaller model, which is what actually changes how
  it writes acceptance criteria — a small model needs criteria it can check, not criteria it can argue.
- Board routes — `PATCH /api/board/plans/:id` accepts the two override fields.

### 5.4 UI

- **Fleet panel** (`/settings/fleet`, the work-board section) — endpoint + model picker for the
  fleet subagent model, directly under "Tasks running at once" since the two only make sense together.
- **Plan page** (`PlanView.tsx`) — the same picker, per project, next to the turn allowance.
  Empty = inherit the fleet setting.

## 6. What this deliberately does not do

- **No enforcement of parallel safety.** Two tasks owned by different agents may still write the
  same file at the same moment. The PM is asked to avoid it; nothing stops it. If that turns out to
  bite, the next step is an `exclusive: string[]` tag on `forum_tasks` that `readySet()` honours —
  not a lock, which would deadlock a graph the manager got wrong.
- **No per-agent board model.** The override is a property of the dispatch, so an agent reads the
  same everywhere else it is used.
- **No auto-probe of `n_parallel`.** `llama-introspect.ts` could read it from `/props`, but a wrong
  auto-value silently thrashes the GPU; the operator declares it.

## 7. Verification

`npm run typecheck` in both apps, a migration for the three new fields, then: two projects running
with `forum_max_parallel: 3` against an endpoint with `parallel_slots: 3` — the LLM page should show
three `active`, zero `queued`, and the work sessions should name the small model while the plan and
review sessions name the agent's own.
