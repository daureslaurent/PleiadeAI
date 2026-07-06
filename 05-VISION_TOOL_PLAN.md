# Vision-as-a-tool plan (approach A)

**Goal.** A text-only orchestration model drives a GUI fine-grained (look → reason → act). A
**separate, operator-configured vision endpoint+model** interprets each screenshot and returns
**text + pixel coordinates**; the orchestration model never receives raw pixels. The vision model's
**input (screenshot) and output (analysis) are shown in the chat trace**.

This supersedes the earlier assumption that the *agent's own* endpoint must be multimodal. The
agent's endpoint stays text-only; only the global Vision endpoint needs `--mmproj`.

## Backend

1. **Settings** (`settings.model.ts`, `settings.service.ts`, `settings.routes.ts`): add
   `vision_endpoint_id` + `vision_model` (mirror `title_endpoint_id`/`title_model`). Empty
   `vision_endpoint_id` → vision analysis unavailable (tool returns a clear note).
2. **LlamaClient.complete()** — one-shot, non-streaming chat completion returning the full text.
   Used for the vision call. Goes through `endpointGate` for metrics/serialisation.
3. **`visual_screenshot` rewrite** (`tools/core/visual.ts`): capture full PNG **and** a small JPEG
   thumbnail (PIL) in-container. Send the full PNG + the agent's `question` to the Vision endpoint
   (`resolveForEndpoint(vision_endpoint_id, vision_model)`); return the model's **text answer** to the
   agent (no image in the agent's context). Emit `tool:vision` (thumbnail + question + answer + model)
   for the UI. New arg: `question` (what to look for / locate). If no Vision endpoint is configured,
   return a note pointing to Settings (still emit the thumbnail so the operator sees the screen).
4. **Event** `tool:vision` (`events.types.ts`) → wire `vision` (`bridge.ts`), carrying `callId`,
   `image` (thumb dataUrl), `question`, `answer`, `model`.
5. **ToolContext.emitVision** wired in `AgentRunner` like `emitOutput`. Remove the now-moot
   `visionCapable` field added earlier (the agent endpoint no longer needs vision).

## Frontend

6. **ws-events.types.ts**: `VisionEvent`.
7. **store/stream.ts**: on `vision`, patch the matching `tool` block (by `callId`) with a `vision`
   sub-object `{ image, question, answer, model }`; thread through `LiveItem`, `Block`, `buildBlocks`.
8. **ToolCall.tsx**: render the vision panel inside the tool card — screenshot thumbnail + `Q:`/`A:`
   + model tag. Good UI/UX: compact, expandable, theme-aware.
9. **SettingsView**: Vision endpoint + model selectors (mirror the Title controls) with an amber hint
   when the chosen endpoint isn't marked `supports_vision`.
10. **AgentModelSelect**: replace the (now-wrong) "agent endpoint isn't multimodal" warning with a
    "no/again non-vision **global** Vision endpoint configured" warning for visual agents.

## Notes
- Coordinates: the vision prompt states the true `WxH` and asks for coordinates in that pixel space
  (full-res image), so `visual_act` clicks land correctly. Thumbnail is display-only.
- Persistence: the thumbnail is capped (≤480px, JPEG q50) so persisted tool blocks stay small.
