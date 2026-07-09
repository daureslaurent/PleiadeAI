# Desktop Operator — Playbook

My operating manual for controlling this Linux (MATE) desktop. Read it before acting; keep it current.

## Machine quick facts
- Display `:99`, roughly **1280×800** px. Coordinates: x ∈ [0, 1279], y ∈ [0, 799], origin top-left.
- Desktop: **MATE** (window manager `marco`) — real title bars; the close button is top-right of each window.
- `bash` runs on **this same machine**. GUI programs need the display, so prefix them:
  `export DISPLAY=:99 XAUTHORITY=/opt/pleiades/visual/Xauthority`

## The loop (every time)
**LOOK** (`visual_screenshot`) → **PLAN** → **ACT** (one step) → **VERIFY** (screenshot or `bash`) → adapt. Never fire two actions blind.

## Two ways to look — phrase the question for what you need
`visual_screenshot` picks its mode from your `question`:
- **READ / DESCRIBE** → ask "what is on screen?", "read the dialog", "list the search results with titles and URLs". You get a plain-text answer (no coordinates). Use this to understand pages, dialogs, and results.
- **LOCATE** → ask "where is the X button?", "give the coordinates of the address bar". You get pixel `(x, y)` to feed `visual_act` (a grid is drawn to help).
Don't ask a "list/read" question expecting coordinates, or a "where" question expecting page text — pick the phrasing that matches your intent.

## Launching applications — use `bash`, not menus
Launch detached so it survives the command, then wait ~1–2s and screenshot:
```
DISPLAY=:99 XAUTHORITY=/opt/pleiades/visual/Xauthority setsid nohup <app> >/dev/null 2>&1 &
```
Common apps: `firefox`, `chromium`, `mate-terminal` / `xterm`, `caja` (files), `pluma` (text editor).
Opening with a target is best, e.g. `firefox "https://example.com"` or `caja /workspace`.
Don't click through the menu to launch something — the terminal is faster and reliable.

## Window management — use `visual_windows`, not clicks
- `visual_windows` (list): every window with `id`, `title`, rectangle `{x,y,width,height}`, and which is active.
- Close: `visual_windows action=close title="Firefox"` (or by `id`) — graceful close, no pixel-hunting.
- Raise/focus: `action=activate`. Minimize: `action=minimize`.
- **Never** chase the title-bar X with the mouse; it is the single least reliable click on the screen.

## Clicking & typing inside an app
- Locate: `visual_screenshot question="where is <thing>?"` → read the `(x, y)` from the analysis (grid-anchored).
- Click, then **verify** with a new screenshot. If nothing changed, the coordinate was off — re-look; do **not** repeat the same click.
- Type into a field: click it (or `Tab` to it) first, then `visual_act action=type text="…"`.
- Keys: `visual_act action=key keys=["ctrl","l"]`; a single key: `visual_act action=key text="Enter"`.

## Web browsing — keyboard first
- Launch with the URL directly: `… setsid nohup firefox "https://…" &`.
- Address bar: **Ctrl+L**, type the URL or a search, **Enter**.
- New tab **Ctrl+T**, close tab **Ctrl+W**, reload **Ctrl+R**, find **Ctrl+F**, back/forward **Alt+Left/Right**.
- To read/extract, screenshot with a question: `question="summarize the visible page"` or `"find the login form and its fields"`. Scroll with `visual_act action=scroll amount=-500` and screenshot again for more.
- Prefer typing URLs and shortcuts over clicking tiny nav buttons.

## Terminal vs GUI
You already have `bash` on this machine — use it directly for anything scriptable (downloads, file ops, checks, `xdotool`, process control) instead of driving an on-screen terminal. Only drive a GUI terminal when the task is specifically about what's shown on screen.

## Coordinate reality (read this)
- The vision model reads coordinates off the red 100‑px grid drawn on each screenshot. They are **approximate**, worst for small targets.
- Out-of-range coordinates are auto-clamped and flagged — treat a clamp note as "my read was wrong," and look again.
- **Two failed attempts at the same target ⇒ stop clicking.** Switch to a keyboard shortcut, the terminal, or `visual_windows`.

## Keyboard shortcut cheatsheet
- General: `Enter` `Tab` `Esc` arrows · `Ctrl+C/V/X` · `Ctrl+A` · `Ctrl+S` · `Ctrl+W` · `Ctrl+Q` · `Alt+F4` (close window) · `Alt+Tab` (switch) · `Super` (menu) · `PrtSc`.
- Browser: `Ctrl+L` `Ctrl+T` `Ctrl+W` `Ctrl+R` `Ctrl+F` `Alt+Left/Right`.

## Human takeover
If `visual_act` returns "a human has manual control of the desktop", pause. Wait a few seconds and retry, or ask the operator whether to continue.

## Reporting
Say the plan in a line, then the outcome with what you actually saw. On failure, state why and what you tried next.

## Learned notes — update me with `update_agents_md`
Append reliable techniques and quirks of *this specific* machine here as you discover them.
- (none yet)
