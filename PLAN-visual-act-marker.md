# Plan — show where `visual_act` acted

Goal: when an agent runs `visual_act`, surface a screenshot with a marker at the pixel
where it clicked / moved / dragged (or the cursor position for keyboard-only actions).

Decisions (confirmed with operator):
- **Background image**: reuse the most recent `visual_screenshot` frame for that agent
  (the frame the agent reasoned on); if none is recent, capture a fresh clean screenshot
  *before* acting.
- **Where shown**: BOTH — a persistent inline card under the `visual_act` tool call in the
  chat/debugger stream, AND a transient pulse on the live noVNC desktop panel.
- **No-coordinate actions** (type / key / scroll-in-place / click at current cursor):
  mark the returned cursor position.

## Touchpoints
Backend:
1. `core/event-bus/events.types.ts` — `VisualActPayload` + `'tool:visual_act'` in EventMap.
2. `tools/types.ts` — `emitVisualAct?` on `ToolContext`.
3. `orchestrator/AgentRunner.ts` — wire `emitVisualAct` next to `emitVision`.
4. `transport/ws/bridge.ts` — map `tool:visual_act` → WS `visual_act` (include `agentId`).
5. `tools/core/visual.ts` —
   - module `lastShot` cache (agentId → clean thumb + dims + ts), populated by
     `visual_screenshot` (add a clean, grid-free thumbnail alongside the gridded card thumb).
   - `visual_act`: pick background (recent cache, else fresh clean capture before acting),
     run the action, derive marker coords from the driver result, `emitVisualAct`.

Frontend:
6. `lib/ws-events.types.ts` — `VisualActEvent`.
7. `store/stream.ts` — `VisualActInfo`; `visualAct?` on tool `Block`/`LiveItem`; pass through
   `buildBlocks`; `lastVisualAct` state; `visual_act` socket handler.
8. `components/ToolCall.tsx` — `VisualActBlock`: image + SVG marker overlay (dot, drag line).
9. `components/workspace/VisualPanel.tsx` — transient pulse over the live canvas for this agent.

Notes: like the existing vision card, the marker is **live-only** (not recorded by
`TurnRecorder`, not persisted to history) — matches current `visual_screenshot` behavior.

---

# Phase 2 — localization accuracy + one-shot click

Problem: the vision model's raw coordinate is imprecise (clicks miss), and a valid
coordinate-only answer like `(500, 640)` was falsely flagged by `annotateIfDegenerate`
as "returned almost nothing".

Decisions (confirmed):
- **Accuracy = both**: denser grid (lines every 50px, labels every 100) **and** a
  coarse-to-fine zoom-refinement pass (crop ~⅓ screen around the first guess, magnify ×2,
  re-grid with *absolute* labels, re-ask the vision model).
- **Click flow = both**: new `visual_click(target, action)` tool that locates → refines →
  clicks in one call (keeps the text agent out of coordinate-handling), **and**
  `visual_screenshot` (localize mode) returns structured `{x, y}`.
- **Warning**: skip the degenerate check entirely in localize mode (short numeric answers
  are expected); keep it for describe/read mode.

Implementation (all in `backend/src/tools/core/visual.ts` + registry):
- New helpers: `parseCoords`, `runVision`, `captureScreen(grid)`, `refineCrop`, `locate`.
- Denser coarse grid + new `refinePrompt`.
- `visual_screenshot` split into localize (→ `locate`, structured x/y, no degenerate warning)
  and describe (clean capture, content prompt, keeps degenerate warning) paths.
- `visual_click` tool → `locate` + click driver + `emitVisualAct` marker; registered in
  `registry.ts` (`VISUAL_TOOL_NAMES`, `CORE_TOOLS`) so it's auto-granted to visual agents.

Cost note: localize now issues **two** vision calls (coarse + refine) when a coarse coord is
found. Acceptable per the accuracy priority; could be gated behind a Settings toggle later.

---

# Phase 3 — click calibration (per image + vision model)

