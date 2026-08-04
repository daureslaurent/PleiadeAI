# ComfyUI media generation — image / video / sound / image-edit

> **Status: implemented.** This is the design record for the `backend/src/media/` subsystem, the
> `media_workflows` collection, and the four media tools. Source comments reference it the way they
> reference `ANDROID_PLAN.md` / `SSH_ISOLATION_PLAN.md`.
>
> Verified against the live ComfyUI at `192.168.1.23:8188`: discovery → import → validate → render
> (image and image-edit), the progress socket, and the resource Range/streaming route. Video and
> sound run the identical code path but had no workflow in ComfyUI's history at verification time —
> import one on the Media page after running it once in ComfyUI.
>
> **Live telemetry increment** (§ *Reporting a run as it happens*, below) also verified live: the
> run announces itself at **+0.0s**, step/node counters track the sampler, and preview frames decode
> into real images mid-render.

## Context

`generate_image` today posts to an OpenAI-compatible sd-server FLUX box
(`backend/src/inference/image-generate.ts`) and can only make stills. The operator runs a
**ComfyUI 0.30.0** server at `http://192.168.1.23:8188` that already generates images, video **with a
synced soundtrack**, and music — models the OpenAI images API cannot express, because the unit of work
there is a *workflow graph*, not a prompt string.

This replaces the sd-server path with **four** ComfyUI-backed core tools — image, video, sound, and
image-edit (image + text in) — each driven by an operator-chosen workflow picked on the Tools page,
with workflows auto-discovered from the ComfyUI server and real-time progress streamed into the tool
card. The ComfyUI endpoint is configured in **Settings → Connections**.

### Verified server facts (probed live — ground truth)

- ComfyUI **0.30.0**, `--listen 0.0.0.0 --enable-cors-header`, **no auth on any route**.
- GPUs: RTX 3060 12 GB (**only ~4.4 GB free** — shares the box with llama.cpp) + RTX 2070S 8 GB.
  A Stable-Audio run in history already died on `RuntimeError: VRAM grow failed`.
- `POST /prompt` · `GET /prompt` (queue depth) · `GET /queue` · `GET /history[/{id}]` ·
  `GET /view?filename=&subfolder=&type=` (verified: 200 `video/mp4` 864 KB) · `GET /object_info[/<Class>]` ·
  **`POST /upload/image`** (`/features` reports `max_upload_size: 104857600`) · `POST /interrupt` ·
  `WS /ws?clientId=` (**verified 101**, echoes our own `sid`).
- Installed, with **measured** runtimes from the server's own history:
  z-image turbo **3.5 s** warm (22–47 s cold) · krea2 turbo ~43 s · MiniMax H3 video+audio
  **538–632 s per 5 s clip** · Stable Audio 3 (its only run failed on VRAM).
- **Discovery format**: saved workflows are UI-format **and use subgraphs** (node `type` is a
  UUID into `definitions.subgraphs`) — converting those means reimplementing ComfyUI's frontend graph
  flattening. **Do not.** `/history` entries are already API-format and already flattened (`prompt[2]`),
  directly re-submittable, with the output node in `prompt[4]`. Re-verified on every saved file the
  operator has, `.json` and `.app.json` alike: each carries exactly one UUID-typed node.
- **Saved workflows are still worth reading — for their names.** `GET /api/userdata?dir=workflows`
  lists them, and each file's top-level `id` matches `extra_data.extra_pnginfo.workflow.id` on a
  history run, so a discovered candidate can be named after the file the operator actually created
  (`image_flux2_ask.json` → *Image Flux2 Ask*) instead of after its checkpoint. Roughly a third of
  runs match; the rest fall back to the model-derived guess.
- **Live preview frames** are binary websocket messages (`protocol.py` `BinaryEventTypes`):
  `PREVIEW_IMAGE = 1` → `[4B event][4B image type: 1=JPEG, 2=PNG][bytes]`;
  `PREVIEW_IMAGE_WITH_METADATA = 4` → `[4B event][4B json length][JSON][bytes]`. A client should first
  send `{"type":"feature_flags","data":{"supports_binary_preview":true}}`; the server replies with its
  own feature set. **These only exist when ComfyUI is started with `--preview-method`** — it defaults
  to `NoPreviews`, so a run emitting nothing is normal, not a fault. Observed live at
  `--preview-method auto`: ~60-70KB JPEGs, several per second, throughout sampling.
