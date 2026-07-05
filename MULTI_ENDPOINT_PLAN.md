# Multi-Endpoint + Per-Agent Model Plan

Add multiple OpenAI-compatible inference endpoints (managed in Settings) with autodiscovered
models, and let each agent optionally pick an `endpoint + model` (falling back to a global default
when unset).

## Decisions (confirmed with operator)
- Override scope: **endpoint + model** per agent (sampling stays global).
- Discovery: **on-demand + cache** — `/v1/models` fetched when an endpoint is saved and via a
  manual "Refresh models" button; cached in Mongo. No background polling.
- Migration: existing `settings.llama_url/model/key` is **migrated into one `default` endpoint**;
  global settings keep sampling params (`max_tokens`, `temperature`, `top_p`, `context_window`) and
  the default model name.
- Compatibility: treat every endpoint as **OpenAI-compatible** (base URL + API key; discovery via
  `GET /v1/models`). Works for llama.cpp, vLLM, Ollama, TGI, etc.

## Data model

New `endpoints` collection (`domain/endpoints/`):
- `name` (unique), `base_url`, `api_key` (default `sk-no-key-required`)
- `models: string[]` (discovered cache), `models_updated_at: Date|null`
- `context_window: number` (0 = fall back to global settings' context_window)
- `is_default: boolean` (exactly one default; enforced on write)
- timestamps

`agents` collection — two new fields:
- `endpoint_id: ObjectId|null` (null → default endpoint)
- `model: string` ('' → endpoint's first model, then global default model)

`settings` singleton keeps `llama_model` as the **global default model** and sampling params.
`llama_url`/`llama_api_key` remain only as a legacy fallback for the resolver.

## Resolution (`inference/inference-resolver.ts`)
`resolveForAgent(agent)` → `{ url, apiKey, model, contextWindow, maxTokens, temperature, topP }`:
1. endpoint = `agent.endpoint_id` ? findById : `findDefault()`; fall back to `settings.llama_url/key`.
2. model = `agent.model` || `endpoint.models[0]` || `settings.llama_model`.
3. contextWindow = `endpoint.context_window || settings.context_window`.
4. sampling = global settings.

## Backend changes
1. `domain/endpoints/endpoint.model.ts`, `endpoint.repository.ts`, `endpoint.service.ts`
   (`discoverModels(id)` calls `client.models.list()`; `resolveForAgent`).
2. `inference/LlamaClient.ts` — `streamChat` takes optional `inference: ResolvedInference`;
   when absent falls back to `settingsService` (keeps `session-titler` working).
3. `orchestrator/AgentRunner.ts` — resolve inference once per `run()`, thread into `streamTurn`,
   use `resolved.contextWindow` for the `agent:context_usage` emit.
4. `domain/agents/agent.model.ts` + `agent.repository.ts` — add `endpoint_id`, `model` to
   schema, `create`, and `update` patch whitelist.
5. `transport/http/routes/endpoints.routes.ts` — CRUD + `POST /:id/discover` + `POST /:id/default`;
   mount at `/api/endpoints` in `index.ts`.
6. `transport/http/routes/agents.routes.ts` — normalise empty `endpoint_id` → null in PATCH.
7. Migration `migrations/20260705140000-endpoints.js` — create `endpoints` (unique `name` index),
   seed a `default` endpoint from the existing settings doc.

## Frontend changes
8. `lib/api.ts` — `Endpoint` type + `endpointsApi`; add `endpoint_id`/`model` to `Agent`,
   `NewAgent`, and `agentsApi.update` Pick.
9. `views/SettingsView.tsx` — new **Endpoints** manager (list/add/edit URL+key, Refresh models,
   set default, per-endpoint context window); keep Generation + Embeddings; default model dropdown.
10. `views/AgentModelSelect.tsx` (mirrors `AgentIsolationSelect`) — endpoint + model dropdowns,
    applied immediately; wired into `AgentsView`.

## Verify
- `cd backend && npm run typecheck`; `cd frontend && npm run typecheck`.
- `npm run migrate:up`; confirm a `default` endpoint appears and existing chats still stream.
