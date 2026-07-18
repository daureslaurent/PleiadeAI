# monitor-client

A tiny read-only metrics API for one machine — CPU, memory, GPU, temperatures, fans, disks, network —
served as JSON on a single endpoint. Meant to run on each inference box (`192.168.1.20`, `192.168.1.23`)
so you can poll one URL instead of shelling in to run `nvidia-smi` and `sensors`.

No dependencies: `node >= 18 monitor.mjs` runs it. Nothing in it can write anything or execute anything
on your behalf; the only subprocess it ever spawns is `nvidia-smi`.

## Run it

```bash
cp .env.example .env      # set MONITOR_API_KEY unless the box is on a trusted LAN only
docker compose up -d --build
curl -s -H "X-API-Key: $KEY" http://localhost:9101/metrics.json | jq
```

The container runs with `network_mode: host` (so `/proc/net/dev` shows the real NICs rather than a veth
pair), `read_only: true`, as a non-root user, with only `:ro` host mounts.

## Endpoints

| Method + path         | Auth | Returns                                          |
| --------------------- | ---- | ------------------------------------------------ |
| `GET /metrics.json`   | yes  | the full snapshot below (`GET /` is an alias)     |
| `GET /health`         | no   | `{"status":"ok"}` — for healthchecks/uptime probes |

Auth is a shared key in `MONITOR_API_KEY`, sent as `X-API-Key: <key>` or `Authorization: Bearer <key>`.
**If the variable is empty, the API is open to anyone who can reach the port.** Anything other than
`GET`/`HEAD` is refused with 405.

## Response shape

```jsonc
{
  "collected_at": "2026-07-18T18:13:12.999Z",
  "host":   { "hostname", "os", "kernel", "uptime_sec" },
  "cpu":    { "model", "sockets", "cores", "threads",
              "usage_percent", "per_core_percent": [],
              "frequencies_mhz": [], "temperature_celsius",
              "load_average": { "1m", "5m", "15m" } },
  "memory": { "total_bytes", "used_bytes", "available_bytes", "used_percent",
              "cached_bytes", "swap_total_bytes", "swap_used_bytes" },
  "gpus": [ { "index", "name", "uuid", "temperature_celsius",
              "utilization_percent", "memory_used_bytes", "memory_used_percent",
              "fan_percent", "power_draw_watts", "power_limit_watts",
              "clock_sm_mhz", "clock_mem_mhz", "pstate" } ],
  "temperatures": [ { "chip", "label", "celsius", "high_celsius", "critical_celsius" } ],
  "fans":         [ { "chip", "label", "rpm", "duty_percent" } ],
  "disks":        [ { "label", "total_bytes", "used_bytes", "available_bytes", "used_percent" } ],
  "network":      { "eno1": { "rx_bytes", "tx_bytes", "rx_bytes_per_sec", "tx_bytes_per_sec",
                              "rx_errors", "tx_errors" } },
  "warnings": []
}
```

Every section degrades on its own: a box with no fan chip or no GPU still gets a 200, with that array
empty and an explanation in `warnings`. Missing individual values are `null`, never omitted, so a
consumer can rely on the shape.

`temperatures` and `fans` are the raw per-sensor lists from `/sys/class/hwmon`; `cpu.temperature_celsius`
is the one summary number picked out of them (the `coretemp`/`k10temp` package sensor).

## Configuration

All env, all optional — see [`.env.example`](.env.example) for the full list with defaults:
`MONITOR_PORT`, `MONITOR_BIND`, `MONITOR_API_KEY`, `MONITOR_DISKS`, `MONITOR_CPU_SAMPLE_MS`, `NVIDIA_SMI`.

## Notes for deployment

- **GPU.** `nvidia-smi` is injected into the container by the NVIDIA container toolkit, which is why the
  compose file sets `runtime: nvidia` and the image is Debian-based (the injected binary is glibc-linked
  and will not run on alpine). On a host without the toolkit, comment `runtime:` out — you lose the
  `gpus` array and nothing else.
- **Temperatures and fans need host drivers.** These come from `/sys/class/hwmon`, so the host must have
  the right modules loaded — `coretemp` for Intel package temps, a Super-I/O driver like `nct6775` for
  motherboard fan RPMs. `sudo sensors-detect` on the host is the usual fix for empty `fans`. WSL2 has no
  hwmon at all, so both lists come back empty there; the real Ubuntu servers are the intended target.
- **Rates.** `usage_percent` and the network `*_per_sec` values are measured across a short blocking
  window (`MONITOR_CPU_SAMPLE_MS`, default 200ms — that is the request's floor latency). Set it to `0`
  to measure across the gap between successive requests instead, which suits a fixed-interval poller and
  makes the request near-instant, at the cost of `null` rates on the first call.
- **Disks.** Paths in `MONITOR_DISKS` are container-side, so an extra volume needs a matching `:ro` bind
  mount in the compose file.

## Not wired into PleiadesAI

Standalone by design for now. Consuming it from the backend would mean an `/api/monitor` route behind
`requireAuth` that fetches these URLs and a view to render them — a separate piece of work.