- **ComfyUI history is in RAM** and dies with the process → discovery must *snapshot* into Mongo.
- **Output-shape trap**: `SaveVideo` results come back under the `images` key
  (`{"92":{"images":[{"filename":"MiniMax_H3_00002_.mp4","subfolder":"video"}],"animated":[true]}}`).
  Classify by filename extension, never by the outputs key name.
- **Prompt-binding trap**: in the audio/krea2 graphs the *positive* encoder input is a **link** from an
  LLM prompt-expander chain while the *negative* encoder holds the literal `""`. A "find the encoder
  with literal text" heuristic silently binds the **negative** prompt. The binder must be
  sampler-anchored (walk `KSampler.positive` / `BasicGuider.conditioning` upstream).

### ⚠️ Image-edit models: node support is there, weights are not

Edit-capable node classes are installed and ready (`TextEncodeQwenImageEditPlus` with `image1..image3`,
`Krea2StyleReferenceNode`, `ReferenceLatent`, `FluxKontextImageScale`, `InpaintModelConditioning`), and
`CLIPVisionLoader` lists **zero** files. Against the models actually on disk:

- **Works today**: `Krea2StyleReferenceNode` + the installed `krea2_turbo` — accepts an image + a text
  prompt. It is *style reference*, not instruction editing ("make the sky red").
- **True instruction editing needs a download.** From the template catalogue's own VRAM figures:
  **Flux.2 Klein 4B Image Edit ≈ 9.9 GB VRAM** — the realistic fit for the 3060, and the same Klein
  family already referenced in `generateImage.ts`. Qwen Image Edit 2511 Int8 reports ≈31 GB — too big.

The `edit_image` tool is workflow-driven, so it ships and works the moment such a workflow is imported;
until then it can be pointed at the Krea2 style-reference workflow. **Nothing in this plan blocks on the
download** — but the tool is not useful for instruction edits until one lands.

### Decisions taken

