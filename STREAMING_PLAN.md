# STREAMING_PLAN.md — Real-time media streaming

Continuous, never-ending audio/video streams fed by flow runs. A flow generates a clip (music,
video, or both), hands it to a **StreamingFlow** node, and the backend muxes an endless flux that a
dedicated player page consumes. A **Time** trigger node re-fires the flow every N seconds so the
stream keeps being fed — a generative radio / TV channel.

Design decisions below were taken with the operator; they are settled, not open questions.

---

## 1. The shape of it

```
[Time every 20s] ──> [Agent: write a prompt] ──> [generate_sound] ──> [StreamingFlow]
      ^                                                                     │
      └──────────────── re-fire when the run ends (skip if still running) ──┘

StreamingFlow ──push──> StreamBuffer(flow id)  ──ffmpeg──> endless fMP4 ──> /api/streams/:flowId/live.mp4
                        (clip queue, one per flow)                              │
                                                                     MediaSource in the player page
```

**The stream is not the run.** A run is one clip; the stream is a long-lived backend object keyed by
**flow id**. Editing the flow's input prompt and re-running appends to the *same* live flux — the
listener never reconnects, the playlist is never rebuilt. This is the whole point of the feature.

## 2. Settled decisions

| Question | Decision |
|---|---|
| Wire format | **One endless chunked HTTP response** carrying fragmented MP4; the page feeds it to a `MediaSource` SourceBuffer. No HLS, no third-party lib. |
| Stream identity | **Per-flow, auto key = flow id.** One flow = one stream, surviving any number of runs. |
| Time node | **Trigger** that re-arms the whole flow (a new run per tick), not an in-run loop. |
| Overlap | **Skip** — if the previous run is still going when the timer fires, that tick is dropped. The interval is a floor. |
| Underrun | **Loop the last clip** until a new one lands. The flux never goes silent or black. |
| Normalization | **Stream profile locked on the node** (resolution/fps/codec/sample rate); every clip is transcoded to it on ingest. |
| Scope | Audio, video **and mixed** (video clips + a music bed, via the existing audio nodes). |
| Auth | **Short-lived signed token in the URL** (`?t=…`), minted by the authed API — `<video src>` can't send headers. |
| Lifecycle | **Idle timeout**: no new clips *and* no subscribers for N minutes → tear down. |
| UI | **Badge in the top bar** → popover listing live streams → opens a **chrome-free full-page player** (`/stream/:flowId`, `window.open`, no sidebar/header), like `/desktop/:agentId`. |

## 3. Backend — `backend/src/streaming/`

### `StreamProfile`
Resolution, fps, video codec/bitrate, sample rate, channels, audio bitrate, underrun policy, idle
timeout, max queued clips. Declared on the StreamingFlow node; the first `push` for a flow creates
the buffer with that profile, later pushes reuse the live one.

### `StreamBuffer` (one per flow)
Three stages, all on temp files under one per-stream directory:

1. **Ingest** — `push(bytes, meta)` transcodes the clip to canonical **MPEG-TS** (profile codecs,
   fixed resolution/fps/sample rate). TS because it concatenates cleanly at the byte level, which is
   what makes a queue of independently-rendered clips into one continuous input.
   An audio-only clip on a video stream gets the still/black-frame treatment so the profile holds.
2. **Playout** — a persistent `ffmpeg -re -f mpegts -i pipe:0 -c copy -bsf:a aac_adtstoasc -f mp4
   -movflags empty_moov+frag_keyframe+default_base_moof pipe:1`. A pump writes queued TS files into
   stdin in order. On underrun the pump rewrites the **last** clip's TS bytes (loop policy), but only
   while somebody is listening.
   Two things learned by building it, both load-bearing: `-re` is *not* sufficient pacing — a few
   seconds of AAC fits entirely in the pipe buffer, so the write returns instantly and the pump would
   re-air the last clip hundreds of times a second; the pump therefore keeps its own wall-clock
   deadline and stays at most `LEAD_MS` ahead of real time. And AAC crosses MPEG-TS as ADTS, which
   MP4 rejects outright without `aac_adtstoasc`.
3. **Fanout** — stdout is parsed as MP4 boxes: `ftyp`+`moov` are cached as the **init segment**,
   each following `moof`+`mdat` pair is a fragment broadcast to every subscriber. A late joiner gets
   the cached init segment, then joins at the next fragment boundary — which is exactly what MSE
   needs and is why we parse rather than blindly tee bytes.

