# THEME_SYSTEM_PLAN.md — Themes & chat layouts


## Context

The frontend has **no theme system at all**. `DIRECT_ART.md` fixes one look — "Glass over the
Pleiades", dark-only, deliberately — and the code hard-codes it everywhere: 5 custom colors in
`tailwind.config.ts`, 1320 literal `slate-*` classes, ~630 `white/…`/`black/…` alphas, 104 raw hex
literals, and hard-coded `rgba()` inside `.glass*`, `.space-bg`, the scrollbars and the React Flow
overrides in `index.css`. `darkMode: 'class'` is configured but never exercised (zero `dark:`
variants); `<html class="dark">` is static.

The chat page has no layout concept either. `ChatPanel.tsx` (797 lines) hard-codes exactly one
structure: user speaks in a right-aligned bubble, the agent answers full-width, tool cards and
sub-agent bubbles render inline, and the trace/isolation/data drawer is a `w-96` sibling `<aside>`.

The operator wants to **choose** both, independently:

- a **theme** — palette, surface treatment, radii, typography — applied to the whole app;
- a **chat layout** — how a turn is structured: user/agent framing, how tool calls, reasoning and
  sub-agent hops are presented, whether the trace sits inline or in a docked column.

Decisions already taken: theme and layout are **independent** settings (5 × 5); **light themes are
allowed** (DIRECT_ART's dark-only rule is lifted and the doc rewritten); the choice **persists on
the backend settings singleton** with a localStorage cache for instant, flash-free boot; and the
token rework covers the **whole app**, not just chat.

Outcome: five themes — **Pleiades** (today, pixel-identical), **Codex** (light, flat, neutral),
**Terminal** (near-black, mono, zero radii), **Paper** (warm light, editorial serif prose),
**Nebula** (saturated dark, cyan/magenta, stronger glow) — and five chat layouts — **Hybrid**
(today), **Transcript** (Codex-style), **Workbench** (split: prose left, live trace docked right),
**Timeline** (one vertical rail of events), **Bubbles** (compact messenger).

---

## Strategy

The whole plan rests on one decision: **no component rewrites for color.** Every color, radius and
font in `tailwind.config.ts` is remapped onto CSS custom properties, so the ~2500 existing color
classes across 150 files become themeable untouched. Themes are then CSS files that redefine the
variables under `:root[data-theme="…"]`.

Likewise, layouts are **not five forks of `ChatPanel`**. The shell (header, banners, todo, ask-user,
composer) stays shared; only a `ConversationView` swaps, driven by a small capability descriptor
that `Blocks.tsx` and `ToolCall.tsx` read from context.

---

## Phase 0 — `THEME_SYSTEM_PLAN.md`

Write this plan to the repo root as `THEME_SYSTEM_PLAN.md`, alongside the other `*_PLAN.md` specs,
so the work is tracked in git and source comments can reference its sections the way they reference
`FLOWS_PLAN.md` and `COMFYUI_MEDIA_PLAN.md`.

## Phase 1 — Token layer (app-wide, zero visual change)

Pleiades must come out of this phase pixel-identical. That is the acceptance test for the phase.

### 1.1 `frontend/tailwind.config.ts` — map every color onto variables

```ts
const ramp = (name: string) => Object.fromEntries(
  [50,100,200,300,400,500,600,700,800,900,950].map(
    (s) => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`],
  ),
);

