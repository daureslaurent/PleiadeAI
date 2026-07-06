# Plan — Dynamic, accurate context counter

Status: **done** (typecheck + backend build green). Compaction is explicitly **out of scope** for
this pass (separate task later). Activation: re-run model discovery per endpoint to populate
`model_contexts`, then restart the backend from `dist`.

## Problem

The chat-header context meter was misleading:
- **Denominator** was a static operator-typed config (`endpoint.context_window || settings.context_window`,
  default 8192). If set larger than the llama.cpp server's real `--ctx-size`, the meter reads "healthy"
  while the server is already context-shifting and silently evicting the system prompt → the agent
  "forgets who it is" and degrades ("worked good, then went bad").
- **Numerator** is the server's `prompt_tokens` for the last inference pass — accurate, but only emitted
  once at end of turn, so a long DesktopAgent screenshot loop shows nothing climbing until it's over.
- Across turns the number legitimately rises and falls, because history is re-sent text-only (old
  screenshots collapse to `[visual_screenshot]`) — this looked like the counter "not counting everything".

## Decisions (from operator)

1. **Max ctx (denominator)** = runtime `n_ctx` from llama.cpp `/props` (the real per-slot ceiling).
2. **Per-model**: server hosts/swaps multiple models with different `n_ctx` → probe per model at
   **discovery** and store keyed by model id.
3. **Applied at conversation start**: the resolver reads the probed per-model `n_ctx`.
4. **Numerator exactness**: `/tokenize` (via `/apply-template` + `/tokenize`) as an exact fallback when
   the server does not return streaming `usage`.
5. **Two-tone meter**:
   - Blue **total** = last completed turn's **peak** `prompt_tokens` (persisted, restored on load).
   - Amber **live** = current in-flight `prompt_tokens`, emitted **per tool iteration**.
   - **Ghost tick** marks the prior total while a turn runs.
   - On turn end: live clears, blue settles at the new peak.

## Implementation

### Backend
- `inference/llama-introspect.ts` (new): `fetchModelContexts(baseUrl, apiKey)` → `Record<modelId, n_ctx>`.
  Raw fetch to `GET /props` (`default_generation_settings.n_ctx`, loaded model) and `GET /v1/models`
  (`data[].meta.n_ctx_train`). Runtime `/props` value wins for the loaded model; `n_ctx_train` fills
  the rest. Best-effort — failures return `{}`.
- `endpoint.model.ts`: add `model_contexts: Map<string, number>`.
- `endpoint.repository.ts`: `setModels` also persists `model_contexts`.
- `endpoint.service.ts` `discoverModels`: probe contexts alongside model list.
- `inference-resolver.ts`: denominator = `model_contexts[model]` → `endpoint.context_window` →
  `settings.context_window` (all three resolve paths).
- `LlamaClient.ts`: `tokenizeMessages(target, messages)` → exact prompt token count (fallback).
- `events.types.ts` / `bridge.ts`: add `phase: 'live' | 'final'` to context-usage payload/event.
- `AgentRunner.ts`: emit `context_usage` (phase `live`) after each tool iteration; final emit is
  phase `final`; if `lastUsage` is null, fall back to `tokenizeMessages` for the final number.
- `TurnRecorder.ts`: persist only `final` phase.
- Migration: initialize `model_contexts: {}` on existing endpoints.

### Frontend
- `ws-events.types.ts`: add `phase` to `ContextUsageEvent`.
- `store/stream.ts`: add `liveContext` state; on `phase:'live'` set it (keep `contextUsage` as ghost);
  on `phase:'final'` set `contextUsage` and clear `liveContext`; clear on session switch.
- `ChatPanel.tsx` `ContextMeter`: blue total fill + amber live fill + ghost tick + label switches to
  live value while running.

## Auto-mode for max context (Settings page)

- **Denominator source clarified**: the model's absolute max is in `/v1/models` (`meta.n_ctx_train`),
  but the meter's max must be the **current model's runtime `n_ctx`** (`/props`). Introspection already
  prefers the runtime value; `n_ctx_train` is only a fallback for not-yet-loaded models.
- **Global default**: `settings.context_window_auto` (bool, default **on**) + a Settings toggle. When
  on, the meter uses each server's probed real n_ctx; the manual number becomes the fallback.
- **Per-endpoint override**: `endpoint.context_window_mode` = `inherit | auto | manual` with a select
  in each endpoint row. Auto shows the resolved n_ctx read-only (`32768 (auto)` from `model_contexts`
  for the endpoint's default model); manual shows the editable number.
- **Freshness**: cached from discovery (`model_contexts`), refreshed by "Refresh models" — no
  per-conversation round-trip.
- `resolveContextWindow()` in inference-resolver gates probed-vs-manual by the effective mode; applied
  to all three resolve paths. Migration `20260706170000` seeds the new fields.

## Router fix (real deployment)

The live server (192.168.1.20:8080) is a llama.cpp **model-router** (llama-swap style): `/props`
returns `role:"router"`, `n_ctx:0` (useless), and `/v1/models` has no `meta`. The real per-model
n_ctx is the launch `--ctx-size` inside each entry's `status.args` — e.g. `PleiadesAI` = 65536 (the
old probe used the trained max and showed 262144). `fetchModelContexts` now reads `--ctx-size`/`-c`
from `status.args` first, `meta.n_ctx_train` second, and `/props` only for non-router single-model
servers. DB values corrected for `ai-xl`/`ai-l`; backend image rebuilt; discovery verified to write
65536 durably. NB: the endpoint URL must be reachable HTTP (this server is plain http, not https).

## Verify
- `npm run typecheck` in `backend/` and `frontend/`.
- Manual: send a multi-tool turn, watch amber climb past the ghost tick, settle to blue on completion;
  confirm the denominator matches the server's actual `--ctx-size`.
