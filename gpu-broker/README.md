# gpu-broker

A **VRAM mutex** in front of several GPU-heavy inference containers that can't all fit in VRAM at
once — e.g. a llama.cpp **vision** server and the **image-gen** FLUX server sharing one box.

It runs one HTTP listener per service. On a request it makes that service the *only* one loaded:
stop whichever other service is running (freeing its VRAM), start the target container, wait until
it's **ready to serve**, then proxy. A loaded service is **only stopped when another service needs its
VRAM** (a swap) — finishing a task leaves it warm, so back-to-back requests to the same service skip
the cold load. Optionally, `idleTimeoutSec > 0` also unloads a service after it sits idle that long;
leave it at `0` (the default) to unload only on a swap.

```
request → gpu-broker (:1234 image / :8080 vision)
            waiters for the loaded service first (no swap) — unless one has waited > maxWaitSec
            is the other service running?  → wait for it to drain, docker stop it, free VRAM
            target container running?       → docker start it
            poll healthPath until it answers 2xx (NOT merely "the port is open")
            proxy the request → upstream container (replayed if the upstream drops us)
            (idle-unload optional: 0 in-flight for idleTimeoutSec → docker stop it)
```

**At most one managed container runs at a time.** GET `/v1/models` is answered locally from config,
so a client polling the model list never forces a load/swap.

## Readiness is the whole ballgame

llama.cpp **binds its port several seconds before the model is loaded**, answers `/health` with `503`
in that window, and **hangs up on any real request** that arrives during it. A broker that treats
"the socket accepted my connection" as ready will forward into that window, the client sees
`socket hang up`, the client retries, the retry queues behind the *other* service — and the box spends
the rest of its life swapping instead of computing.

So a probe only counts as ready when the health path answers **2xx**. If an upstream of yours
genuinely never returns 2xx until its first real request (an on-demand model router), set
`"readyAnyStatus": true` on that service to get the old lax behaviour.

Two more guards on top of that:

- **Swaps prefer the loaded service.** Waiters for the already-loaded service are admitted first, and
  after the outgoing service drains the broker waits `swapGraceMs` and re-checks the queue — so an
  agent's chat turn resuming right after its image tool returned doesn't race a swap. `maxWaitSec`
  bounds the starvation: a waiter older than that always wins.
- **An upstream that drops the connection before we've answered the client is retried**
  (`upstreamRetries`), after re-probing readiness — instead of handing back a 502 the client turns
  into its own retry (and another swap).

## The tradeoff

Swapping is not free: each switch cold-loads ~10 GB of weights, so the **first request after a swap
pays ~10–30 s** of load latency. Great for *bursty* use (a run of chat, then a run of images); bad if
you interleave image↔chat on every message. The broker logs `WARNING: N swaps in the last 5 min` when
that starts happening. Make sure the calling client's timeout is longer than a cold load + a generation.

## Wiring

The broker **owns the public ports** that clients (e.g. PleiadesAI's endpoints) connect to; each
managed container must listen on a *different* localhost port that only the broker talks to.

For the bundled image-gen server, publish it on a localhost-only internal port instead of the public
`1234` (its compose supports `SD_HOST_PORT` + `SD_BIND`):

```bash
# image-gen/.env
SD_BIND=127.0.0.1
SD_PORT=1234          # port inside the container (unchanged)
SD_HOST_PORT=8201     # host port only the broker reaches
```

Then point `config.json`'s `image` service at `upstreamPort: 8201` and let the broker `listenPort: 1234`.
Do the same for your llama vision server (bind it to `127.0.0.1:8202`, broker listens on `8080`).

Finally, repoint PleiadesAI's endpoints at the broker: the **Image endpoint** → `http://<box>:1234`,
the **vision endpoint** → `http://<box>:8080`. (The broker speaks the same OpenAI-shaped API it
proxies, so nothing else changes.)

**Disable container restart policies** on the managed services (`restart: "no"`), or the daemon may
respawn a container the broker just stopped and break the mutex. (`unless-stopped` is usually fine —
it honours a manual stop — but `"no"` is safest.)

## Run it

Two options — it's dependency-free (`node >= 18`).

**Directly on the host (simplest):**
```bash
cp config.example.json config.json    # fill in your vision container name/port/model id
node broker.mjs                        # reads ./config.json (or $BROKER_CONFIG)
```
(Use systemd / pm2 / `nohup` to keep it up.)

**As a container** (`docker compose up -d` here) — uses host networking so `127.0.0.1:<port>` reaches
the host-published upstreams, and mounts the Docker socket so it can start/stop the siblings.

## Config

| key | meaning |
| --- | --- |
| `idleTimeoutSec` | also stop a service after this long with 0 in-flight requests; `0` disables idle-unload so a service only stops on a swap (default `0`) |
| `startTimeoutSec` | how long to wait for a cold-started container to become *ready* (default 300 — a big GGUF load is slow) |
| `stopTimeoutSec` | SIGTERM→SIGKILL grace passed to `docker stop` (default 30). A stop that always takes exactly this long means the process ignores SIGTERM (sd-server mid-generation does) |
| `stopSettleMs` | grace after `docker stop` for the driver to reclaim VRAM before starting the next (default 2000) |
| `swapGraceMs` | pause after the outgoing service drains, to catch a follow-up request for it and cancel the swap (default 1500) |
| `maxWaitSec` | starvation guard: a waiter queued longer than this forces its swap through (default 180) |
| `upstreamRetries` | replays when the upstream drops the connection before we've answered the client (default 3) |
| `retryDelayMs` | pause before a replay (default 2000) |
| `maxBodyBytes` | bodies above this (or chunked) are streamed through and can't be replayed (default 64 MB) |
| `logLevel` | `info` (default) or `debug` — `debug` adds probe results and admission timings |
| `dockerSocket` | Docker Engine API socket (default `/var/run/docker.sock`) |
| `services[]` | one per GPU service — see below |

Each service: `name`, `listenPort` (public, the broker), `container` (Docker container name to
start/stop), `upstreamHost`/`upstreamPort` (where that container actually listens), `healthPath`
(GET-able readiness probe — `/v1/models` for sd-server, `/health` for llama.cpp), `models`
(ids returned by `/v1/models`), and optionally `readyAnyStatus: true` (accept *any* HTTP answer as
ready, instead of requiring 2xx — only for an upstream that loads on first use).

## Health

`GET /healthz` on any listener returns the full state without touching the GPU:

```json
{ "ok": true, "active": "vision", "ready": true, "admitting": false,
  "inflight": { "image": 0, "vision": 1 }, "queued": { "image": 2, "vision": 0 },
  "swaps_last_5min": 2 }
```

## Reading the log

Every request gets a tag (`[vision#42]`) carried through admission, swap, and response:

```
[vision#42] POST /v1/chat/completions — active=image inflight=0 queue=0
[vision#42] swap: stopping image (image_gen_sd_server) to free VRAM for vision
[vision#42] stopped image in 30.4s (hit the 30s SIGTERM grace → SIGKILL; it was probably mid-generation) (drain took 1.5s)
[vision#42] starting vision (llama-server)
[vision#42] vision not ready yet (probe: 503) — waiting for the model to load
[vision#42] vision ready after 6.0s
[vision#42] ← 200 in 3.4s (5.2 KB)
```

`swap to X deferred` means a follow-up for the loaded service saved you a swap. A burst of
`upstream error … socket hang up` means the upstream is dropping us *after* it passed the readiness
probe — check that service's `healthPath` actually reflects readiness.
