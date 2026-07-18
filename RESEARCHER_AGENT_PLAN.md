# Deep-research agent pair — `researcher` + `research_critic`

Adds a heavyweight research capability to the fleet: an agent that decomposes a question, gathers
sources, writes a durable report to its own workspace, and is **verified by a second agent** before
answering. Alongside it, the write path the CLI/MCP has been missing.

## Decisions (operator-chosen)

| Question | Choice |
|---|---|
| Relation to existing `websearch` | New agents; `websearch` stays the cheap shallow lookup |
| Artifacts | Own container, `isolation_volume_mode: individual` (private persistent `/workspace`) |
| Critique | **Separate critic subagent**, not prompt-only self-review |
| Critic power | Verifier — its own `web_search`/`webfetch` so it can check citations, not just reason |
| Deploy | Extend CLI + MCP with real write support |
| Invocation | `subagent: true` — Nova delegates via `ask_agent`, still directly chattable |
| Domain | General-purpose, no narrowing |
| Network | `bridge` |
| Model | Fleet default (blank `endpoint_id`/`model`) |
| Hops | Raise global `MAX_AGENT_HOPS` 3 → 5 |
| Output | Report on disk + memory; tight summary + path returned to caller |

## Findings that shaped the design

- `scripts/prod.mjs` and `tools/pleiades-mcp/` are **GET-only** by construction — `client.mjs`
  deliberately exports only `apiGet`. Creating an agent from the CLI needs a new verb.
- `WRITE_SCOPES` in `middleware/auth.ts` maps only `agents:write` → `/api/agents`. Creating the
  isolation profile over an API key needs a new `isolations:write` scope.
- `devops_isolation` is the only existing `bridge` profile but has **`image_id: null`**, so it
  cannot launch a container (`IsolationNotReadyError`). The new profile reuses the already-built
  **CodeSpace** image (`node:22-bookworm-slim` + python3/git/curl) — no new image build.
- `MAX_AGENT_HOPS` defaults to 3 (`config/env.ts`). Nova → researcher → critic burns 2, leaving the
  researcher no room to consult peers. Raised to 5.

## Work items

1. **`isolations:write` scope** — `api-key.model.ts` (`API_KEY_SCOPES`) + `auth.ts` (`WRITE_SCOPES`).
2. **Hop budget** — promoted from an env var to the `max_agent_hops` runtime setting, editable at
   Settings → Inference beside "Max tool steps per turn". `HopGuard` now reads it per check (so a
   change applies on the next delegation, no restart) and `MAX_AGENT_HOPS` — default raised 3 → 5 —
   became the fallback for when the operator hasn't set one. Clamped 1–10 in the PUT whitelist;
   migration `20260718210000` seeds `null` so existing deploys keep their current ceiling.
3. **CLI/MCP write support** — `apiSend()` in `client.mjs`; `method`/`body` on endpoint descriptors
   in `endpoints.mjs`; dispatch in `prod.mjs` (`--body=@file.json`) and `index.mjs`. New commands:
   `create_agent`, `update_agent`, `create_isolation`.
4. **Agent definitions** — `scripts/agents/researcher.json`, `research-critic.json`,
   `research-isolation.json`, applied by `scripts/deploy-research-agents.mjs`.
5. **Deploy to prod** via the new CLI.

## Design of the pair

**`researcher`** — owns the loop, never trusts its own first draft.

1. *Frame* — restate the question, list sub-questions and what would falsify each answer.
2. *Gather* — `web_search`/`webfetch`, peers via `ask_agent`, capturing every claim with its source
   URL into `/workspace/research/<slug>/sources.md` as it goes (not from memory afterwards —
   that is where fabricated citations come from).
3. *Draft* — `/workspace/research/<slug>/report.md`.
4. *Verify* — **must** `ask_agent('research_critic')` with the slug before answering.
5. *Revise* — address every finding or record in the report why it was rejected.
6. *Answer* — headline finding, confidence, open questions, path to the report; `remember` the
   durable conclusions.

**`research_critic`** — adversarial verifier with its own `web_search`/`webfetch`, so it independently
re-checks claims instead of only reasoning about the draft. Checks: does each cited URL exist and
actually say this; claims with no source; contradicting sources presented as settled; sub-questions
silently dropped; overclaimed confidence. Returns a verdict (`accept` / `revise` / `reject`) plus
specific findings. It never rewrites the report — it reports, the researcher revises.

Both agents sit on the `research` profile with **individual** volumes (private `/workspace` each),
per the operator's choice of an independent verifier over a shared-disk one. The researcher therefore
passes the draft **inline** in its `ask_agent` call; the critic keeps its own verification notes.

## Status

Items 1–4 are implemented; backend and frontend typecheck clean and
`node scripts/deploy-research-agents.mjs --dry-run` resolves the image and plans the three writes.

**Item 5 (deploy) is blocked on prod.** Probing the current key: `agents:write` is granted, but
`isolations:write` returns *"api keys are read-only here"* — prod runs the `dist` built before this
change, so the scope does not exist there yet. Unblock either way:

- **Rebuild + restart the prod backend**, mint a key with both scopes, then run the deploy script; or
- **Create the `research` profile by hand** on the Isolations page (bridge network, CodeSpace image)
  and run the script as-is — it matches the profile by name and only needs `agents:write` for the rest.

## Verification

`npm run typecheck` in `backend/` and `frontend/`, `node scripts/prod.mjs` for the new `[write]`
commands, then a live deep dive through the Workspace to confirm the `ask_agent` hop into the critic
and the report landing in the container's `/workspace/research/<slug>/`.
