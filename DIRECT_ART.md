# DIRECT_ART.md — PleiadesAI Visual Direction

Art direction for the PleiadesAI frontend. Defined during the chat-workspace restyle (July 2026);
opened up into a theme system in September 2026 (`THEME_SYSTEM_PLAN.md`). Every new view or
component should be judged against this document.

The app now wears one of **five themes** and lays its chat page out in one of **five structures**,
picked independently at `/settings/interface`. **Pleiades** is the default and the reference
implementation — the living example is the Agent Workspace (`views/AgentWorkspace.tsx` and
everything it renders) — but it is no longer the only look, and nothing in a component may assume
it is.

---

## 1. Concept — *"Glass over the Pleiades"*

PleiadesAI is named after the Pleiades star cluster, and its default theme commits to that
identity: a single-operator **command center floating in deep space**, built as two strata:

1. **The backdrop** — a deep-space gradient with faint nebula glows and twinkling CSS stars.
   It is atmosphere, never content. It sits at the very back and nothing else imitates it.
2. **The instruments** — frosted-glass panels (sidebar, header, drawer, composer, cards) that
   float above the backdrop. Everything the operator reads or touches lives on glass.

The emotional target: calm, dark, precise — an observatory at night, not a neon arcade. Color is
spent on *meaning* (identity, state, danger), never on decoration.

The other four themes are different answers to the same brief, and each one owns its own claim:

| Theme | Claim |
|---|---|
| **Pleiades** (default) | The command center as an observatory. Glass over a starfield. |
| **Codex** | A document tool. Flat, light, neutral; one hairline rule; no glow. |
| **Terminal** | The fleet as a TTY. Near-black, one mono family, square corners, phosphor green. |
| **Paper** | A printed page. Warm cream, ink text, **serif prose** — built to read a long answer. |
| **Nebula** | Pleiades saturated. Violet ground, cyan and magenta, glow turned up. |

Theme policy: **whatever the operator picked.** A component never hard-codes a colour, a radius, a
font, or the existence of frost — it names a token and the theme answers. Light themes are
first-class; anything you write must be legible on cream as well as on deep space.

---

## 2. The token contract

This is the part a component actually programs against. Everything below is a CSS custom property
defined per theme in `frontend/src/theme/themes/*.css` and exposed through
`frontend/tailwind.config.ts`, so the class names in components stay ordinary Tailwind.

**The neutral ramp is a *foreground* ramp.** `slate-*` is the app's text scale, and the numbers
mean *strength*, not lightness:

| Class | Role |
|---|---|
| `text-slate-100` | primary text |
| `text-slate-200`/`300` | body, secondary |
| `text-slate-400`/`500` | metadata, labels |
| `text-slate-600` | faintest — placeholders, disabled |

A light theme therefore *inverts the ends and keeps the middle*: `slate-100` becomes near-black
ink, `slate-500` stays a mid grey. Never reach for `slate-800` as a *surface*; that is what
`bg-panel` / `bg-surface` are for.

**Named surfaces and hues**

| Token | Role |
|---|---|
| `panel` | the page ground |
| `surface` | a raised opaque surface (device chrome, popover ground) |
| `border` | the opaque hairline for legacy non-glass surfaces |
| `accent` | primary actions, links, the user's voice |
| `reasoning` | thinking/`<think>`/debugger — *cognition is always this hue* |
| `oncolor` | text or a knob **on a filled colour** (`bg-accent text-oncolor`) — not part of the ramp |
| `scrim` | a darkening layer over *media* (video letterbox, a badge on a thumbnail) — dark in every theme |

**Semantic state ramps** — `emerald` (success, "working", exit 0), `amber` (live/in-flight,
warnings, truncated turns), `red` (errors, stop, destructive). Themed like the neutrals, so they
stay readable on a light ground. Never used decoratively.

**The four on-surface idioms.** These are utilities, not alphas, because the alpha itself has to
change per theme — 6% white reads as a hairline on deep space and is invisible on cream:

| Utility | Role |
|---|---|
| `.hairline` / `.hairline-strong` | a divider or border (strong = its hover/active state) |
| `.ring-hairline` / `.ring-hairline-strong` | the same, as a ring |
| `.divide-hairline` | the same, on a `divide-y` stack |
| `.raise-1` / `.raise-2` / `.raise-3` | a fill lifted off the ground: card · hover/selected · pressed chip, meter track |
| `.well` / `.well-strong` | an inset well: input, quote, terminal pane · focused input, bash pane |

Do **not** write `bg-white/[0.05]` or `bg-black/25` in new code. (`white` and `black` still resolve
to theme-aware raise/well colours so the long tail keeps working, but they cannot vary their alpha
and are not the idiom.)

