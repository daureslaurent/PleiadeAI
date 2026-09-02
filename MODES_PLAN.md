# MODES_PLAN.md — Inference modes

Operator-defined **modes** attached to a *model* on an inference endpoint, toggled per conversation
from the chat composer. Default state is "no mode": nothing about today's behaviour changes.

Two kinds:

- **`sampling`** — overrides llama.cpp sampling for the turn: `temperature`, `top_p`, `top_k`,
  `min_p`, `presence_penalty`, `repetition_penalty`. Every field is individually optional; an unset
  field is not sent and the existing global setting (or the server's default) stands.
- **`prompt`** — appends operator-authored text to the turn. `placement` decides where:
  `system_suffix` (end of the single leading system message) or `user_suffix` (end of the user
  turn — the placement llama.cpp control tokens such as `/no_think` require).

  An enabled prompt mode is **stamped, not appended**. Raw text landed after the notebook and read
  as more of the agent's own notes — and the notebook is deliberately the *lowest*-authority block
  in the prompt, so the instruction inherited the authority of a scratch pad. `renderActiveModesBlock`
  / `renderModeUserSuffix` (`jit-builder.ts`) wrap it in a block that names the operator as its
  author and says what it outranks. Placement is purely an authority-and-recency choice, never a
  cache one: the environment block's minute-resolution clock already changes the prompt prefix on
  every turn, so nothing is cacheable across turns anyway.

A model may carry any number of modes of either kind, and the operator may have **any number of
them active at once** in a conversation.

Modes come in two scopes:

- **Per-model** — defined on an endpoint, tagged with the model they belong to, offered only when
  that model is the one running. Either kind.
- **Global** — offered in *every* conversation whatever endpoint and model it runs on. Either the
  app's own **built-ins** (`domain/settings/builtin-modes.ts` — code-defined and read-only, like the
  `managed` fallback endpoint: composed into the settings on every read rather than seeded, so they
  improve with the app instead of freezing at whatever a migration once wrote; the operator may
  still switch one off, stored as an id in `settings.global_modes_disabled`, which is a choice about
  their own chip row rather than an edit), or the operator's own, defined in Settings → Inference. **`prompt` only, by construction**: a temperature that suits one
  model is not a claim you can make about the whole fleet, whereas a standing instruction ("answer
  in French") travels across models perfectly well. Stored on the settings singleton
  (`settings.global_modes`), not on any endpoint.

---

## 1. Storage

`endpoints.modes[]` — one array on the endpoint doc, each entry tagged with the model it belongs to.

```ts
{
  id: string,            // stable, minted server-side; what a session references
  model: string,         // model id this mode belongs to (must be one of endpoint.models)
  name: string,          // shown on the composer chip
  type: 'sampling' | 'prompt',
  enabled: boolean,      // off = hidden from the composer, kept for later
  params: {              // sampling only; null/absent = don't send this field
    temperature, top_p, top_k, min_p, presence_penalty, repetition_penalty
  },
  text: string,          // prompt only
  placement: 'system_suffix' | 'user_suffix',   // prompt only
}
```

An explicit `id` string rather than a Mongoose subdocument `_id`: the UI saves the whole array on
edit, and subdocument ids would be re-minted on every save, orphaning the session references.

A global mode is the same record minus `model` and `type` (always `prompt`), and `asEndpointModes`
lifts it into the common shape with `model: '*'` so callers apply one stack and never branch on
where a mode came from.

Selection lives on the session: `sessions.mode_ids: string[]` — one id space across both scopes. Persisting it there (rather than in
the composer's React state) is what makes an auto-loop tick, a `continue` nudge and a reload all run
the conversation in the modes the operator picked.

## 2. Resolution

`inference/modes.ts` owns the whole rule set:

- `offeredModes(endpoint, model, globals)` — everything on offer for a turn on this model: the
  endpoint's per-model modes first, then the globals.
- `selectModes(endpoint, model, ids, globals)` — those of them the session asked for, in array
  order. Globals come last, so a model-specific sampling preset can't be undone by a fleet-wide one.
- `applySampling(base, modes)` — folds each sampling mode's set fields onto the resolved target,
  last-wins per field.
- `promptAdditions(modes)` — the system/user suffix strings, in order.

`ResolvedInference` grows `topK`/`minP`/`presencePenalty`/`repetitionPenalty` (all `null`able,
meaning "don't send") plus `promptSuffixes: { system: string[]; user: string[] }`.
`resolveInference(agent, modeIds)` takes the ids; `LlamaClient.attemptStream` puts the extra
samplers on the wire (`top_k`, `min_p`, `repeat_penalty` are llama.cpp extensions to the OpenAI
body, so they're set on a cast body object).

Scope rules, deliberately:

- **Depth 0 only.** `AgentRunner` reads `session.mode_ids` for the top-level run. A sub-agent hop
  resolves without them: the operator's chat-level choice is not an instruction to every delegate.
- **Fallback endpoints get no modes.** A mode belongs to one model on one endpoint; the failover
  chain is a different box running a different model, so `resolveFallbacks` stays untouched.
- **A stale id is silently ignored** — deleting a mode can't break the conversations that used it.

## 3. Surfaces

- `PATCH /api/endpoints/:id` accepts `modes` (normalized + id-minted server-side).
- `PUT /api/settings` accepts `global_modes` (same contract; whitelisted in `settings.routes.ts`, or
  it would silently never persist).
- `GET /api/endpoints/modes?agentId=…` returns the modes applicable to that agent's resolved
  endpoint+model — the composer never has to re-implement the resolution precedence.
- `PATCH /api/sessions/:id` accepts `mode_ids`.

## 4. UI

**Settings → Inference → endpoint card**: a "Modes" section listing each mode as a compact row
grouped under its model, with an inline editor (type-specific fields) and add/delete. Sampling
fields are blank-means-unset number inputs.

**Settings → Inference → Global modes**: the same mode rows without the model picker, and only an
"Add global mode" button — there is no control to make one sampling.

**Chat composer**: a chip row above the textarea, one chip per applicable mode, toggling on click.
The row is absent entirely when the agent's model has no modes — the default install sees no new
chrome. Per DIRECT_ART, the two types are visually distinct: `sampling` chips read in **accent
blue** (a knob on the machine), `prompt` chips in **reasoning purple** (words entering the model's
head), inactive chips as on-glass neutrals.
