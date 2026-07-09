# PleiadesAI Fine-Tune Service

A standalone, headless microservice that runs multi-GPU **QLoRA** fine-tuning with
[Axolotl](https://github.com/axolotl-ai-cloud/axolotl) and exports a **GGUF** for serving with
llama.cpp. It runs on a dedicated dual-GPU box (2×16GB = 32GB VRAM) and is driven over HTTP by the
main PleiadesAI backend.

It is intentionally self-contained: it does **not** import from or modify the main backend. It only
mirrors the backend's house style (Express, Zod fail-fast env, Pino `createLogger`, native `fetch`)
so it can slot in as a compose sibling later.

## Pipeline

```
POST /upload (jsonl)  ─┐
                       ├─▶  POST /train  ──▶  [queued→preparing→training→exporting→done]
GET  /jobs/:id  ◀──────┘         │                                    │
GET  /jobs/:id/model  ◀──────────┴── webhook_url  ◀───────────────────┘  (on done/failed)
```

- **One job at a time** — each run uses both GPUs, so `POST /train` requests are queued (single slot).
- Fine-tuning: **4-bit QLoRA** + **DeepSpeed ZeRO-2** across both GPUs (defaults tuned for up to
  ~13–14B base models).
- Export: merge the LoRA adapter, then convert + quantize to GGUF via bundled llama.cpp
  (`convert_hf_to_gguf.py` + `llama-quantize`), avoiding Axolotl's version-sensitive GGUF path.

## Dataset format

One JSON object per line, OpenAI-chat shape — **exactly** what the main backend's
`GET /api/scoring/export/download` produces:

```jsonl
{"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
```

Upload validates that a sampled prefix parses and carries a non-empty `messages` array.

## Configure

```bash
cp .env.example .env
# set FINETUNE_API_KEY (>= 8 chars), and HF_TOKEN if using gated base models
```

All vars are documented in `.env.example` and validated at boot (`src/config/env.ts`) — the process
exits on any invalid value.

## Run

```bash
# On the GPU host:
docker compose up --build

# Local dev (API only, no GPU/training):
npm install
npm run dev            # tsx watch
npm run typecheck      # tsc --noEmit
npm run build && npm start
```

## API

All endpoints except `/health` require `Authorization: Bearer $FINETUNE_API_KEY`.

| Method | Path              | Description |
|--------|-------------------|-------------|
| GET    | `/health`         | Public liveness probe → `{ ok: true }` |
| GET    | `/hardware`       | Detected GPU/VRAM/CPU/RAM **+ a per-size feasibility table** (see below) |
| GET    | `/usage`          | **Live** utilization: per-GPU util%/VRAM/temp/power, CPU load avg, RAM |
| POST   | `/upload`         | `multipart/form-data`, field `file` = `*.jsonl` → `{ dataset_id, path, line_count }` |
| POST   | `/train`          | JSON body (below) → **202** `{ job_id, status, plan }` |
| GET    | `/jobs/:id`       | Job status, progress, resolved `plan`, `metrics[]` (loss curve), recent log tail |
| GET    | `/jobs/:id/model` | Stream the produced GGUF (404 until `status === "done"`) |

### `GET /usage`

Real-time load (1s cache), distinct from the static `/hardware` report — intended to be polled a few
times a second by a dashboard. Degrades gracefully: without `nvidia-smi` it returns CPU/RAM with
`gpus: []` and an explanatory `note`.

```json
{
  "gpus": [{ "index": 0, "name": "NVIDIA RTX 4080", "util_pct": 97, "vram_used_mb": 14100,
             "vram_total_mb": 16376, "temp_c": 72, "power_w": 285.4 }],
  "cpu": { "cores": 24, "load_avg": [3.4, 2.9, 2.1], "load_pct": 14 },
  "ram": { "used_mb": 22150, "total_mb": 128000 },
  "at": "2026-07-08T12:00:00.000Z"
}
```

### `GET /hardware`

Reports the server's hardware and what it can fine-tune. VRAM math assumes 4-bit QLoRA; because
DeepSpeed **ZeRO-2 replicates** the base on each GPU, the binding constraint is a *single* GPU's
VRAM — so for models too large for one GPU the planner reports (and `/train` uses) **FSDP+QLoRA** to
shard the base across both GPUs (when `ENABLE_FSDP=true`).

```json
{
  "hardware": {
    "gpus": [{ "index": 0, "name": "NVIDIA RTX 4080", "vram_total_mb": 16376, "vram_free_mb": 16000 }],
    "gpu_count": 2, "min_gpu_vram_mb": 16376, "total_gpu_vram_mb": 32752,
    "cpu": { "model": "…", "cores": 32 }, "ram": { "total_mb": 128000, "free_mb": 110000 }
  },
  "sizes": [
    { "size_b": 7,  "feasibility": "ok",    "strategy": "deepspeed_zero2", "max_sequence_len": 4096, "note": "…" },
    { "size_b": 24, "feasibility": "tight", "strategy": "deepspeed_zero2", "max_sequence_len": 1024, "note": "…" },
    { "size_b": 32, "feasibility": "ok",    "strategy": "fsdp_qlora",      "max_sequence_len": 2048, "note": "…" }
  ]
}
```

`POST /train` body:

```json
{
  "base_model": "Qwen/Qwen2.5-14B-Instruct",
  "run_name": "support-agent-v3",
  "dataset_id": "<from /upload>",
  "webhook_url": "https://backend/api/finetune/callback",
  "target_size_b": 14,
  "on_infeasible": "auto_adjust",
  "hyperparams": {
    "sequence_len": 2048,
    "num_epochs": 3,
    "learning_rate": 0.0002,
    "gguf_quant": "q4_k_m"
  }
}
```

`hyperparams` is optional; anything omitted uses a 13–14B-safe default from
`src/lib/axolotl-config.ts`.

**Size & feasibility.** The service derives the base model's parameter count (in billions) to run a
pre-flight fit check against the detected hardware:

- `target_size_b` (optional) — assert the size directly (e.g. request a `9` or `24`). If omitted the
  size is parsed from the model name (`…-14B-…`), falling back to an estimate from the model's HF
  `config.json`. If none work, `/train` returns `400` asking you to pass `target_size_b`.
- `on_infeasible` (optional, default `auto_adjust`) — controls what happens when the (size, hardware)
  combo doesn't fit:
  - `auto_adjust` — tighten settings (shorten `sequence_len`, switch to FSDP) until it fits; if
    nothing fits, reject with **422** and the attempted `plan`.
  - `warn_proceed` — start best-effort anyway; the `plan.warnings` explain the OOM risk.

The chosen **`plan`** (resolved `strategy`, `sequence_len`, `feasibility`, `est_per_gpu_vram_gb`, any
`adjustments`/`warnings`) is returned in the `202` body and on `GET /jobs/:id`.

### Webhook payload (POSTed to `webhook_url`)

```json
{
  "job_id": "…",
  "run_name": "support-agent-v3",
  "status": "done",
  "base_model": "Qwen/Qwen2.5-14B-Instruct",
  "gguf_filename": "support-agent-v3-<id>.q4_k_m.gguf",
  "download_url": "/jobs/<id>/model",
  "error": null
}
```

Delivery is best-effort (3 retries with backoff). If the webhook never lands, the backend can still
poll `GET /jobs/:id` and pull from `GET /jobs/:id/model` — those are the source of truth.

## Example

```bash
KEY=your-finetune-api-key
BASE=http://localhost:8088

curl -sf $BASE/health

DS=$(curl -sf -H "Authorization: Bearer $KEY" \
  -F file=@sft-export.jsonl $BASE/upload | jq -r .dataset_id)

JOB=$(curl -sf -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d "{\"base_model\":\"Qwen/Qwen2.5-14B-Instruct\",\"run_name\":\"demo\",\"dataset_id\":\"$DS\"}" \
  $BASE/train | jq -r .job_id)

curl -sf -H "Authorization: Bearer $KEY" $BASE/jobs/$JOB          # poll status
curl -sf -H "Authorization: Bearer $KEY" $BASE/jobs/$JOB/model -o model.gguf  # when done
```

## Known limitations (v1)

- **Job state is in-memory** — a restart loses job history and abandons any in-flight training.
  `TODO` marker in `src/lib/job-store.ts` for disk/Mongo persistence.
- The pinned `AXOLOTL_REF` / `LLAMACPP_REF` in the `Dockerfile` should be verified against the base
  models you actually intend to train (build args let you bump them without editing the Dockerfile).
- 14B QLoRA on 16GB/GPU is tight; if you hit OOM, lower `sequence_len` or raise
  `gradient_accumulation_steps` via `hyperparams`.
```