**Radii, type and effects** are tokens too: `--r-md/lg/xl/2xl` (Terminal sets them all to `0`),
`--font-sans/mono/serif/prose` (`font-prose` is markdown body text; Paper points it at a serif),
`--glass-*` / `--popover-*` (a flat theme sets blur to `0` and the background opaque),
`--stars-opacity` and `--glow-strength` (both `0` in the flat themes).

**Agent identity colours** come from `lib/agentColor.ts`. Only the *hue* belongs to the agent (hash
or operator-chosen); saturation and lightness come from the theme's `--identity-*` variables, so an
identity reads on cream as well as on deep space. Identity color always beats accent inside an
agent's own scope, and threads through everything the agent owns: avatar, name, sub-agent bubble
border/rail/glow, working pins.

---

## 3. Surfaces

Three utilities in `index.css`; do not hand-roll a new recipe:

- **`.glass`** — chrome (sidebars, headers, drawers).
- **`.glass-card`** — floating elements (composer, ask-user prompt).
- **`.glass-popover`** — anything floating *over* content, which must stay opaque enough to read.

Under Pleiades and Nebula these frost; under Codex, Terminal and Paper the same classes render as
flat opaque panels. That is the point — a component asks for "chrome" and the theme decides what
chrome is.

In-flow cards (tool cards, thinking blocks, trace cards) use *lightweight* surfaces: `.raise-1`,
`.well`, or a color-tinted alpha, plus at most `backdrop-blur-sm`. Full `.glass` blur is reserved
for chrome — dozens of heavily blurred cards would tank paint time.

Radii grammar: `rounded-full` for pills/meters, `rounded-2xl` for floating cards, `rounded-xl` for
in-flow cards and bubbles, `rounded-lg`/`rounded-md` for buttons and chips. Shadows are either the
glass-card drop shadow or a *colored glow* (see Motion) — never generic grey elevation.

---

## 4. Layout

The chat page's structure is the operator's choice (`src/theme/layouts.ts`); §7 describes the
default. What holds across all five:

- **Reading column**: conversation content is centered and capped (`max-w-2xl`–`max-w-4xl`
  depending on the layout); the chrome (header, composer card) spans wider but the composer's inner
  card caps at the same width so the eye travels one vertical lane.
- **Floating, not full-bleed**: the composer is a padded floating card (`px-4 pb-4 pt-3`), not an
  edge-to-edge bar. Banners (ask-user) follow the same pattern.
- Message rhythm comes from the layout's `turnGap`; inside a group use `gap`-based flex/grid, not
  stacked margins.

The **shell** — header, forum strip, container banner, todo panel, ask-user prompt, composer — is
layout-independent and lives in `ChatPanel`. Only the `ConversationView` swaps.

---

## 5. Typography

System stacks only (no webfonts), through the tokens: `font-sans` for UI, `font-mono` for anything
machine — commands, token meters, trace labels, image handles, JSON — and `font-prose` for markdown
bodies. The mono/sans split is semantic: *if an agent or the system produced it verbatim, it's
mono.* (Terminal points all three at the mono stack; Paper points `font-prose` at a serif.)

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
  (e.g. a sub-agent bubble pulses in *its own* hue at ~18% alpha). Its *spread* is scaled by the
  theme's `--glow-strength`, which the flat themes set to `0` — so a glow you add is automatically
  absent where glow isn't part of the language.
- Motion marks **liveness**. A finished turn is still; a running one shimmers, pulses, and
  carries a caret. Never animate something idle.
- Everything decorative freezes under `prefers-reduced-motion: reduce` (global kill in
  `index.css`). Micro-interactions: `active:scale-95` on primary buttons, `transition-colors`
  or `transition-shadow` elsewhere; 150–300ms.

---

## 7. Component treatments (reference)

- **Chat header**: `.glass` bar; status line uses a glowing dot + shimmered label in the active
  agent's color; context meter is a glass **pill** (`rounded-full`) — accent when settled, amber
  while live, red ≥90%, with a ghost tick marking the settled total.
- **Thinking block**: purple-tinted (`bg-reasoning/[0.06]`, `border-reasoning/20`), purple glow +
  shimmered "Thinking…" while active, collapses to a chip when done. The compact layouts render the
  same block as a one-line `Thought · N chars` toggle instead.
- **Tool cards**: `.raise-1` with a `.hairline` that brightens on hover; **bash** is the exception —
  a near-black terminal pane (`.well-strong`, mono, emerald `$`). Image thumbnails ride in a
  bordered strip with their `img_N` handle badged on a `scrim`. The compact layouts show a row or a
  chip that *expands into this same card* — the summary is a lead, never a replacement.
- **Sub-agent bubble**: bordered/tinted in the agent's identity color, `animate-glow-pulse` while
  running, its work rail-marked by a 2px left border in the same hue.