| Fork | Decision |
|---|---|
| Tools | Four: `generate_image` (**keeps its name** — every agent's `tools_allowed` already has it), `generate_video`, `generate_sound`, `edit_image` |
| Endpoint config | **Settings → Connections** (`ConnectionsPanel.tsx`), alongside Google OAuth / mailboxes / Android devices |
| Workflows | Operator-managed in Mongo, **snapshotted** at import; seeded by auto-discovery from `/history`; manual paste of an API-format graph also supported |
| Long jobs | **Block with a live progress bar**; past a per-tool timeout, return and let a detached watcher store the artifact + fire an inbox notification |
| Prompt injection | **At the encoder** — deterministic; severs the operator's LLM prompt-expander chain by design |
| Media auth | **`?token=` in the URL**, the precedent already set by `transport/ws/visual-proxy.ts:28,44` — enables real Range streaming and seeking |
| sd-server FLUX | **Removed in this pass** (`image-generate.ts`, `image_endpoint_id`/`image_model`, the Settings section) |
| Linked inputs | Bindable anyway — writing a literal over a linked input is legal API format and just orphans the upstream node. So the video workflow's `width`/`height`/`length` (currently fed by `ResolutionSelector` / `ComfyMathExpression`) stay controllable; we snap to the schema's `step: 17` frame grid ourselves. The binding editor warns that it overrides upstream. |

---

## Phase 0 — Config + HTTP client

1. `backend/src/domain/settings/settings.model.ts` — add `comfy_url` (`''`), `comfy_queue_max` (`3`).
2. `backend/src/domain/settings/settings.service.ts` — `EffectiveSettings` fields + `get()` fallbacks
   (env default `COMFY_URL`).
3. `backend/src/transport/http/routes/settings.routes.ts` — **whitelist lines** near `:59`
   (trim + strip trailing slash). *A key missing here silently never persists.*
4. `backend/src/config/env.ts` + `.env.example` + a `docker-compose.yml` comment — optional `COMFY_URL`.
5. `backend/migrations/20260804090000-comfyui-media-settings.js` — seed both keys
   (template: `20260718210000-max-agent-hops-setting.js`).
6. **New** `backend/src/media/comfy/ComfyHttpClient.ts` — `systemStats`, `queueInfo`,
   `objectInfo(class)` (60 s TTL cache), `history()`, `history(id)`, `submit(graph, clientId)`,
   `view(ref) → {buffer, mime}` (mime from the response header), **`uploadImage(buffer, filename)`**
   (multipart to `/upload/image`, `type=input`, `overwrite=true`, refuses >100 MB per `/features`),
   `queueDelete(id)`, `interrupt()`. `ComfyError` for operator-fixable failures.

**Verify:** `npm run typecheck`; a scratch `tsx` call returns `0.30.0`.

## Phase 1 — Progress socket + job runner

7. **New** `backend/src/media/comfy/ComfyProgressSocket.ts` (uses the existing `ws@^8.21` dep):
   - `clientId = randomUUID()`; **connect and await the first `status` frame before `POST /prompt`** —
     that ordering is why a job can never complete before we are subscribed.
   - `ws.on('message', (d, isBinary) => { if (isBinary) return; … })` — binary preview frames dropped.
   - Ignore any message carrying a `prompt_id` that isn't ours → concurrent agents can't cross-talk.
   - Map `status`→queue depth, `execution_start`→t0, `execution_cached`→pre-complete those nodes,
     `executing {node}`→current node (label from the snapshot's `_meta.title ?? class_type`),
     `progress {value,max}`→fine percent, `progress_state`→preferred aggregate when present,
     `execution_error`→`node_type` + `exception_message` + `traceback[0]`, `execution_success`→done.
   - `overall = (completedNodes + value/max) / totalNodes`; ETA suppressed under 5 %.
     Throttle to ≤2 emits/s and only on ≥1 pt movement or a node change.
   - Reconnect same clientId (1/2/4 s, 5 tries); on every connect re-check `/history/{id}`.
     **A 3 s `/history/{id}` watchdog poll runs for the whole job regardless** — the WS is an
     optimisation for granularity, never a correctness dependency.
8. **New** `backend/src/media/comfy/outputs.ts` — walk `output_node_id` first, then every node and
   **every array-valued key** (`images`/`gifs`/`audio`/`video`/`files`); classify by extension
   (`.png|.jpg|.webp` · `.mp4|.webm|.mkv|.gif` · `.mp3|.flac|.wav|.opus`), falling back to `class_type`.
9. **New** `backend/src/media/comfy/errors.ts` — `ComfyError`, `ComfyExecutionError`, VRAM classifier
   (`/VRAM grow failed|out of memory|CUDA error: out of memory/i`).
10. **New** `backend/src/media/comfy/runJob.ts` — submit → progress → terminal → fetch bytes. Honours
    `AbortSignal`: `POST /queue {delete:[id]}` first, and `POST /interrupt` **only** when
    `queue_running` is ours (a blind interrupt would kill another agent's or the operator's job).

**Verify:** drive a real z-image run from a scratch `tsx` script logging every frame — this also pins
`progress_state`'s exact 0.30.0 shape, the one field not confirmable from a static probe.

## Phase 2 — Workflow domain, introspection, discovery

11. **New** `backend/src/domain/media-workflows/media-workflow.model.ts` — `name`, `kind`
    (**`image|video|audio|edit`**), `graph` (**snapshot**), `bindings`, `output_node_id`, `output_kind`,
    `source` (`discovered|manual`), `source_prompt_id`, `source_workflow_uuid`, `graph_hash`, `enabled`,
    `avg_duration_ms`, `last_validated_at`, `last_validation_error`.
12. **New** `.../media-workflow.repository.ts` — CRUD, `listByKind`, `findByGraphHash`.
13. **New** `backend/src/media/comfy/graph-introspect.ts`:
    - `autoBind(graph, outputsToExecute)` — output node from `prompt[4]` ∩ `/^Save(Image|Video|Audio…)/`;
      **prompt** by walking `sampler.positive` (or `guider → BasicGuider.conditioning`) upstream to the
      first `STRING` input named `text`/`prompt`, *bound whether it holds a literal or a link*;
      **negative** the same via `.negative` (unbound if it lands on `ConditioningZeroOut` or the same
      node); **seed** prefers `noise_seed` (the video graph's seed lives on `RandomNoise`, not a
      KSampler) then `seed`; **width/height** from `/^Empty\w*Latent/`; **length** / **seconds** /
      **fps** / **batch** by input name; **`image1..image3`** = every `LoadImage` node in node-id order
      (also matches `TextEncodeQwenImageEditPlus.image1..3` fed through them). A graph with ≥1
      `LoadImage` and an image output is proposed as `kind: 'edit'`.
      Each binding snapshots its `object_info` `spec` (`min`/`max`/`step`/enum) for clamping.
    - `graphHash` (literals blanked — dedups the 17 history entries to ~5 workflows), `describeNodes`,
      `validateBindings`, `validateModels` (literal vs `/object_info` enum), `applyBindings`
      (deep-clone, clamp, snap to `step`).
14. **New** `backend/src/media/discovery.service.ts` — `/history` → candidates grouped by `graph_hash`,
    with `suggested_name` from the loader filename and `duration_ms` from the `status.messages`
    timestamps (free, and how the 3.5 s / 43 s / 632 s figures were obtained).
15. **New** `backend/src/transport/http/routes/media.routes.ts` — `GET comfy/status`,
    `GET comfy/discover`, `POST workflows/import`, workflows CRUD, `POST :id/validate`,
    `POST :id/test` (accepts an optional test image for `edit` workflows),
    `GET view` (authenticated proxy to ComfyUI's `/view`).
16. `backend/src/index.ts:130` — mount `/api/media` behind `requireAuth`.

**Verify:** `discover` returns ~5 distinct workflows; **the audio candidate must bind `prompt` to
`52:6` (positive), not `52:7`** — the single highest-value assertion in this plan.

## Phase 3 — Dynamic workflow picker on the Tools page

`ToolConfigField` options are static today (`backend/src/tools/types.ts:143-151`, rendered by
`frontend/src/views/ToolsView.tsx:128-164`), so the per-content-type workflow select needs one narrow
extension — **server-resolved options, no new field type**:

17. `backend/src/tools/types.ts` — add
    `optionsSource?: 'media_workflows:image'|':video'|':audio'|':edit'` and
    `optionLabels?: Record<string,string>` to `ToolConfigField`; add `emitProgress` + `signal` to
    `ToolContext`; rename `emitImageGen` → `emitMediaGen`.
18. **New** `backend/src/tools/config-options.ts` — provider registry + `resolveDynamicOptions`,
    injecting a leading `{'': 'None — pick a workflow'}` and a `(missing) <id>` entry when the stored id
    has vanished, so the select never lies.
19. `backend/src/transport/http/routes/tools.routes.ts:13-28` — pipe the schema through it in the GET
    and the PUT response (3 lines).
20. `frontend/src/lib/api.ts:839-846` + `ToolsView.tsx:135-145` — mirror the fields, render
    `optionLabels[opt] ?? opt`. Stored value is the workflow's `_id` (stable across renames).

## Phase 4 — The four tools + progress/media events

21. `backend/src/core/event-bus/events.types.ts` — `ToolProgressPayload`
    (`phase`, `percent`, `node`, `nodeLabel`, `queuePosition`, `elapsedMs`, `etaMs`) and
    `MediaGeneratedPayload` (replacing `ImageGeneratedPayload:167-190`) + `EventMap` entries.
22. `backend/src/orchestrator/AgentRunner.ts:851-858` — wire `emitProgress`, `signal`, `emitMediaGen`
    alongside the existing `emitOutput`.
23. `backend/src/transport/ws/bridge.ts:86,127-144` — bridge `tool_progress` and `media_gen`.
    Progress is deliberately **not** recorded by `TurnRecorder` (meaningless post-turn); instead the
    tools emit ~4 milestone lines through the existing `ctx.emitOutput` so the persisted turn still
    narrates `queued behind N` / `started` / `done in Ns`.
24. **New** `backend/src/media/media-generate.service.ts` — resolve settings → workflow → validate →
    **upload input images (edit only)** → apply bindings → preflight
    (`queue_remaining >= comfy_queue_max` → refuse) → run → normalise → fetch bytes. Plus the detached
    `mediaJobWatcher` for the post-timeout path (stores into the same session's resource pool, then
    `alertEngine.dispatch`).
25. **New** `backend/src/tools/core/media.ts` — the four tools; **delete**
    `backend/src/tools/core/generateImage.ts` and `backend/src/inference/image-generate.ts`.
    - `generate_image` returns `images: [{dataUrl, kind:'image'}]` **without** `storageId`, so
      `AgentRunner.persistAndPool:681-720` stores it, assigns `img_N` and folds it into a multimodal
      agent's context — exactly as today.
    - `generate_video` / `generate_sound` **self-store** via `resourceRepository.store({bytes: Buffer,
      kind:'blob', mime, filename})` and return the block with `storageId` set (the
      `webFetch.ts:222-247` pattern) — the runner never persists a blob on its own. No `dataUrl`, so
      they can never enter model context. `result` carries `resource_id`, `mime`, `filename`, `size`,
      `duration_ms` and a note telling the agent to use `write(from_handle:…)` or hand off the handle.
    - **`edit_image`** — params `{image, prompt, image2?}`. `image` accepts **either** a resource handle
      (`img_3`, `blob_2` → `resourceRepository.readBytes`) **or** a workspace path
      (`/work/photo.png` → `readFileBytes` from `tools/core/fs/env-fs.ts:92`, which reads inside the
      agent's isolation container / SSH host transparently). Bytes → `uploadImage()` →
      `{name, subfolder}` → bound into the workflow's `image1` (`LoadImage.image`, value
      `subfolder ? "sub/name" : "name"`). Returns the edited image the same way `generate_image` does
      (dataUrl → `img_N` → enters context), with `source_handle` echoed in `result` so the agent can
      chain edits. Uploads are named `pleiades_<sessionId>_<handle>.<ext>` with `overwrite=true` so a
      retry doesn't litter ComfyUI's input folder.
    - Per-tool config: `workflow` (dynamic select), `wait_timeout_seconds`
      (**image 300 · edit 300 · sound 600 · video 1200**, hard ceiling 30 min), `seed_mode`+`seed`,
      `negative_prompt`, plus `size`/`batch` (image), `seconds`+`fps` (video), `seconds` (sound),
      `max_input_dimension` (edit — downscale before upload, default 1536).
      Every hint states the field is ignored when the chosen workflow doesn't bind it.
26. `backend/src/tools/registry.ts:30,97` — imports + four `CORE_TOOLS` entries.

## Phase 5 — Resource serving (Range + inline)

27. `backend/src/domain/resources/resource.repository.ts` — `openDownloadRange(doc, start, end)`
    (`openDownloadStream` already supports `{start,end}`; only `openDownload` is wired today).
28. `backend/src/transport/http/routes/resources.routes.ts:37-57` — `Accept-Ranges`, `Range` → `206` +
    `Content-Range` (malformed → `416`), explicit `HEAD`, and `Content-Disposition: inline` for
    `image/*`, `video/*`, `audio/*`, `application/pdf` (`attachment` otherwise, or on `?download=1`).
    Today *every* blob is forced to `attachment` with no Range — both block inline playback.
29. **New** `backend/src/transport/http/middleware/query-token.ts` — promotes `?token=` into
    `Authorization` when the header is absent; mounted **only** in front of the resources router
    (`backend/src/index.ts:130`), so `requireAuth` itself is untouched and no other surface widens.

**Verify:** `curl -I` and `curl -H 'Range: bytes=0-1023'` on a stored mp4 → `206` + `Content-Range`.

## Phase 6 — Frontend

30. `frontend/src/lib/ws-events.types.ts` — `ToolProgressEvent`, `MediaGenEvent`, union at `:295`.
31. `frontend/src/store/stream.ts` — `ToolProgressInfo` (live-only, not in `buildBlocks`) and
    `MediaGenInfo`; reducers beside `tool_output:494` and `image_gen:528`.
32. `frontend/src/components/ToolCall.tsx:14,239-330` — `ImageGenBlock` → `MediaGenBlock`: progress bar
    (percent, node label, `queued behind N`, elapsed/ETA) while running; then `<img>` grid, or
    `<video controls preload="metadata">`, or `<audio controls>` on the streaming URL; for `edit_image`
    a **before/after pair** (source handle thumb → result). **Keep reading the legacy `block.imageGen`**
    — `buildBlocks:219` persisted it, so old turns must not regress. Everything the card needs
    (`resource_id`, `mime`, `filename`) rides in `block.result`, which is already persisted — so the
    bridge's blob filter at `:146-160` needs **no change**.
33. `frontend/src/components/workspace/DataPanel.tsx:108` — replace the `kind === 'image'` branch with a
    mime-driven one (image thumb / video tile / audio play row / `FileBox`), using the streaming URL so
    a 50 MB mp4 seeks instead of downloading.
34. `frontend/src/lib/api.ts` — `resourcesApi.streamUrl()`, a `mediaApi`, the two settings keys.
35. **New** `frontend/src/views/MediaView.tsx` + `components/media/` (`DiscoverPanel`, `WorkflowList`,
    `WorkflowDetail` with the node/input binding editor and a **Test run** button) — route in
    `App.tsx:83`, sidebar entry in `Sidebar.tsx:33`. The discover panel states plainly that ComfyUI's
    history is in RAM and that importing snapshots the graph.
36. **Settings → Connections**: a new **ComfyUI server** `Section` in
    `frontend/src/views/settings/panels/ConnectionsPanel.tsx` (alongside Google OAuth / mailboxes /
    Android devices) — a `SettingText` URL field (debounced, no Save button per `settings/context.tsx`),
    a **Test connection** button hitting `GET /api/media/comfy/status` (version, queue depth, free
    VRAM per GPU), and a link to `/media`. `frontend/src/views/settings/categories.ts`: add
    `'ComfyUI server'` to the `connections` category's `contains`, and **remove `'Image generation'`
    from `inference`'s**.
37. `frontend/src/views/settings/panels/InferencePanel.tsx:155-163` — delete the Image-generation
    section outright (its replacement lives in Connections now).
38. `frontend/src/lib/toolSummary.ts` — cases for all four tools (`generate_image` has none today).

## Phase 7 — Retirement

39. Remove `image_endpoint_id` / `image_model` from `settings.model.ts:63-66`,
    `settings.service.ts:43-45,144-145`, the `settings.routes.ts:60-61` whitelist and
    `frontend/src/lib/api.ts:1053-1055` (the complete reference list, grepped).
40. `backend/migrations/20260804093000-retire-image-endpoint-settings.js` — `$unset` both;
    `down` restores `''`.
41. `backend/src/tools/core/guide.ts:83` — rewrite the `generate_image` entry (workflow-driven, real
    timings: ~4–45 s image, ~10 min for a 5 s video), add `generate_video` / `generate_sound` /
    `edit_image` entries and a `media` topic covering the handle → `write` / `ask_agent` flow and the
    `edit_image(image: "img_2")` chaining pattern.

---

## Failure modes handled explicitly

| Failure | Detection | Behaviour |
|---|---|---|
| ComfyUI not configured / unreachable | `comfy_url === ''`; 5 s preflight `GET /prompt` | non-throwing `{ok:false,error}` the agent can relay (the `ImageGenError` precedent) |
| **VRAM exhaustion** | `execution_error` matching the VRAM regex | error + node + hint that the 12 GB card is shared with the inference server |
| ComfyUI restarted mid-job | WS closed, reconnects exhausted, `/history/{id}` empty | "its queue and history are in memory — resubmit" |
| Model file missing | literal ∉ `/object_info` enum, **pre-submit** | refuse before queueing, listing installed options — never a 10-minute wait ending in a load error |
| Queue backlog | `queue_remaining >= comfy_queue_max` | refuse with the count; report `queued behind N` while waiting |
| Bindings stale | node/input asserted against the snapshot at submit | hard refuse. **A missing `prompt` binding is always fatal** — the alternative is silently regenerating the workflow author's prompt |
| `edit_image` on a workflow with no `image1` binding | pre-submit | refuse: "workflow *X* takes no input image — pick an edit workflow" |
| Bad handle / unreadable path / non-image bytes | `readBytes` null, `readFileBytes` throws, sniffed mime not `image/*` | plain tool error naming the handle or path |
| Upload too large | >100 MB (`/features max_upload_size`) | downscale to `max_input_dimension` first; still too big → refuse |
| Turn aborted | `ctx.signal` | `/queue delete`, then `/interrupt` only if the running job is ours |

## Verification (no test suite — this is the whole story)

1. `npm run typecheck` in `backend/` and `frontend/`; `npm run migrate:up` then `migrate:status`.
2. `docker compose up --build`, log in. **Settings → Connections → ComfyUI server** → paste
   `http://192.168.1.23:8188` → **Test connection** shows `0.30.0`, queue 0, both GPUs.
3. Media page → **Discover** → ~5 candidates with plausible durations. Import all four workflows.
4. Assert the auto-bindings: z-image `prompt→57:27.text`, `seed→57:3.seed`, `width/height→57:13`,
   output `9`; MiniMax `prompt→105:104.prompt`, `seed→105:15.noise_seed`, output `92`, kind `video`;
   Stable Audio `prompt→52:6` (**positive**). Fix any miss in the editor, then **Test run**.
5. Point a workflow at a bogus `unet_name` → **Validate** reports it as not installed.
6. Tools page: each tool shows a populated workflow select with human names. Grant all four to a test
   agent.
7. Image run → progress bar ticks, card renders, `img_N` in the Data tab, a multimodal agent can
   describe it back. Sound run → `<audio>` plays; `write(from_handle:'blob_N')` writes a valid mp3.
8. Video run (~10 min) → progress throughout; card renders `<video controls>`; **seek to the middle**
   (proves the Range work) and confirm `206`s in the network tab.
9. **`edit_image`**: import the Krea2 style-reference workflow, then (a) generate an image and feed its
   `img_N` straight back in — before/after pair renders and the result is a new `img_N`; (b) point it at
   a file path inside an *isolated* agent's container and confirm `readFileBytes` reaches it;
   (c) check ComfyUI's `input/` folder holds one `pleiades_…` file per source, not one per retry.
10. Stop mid-video → turn ends cleanly, ComfyUI's `/queue` shows no orphan.
11. Two agents at once → each card shows only its own job; the second reports `queued behind 1`.
12. Generate video while a large chat model is streaming → the VRAM error surfaces as a readable tool
    error, not a thrown exception.
13. Kill ComfyUI mid-job → "ComfyUI restarted…"; afterwards the imported workflows still run, proving
    the snapshot beat the in-memory history.
14. Reload the browser on a finished turn → video/audio cards still render from persisted `result`, and
    pre-migration `generate_image` turns still render via the legacy `imageGen` path.
15. A cron task that generates an image completes and its inbox notification carries the result.

## Reporting a run as it happens

A ten-minute video used to reach the chat as a bare percentage: `emitMediaGen` fired from
`packageResult`, i.e. only once the last byte was downloaded, so every identifying detail arrived
after the operator had stopped caring. The run now narrates itself.

- **Two emissions, merged client-side.** `MediaGeneratedPayload.phase` is `start` or `done`.
  `runJob` gained `onSubmitted`, which fires the instant `POST /prompt` returns — the earliest moment
  a run has an identity — and `generateMedia` turns that into `onStart` carrying the workflow name and
  kind, the graph's model files, the `prompt_id`, the ComfyUI base URL, the queue depth, the seed, and
  **free VRAM on the tightest GPU**. That last one is the number that predicts the
  `VRAM grow failed` this box is prone to, since its 3060 is shared with the inference server.
  The store merges rather than replaces, so `done` adds artifacts without erasing any of it.
  Measured: the start emission lands at **+0.0s**.
- **The queue preflight moved** from `runJob` into `generateMedia` (which passes `queueMax: 0` on) so
  the depth can be *reported* rather than merely enforced, without a second round trip.
- **Counters, not just a bar.** `ComfyProgressSocket` now reports `step/steps` (the sampler's own
  progress inside the running node) and `nodesDone/nodesTotal`. A percentage alone hides which of
  those is stuck.
- **Live previews.** The socket sends the `feature_flags` greeting and decodes binary frames instead
  of dropping them. Previews ride their own **1/s** clock, separate from the numeric bar's 2/s: at
  ~65KB a frame and several per second, matching the bar's rate would push hundreds of megabytes at
  the browser for frames nobody can perceive individually. Only the newest is kept, and none of it is
  persisted — `sawPreview` lets the card say *"start ComfyUI with `--preview-method auto`"* instead of
  rendering an empty box when the server isn't sending any.
- A progress tick that **omits** a field is not asserting the field is gone (the closing
  `downloading` tick carries no counters at all), so the store spreads previous state forward. Without
  that the card flickers empty exactly at 100%.

## Risks

- **No installed model does instruction-based image editing.** `edit_image` ships working against the
  Krea2 style-reference workflow; real "change the sky to sunset" editing needs a download —
  Flux.2 Klein 4B Image Edit (~9.9 GB VRAM) is the fit for the 3060.
- A blocking 10-minute video holds that agent's `SessionLock`; a live chat with the same agent waits
  (cron yields to users, not the reverse). Accepted — the agent genuinely is busy.
- `?token=` puts the session JWT in media URLs (logs, browser history). Accepted, matching
  `visual-proxy.ts`. Short-lived signed URLs remain the upgrade path.
- Binding at the encoder bypasses the operator's `TextGenerate` prompt-expander, so output character
  will differ from running the same workflow in the ComfyUI UI. Intended.
- `progress_state`'s exact 0.30.0 shape is confirmed in Phase 1 by frame logging; the
  `progress` + `executing` fallback works regardless.
