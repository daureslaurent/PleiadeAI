# VIEWS_RESTYLE_PLAN.md — Skills / Tools / Images / Isolation / Memory Vault

Bring the five remaining legacy views onto the `DIRECT_ART.md` art direction ("Glass over the
Pleiades"). Decided with the operator, July 2026.

## Starting state

| View | Lines | Ground | Notes |
|---|---|---|---|
| `SkillsView` | 207 | `bg-surface` / `border-border` | via `MasterDetail`; 2× Monaco on `vs-dark` |
| `ToolsView` | 191 | `bg-surface` | closest to conforming; private `Toggle`, `Field` |
| `ImagesView` | 857 | `bg-surface` | via `MasterDetail`; private `StatusBadge`/`Label`/`Empty`; Monaco |
| `IsolationsView` | 830 | `bg-surface` | via `MasterDetail`; private `StatusBadge`/`Label`/`Field`/`Empty` |
| `MemoryVault` | 82 | unstyled `<table>` | raw `JSON.stringify(payload)`; delete with no confirm |

Already conforming (reference): `AgentWorkspace`, `ScoringView`, `FineTuningView`, `LLMDebugView` —
each mounts its own `.space-bg` and uses `glass-card rounded-2xl border-white/[0.06]`.

The app shell (`App.tsx` `PageHeader`, `Sidebar.tsx`) is still legacy grey and sits *above* the
glass views.

## Decisions

1. **Backdrop lifts to the shell.** `.space-bg` mounts once on `MainLayout`; `Sidebar` and
   `PageHeader` become `.glass`. The four per-view `.space-bg` wrappers are removed (they would
   double-paint the gradient and re-run the star layers). `VisualDesktopWindow` is outside
   `MainLayout` and keeps its own background.
2. **Extract `components/ui/`.** One kit, all five views consume it. `DIRECT_ART.md` §9 gets a row.
3. **Restyle `MasterDetail`** (shared by Skills, Images, Isolation, **and Agents**). Agents inherits
   the new look; it is verified, not redesigned.
4. **Restyle + targeted UX fixes.** No new backend calls, no new API surface.
5. **Memory Vault → glass memory cards + search.** Payload is
   `{ text, created_at, source: 'auto_turn'|'remember_tool', session_id?, tags? }` (see
   `backend/src/domain/memory/agent-memory.service.ts:29`) — render those fields, raw JSON behind a
   disclosure.
6. **Monaco gets a `pleiades-dark` theme** with a transparent background over a `bg-black/25` well.
7. **Images / Isolation keep their single-column flow**, regrouped into labelled glass strata
   (the `FineTuningView` pattern). No IA change.

## Work items

### 1. `frontend/src/lib/monacoTheme.ts` (new)
`pleiades-dark`: `editor.background: #00000000`, accent cursor, palette-matched token colors.
Exported `registerPleiadesTheme(monaco)` + `MONACO_OPTIONS` defaults (no minimap, 12px, no
scroll-beyond-last-line). Applied in `SkillsView` (2×) and `ImagesView` (1×).

### 2. `frontend/src/components/ui/` (new)
- `GlassCard` — `glass-card rounded-2xl border border-white/[0.06]`; `Section` = card + `[10px]
  uppercase tracking` header + optional right-side slot.
- `Label`, `Field` (label + hint + control), `Hint`.
- `Input`, `Textarea`, `Select` — inset wells: `bg-black/25 border-white/[0.07]
  focus:border-accent/60`.
- `Toggle` — the existing `ToolsView` switch, accent-on / `bg-white/[0.08]`-off.
- `Button` — `primary` (accent), `ghost` (white-alpha ring), `danger` (red-alpha), all
  `active:scale-95`, `rounded-lg`.
- `StatusBadge` + `Dot` — one tone map (`ok`/`busy`/`error`/`idle` → emerald/amber/red/slate),
  replacing three private copies.
- `EmptyState` — icon + line, `text-slate-600`.
- `ConfirmDialog` + `ConfirmProvider` / `useConfirm()` — promise-based glass modal. Replaces the
  seven native `confirm()` calls in Images/Isolation and adds the two missing ones (MemoryVault
  delete, Skills delete). `alert()` (error surfacing only) is left alone.

### 3. Shell — `App.tsx`, `Sidebar.tsx`
`MainLayout` root gets `space-bg`; `PageHeader` and `Sidebar` get `.glass` + white-alpha hovers;
`ConfirmProvider` wraps the routes. Strip `space-bg` from `AgentWorkspace`, `ScoringView`,
`FineTuningView`, `LLMDebugView`.

### 4. `MasterDetail.tsx`
Glass rail (`.glass border-r`), dashed→white-alpha "New" button, `ListRow` active state copies the
`WorkspaceNav` idiom: `bg-accent/15 shadow-[inset_2px_0_0_0_rgba(59,130,246,0.7)]`.

### 5. The five views
- **Tools** — glass cards, kit `Toggle`/`Field`/`Button`; add the missing `error` state on
  `toolsApi.list()` (currently an unhandled rejection → infinite spinner).
- **Skills** — glass header row, Monaco in wells, delete confirm, `EmptyState`.
- **Images** — strata: *Identity*, *Visual desktop*, *Dockerfile*, *Build options*, *Build console*
  (near-black terminal glass, per DA §7). `BuildsPanel` rows → `bg-black/25 rounded-xl`.
- **Isolation** — strata: *Identity*, *Image*, *Resources*, *VPN*, *SSH*, *Sudo*, *Instances*,
  *Volumes*. `ContainersPanel` rows → same treatment.
- **Memory Vault** — agent selector pill + search field; each point a `rounded-xl` glass card:
  mono id badge, `source` chip, relative `created_at`, text preview, raw-JSON disclosure, delete.
  Loading / empty / error states.

## Non-goals
No light theme. No new keyframes. No new radii. No IA change to Images/Isolation. No backend change.

## Verification
`npm run typecheck` (frontend), then boot the stack and load all five routes plus `/agents` (the
`MasterDetail` spillover) and `/workspace` (the backdrop move).
