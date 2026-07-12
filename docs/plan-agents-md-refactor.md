# Plan — AGENTS.md refactor: immutable charter vs. agent-owned notebook

**Status: implemented** (branch `fix/image-gen-flux-doc-params`). Migration
`20260712120000-agents-md-charter-notebook.js` auto-applied at boot.

## Problem

Today there is **one** document with **two** writers: `agent.agents_md` is injected into the system
prompt (`jit-builder.ts`), edited by the operator on the Agents page, *and* rewritten by the agent
itself via the `update_agents_md` tool. An agent can therefore overwrite the instructions the
operator gave it. There is also no fleet-wide place to state house rules.

## Target model — three documents

| Document | Storage | Operator | Agent |
|---|---|---|---|
| **Global AGENTS.md** (house rules, whole fleet) | `settings.agents_md` (singleton) | read/write (Settings page) | **read-only** |
| **Agent AGENTS.md** (this agent's charter) | `agent.agents_md` | read/write (Agents page) | **read-only** |
| **Notebook** (learnings, TODOs) | `agent.notebook` (new) | read/write (Agents page) | **read/write** via `update_notebook` |

The tool `update_agents_md` is **renamed** `update_notebook` and now writes `agent.notebook`. No tool
can write either AGENTS.md.

Both AGENTS.md docs are injected into **every** agent, subagents included.

## Prompt order (`buildSystemMessage`)

```
## Environment
## Local Parameters
## House Rules            <- settings.agents_md   (immutable)
## AGENTS.md              <- agent.agents_md      (immutable)
## Orchestration (top-level only) / ## Tool use
---
<system_prompt>
---
## Notebook               <- agent.notebook       (agent-writable)
[## Relevant memories]    <- appended by AgentRunner as today
```

Immutable instructions precede the agent's own notes, so the notebook reads as recollection rather
than orders.

## Steps

### Backend
1. `domain/agents/agent.model.ts` — add `notebook: String, default: ''`; re-document `agents_md` as
   the operator-owned charter.
2. `domain/agents/agent.repository.ts` — `setAgentsMd` → `setNotebook` (writes `notebook`); add
   `notebook` to the `update()` pick list.
3. `tools/core/updateAgentsMd.ts` → `tools/core/updateNotebook.ts`, tool name `update_notebook`,
   description points at the notebook and states the AGENTS.md files are read-only.
4. `tools/registry.ts` — register `updateNotebook`.
5. `domain/settings/{settings.model,settings.service}.ts` — add `agents_md` (default `''`);
   `transport/http/routes/settings.routes.ts` — accept it in the PATCH body.
6. `domain/agents/jit-builder.ts` — `renderHouseRulesBlock` + `renderAgentsMdBlock` (charter) +
   `renderNotebookBlock`; `buildSystemMessage(agent, houseRules)` composes the order above.
7. `orchestrator/AgentRunner.ts` — `await settingsService.get()` and pass `agents_md` into
   `buildSystemMessage`.
8. `transport/http/routes/agents.routes.ts` — `PUT /:id/agents-md` now writes the charter;
   add `PUT /:id/notebook`.
9. `transport/http/routes/transfer.routes.ts` — export/import `notebook` alongside `agents_md`.
10. **Migration** `2026071xxxxxxx-agents-md-charter-notebook.js`:
    - `agents.agents_md` → `$rename` to `agents.notebook` (existing content was agent-written), then
      `agents_md: ''` so the charter starts empty;
    - rewrite `tools_allowed`: `update_agents_md` → `update_notebook`;
    - add `settings.agents_md: ''`.
    - `down` reverses all three.

### Frontend
11. `lib/api.ts` — `Agent.notebook`, `Settings.agents_md`, `agentsApi.setNotebook`.
12. `views/AgentsView.tsx` — two editors: AGENTS.md (charter, "the agent cannot edit this") and
    Notebook ("the agent writes this via `update_notebook`; you may correct it").
13. `views/SettingsView.tsx` — global AGENTS.md editor (house rules).
14. `backend/scripts/seed.mjs` — `update_agents_md` → `update_notebook` in `tools_allowed`.

## Verification
- `npm run typecheck` in `backend/` and `frontend/`.
- `npm run migrate:up`, confirm an existing agent's notes landed in `notebook` and `agents_md` is
  empty.
- Run a turn; confirm the assembled system prompt shows House Rules + AGENTS.md before the prompt and
  the Notebook after it, and that `update_notebook` only mutates `notebook`.