Also tracks: `nowPlaying` (title/prompt of the clip on air), clip history, buffered seconds,
subscriber count, `startedAt`. Idle sweep tears the whole thing down (kill ffmpeg, rm the dir).

### `StreamRegistry`
`Map<flowId, StreamBuffer>` + `get/getOrCreate/list/stop`, and the idle sweep interval. Shut down
cleanly on SIGTERM so no ffmpeg outlives the process.

### `streaming/token.ts`
HMAC-SHA256 over `flowId|exp` with `JWT_SECRET`. Minted by an authed route, verified by the media
route only. Short TTL, no DB.

### Routes — `transport/http/routes/streams.routes.ts`
| Route | Auth | Purpose |
|---|---|---|
| `GET /api/streams` | `requireAuth` | live streams: flow id/name, kind, now-playing, buffer depth, listeners, uptime |
| `GET /api/streams/:flowId` | `requireAuth` | one stream's detail + a freshly minted playback token |
| `DELETE /api/streams/:flowId` | `requireAuth` (`flows:write`) | stop and tear down |
| `GET /api/streams/:flowId/live.mp4?t=…` | signed token | the endless fMP4 flux |

`live.mp4` is mounted **before** the `requireAuth` router (token-only), and streams with
`Cache-Control: no-store`, no `Content-Length`, and a `close` handler that drops the subscriber.

## 4. Nodes

### `stream_out` — "StreamingFlow" (group `media`)
- **inputs**: `media` (`video`/`audio`/`image`/`file`, required), `run` (`signal`, ordering only)
- **outputs**: `stream_url` (`text`), `done` (`signal`)
- **config**: title (templated — becomes now-playing), stream kind (`audio`/`video`), video size,
  fps, audio sample rate/bitrate, underrun policy, idle timeout, max queued clips.
- **run**: reads each handle with `ctx.readResource`, pushes into `StreamRegistry.getOrCreate(ctx.flowId, profile)`, emits progress ("queued behind N clips"), returns the stream URL.

### `timer` — "Time" (group `control`)
A trigger, so the node itself is a no-op when the runner reaches it (it emits `tick`). The real work
is in the scheduler:

`flows/TimerScheduler.ts` — in-process `setTimeout` per flow (Agenda's cron floor is a minute; this
needs seconds). Arm/disarm is persisted as `timer_armed` on the flow doc so a restart restores it.
On fire: skip if a run for that flow is in flight, else `flowRunner.start({ trigger: 'timer' })`,
then re-arm. Config: interval seconds (min 5), max consecutive failures before auto-disarm.

Routes: `POST /api/flows/:id/timer/start|stop` (both `flows:write`).
Migration: `timer_armed` on `flows`.

## 5. Frontend

- **`components/StreamsBadge.tsx`** — top-bar badge beside `EndpointBadge`. Hidden when nothing is
  live; otherwise an emerald glow-pulse dot + count, popover listing streams (name, kind, uptime,
  buffer meter), each opening the player with `window.open`.
- **`views/StreamWindow.tsx`** — route `/stream/:flowId` mounted *outside* `MainLayout`, no sidebar,
  no header (same pattern as `/desktop/:agentId`).
- **`components/stream/LiveStreamPlayer.tsx`** — the MSE client: `fetch(url).body` reader →
  `sourceBuffer.appendBuffer`, an eviction pass on the buffered range so a 6-hour stream doesn't
  grow unbounded, auto-reconnect with backoff, and a "LIVE" seek-to-edge control. It must seek on
  join, not only on drift: fragments carry the *stream's* timeline, so a listener tuning in an hour
  later gets a buffered range starting at 3600s while the element sits at 0 and stalls forever.
  Video streams render the `<video>` surface; audio streams render a WebAudio analyser visualizer.
  Chrome: now-playing title, clip counter, buffer-health meter, volume, fullscreen, copy-URL.

**DIRECT_ART compliance**: `.space-bg` backdrop mounted by the window (it is outside `MainLayout`,
so it owns its own), player chrome on `.glass-card`, LIVE pill `rounded-full` amber with
`animate-glow-pulse` via `--glow`, shimmered now-playing label while live, mono for the stream URL
and clip handles, `fade-up` entrances, everything frozen under `prefers-reduced-motion`.

## 6. Out of scope (v1)
Recording/DVR of past segments, multiple streams per flow, external-player (VLC) endpoints,
per-listener transcode ladders.