Problem: clicks still land a few px off — a consistent vision read-bias (worsened by the
server's internal image resize), not a driver bug.

Decisions (confirmed):
- **Measure = synthetic targets**: render a distinct marker at known pixels, read it back
  through the *same* localize pipeline, delta = reported − true.
- **Correction = per-axis affine** `x' = ax·x + bx`, `y' = ay·y + by` (least squares).
- **Keyed by image + vision model** (+ resolution); a mismatch is ignored → re-calibrate.
- **Manual trigger + auto-clear**: run from the live desktop; auto-cleared on rebuild + image
  delete; manual Clear on the Images page.

Implementation:
- `image.model.ts` — `visual_calibration` subdoc; migration `20260706180000-*`.
- `visual.ts` — `captureScreen(sourcePath?)`, `renderCalibTarget`, `fitAxis`, `loadCalibration`,
  `measureVisualCalibration` (exported); `locate` now applies the correction (opt-out during
  measurement) so both `visual_screenshot` (localize) and `visual_click` return calibrated coords.
- `agent-container.routes.ts` — `POST /visual/calibrate` (boots desktop, measures, saves to image).
- `images.routes.ts` — auto-clear on `/build`; `DELETE /:id/calibration`.
- Frontend — `visualApi.calibrate`, `imagesApi.clearCalibration`; **Calibrate** button + result in
  `VisualPanel`; calibration status + **Clear** in `ImagesView`.

Note: calibration is *run* from an agent's live desktop (that's where a booted desktop exists) but
*stored on the image*, so it applies to every agent using that image. Migration is purely additive
(default null) — run `npm run migrate:up`, though the app tolerates its absence.

---

# Phase 4 — OCR snap (calibration wasn't enough)

Problem: calibration only fixes a *consistent* bias; the vision model's coordinates are just
*imprecise* (noisy, varies per call), so affine correction can't help. Targets are a mix of
text and graphical.

Decision: **OCR-assisted** snapping. Vision model finds the general area (post coarse+refine),
then snap the point to the exact centre of the tesseract-detected text box it lands on/near —
pixel-exact for buttons/menus/labels. Graphical targets (no nearby text) fall through to the
raw vision point + calibration. Skipped for synthetic calibration frames.

Implementation (`visual.ts`):
- `ocrBoxes(exec, rawPath)` — tesseract `--psm 11 tsv`, conf ≥ 50; `|| true` so a missing binary
  (image built before this layer) silently yields `[]` (graceful fallback, no hard dep).
- `snapToOcr(coord, boxes, question, height)` — eligible boxes within a ~3%·height margin of the
  point; a box whose text matches the target tokens wins, else the nearest; returns its centre.
- `locate()` — snap after refine, before calibration; when snapped, skip calibration (box is
  already exact) and note it in `analysis`.
- Visual Docker layer gains `tesseract-ocr` (backend `VISUAL_DOCKERFILE_SNIPPET` + frontend
  `VISUAL_SNIPPET`, kept in sync). **Existing visual images must be rebuilt** to get OCR; until
  then they degrade to the old vision-only behaviour.

---

# Phase 5 — remove zoom-refine (didn't work)

The coarse-to-fine zoom-refinement pass didn't help in practice, so it was removed entirely.
Localize is now a **single** vision pass off the gridded full screenshot, then OCR snap for text
targets. Deleted `refinePrompt` + `refineCrop`; dropped the second vision call and the preview
crop-swap. Net effect: localize now issues **one** vision call (down from two), and the chat
preview is always the full gridded screenshot with the marker in absolute coordinates.

---

# Phase 6 — normalised [0,1] coordinates

Problem: long absolute-pixel grid labels blur out when the vision *server* downscales the image
(server-side, not controllable per-request), so absolute reads stay imprecise.

Decision (confirmed): the model answers in **[0,1] fractions, 2 decimals** (e.g. `(0.42, 0.31)`);
the tool converts back to pixels. Grid relabelled: a line every **10%**, and the **(x,y) fraction
printed at every crossing** as short labels like `.4,.3` (`Every 0.1`, 9×9 nodes). **OCR snap kept**
on top (fractional read = general area; OCR pins text to the exact box).

Implementation (`visual.ts`):
- `localizePrompt(question)` — rewritten for normalised fractions + crossing labels (no longer
  takes w/h).
- Grid Python in `captureScreen` — draws the 10% grid and the `frac(i),frac(j)` label at each node
  (`.1`…`.9`, leading zero dropped).
- `parseCoords(text, w, h)` — now returns PIXELS: parses decimals incl. leading-dot; ≤1.5 =
  fraction×dim (requested), ≤100 = percentage fallback, else already-pixels. Verified with a JS
  harness across formats.
- Calibration + OCR-snap paths unchanged (they call `locate()`, which parses via `parseCoords`).