- **Workspace nav / debugger**: `.glass` chrome; active session gets `bg-accent/15` + a 2px inset
  accent rail; trace cards are `.well` with kind-colored rings.
- **Send button**: the one deliberately loud element on the page — animated tri-color gradient,
  indigo hover glow. Everything around it stays quiet; keep it that way.

**Hybrid chat** (the default layout): the user speaks in a compact right-aligned bubble
(`max-w-[78%]`, gradient `accent → indigo`, `rounded-br-md` tail, glow shadow); the agent answers
**full-width, document-style** — a 7×7 identity avatar + name header row, then an open content
column indented `pl-9`. Rationale: user turns are short and scannable; agent turns are dense with
tool cards, code, and sub-agent bubbles and need the whole line.

---

## 8. Do / Don't

**Do**
- Name a token. `text-slate-400`, `.hairline`, `.well`, `bg-accent`, `rounded-xl`.
- Reuse `.glass`/`.glass-card`/`.glass-popover` for chrome and floating surfaces.
- Thread agent identity color through anything an agent owns; pass glows via `--glow`.
- Use `text-oncolor` on a filled colour and `bg-scrim/*` over media.
- Animate liveness only, and always respect reduced motion.
- Check a new surface on **Paper** as well as Pleiades before calling it done.

**Don't**
- Hard-code a hex, an `rgba()`, or a `white`/`black` alpha in a component.
- Assume a dark ground, a starfield, frost, a glow, or a non-zero radius exists.
- Use `reasoning` purple for anything that isn't cognition/debugging.
- Stack heavy `backdrop-blur` on repeated in-flow cards.
- Introduce grey elevation shadows, new radii, or one-off keyframes.
- Spend accent on decoration — it belongs to actions and the user's voice.

---

## 9. Where it lives

| Concern | File |
|---|---|
| Token → CSS-variable mapping, keyframes, animations | `frontend/tailwind.config.ts` |
| Structure: backdrop, glass, on-surface utilities, scrollbars, reduced motion | `frontend/src/index.css` |
| Theme values (one file per theme) | `frontend/src/theme/themes/*.css` |
| Theme registry + `applyTheme` | `frontend/src/theme/themes.ts`, `theme/apply.ts` |
| Chat layout registry | `frontend/src/theme/layouts.ts` |
| Conversation views (one per layout) | `frontend/src/components/workspace/conversation/` |
| Layout context read by block renderers | `frontend/src/components/workspace/ChatLayoutContext.tsx` |
| Backdrop mount (once, for the whole app) | `frontend/src/App.tsx` (`.space-bg`) |
| Chat shell: header, banners, composer | `frontend/src/components/workspace/ChatPanel.tsx` |
| Thinking / sub-agent / streaming | `frontend/src/components/workspace/Blocks.tsx` |
| Tool cards, rows and chips | `frontend/src/components/ToolCall.tsx` |
| Trace column (drawer tab + Workbench) | `frontend/src/components/workspace/TraceColumn.tsx` |
| Identity colors | `frontend/src/lib/agentColor.ts` |
| Third-party themes (Monaco, Mermaid, Prism) | `frontend/src/lib/monacoTheme.ts`, `components/Mermaid.tsx`, `components/Markdown.tsx` |
| Pickers | `frontend/src/views/settings/panels/AppearanceControls.tsx`, `components/ThemeSwitcher.tsx` |
| No-flash bootstrap | `frontend/index.html` |
| Favicon (same DA: cluster + nebula on dark tile) | `frontend/public/favicon.svg` |

---

## 10. Adding a theme, or a chat layout

**A theme** is two things:

1. `frontend/src/theme/themes/<id>.css` — one `:root[data-theme='<id>']` block defining every
   variable the contract in §2 lists. Copy `pleiades.css` and replace the values; leaving one out
   means inheriting Pleiades' and looking broken.
2. An entry in `THEMES` (`frontend/src/theme/themes.ts`) — label, blurb, `mode`, the swatch triplet
   the picker paints, and the Monaco/Mermaid palettes, since those two libraries own their own
   theming and cannot read a variable.

Then add the id to `UI_THEMES` in `backend/src/domain/settings/settings.service.ts`, or the choice
will not persist. Import the CSS file from `index.css`, and add the id to the tiny map in
`index.html` so the first paint is right.

**A chat layout** is also two things: a `ChatLayoutDef` in `frontend/src/theme/layouts.ts` and a
`ConversationView` in `components/workspace/conversation/`, registered in that folder's `index.ts`
(plus the id in `UI_CHAT_LAYOUTS` on the backend). Build it out of the pieces in
`conversation/shared.tsx` and let the descriptor do the work: `toolStyle`, `thinkingStyle` and
`rightColumn` are read by the shared `ToolCall` and `Blocks` renderers at every nesting depth, so a
layout should almost never need to know what a block tree is.
