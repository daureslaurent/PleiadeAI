# Feature: Isolation tab in the Debugger (Workspace chat)

Add a tabbed header to the right-side **Debugger** drawer: **Trace** (existing) | **Isolation**.
The Isolation tab, for the active agent's assigned isolation container, shows **live usage** and a
**file explorer** for `/workspace`.

## Decisions (from operator)
- File explorer: **view contents, download, delete, upload** (one file at a time).
- Root: **`/workspace`** (the persistent volume); navigation stays within that subtree.
- Usage: **live CPU + memory**, **workspace disk usage**, **network I/O**, plus **container
  controls** (start / stop / restart / delete-volume) inline.
- No isolation profile ⇒ tab still shows, with an empty state pointing at the Agents page.

## Backend (`/api/agents/:id/container`, extends `agent-container.routes.ts`)
All exec paths validated to stay inside `/workspace` (posix-normalize + prefix check); all args
passed as argv (no shell interpolation). Ops require the container **running** (else `409
not_running`; frontend offers Start). No isolation ⇒ `409 no_isolation`.
- `GET  /files?path=` — `find -maxdepth 1 -printf '%y\t%s\t%T@\t%f\n'` → `[{name,type,size,mtime}]`.
- `GET  /file?path=` — `head -c 512K` + `stat` → `{content, size, truncated, binary}`.
- `GET  /download?path=` — streams `docker exec cat` raw to the response (binary-safe).
- `PUT  /files?path=` — streams request body into `docker exec -i tee <path>` (binary-safe upload).
- `DELETE /files?path=` — `rm -rf -- <path>` (guarded ≠ `/workspace` root).
- `GET  /stats` — `docker stats --no-stream --format '{{json .}}'` + `du -sb /workspace`.
- `POST /start` — `agentContainerManager.ensureReady` (boots the container on demand).
- (`GET /`, `POST /stop`, `DELETE /volume` already exist.)
- `docker.service.ts`: add `spawnRaw(argv)` returning the ChildProcess for streamed cat/tee.

## Frontend
- `lib/api.ts`: extend `agentsApi` with `files/readFile/deleteFile/uploadFile/downloadFile/stats/
  startContainer`.
- New `components/workspace/IsolationPanel.tsx`: status + usage cards (CPU/mem bars, net/block I/O,
  disk, state badge, controls) + breadcrumb file explorer + read-only file preview.
- `DebuggerDrawer.tsx`: tab header (Trace | Isolation); takes the active `agent`.
- `AgentWorkspace.tsx`: pass `activeAgent` to the drawer.

## Status: IMPLEMENTED
</content>
