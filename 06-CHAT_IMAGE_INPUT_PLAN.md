# Chat image input plan

Attach image(s) to a normal chat turn. Handling: **raw pixels to the agent's own model if it's
multimodal; otherwise an `analyze_image` tool routes through the global Vision endpoint.** The agent
can also **forward the image to a subagent** via `ask_agent`. Display: **thumbnail in the user bubble
+ a vision analysis card** (reusing the `tool:vision` VisionBlock).

Backend transport already supports it: `chat:message` accepts `images` and `buildUserMessage` folds
them into `image_url` parts. Missing: conditional routing, the tool, delegation forwarding, and all UI.

## Backend
1. **`inference/vision-analyze.ts`** (new): `resolveVisionTarget()` + `analyzeImageWithVision(dataUrl, question)` — shared vision-endpoint call (used by `analyze_image`).
2. **`analyze_image` core tool** (`tools/core/analyzeImage.ts`): args `question`, `index?`. Reads `ctx.attachedImages[index]`, analyzes via the Vision endpoint, emits `tool:vision` (thumbnail + Q&A), returns the text.
3. **ToolContext**: add `attachedImages?: ImageBlock[]`; extend `invokeSubAgent` to `(name, query, images?)`.
4. **AgentRunner**:
   - Put raw images in the user message only when `inference.supportsVision`; always expose them as `attachedImages` to tools.
   - Auto-grant `analyze_image` when the turn has attached images (like the visual tools).
   - `makeInvoker`/`hop`: thread `images` into the sub-run so a delegated subagent receives them.
5. **`ask_agent` tool**: add `include_image?: boolean` (default true when images exist) → forwards `ctx.attachedImages` to `invokeSubAgent`.
6. **registry**: register `analyze_image`.

## Frontend
7. **Composer (`ChatPanel`)**: attach via drag-&-drop, a `+` file-picker button, and clipboard paste; multiple images; thumbnail strip with remove buttons; downscale large images (canvas, ≤~1600px, JPEG) before attaching. `onSend(text, images)`.
8. **`onSend`/`handleSend`/`store.send`**: thread `images: {dataUrl}[]` → `chat:message`; the user `Turn` gains `images?: string[]` for display.
9. **User bubble**: render attached thumbnails above the text.
10. **VisionBlock**: also render for `analyze_image` (route by `block.vision` present or tool ∈ {visual_screenshot, analyze_image}).

## Notes
- Text-only agent + attached image + no Vision endpoint → `analyze_image` returns the "configure a Vision endpoint" hint (same as visual_screenshot).
- Payload size: downscale client-side; images ride the socket as data URLs and persist in history.
