# gpu-broker

A **VRAM mutex** in front of several GPU-heavy inference containers that can't all fit in VRAM at
once — e.g. a llama.cpp **vision** server and the **image-gen** FLUX server sharing one box.

It runs one HTTP listener per service. On a request it makes that service the *only* one loaded:
stop whichever other service is running (freeing its VRAM), start the target container, wait until
it's healthy, then proxy. After `idleTimeoutSec` with nothing in flight it stops the service again,
so the box idles at zero GPU use between bursts.

```
request → gpu-broker (:1234 image / :8080 vision)
            is the other service running?  → docker stop it, wait for VRAM to free
            target container running?       → docker start it, poll health
            proxy the request → upstream container
            0 in-flight for idleTimeoutSec  → docker stop it
```

**At most one managed container runs at a time.** GET `/v1/models` is answered locally from config,
so a client polling the model list never forces a load/swap.

## The tradeoff

Swapping is not free: each switch cold-loads ~10 GB of weights, so the **first request after a swap
pays ~10–30 s** of load latency. Great for *bursty* use (a run of chat, then a run of images); bad if
you interleave image↔chat on every message (constant thrashing). Make sure the calling client's
timeout is longer than a cold load + a generation.

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
| `idleTimeoutSec` | stop a service after this long with 0 in-flight requests (default 300) |
| `startTimeoutSec` | how long to wait for a cold-started container to become healthy (default 180) |
| `stopSettleMs` | grace after `docker stop` for the driver to reclaim VRAM before starting the next (default 2000) |
| `dockerSocket` | Docker Engine API socket (default `/var/run/docker.sock`) |
| `services[]` | one per GPU service — see below |

Each service: `name`, `listenPort` (public, the broker), `container` (Docker container name to
start/stop), `upstreamHost`/`upstreamPort` (where that container actually listens), `healthPath`
(GET-able readiness probe — `/v1/models` for sd-server, `/health` for llama.cpp), and `models`
(ids returned by `/v1/models`).

## Health

`GET /healthz` on any listener returns `{ ok, active }` without touching the GPU — `active` is the
currently-loaded service (or `null` when the box is idle).
