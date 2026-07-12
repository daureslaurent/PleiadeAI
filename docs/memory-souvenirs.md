# Qdrant memory → "souvenirs"

Replaces the raw-transcript vector memory with distilled, typed, scored memories.
The agent **notebook** (`agents_md` / `notebook`) is unchanged — it stays the place for
deliberate, author-owned notes. This is only about the Qdrant vector store.

## What was wrong

Write path (`AgentRunner.ts`, post-turn):

```ts
void agentMemory.remember(ns, `User: ${input.userText}\n${agent.name}: ${finalText}`,
  { source: 'auto_turn', session_id });
```

Every turn, verbatim, both roles, one embedding.

- **A whole turn is a bad embedding unit.** One 768-d vector averaging a question, an essay
  and two speakers points nowhere: it weakly matches everything and strongly matches nothing.
- **No salience.** "ok thanks" is stored with the same weight as a real decision.
- **No dedup / no update / no death.** Ask the same thing five times → five near-identical
  points. "I use Postgres" and "I moved to Mongo" both live forever, equally weighted, and the
  model is served the contradiction with no way to tell which is current.
- **Tags were write-only** — `remember` stored them, nothing ever read them.

Read path (`AgentRunner.ts:244` → `qdrant.service.ts:45`):

- **No `score_threshold`.** Qdrant returns the top 5 no matter how irrelevant. Cosine between
  unrelated normalized embeddings rarely drops below ~0.3, so *every* turn injected 5 memories
  under a header that claims they are relevant.
- **Query = the raw last user message.** "and the second one?" embeds to mush.
- **No recency, no importance, no usage, no diversity** — pure single-shot cosine.

## Design

Stays **Qdrant-only**. Everything below lives in the point payload; no Mongo entity, no
migration of the memory store itself, and `exportNamespace` / clone / transfer keep working.

### Payload

```ts
{
  text: string,                 // distilled, standalone, third person
  kind: 'fact'|'preference'|'episode'|'procedure',
  subject: string,              // short topic/entity key, used for grouping + supersede
  importance: 1..5,
  tags: string[],
  source: 'distiller'|'remember_tool'|'auto_turn',   // auto_turn = legacy, wiped by hand
  status: 'active'|'superseded',
  superseded_by: string|null,
  created_at: iso,
  last_recalled_at: iso|null,
  recall_count: number,
  reinforced_count: number,
}
```

### Write — distillation, not dumping

After each turn, fire-and-forget (same shape as `scoringService.autoScoreTurn`):

1. Embed the exchange, pull the ~10 nearest **active** existing memories.
2. **One call on the agent's own endpoint** (`resolveInference(agent)` — same model, same
   persona, so the agent's own voice writes its own memories). It gets the exchange *and* those
   existing memories with their ids, and returns JSON-schema-constrained:
   `{ memories: [{ text, kind, subject, importance, supersedes: [id...] }] }`.
   **Most turns return `[]`** — the prompt is explicit that nothing durable is the common case.
3. Per candidate: embed → if cosine ≥ `DEDUP_THRESHOLD` (0.93) against an existing point,
   **reinforce** it (bump `reinforced_count`, raise `importance`) instead of inserting a twin.
   Otherwise insert, and mark every id in `supersedes` as `status: 'superseded'`.

Letting the model name what it supersedes is what makes "I moved to Mongo" actually retire
"I use Postgres" — a similarity threshold alone can't, because those two sentences aren't
especially similar.

### Read — threshold, rerank, budget

1. **Query building**: last user message; if it's short/anaphoric, prepend the previous user
   message from history so pronoun-only follow-ups still retrieve.
2. **Over-fetch** ~20 with a real `score_threshold` and a `status = active` payload filter.
3. **Rerank** on a composite score:
   `0.55·similarity + 0.20·recency_decay + 0.15·importance + 0.10·usage`
   (recency = exponential half-life; usage = normalized `recall_count`, so memories that keep
   proving useful get stickier).
4. **MMR**: drop a candidate that's ≥0.90 cosine to one already selected (kills survivor dupes).
5. Cut to top-k under a **character budget**, inject grouped by kind with dates.
6. Bump `recall_count` / `last_recalled_at` on what was actually injected (fire-and-forget).

### Tools

`remember` gains `kind` / `subject` / `importance`. New `forget` tool so an agent can retire a
memory it knows is wrong. `recall` stays implicit (auto-RAG).

## Files

| File | Change |
|---|---|
| `domain/memory/memory.types.ts` | new — payload types, kinds, scoring weights |
| `domain/memory/qdrant.service.ts` | `score_threshold`, payload filter, `with_vector`, `setPayload`, indexes |
| `domain/memory/agent-memory.service.ts` | typed `remember`, reranked `recall`, `reinforce`, `supersede` |
| `domain/memory/memory-distiller.ts` | new — the post-turn extraction call |
| `orchestrator/AgentRunner.ts` | drop the transcript dump → call the distiller; better recall query |
| `domain/agents/jit-builder.ts` | `buildMemoryMessage` grouped by kind, dated |
| `tools/core/remember.ts` + `forget.ts` | typed write, deliberate retire |
| `domain/settings/settings.model.ts` + migration | `memory_*` knobs |
| `core/event-bus/events.types.ts`, `transport/ws/bridge.ts` | recall badge carries kind/subject |
| `frontend/.../MemoriesBadge.tsx`, `views/MemoryVault.tsx` | render the new shape |

## Verified

Driven end-to-end against the live stack (agent bound to the `ai-l` endpoint, `Qwen3.6-27B` on
192.168.1.23). Fed one turn stating two durable things:

- **Distilled**, not dumped — two standalone memories, correctly typed:
  - `[fact/inference-server i5]` "The inference server for both chat and image generation runs at
    192.168.1.23; debugging must always occur on the remote server, never in the local container."
  - `[preference/planning i5]` "The operator requires all plans to be persisted to a
    repository-tracked .md file rather than remaining as internal notes."
- **Relevant query** ("where does image generation actually run?") → recalled the fact
  (similarity 0.675, rerank 0.721 — reranked *above* raw similarity by recency + importance), and
  correctly did **not** return the unrelated planning preference.
- **Unrelated query** ("airspeed velocity of an unladen swallow") → **0 memories**. The old code
  returned 5 here, every time. This was the core bug.
- **Re-distilling the same turn** → the model was shown its existing memories, returned `[]`, and
  the namespace stayed at 2 points. No duplicate twins.

## Known cost

The distillation call is fire-and-forget (it never delays the reply), but it runs on the agent's own
endpoint and therefore takes a slot on that endpoint's `endpointGate`. The verified call took ~88s
on the 27B remote (including a model load). On a busy endpoint that can queue ahead of the
operator's *next* turn. If that bites, the fix is the one the judge already uses: a dedicated
`memory_endpoint_id` setting pointing the distiller at a small fast model.

## Migration

Legacy `source: 'auto_turn'` points are **wiped by hand** by the operator. Anything left without
the new fields is treated as `kind: 'episode'`, `importance: 2`, `status: 'active'` by the
reader, so a half-wiped namespace still works.
