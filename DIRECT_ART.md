# DIRECT_ART.md — PleiadesAI Visual Direction

Art direction for the PleiadesAI frontend. Defined during the chat-workspace restyle (July 2026);
every new view or component should be judged against this document. The living reference
implementation is the Agent Workspace (`views/AgentWorkspace.tsx` and everything it renders).

---

## 1. Concept — *"Glass over the Pleiades"*

PleiadesAI is named after the Pleiades star cluster, and the interface commits to that identity:
a single-operator **command center floating in deep space**. The UI is built as two strata:

1. **The backdrop** — a deep-space gradient with faint nebula glows and twinkling CSS stars.
   It is atmosphere, never content. It sits at the very back and nothing else imitates it.
2. **The instruments** — frosted-glass panels (sidebar, header, drawer, composer, cards) that
   float above the backdrop. Everything the operator reads or touches lives on glass.

The emotional target: calm, dark, precise — an observatory at night, not a neon arcade. Color is
spent on *meaning* (identity, state, danger), never on decoration.

Theme policy: **dark-only, deliberately.** The command center is a low-light environment; there is
no light theme and none should be added ad hoc.

---

## 2. Palette

Core tokens (in `tailwind.config.ts`):

| Token | Hex | Role |
|---|---|---|
| `panel` | `#0f1419` | legacy base ground (pre-glass surfaces, non-workspace views) |
| `surface` | `#161b22` | legacy raised surface |
| `border` | `#2a3038` | legacy hairline |
| `accent` | `#3b82f6` | the brand blue: primary actions, links, the user's voice |
| `reasoning` | `#a855f7` | thinking/`<think>`/debugger purple — *cognition is always purple* |

Backdrop gradient (in `index.css`, `.space-bg`): `#0b0f16 → #0a0d13 → #0d0f1a` at 165°, with a
`rgba(59,130,246,.13)` nebula top-left and `rgba(168,85,247,.10)` bottom-right. The nebulae tie the
backdrop to `accent`/`reasoning` so the atmosphere and the instruments share DNA.

Semantic state colors (never used decoratively):

- **emerald** (`#34d399` family) — success, "working" pulses, exit 0
- **amber** (`#f59e0b` family) — live/in-flight readings, warnings, truncated turns
- **red** (`#ef4444` family) — errors, stop, destructive hovers

Agent identity colors come from `lib/agentColor.ts` (hash or operator-chosen) and thread through
everything an agent owns: avatar, name, sub-agent bubble border/rail/glow, working pins. Identity
color always beats accent inside an agent's own scope.

**On-glass neutrals**: on translucent panels, do not use the legacy `border`/`panel` greys for
fills, dividers, or hovers — use white alphas so the glass shows through:

- hairline dividers/borders: `border-white/[0.06]`–`/[0.07]` (hover: `/[0.12]`)
- hover fills: `bg-white/[0.05]`–`/[0.06]`
- inset wells (inputs, quotes, terminal): `bg-black/20`–`/40`
- slate text scale: `slate-100` (primary) → `slate-400` (secondary) → `slate-500/600` (faint)

---

## 3. Glass

Two utilities in `index.css`; do not hand-roll new glass recipes:

- **`.glass`** — chrome (sidebars, headers, drawers): `rgba(22,27,34,.55)` + `blur(14px)` +
  `border-color: rgba(255,255,255,.07)`. Always pair with a Tailwind `border-*` side class.
- **`.glass-card`** — floating elements (composer, ask-user prompt): `rgba(17,22,30,.6)` +
  `blur(18px)` + deep drop shadow + a 1px inner top highlight.

In-flow cards (tool cards, thinking blocks, trace cards) use *lightweight glass*: a translucent
fill (`bg-white/[0.03]`, `bg-black/25`, or a color-tinted alpha) + `backdrop-blur-sm`. Full
`.glass` blur is reserved for chrome — dozens of heavily blurred cards would tank paint time.

Radii grammar: `rounded-full` for pills/meters, `rounded-2xl` for floating cards, `rounded-xl` for
in-flow cards and bubbles, `rounded-lg`/`rounded-md` for buttons and chips. Shadows are either the
glass-card drop shadow or a *colored glow* (see Motion) — never generic grey elevation.

---

## 4. Layout

- **Hybrid chat**: the user speaks in a compact right-aligned bubble (`max-w-[78%]`, gradient
  `accent → indigo`, `rounded-br-md` tail, blue glow shadow). The agent answers **full-width,
  document-style**: a 7×7 identity avatar + name header row, then an open content column indented
  `pl-9`. Rationale: user turns are short and scannable; agent turns are dense with tool cards,
  code, and sub-agent bubbles and need the whole line.
- **Reading column**: conversation content is centered at `max-w-3xl`; the chrome (header,
  composer card) spans wider but the composer's inner card also caps at `max-w-3xl` so the eye
  travels one vertical lane.
