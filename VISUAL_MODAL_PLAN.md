# Visual control: legacy vs. modal

## The problem

The GUI-control tools (`visual_*`, `android_*`) were designed around a **text-only orchestrator**.
Every time the agent needed to know something about its own screen, the tool captured a frame, sent
it to a *second* model — the operator-configured **Vision endpoint** (Settings → Vision) — and handed
the agent back that model's **prose**. The agent never saw a pixel.

That shape is correct for a text-only agent and strictly lossy for a multimodal one: the runner
already feeds tool-returned images to a vision-capable agent as pixels, and `analyze_image` is
withheld from such agents for exactly this reason — a weaker second model paraphrasing what the
agent could read itself.

Commit `9ebe090` fixed half of it: **describe/read** mode now hands the frame to a multimodal caller.
**Localization** was left entirely on the old path — and localization is where most of the machinery
lives: a red reference grid burned into the image, a coordinate-fraction prompt, `parseCoords`, an
OCR snap onto the nearest tesseract text box, and a per-image affine **calibration** fitted from
synthetic targets. All of it exists to compensate for a weak model guessing coordinates through a
downscale.

## The two modes

One global switch, `screen_control_mode` (Settings → Vision), with three values:

- **`legacy`** — the pre-existing behaviour. A separate Vision-endpoint model reads and locates; the
  agent works from text and coordinates it never verified.
- **`modal`** — the agent's own multimodal model *is* the vision model. Frames arrive as pixels; the
  agent points at what it sees and the tools execute. No second model, no grid-fraction prompt, no
  calibration.
- **`auto`** (default) — `modal` when the calling agent's model supports vision, else `legacy`.
  A fleet mixing text-only and multimodal agents does the right thing per agent with no config.

It is global rather than per-tool because it is one concept, not four: whether a screen is read by
the agent or by a proxy. The per-tool `screen_analysis` select added in `9ebe090` is superseded and
removed; `frames_kept` stays per-tool (it is a context-budget knob, not a mode).

## What each mode does

| | legacy | modal |
| --- | --- | --- |
| `visual_screenshot` READ | Vision endpoint → `analysis` prose | frame attached as pixels (`frameKeep`) |
| `visual_screenshot` LOCATE | grid → Vision endpoint → `parseCoords` → OCR snap → calibration → `x`/`y` | gridded frame attached; the agent reads the coordinate off it |
| `visual_click({target})` | locate + click in one step | **withheld from the toolset** — the agent points, `visual_act` clicks |
| `visual_act`, `visual_windows` | unchanged | unchanged (model-free drivers) |
| `android_screenshot` | Vision endpoint → `analysis` prose | frame attached as pixels |
| `android_ui`, `android_act` | unchanged | unchanged — Android publishes its view hierarchy, so `target` resolution is already exact and no vision model was ever involved |

`visual_click` disappearing in modal mode is the point of the refactor, not a regression: its whole
job is to keep a blind agent out of coordinate-handling. A modal agent is not blind, and routing its
click through a weaker model's guess would make it *less* accurate. It is dropped at resolve time
(the same way `analyze_image` is) and also refuses defensively if called.

The grid survives in modal LOCATE mode: labelled crossings cost nothing and are exactly the aid a
VLM needs to convert what it sees into a pixel. `visual_screenshot` gains an explicit `grid` boolean
so the agent can force or suppress the overlay instead of relying on the question-shape heuristic.

Click **calibration** (`measureVisualCalibration`, `image.visual_calibration`) stays, and stays a
legacy-only concept: it fits the bias of a *specific vision model at a specific resolution*, which
has no meaning when the agent reads the frame itself.

## Files

- `domain/settings/settings.model.ts` + `settings.service.ts` — the `screen_control_mode` field.
- `transport/http/routes/settings.routes.ts` — the PUT whitelist (a key absent here silently never persists).
- `migrations/` — one migration seeding `auto` on the settings singleton.
- `tools/core/screen-analysis.ts` — the shared policy: resolves the mode, drops the per-tool select.
- `tools/core/visual.ts` — modal LOCATE, the `grid` param, `visual_click`'s modal refusal.
- `tools/core/android.ts` — reads the global mode.
- `orchestrator/AgentRunner.ts` — withholds `visual_click` in modal mode.
- `tools/core/guide.ts` — mode-aware `visual_screenshot` / `visual` / `android` guidance.
- `frontend/src/lib/api.ts`, `views/settings/panels/InferencePanel.tsx` — the Settings control.
