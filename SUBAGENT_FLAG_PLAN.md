# Subagent flag (primary vs. subagent)

Opencode-inspired split of agents into **top-level orchestrators** and **delegatable subagents**,
driven by a single boolean `subagent` field.

## Semantics
- `subagent = true` (default) — a delegation target. Appears in the `annuaire` directory and can be
  reached via `ask_agent`. Still directly chattable in the Workspace.
- `subagent = false` — a top-level/orchestrator agent. **Not** listed in the `annuaire` (nothing can
  delegate *to* it). Auto-granted `annuaire` + `ask_agent`, and given a JIT system-prompt directive
  that forces it to consult the annuaire and delegate to specialised subagents before answering.

Default `true` keeps backward compatibility: every existing agent stays visible in the annuaire.

## Changes
Backend
- `domain/agents/agent.model.ts` — add `subagent: Boolean, default true`.
- `domain/agents/agent.repository.ts` — allow `subagent` in `create` input and `update` patch.
- `tools/core/annuaire.ts` — list only agents with `subagent === true` (still excluding self).
- `domain/agents/jit-builder.ts` — inject an orchestration directive when `!agent.subagent`.
- `orchestrator/AgentRunner.ts` — for `subagent === false`, ensure `annuaire` + `ask_agent` are in
  the effective toolset regardless of `tools_allowed`.
- `migrations/*-agent-subagent.js` — backfill existing agents with `subagent: true`.

Frontend
- `lib/api.ts` — add `subagent: boolean` to `Agent`.
- `views/AgentsView.tsx` — toggle in the editor; include in create/update payloads.