- **Floating, not full-bleed**: the composer is a padded floating card (`px-4 pb-4 pt-3`), not an
  edge-to-edge bar. Banners (ask-user) follow the same pattern.
- Message rhythm: `space-y-6` between turns; `gap`-based flex/grid inside groups, not stacked
  margins.

---

## 5. Typography

System stacks only (no webfonts): `ui-sans-serif` for UI, `ui-monospace` for anything machine —
commands, tokens meters, trace labels, image handles, JSON. The mono/sans split is semantic:
*if an agent or the system produced it verbatim, it's mono.*

Scale in practice: `text-sm` body, `text-xs` controls/labels, `text-[11px]` metadata,
`text-[10px]` uppercase-tracked section labels. Agent names get `font-semibold tracking-wide` in
their identity color.

---

## 6. Motion

The motion vocabulary is six keyframes in `tailwind.config.ts` — compose these, don't invent
one-off animations:

| Animation | Use |
|---|---|
| `fade-up` (350ms, overdamped) | entrance of every message, card, and trace entry |
| `shimmer` → `.text-shimmer` | any live "working…/thinking…" label — a sheen across the glyphs |
| `glow-pulse` (2.4s, `--glow` var) | breathing colored glow on *live* things: running sub-agent bubbles, stop button, ask-user card, working pins |
| `gradient-x` (6s) | drifting gradient fills — the send button (accent → indigo → reasoning) |
| `blink` → `.stream-caret` | the `▍` streaming caret riding the end of live prose |
| `twinkle` | the starfield layers only |

Rules:

- Glow color is always passed through the `--glow` CSS variable so identity colors thread in
  (e.g. a sub-agent bubble pulses in *its own* hue at ~18% alpha).
- Motion marks **liveness**. A finished turn is still; a running one shimmers, pulses, and
  carries a caret. Never animate something idle.
- Everything decorative freezes under `prefers-reduced-motion: reduce` (global kill in
  `index.css`). Micro-interactions: `active:scale-95` on primary buttons, `transition-colors`
  or `transition-shadow` elsewhere; 150–300ms.

---

## 7. Component treatments (reference)

- **Chat header**: `.glass` bar; status line uses a glowing dot + shimmered label in the active
  agent's color; context meter is a glass **pill** (`rounded-full`) — blue when settled, amber
  while live, red ≥90%, with a ghost tick marking the settled total.
- **Thinking block**: purple-tinted glass (`bg-reasoning/[0.06]`, `border-reasoning/20`), purple
  glow + shimmered "Thinking…" while active, collapses to a chip when done.
- **Tool cards**: `bg-white/[0.03]` glass, hairline border that brightens on hover; **bash** is
  the exception — near-black terminal glass (`bg-black/40`, mono, emerald `$`). Image thumbnails
  ride in a bordered strip with their `img_N` handle badged on a black scrim.
- **Sub-agent bubble**: bordered/tinted in the agent's identity color, `animate-glow-pulse` while
  running, its work rail-marked by a 2px left border in the same hue.
- **Workspace nav / debugger**: `.glass` chrome; active session gets `bg-accent/15` + a 2px inset
  accent rail; trace cards are `bg-black/25` with kind-colored rings.
- **Send button**: the one deliberately loud element on the page — animated tri-color gradient,
  indigo hover glow. Everything around it stays quiet; keep it that way.

---

## 8. Do / Don't

**Do**
- Put new workspace surfaces on glass over the starfield; reuse `.glass`/`.glass-card`.
- Thread agent identity color through anything an agent owns; pass glows via `--glow`.
- Use white/black alphas for on-glass borders, hovers, and wells.
- Animate liveness only, and always respect reduced motion.

**Don't**
- Add a light theme, a second backdrop, or per-component star effects.
- Use `reasoning` purple for anything that isn't cognition/debugging.
- Stack heavy `backdrop-blur` on repeated in-flow cards.
- Introduce grey elevation shadows, new radii, or one-off keyframes.
- Spend accent blue on decoration — it belongs to actions and the user's voice.

---

## 9. Where it lives

| Concern | File |
|---|---|
| Tokens, keyframes, animations | `frontend/tailwind.config.ts` |
| Backdrop, glass, shimmer, caret, scrollbars, reduced-motion | `frontend/src/index.css` |
| Backdrop mount | `frontend/src/views/AgentWorkspace.tsx` (`.space-bg`) |
| Hybrid chat, header, composer | `frontend/src/components/workspace/ChatPanel.tsx` |
| Thinking / sub-agent / streaming | `frontend/src/components/workspace/Blocks.tsx` |
| Tool cards | `frontend/src/components/ToolCall.tsx` |
| Nav + drawer chrome | `frontend/src/components/workspace/WorkspaceNav.tsx`, `DebuggerDrawer.tsx` |
| Identity colors | `frontend/src/lib/agentColor.ts` |
| Favicon (same DA: cluster + nebula on dark tile) | `frontend/public/favicon.svg` |
