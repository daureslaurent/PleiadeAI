# Agent Color + Icon Identity — Implementation Plan  ✅ DONE

All items below implemented; both packages typecheck clean. A `migrate:up` is required to add the
fields to existing agents. Export/import (transfer.routes) also carries the new fields.


Let operators choose each agent's **color** and **logo/icon** on the Agents page, overriding the
current auto-derived (name-hash) identity. Chosen values thread through the whole UI (chat avatar,
`ask_agent` sub-agent bubbles) exactly like the existing `agentColor()` identity.

## Decisions (from operator)
- **Color:** curated **preset swatches**. Stored as an HSL **hue number** (`0–360`) so the existing
  `border`/`soft` derivations in `agentColor.ts` stay consistent. `null` = unset.
- **Icon:** curated **lucide subset** (~30 icons). Stored as a kebab **icon key** string. `''` = unset.
- **Default when unset:** keep the current **name-hash** color + **initial letter** (no visual change
  for existing agents until an operator overrides).
- **LLM suggest:** manual **“Suggest” button** in the editor → backend LLM call (mirrors
  `session-titler.ts`) returns `{ color, icon }` constrained to the palette + icon set. Operator can
  edit before saving.

## Backend
1. `domain/agents/identity.constants.ts` — canonical `PRESET_HUES` (12) + `ICON_KEYS` (~30). Single
   source the suggester validates against.
2. `domain/agents/agent.model.ts` — add `color: { type: Number, default: null }`,
   `icon: { type: String, default: '' }`.
3. `migrations/20260705200000-agent-identity.js` — add the two fields (nullable, no backfill).
4. `domain/agents/agent.repository.ts` — accept `color`/`icon` in `create` + `update` whitelist.
5. `domain/agents/identity-suggester.ts` — one-shot LLM call (name + description → constrained JSON
   `{ hue, icon }`), graceful fallback, clamped/validated against the constants.
6. `transport/http/routes/agents.routes.ts` — `POST /agents/suggest-identity` `{ name, description }`.

## Frontend
1. `lib/agentIcons.tsx` — kebab-key → lucide component registry + `PRESET_HUES` (mirrors backend).
2. `lib/agentColor.ts` — `agentColor(name, hue?)` uses explicit hue when given, else hash. Add a
   module-level name→`{hue, icon}` registry (`registerAgentIdentities`, `identityFor`) so the live
   stream (which only knows agent *names*) can resolve chosen colors/icons.
3. `lib/api.ts` — `Agent`/`NewAgent` gain `color: number | null` + `icon: string`; add both to the
   `update` whitelist; add `agentsApi.suggestIdentity(name, description)`.
4. `views/AgentsView.tsx` — `Draft`/`blank`/`select`/`save` carry color+icon; swatch picker + icon
   grid + “Suggest” button in the editor; list rows + header preview use the chosen identity; call
   `registerAgentIdentities` after refresh.
5. `views/AgentWorkspace.tsx` — call `registerAgentIdentities(list)` on load so bubbles/avatars in the
   chat resolve chosen identities.
6. `components/workspace/ChatPanel.tsx` + `Blocks.tsx` — avatar renders the chosen lucide icon (else
   initial); color pulled via the registry.

## Verify
`npm run typecheck` in both packages; boot the stack and confirm swatch/icon pick + Suggest + live
propagation into an `ask_agent` bubble.