colors: {
  // Neutral foreground/background ramp. Semantics in this codebase: 100 = strongest text,
  // 400/500 = secondary, 600 = faintest. Each theme authors its own 11 stops (a light theme is
  // NOT a mirror — mid stops stay mid-grey).
  slate: ramp('slate'),
  // Semantic state ramps, so Terminal can make "ok" phosphor-green and Paper can darken
  // everything for contrast on cream.
  emerald: ramp('emerald'), amber: ramp('amber'), red: ramp('red'),
  sky: ramp('sky'), rose: ramp('rose'), indigo: ramp('indigo'),
  // Contrast alphas. `white` means "the raise color", `black` means "the well color" — the
  // safety net for the long tail of `bg-white/[0.04]` that Phase 1.3 does not codemod.
  white: 'rgb(var(--c-raise) / <alpha-value>)',
  black: 'rgb(var(--c-well) / <alpha-value>)',
  // The five existing tokens.
  panel:     'rgb(var(--c-panel) / <alpha-value>)',
  surface:   'rgb(var(--c-surface) / <alpha-value>)',
  border:    'rgb(var(--c-border) / <alpha-value>)',
  accent:    'rgb(var(--c-accent) / <alpha-value>)',
  reasoning: 'rgb(var(--c-reasoning) / <alpha-value>)',
}
borderRadius: { md: 'var(--r-md)', lg: 'var(--r-lg)', xl: 'var(--r-xl)', '2xl': 'var(--r-2xl)' }
fontFamily: {
  sans:  ['var(--font-sans)',  'ui-sans-serif', 'system-ui', 'sans-serif'],
  mono:  ['var(--font-mono)',  'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
  serif: ['var(--font-serif)', 'ui-serif', 'Georgia', 'serif'],
}
```

Keyframes/animations are unchanged, except `glow-pulse`'s fallback and `twinkle`, which pick up
`--glow-strength` / `--stars-opacity` (Terminal/Codex/Paper set them to 0).

### 1.2 `frontend/src/index.css` — var-ize every hard-coded value

Split into `index.css` (structure + utilities, no literal colors) and `src/theme/themes/*.css`
(the values). Everything currently literal becomes a variable:

| Utility | New variables |
|---|---|
| `.space-bg` | `--bg-gradient`, `--bg-nebula-a`, `--bg-nebula-b` |
| `.space-bg::before/::after` | `--stars-opacity` (0 disables the layers entirely) |
| `.glass` | `--glass-bg`, `--glass-blur`, `--glass-border` |
| `.glass-card` | `--glass-card-bg`, `--glass-card-blur`, `--glass-card-border`, `--glass-card-shadow` |
| `.glass-popover` | `--popover-bg`, `--popover-blur`, `--popover-shadow` |
| `.text-shimmer` | `--shimmer-sheen` |
| `.stream-caret` | already `theme('colors.accent')` → now a var automatically |
| scrollbars | `--scrollbar-thumb`, `--scrollbar-thumb-hover` |
| React Flow block | `--flow-chrome-bg`, `--flow-chrome-border`, `--flow-control-fg` |
| `@keyframes node-pulse-glow` | `--flow-pulse` |

A theme with no frost sets `--glass-blur: 0px` and an opaque `--glass-bg`; the class names and
every `className` referencing them stay exactly as they are.

### 1.3 Codemod the four on-glass idioms into semantic utilities

The `white`/`black` var mapping keeps the long tail working, but it cannot vary the *alpha*, and a
6% hairline that reads on dark is invisible on cream. So the top patterns (~500 of the 631
occurrences) become theme-controlled utility classes in `index.css`:

| From (count) | To |
|---|---|
| `border-white/[0.06]` (140), `/[0.07]` (20), `/[0.08]` (23), `/[0.09]` (5) | `.hairline` |
| `border-white/[0.12]` (33), `/[0.1]` (4), `border-white/10` (7) | `.hairline-strong` |
| `bg-white/[0.03]`–`/[0.06]` (159) | `.raise-1` / `.raise-2` |
| `bg-black/20`–`/40` (118) | `.well` / `.well-strong` |

Mechanical `sed` across `src/**/*.tsx`, then read the diff. Each utility is one line per theme.
The remaining ~130 one-off alphas ride the `white`/`black` var mapping untouched.

### 1.4 The handful of genuine exceptions

- **`slate` used as a surface, not text** — ~10 spots, all device chrome:
  `components/workspace/AndroidPanel.tsx`, `workspace/VisualPanel.tsx`,
  `views/VisualDesktopWindow.tsx`, `views/AndroidPhoneWindow.tsx` (`bg-slate-800`,
  `border-slate-700/800`). Retarget to `bg-surface` / `.hairline`. The `bg-slate-500/600` dots in
  `ui/Badge.tsx`, `EndpointBadge`, `forumBits`, `monitor/format.ts` are idle-status pills and
  invert correctly as-is — leave them.
- **Raw hex literals** (104 across 20 files) — the visible ones are
  `components/Sidebar.tsx:168-174` (`ring-[#161b22]`, duplicating `surface`) and `:217`
  (`from-[#0d1424] to-[#0a0d13]` brand tile). Retarget to tokens; the rest are in
  `views/flows/portStyle.ts` (`PORT_COLORS`/`GROUP_COLORS` — port *types*, deliberately fixed) and
  chart/monitor series colors, which stay literal.
- **`lib/agentColor.ts`** — returns `hsl(H 72% 66%)`, tuned for dark grounds only. Change to emit
  `hsl(${h} var(--identity-s) var(--identity-l))` etc.; CSS resolves the vars at paint, so inline
  `style={{ color }}` keeps working and each theme tunes identity saturation/lightness. Same for
  `border` (`--identity-border-l` + alpha) and `soft`.
- **`lib/modeTone.ts`** returns class strings — already token-based, no change.
- **`<html class="dark">` / `<body class="bg-panel">` / `<meta name="theme-color">`** in
  `index.html` — driven at runtime in Phase 2.

### 1.5 Third-party themes

Three libraries carry their own dark theme; each gets a per-theme variant selected from the theme
descriptor rather than a hard-coded constant:

- `lib/monacoTheme.ts` — `registerPleiadesTheme` becomes `registerThemes(monaco)` defining one
  Monaco theme per app theme (`base: 'vs'` for Codex/Paper), and `monacoThemeFor(themeId)`.
  Consumers: `views/SkillsView.tsx:190,206`, `views/ImagesView.tsx:497`.
- `components/Mermaid.tsx:15-26` — `themeVariables` read from the active theme descriptor.
- `components/Markdown.tsx:5,61` — swap Prism `oneDark` ↔ `oneLight` on `mode`.

---

## Phase 2 — Theme registry, persistence, and the five themes

### 2.1 Registry — `frontend/src/theme/themes.ts`

```ts
export type ThemeId = 'pleiades' | 'codex' | 'terminal' | 'paper' | 'nebula';

export interface ThemeDef {
  id: ThemeId;
  label: string;
  blurb: string;                 // one line, shown on the picker card
  mode: 'dark' | 'light';        // drives `class="dark"`, Prism, Monaco base
  themeColor: string;            // <meta name="theme-color">
  swatch: [string, string, string]; // ground / surface / accent, for the picker preview
  monacoBase: 'vs' | 'vs-dark';
  mermaid: Record<string, string>;
}
export const THEMES: ThemeDef[];
export const DEFAULT_THEME: ThemeId = 'pleiades';
```

CSS lives in `frontend/src/theme/themes/{pleiades,codex,terminal,paper,nebula}.css`, each a single
`:root[data-theme="<id>"] { … }` block, all imported from `index.css`.

`applyTheme(id)` (`frontend/src/theme/apply.ts`): sets `documentElement.dataset.theme`, toggles
`classList('dark')` from `mode`, and updates the `theme-color` meta.

### 2.2 The five themes

| Theme | Ground | Surfaces | Accent / reasoning | Radii | Type |
|---|---|---|---|---|---|
| **Pleiades** | starfield gradient, nebulae | frosted glass, blur 14/18px | `#3b82f6` / `#a855f7` | today's scale | system sans + mono |
| **Codex** | flat `#ffffff` / `#f7f7f8` | opaque cards, 1px `#e5e5e5`, no blur, no shadow | `#10a37f` / `#6b7280` | 8/12px | system sans, tight |
| **Terminal** | flat `#07090b`, no stars | hairline boxes `#1c2128`, no blur | `#7ee787` / `#d29922` | **0** | mono everywhere |
| **Paper** | `#faf7f2` cream | `#fffdf9` cards, thin rules, tiny shadow | `#8a5a2b` sienna / `#6b4f8a` | 4px | serif prose, sans UI |
| **Nebula** | deep violet gradient, stars ×1.4 | glass, higher saturation | `#22d3ee` / `#e879f9` | today's scale | system sans + mono |

Terminal and Codex set `--stars-opacity: 0` and `--glow-strength: 0`; Paper keeps a whisper of both
at 0. Nebula raises `--glow-strength`.

### 2.3 Persistence

**Backend** (three files, per CLAUDE.md's settings conventions — a key not whitelisted silently
never persists):

- `backend/src/domain/settings/settings.model.ts` — add
  `ui_theme: { type: String, default: 'pleiades' }`,
  `ui_chat_layout: { type: String, default: 'hybrid' }`.
- `backend/src/transport/http/routes/settings.routes.ts` — whitelist both with an enum guard,
  following the existing `SCREEN_CONTROL_MODES` idiom (unknown value ignored, not stored).
  Export `UI_THEMES` / `UI_CHAT_LAYOUTS` from `settings.service.ts` next to `SCREEN_CONTROL_MODES`.
- `backend/migrations/<timestamp>-ui-appearance.js` — set the defaults on the existing singleton.

**Frontend**:

- `frontend/src/store/prefs.ts` — add `theme: ThemeId` and `chatLayout: ChatLayoutId` to
  `PersistedPrefs`/`DEFAULTS`, with setters that (a) apply immediately, (b) write localStorage,
  (c) fire-and-forget `settingsApi.update({ ui_theme })`. **Fix the latent bug at
  `prefs.ts:45-52`**: `persist()` destructures a fixed field list despite its comment claiming
  otherwise — replace with an explicit `PERSISTED_KEYS` pick so adding a field can't drop another.
  Update the doc comment: this store is no longer "never sent to the backend" — it is the local
  cache of an operator preference that also lives on the settings doc.
- Boot adoption: after the first authenticated `settingsApi.get()`, if `ui_theme`/`ui_chat_layout`
  differ from the cached values, adopt the server's (it is the cross-device source of truth).
  Hook into `views/AuthGuard.tsx`, which already gates the app on auth.
- **No flash**: an inline `<script>` in `frontend/index.html`, before the module bundle, reads
  `localStorage['pleiades.prefs.v1']` and stamps `data-theme` + `dark` on `<html>`. It also lets
  the login screen render themed. Drop the static `class="dark"` and `bg-panel` from the markup.
- `frontend/src/lib/api.ts` — add both fields to `interface InferenceSettings` (~L1593).

### 2.4 Settings UI

Extend the **existing** `/settings/interface` route rather than adding a category — one card, one
route, no new registry plumbing:

- `frontend/src/views/settings/categories.ts` — retitle `interface` to **"Appearance & Interface"**,
  icon `Palette`, `contains: ['Theme', 'Chat layout', 'Debugger & chat display']`.
- `frontend/src/views/settings/panels/InterfacePanel.tsx` — two new `<Section>`s above today's:
  **Theme** (a grid of cards, each painting its own `swatch` triplet plus a miniature fake message)
  and **Chat layout** (a grid of cards, each a small CSS diagram of the structure). Both apply
  instantly on click. Reuses `ui/Glass.tsx`'s `Section` and the existing panel idiom.
- Also add a compact theme popover to the sidebar footer (`components/Sidebar.tsx`) — switching a
  theme is something you do to *look* at it, and a round-trip through Settings kills that.

---

## Phase 3 — Chat layout seams (no visual change for Hybrid)

`ChatPanel.tsx` is decomposed once; Hybrid must come out identical.

### 3.1 Layout registry — `frontend/src/theme/layouts.ts`

```ts
export type ChatLayoutId = 'hybrid' | 'transcript' | 'workbench' | 'timeline' | 'bubbles';

export interface ChatLayoutDef {
  id: ChatLayoutId;
  label: string; blurb: string;
  /** Turn framing. */
  userStyle: 'bubble-right' | 'label-block' | 'bubble-left';
  agentStyle: 'document' | 'label-block' | 'bubble' | 'rail';
  /** How a `kind:'tool'` block presents. */
  toolStyle: 'card' | 'row' | 'chip' | 'none';
  /** How a `kind:'reasoning'` block presents. */
  thinkingStyle: 'block' | 'line' | 'node' | 'none';
  /** Tools/reasoning/hops move out of the flow into a permanently docked column. */
  rightColumn: 'trace' | null;
  density: 'comfortable' | 'compact';
  readingWidth: string;          // Tailwind max-w-* for the conversation column
}
export const CHAT_LAYOUTS: ChatLayoutDef[];
```

A `ChatLayoutContext` provider wraps the conversation; `Blocks.tsx` and `ToolCall.tsx` read it, so
tool/reasoning/sub-agent rendering adapts **without any layout owning a copy of them**.

### 3.2 Extractions

- **`ChatPanel.tsx` → shell + conversation.** The shell keeps the header (`:387-474`), the
  forum strip (`:478`), `ContainerBanner`, the scroll region, `TodoPanel`, `AskUserPrompt` and the
  whole composer (`:599-794`) — all layout-independent. It renders `<ConversationView>` for the
  active layout inside the scroll region. While in there, replace the awkward `ml-auto` cascade at
  `:420/430/442/453` (each optional control recomputes whether *it* carries `ml-auto`) with a single
  spacer.
- **`MessageRow` (`ChatPanel.tsx:27-97`)** — the only place the bubble-vs-document decision is
  made — moves into `components/workspace/layouts/hybrid/` and becomes one implementation among
  five.
- **`ToolCall.tsx` — extract the shared shell.** The same string
  (`my-2 animate-fade-up overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.03] …`)
  plus its header/status row is duplicated across all six variants (`DraftingBlock`, `BashBlock`,
  `VisualActBlock`, `VisionBlock`, `MediaGenBlock`, `GenericToolBlock`). Extract one `<ToolCard>`
  that reads `toolStyle`/`density` from context. **This is the single highest-leverage change in
  the phase**: all six variants then work in every layout for free.
- **`Blocks.tsx:37-57`** — the one dispatch point for all four block kinds; it consults the
  descriptor to pick `ThinkingBlock` vs a one-line thought toggle vs a timeline node, and to
  suppress inline tools when `rightColumn === 'trace'`.
- **`AgentWorkspace.tsx:339-410`** — the flat flex row gains the layout's `rightColumn`. When it is
  `'trace'`, the trace column is always docked and the header's debugger toggle offers only
  Isolation / Data.

No change to `store/stream.ts`. Live and persisted turns already render through the identical
`Block[]` shape (`buildBlocks` at `stream.ts:243-292`, fed at `ChatPanel.tsx:308-311`), so every
layout gets streaming for free.

---

## Phase 4 — The four new layouts

Each is one directory under `frontend/src/components/workspace/layouts/`, exporting a
`ConversationView` with a common props contract (`turns`, `liveBlocks`, `streaming`,
`activityLabel`, `onRetry`…).

- **`transcript/`** (Codex) — everything left-aligned at `max-w-3xl`, small `You` / agent-name role
  labels, no bubbles. `toolStyle: 'row'`: one line per call — chevron, mono tool name, the
  `describeTool` value from `lib/toolSummary.ts:describeTool`, a status glyph — expanding to the
  full `ToolCard` body on click. `thinkingStyle: 'line'`: a quiet "thought for 4s" toggle.
  Sub-agent hops render as an indented rail rather than a tinted bubble.
- **`workbench/`** — `rightColumn: 'trace'`, `toolStyle: 'none'`, `thinkingStyle: 'none'`. The
  conversation column carries prose and one-line sub-agent summaries only; a docked
  `TraceColumn` renders every tool call, thought and hop live. **It reuses the store's existing
  `TraceEntry[]`** (`stream.ts:340-346`, pushed at `:541/:639/:773/:815/:846`) and
  `DebuggerDrawer.tsx`'s `TraceCard` + `KIND_META` — promoted out of the drawer into a shared
  `components/workspace/TraceColumn.tsx` that both the drawer's Trace tab and this layout render.
- **`timeline/`** — a `flattenToTimeline(turns, live)` helper walks the `Block[]` tree into a flat
  `{ t, kind, actor, label, detail, depth }[]`, rendered as nodes on one vertical spine with
  depth-indented hop markers. Densest view; built for auditing a long autonomous run.
- **`bubbles/`** — both roles bubbled and tight, `density: 'compact'`, `toolStyle: 'chip'`
  (an inline pill that expands into the card), `readingWidth: 'max-w-2xl'`.

---

## Phase 5 — Rewrite `DIRECT_ART.md`

The doc currently mandates the single look and forbids exactly this change ("Theme policy:
**dark-only, deliberately**"; §8 Don't: "Add a light theme"). Rewrite:

- §1 — Pleiades becomes *the default theme and reference implementation*, not the only one.
- §2 — the palette table becomes the **token contract**: what each variable means semantically
  (`slate-100` = strongest text … `slate-600` = faintest; `.hairline`, `.raise-*`, `.well*`), which
  is what a new theme must satisfy.
- §3/§5/§6 — glass, typography and motion restated as *per-theme variables* with Pleiades' values
  as the reference.
- New §10 — **How to add a theme** (one CSS file + one `ThemeDef`) and **how to add a chat layout**
  (one `ChatLayoutDef` + one `ConversationView`).
- §9's "where it lives" table gains `src/theme/`.

---

## Critical files

| Concern | File |
|---|---|
| Token remap | `frontend/tailwind.config.ts` |
| Utilities, var-ized | `frontend/src/index.css` |
| Theme registry + apply | `frontend/src/theme/themes.ts`, `theme/apply.ts` (new) |
| Theme CSS | `frontend/src/theme/themes/*.css` (new, 5 files) |
| Layout registry + context | `frontend/src/theme/layouts.ts`, `theme/ChatLayoutContext.tsx` (new) |
| Layouts | `frontend/src/components/workspace/layouts/*/` (new, 5 dirs) |
| Chat shell decomposition | `frontend/src/components/workspace/ChatPanel.tsx` |
| Block dispatch | `frontend/src/components/workspace/Blocks.tsx` |
| Tool card shell | `frontend/src/components/ToolCall.tsx` |
| Trace column extraction | `frontend/src/components/workspace/DebuggerDrawer.tsx` → `TraceColumn.tsx` |
| Workspace flex row | `frontend/src/views/AgentWorkspace.tsx` |
| Prefs + backend sync | `frontend/src/store/prefs.ts`, `views/AuthGuard.tsx` |
| Picker UI | `frontend/src/views/settings/panels/InterfacePanel.tsx`, `settings/categories.ts` |
| Quick switcher | `frontend/src/components/Sidebar.tsx` |
| Runtime identity colors | `frontend/src/lib/agentColor.ts` |
| Third-party themes | `frontend/src/lib/monacoTheme.ts`, `components/Mermaid.tsx`, `components/Markdown.tsx` |
| No-flash bootstrap | `frontend/index.html` |
| Settings persistence | `backend/src/domain/settings/settings.model.ts`, `settings.service.ts`, `transport/http/routes/settings.routes.ts`, `backend/migrations/<ts>-ui-appearance.js` |
| Art direction | `DIRECT_ART.md` |

## Reused, not rebuilt

- `store/stream.ts` — `Block[]`, `buildBlocks`, `TraceEntry[]`: untouched; every layout reads them.
- `lib/toolSummary.ts:describeTool` — already produces the icon/value/hint the compact tool row and
  the timeline node need.
- `components/ui/{Glass,Controls,Badge}.tsx` — the shared kit; theming it themes most views.
- `ui/Badge.tsx:TONES`/`toneOf` — the app's existing semantic status vocabulary; keep it, point it
  at the ramps.
- `DebuggerDrawer.tsx:TraceCard`/`KIND_META` — becomes the Workbench trace column.
- `hooks/usePersistentState.ts`, `useStickyScroll.ts`, `workspace/Collapsible.tsx`.

---

## Verification

1. `cd frontend && npm run typecheck && npm run build`; `cd backend && npm run typecheck`.
2. **Phase 1 gate — visual no-op.** Screenshot `/workspace`, `/agents`, `/settings`, `/flows`
   before starting; after Phase 1 they must be pixel-identical on Pleiades.
3. `npm run migrate:up`, then confirm `GET /api/settings` returns `ui_theme`/`ui_chat_layout` and a
   `PUT` of a bogus value is ignored (enum guard) while a valid one persists across a restart.
4. `docker compose up --build`, log in, then for **each of the 5 themes**: walk `/workspace`
   (streaming turn with a bash call, an image tool, a `<think>` block and an `ask_agent` hop),
   `/settings`, `/flows` (React Flow chrome), `/skills` (Monaco), a markdown reply with a mermaid
   diagram and a fenced code block (Mermaid + Prism), and the logged-out `/login` screen.
   Watch specifically for: unreadable text on the two light themes, invisible hairlines, Monaco's
   transparent background, and agent identity colors from `agentColor.ts`.
5. For **each of the 5 layouts**, on one long session: tool cards, nested sub-agent bubbles, live
   streaming caret, sticky scroll, the "Show N earlier messages" fold, TodoPanel, ask-user banner,
   and the debugger drawer (Workbench must dock the trace and hide the Trace tab).
6. Reload mid-stream to confirm `chat:snapshot` hydration renders in the active layout.
7. Hard-refresh with a non-default theme selected → **no flash of Pleiades** (the `index.html`
   bootstrap).
8. Change theme in one browser, reload in another → the backend value is adopted.
9. `prefers-reduced-motion: reduce` (DevTools rendering pane) → all decorative animation frozen in
   every theme.
