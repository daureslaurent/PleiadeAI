# Docker Images as first-class entities

## Goal
Decouple the **Docker image / build** from the isolation *profile*. Give images their own
CRUD, Dockerfile, build options, and background (queued, reattachable) builds, plus a global
build/image overview. Isolation profiles keep the runtime policy (cpus/memory/network/VPN/SSH/
sudo/volume) and gain an `image_id` reference. Agents still pick a profile.

## Decisions (from operator)
- **Architecture:** Image + Profile (keep both). `Image { dockerfile, buildOpts, status }` is
  referenced by `Profile { image_id, cpus, mem, network, vpn, ssh, sudo }`; agents → profile.
- **Terminal:** live build-log stream that reattaches to a background build (no interactive shell).
- **Builds:** background, **serialized** (one `docker build` at a time; others queued), with
  server-buffered logs so a reload/navigation reattaches to the live stream.
- **Migration:** fresh start — no data extraction. Existing profiles simply need an image picked.

## Docker naming
- New tag: `imgImageName(imageId)` = `${AGENT_IMAGE_PREFIX}_img_${imageId}:latest`.
- The old `isoImageName(profileId)` is retired for provisioning (profiles no longer own an image).

## Backend
1. `isolation/names.ts` — add `imgImageName`.
2. `domain/images/image.model.ts` + `image.repository.ts` — new `images` collection:
   `name*(unique), description, dockerfile, build_args[{key,value}], no_cache, pull,
    image_status(none|queued|building|built|error), image_built_at, last_build_error, image_size`.
3. `isolation/docker.service.ts` — `build()` gains `{ buildArgs, noCache, pull }`; add `imageSize()`.
4. `isolation/build.manager.ts` — serialized queue; per-image in-memory log ring + subscribers;
   persists status; on success drops containers of agents whose profile references the image.
5. `domain/isolations/isolation.model.ts` + repo — add `image_id` ref. Stop using profile
   `dockerfile`/`image_status` for provisioning (left as dead fields, unused).
6. `isolation/AgentContainerManager.ts` — resolve image via `profile.image_id` → image doc →
   `imgImageName`; `IsolationNotReadyError` if no image / not built. `teardownIsolation` no longer
   removes the image (owned by the Image entity now).
7. `orchestrator/AgentRunner.ts` — pass `image_id` through the `IsolationProfile` shape (already
   forwards the whole `iso` doc; just widen the interface).
8. `transport/http/routes/images.routes.ts` — CRUD + `POST /:id/build` (enqueue) +
   `GET /:id/build/logs` (SSE reattach) + `GET /:id/status` + `GET /` list (with live job state).
   Mounted at `/api/images`.
9. `transport/http/routes/isolations.routes.ts` — drop `POST /:id/build`; PATCH/POST accept
   `image_id` (drop containers on change); `/:id/status` reports the referenced image's state;
   delete no longer removes an image.
10. `transport/http/routes/agent-container.routes.ts` — agent status `image_status` from the
    referenced image.
11. `migrations/…-images-collection.js` — create `images` collection + unique index on `name`;
    add `image_id: null` to existing isolations.

## Frontend
12. `lib/api.ts` — `Image`, `ImageStatus`, `imagesApi` (list/get/status/create/update/remove/
    build-enqueue/streamLogs SSE/active builds). `Isolation` gains `image_id`; `IsolationStatus`
    gains `image_id`/`image_name`. Remove Dockerfile/build from the profile editor path.
13. `views/ImagesView.tsx` — master-detail: image CRUD list + a "Builds" overview row; detail =
    name/desc + Monaco Dockerfile + build options (build args, no-cache, pull) + Build button +
    live reattaching log terminal + referenced-by profiles.
14. `views/IsolationsView.tsx` — remove Dockerfile editor + build; add an **image** selector +
    show referenced image status; link to Images page.
15. `components/Sidebar.tsx` + `App.tsx` — add "Images" nav + `/images` route.

## Verify
- `npm run typecheck` in `backend/` and `frontend/`.
- Manual: create image → build (background, reattach) → assign to a profile → agent tool runs.
