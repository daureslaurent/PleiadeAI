# Agent image handles — read pictures into a turn, analyze & forward by id

## Goal

An agent can `read` (or otherwise acquire, via any tool/skill) a picture, keep it in the
conversation, and then **analyze it** or **hand it to a sub-agent** — always by a stable handle
(`img_1`, `img_2`, …), **never by filesystem path**. Paths don't survive a cross-agent hop (sub-agents
run in different containers), so delegation forwards image *bytes* keyed by handle.

## Current behaviour (before this change)

- A turn computes its image set **once** (`attachedImages`) and hands that fixed snapshot to every
  tool call via `ToolContext.attachedImages`.
- `read` on an image returns `{ images }`; `AgentRunner` folds the pixels into a *following* user
  message so a **multimodal** agent sees them — but they never join `attachedImages`, so
  `analyze_image` and `ask_agent` can't reach a read-in image.
- `ask_agent` already forwards dataUrls (not paths); it just didn't cover read-in images.
- Tool-result images are not surfaced to the UI (`bridge` drops `images` on `tool:execution_complete`).

## Decisions (from operator)

1. Read-in images **join the turn image pool** (unified with attachments).
2. Reference images by **stable handles/ids** (`img_N`), never path.
3. **Show in chat, don't persist** — no Mongo `images` write, no migration.
4. `ask_agent` **auto-forwards all** turn images by default (`include_image` stays default-true);
   optional `image_ids` forwards a subset.
5. Any **tool/skill** that returns images registers them into the pool (centralized in AgentRunner).
6. Backend first (this doc), then the UI tool-card thumbnail.

## Backend design

- **`ImageBlock`** (`core/event-bus/events.types.ts`) gains optional `id` (handle) + `source`
  (`attachment` | `tool`).
- **`TurnImagePool`** (`orchestrator/TurnImagePool.ts`): per-turn mutable pool. Seeds from
  attachments, assigns `img_N`, preserves handles that arrive already-numbered (forwarded across a
  hop), resolves subsets `byIds`.
- **`AgentRunner`**:
  - Build one `TurnImagePool` per run; pass it (by reference) into every `executeToolCall`.
  - `toolCtx.attachedImages = pool.all()` (now includes read-in images).
  - After a tool returns `images`, register them (`pool.addMany(..., 'tool')`), stamp
    `image_ids` onto the tool result JSON, and fold a **handle note** into the following user
    message (pixels only for a multimodal agent; text-only agents just get the note).
  - Auto-grant `analyze_image` when the turn has images **or** the agent can `read`.
- **`analyze_image`**: add `image_id` (preferred); keep `index` for back-compat; resolve from pool.
- **`ask_agent`**: forwards all pool images by default; add optional `image_ids` subset. Forwarded
  blocks keep their handles so parent and child speak the same `img_N`.

## UI phase (after backend verified)

- `bridge` passes `images` through on `tool:execution_complete`; tool-result card renders thumbnails.
