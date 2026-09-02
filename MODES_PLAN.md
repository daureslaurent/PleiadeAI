# MODES_PLAN.md — Per-model inference modes

Operator-defined **modes** attached to a *model* on an inference endpoint, toggled per conversation
from the chat composer. Default state is "no mode": nothing about today's behaviour changes.

Two kinds:

- **`sampling`** — overrides llama.cpp sampling for the turn: `temperature`, `top_p`, `top_k`,
  `min_p`, `presence_penalty`, `repetition_penalty`. Every field is individually optional; an unset
  field is not sent and the existing global setting (or the server's default) stands.
- **`prompt`** — appends operator-authored text to the turn. `placement` decides where:
  `system_suffix` (end of the single leading system message) or `user_suffix` (end of the user
  turn — the placement llama.cpp control tokens such as `/no_think` require).

A model may carry any number of modes of either kind, and the operator may have **any number of
them active at once** in a conversation.

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

Selection lives on the session: `sessions.mode_ids: string[]`. Persisting it there (rather than in
the composer's React state) is what makes an auto-loop tick, a `continue` nudge and a reload all run
the conversation in the modes the operator picked.

## 2. Resolution

`inference/modes.ts` owns the whole rule set:

- `selectModes(endpoint, model, ids)` — the enabled modes on this endpoint whose `model` matches the
  turn's *resolved* model and whose id the session asked for, in array order.
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
- `GET /api/endpoints/modes?agentId=…` returns the modes applicable to that agent's resolved
  endpoint+model — the composer never has to re-implement the resolution precedence.
- `PATCH /api/sessions/:id` accepts `mode_ids`.

## 4. UI

**Settings → Connections → endpoint card**: a "Modes" section listing each mode as a compact row
grouped under its model, with an inline editor (type-specific fields) and add/delete. Sampling
fields are blank-means-unset number inputs.

**Chat composer**: a chip row above the textarea, one chip per applicable mode, toggling on click.
The row is absent entirely when the agent's model has no modes — the default install sees no new
chrome. Per DIRECT_ART, the two types are visually distinct: `sampling` chips read in **accent
blue** (a knob on the machine), `prompt` chips in **reasoning purple** (words entering the model's
head), inactive chips as on-glass neutrals.
