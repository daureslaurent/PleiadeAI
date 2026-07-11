# image-gen

Self-hosted **GGUF image generation** server for PleiadesAI, using
[`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp)'s `sd-server` in Docker.
It exposes an **OpenAI-compatible** endpoint — `POST /v1/images/generations` — so it plugs in the
same way a remote `llama.cpp` box does for chat. Defaults to **FLUX.2-klein-9B**, configured per
upstream's [FLUX.2 guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/flux2.md).

## Quick start

```bash
cp .env.example .env      # optional: edit port / model files
./run.sh                  # downloads the FLUX.2 weights (~15GB) into ./models, then starts the server
./run.sh test             # generates a sample image → ./output/test-*.png
```

Server is then at `http://localhost:1234/v1/images/generations`.

## Commands

| Command          | Does                                                        |
|------------------|------------------------------------------------------------|
| `./run.sh`       | Download models (if missing) **and** start the server      |
| `./run.sh models`| Download the GGUF weights only                             |
| `./run.sh up`    | Start the server (models must already be in `./models`)    |
| `./run.sh down`  | Stop the server                                            |
| `./run.sh logs`  | Follow server logs (watch model load / generation)        |
| `./run.sh test`  | POST a sample prompt and save the returned PNG            |

## The model

FLUX.2 is **not** FLUX.1 with a bigger number. The CLIP-L + T5-XXL encoder pair is gone, replaced by
a single **LLM text encoder** (`--llm`), and the VAE is new. Three files instead of four.

| Variant | Diffusion | Encoder | Steps / CFG | Notes |
|---|---|---|---|---|
| **klein-9B** (default) | 10.0 GB @ Q8_0 | Qwen3-8B (5.0 GB) | 4 @ cfg 1.0 | Distilled → fast despite 9B. Best that fits 12+8 GB fully resident. |
| klein-9B Q4_0 | 5.6 GB | Qwen3-8B | 4 @ cfg 1.0 | Same speed, lots of VRAM headroom, some quality loss. |
| klein-4B | 4.3 GB @ Q8_0 | Qwen3-4B (2.5 GB) | 4 @ cfg 1.0 | Fastest; less detail / prompt adherence. |
| klein-base-9B | 10 GB @ Q8_0 | Qwen3-8B | **20 @ cfg 4.0** | NOT distilled — the only variant where a **negative prompt works**. ~5x slower. |
| FLUX.2-dev | ~19 GB | Mistral-Small-3.2-**24B** | 20-28 | Won't fit this box. Not wired into `run.sh`. |

Weights come from `leejet/FLUX.2-klein-*-GGUF` (diffusion), `unsloth/Qwen3-*-GGUF` (encoder) and the
ungated `Comfy-Org/flux2-dev` mirror (VAE — Black Forest Labs' own repo is gated and 401s). No Hugging
Face token needed. `run.sh` derives each URL from the file name in `.env`, so swapping variant or
quant needs no script edit.

## Calling it

The OpenAI route is a **compatibility shim**: it reads only `prompt`, `n`, `size`, `output_format`
and `output_compression` from the body ([`api.md`](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md)).
Top-level `steps` / `cfg_scale` / `seed` / `negative_prompt` are **silently ignored** — they only take
effect through the native schema, embedded in the prompt as an `<sd_cpp_extra_args>` block that the
server extracts and strips before generating:

```bash
curl http://localhost:1234/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a lovely cat, cinematic lighting <sd_cpp_extra_args>{\"seed\":-1,\"sample_params\":{\"sample_method\":\"euler\",\"sample_steps\":4,\"guidance\":{\"txt_cfg\":1.0}}}</sd_cpp_extra_args>",
    "n": 1,
    "size": "1024x1024"
  }'
```

Returns OpenAI-shaped JSON: `{ "data": [ { "b64_json": "<base64 PNG>" } ] }`.
The backend does exactly this — see `backend/src/inference/image-generate.ts`.

Anything not sent per-request falls back to the server's **CLI defaults** (`SD_CFG_SCALE`,
`SD_SAMPLING_METHOD`, `SD_STEPS` in `.env`), so those must be model-correct too. The generated PNG
embeds a `parameters` text chunk listing the params that *actually* applied — the fastest way to
prove a knob landed.

## Configuration (`.env`)

- `SD_PORT` / `SD_BIND` / `SD_HOST_PORT` — listen port, host interface (`0.0.0.0` LAN, `127.0.0.1`
  local-only), and the published host port (set a private one when fronting with `gpu-broker`).
- `SD_IMAGE` — container image. Upstream publishes accelerator tags only: `master-cuda` (default),
  `master-vulkan`, `master-sycl`, `master-musa`. Non-NVIDIA hosts must also delete the `deploy` GPU
  block in `docker-compose.yml`.
- `SD_DIFFUSION_MODEL` / `SD_LLM` / `SD_VAE` — the three FLUX.2 files under `./models`.
- `SD_CFG_SCALE` / `SD_SAMPLING_METHOD` / `SD_STEPS` — default generation params.
- `SD_BACKEND` / `SD_EXTRA_ARGS` — module placement and raw extra flags.

## Notes

- **Real CFG must stay at 1.0 on klein.** It is guidance-*distilled*: real CFG > 1 runs an
  unconditional pass the model was never trained for → burnt, oversaturated output at ~2x the compute.
  `sd-server`'s stock default is **7.0**, which is exactly that failure mode, so `--cfg-scale 1.0` is
  passed explicitly. Consequence: a **negative prompt is a no-op** unless you switch to klein-base.
- **Steps**: klein is distilled to **4**. Cranking steps up doesn't add detail, it just costs time.
- **VRAM**: default places the 9B diffusion weights on `cuda0` and the encoder + VAE on `cuda1`, all
  resident, nothing streaming across PCIe. ggml's `cuda0`/`cuda1` may be the **reverse** of
  `nvidia-smi`'s indices — check the load log to see which card took the ~10 GB slice. On a single GPU,
  use `SD_BACKEND=te=cpu` or `SD_EXTRA_ARGS=--offload-to-cpu` (flux2.md's own answer). Never add
  `--auto-fit`: it overrides `--backend`/`--params-backend` and OOMs.
- `./models` and `./output` are gitignored — weights are large and downloaded on demand.
- Confirm exact flags for your build with:
  `docker run --rm --entrypoint /sd-server ghcr.io/leejet/stable-diffusion.cpp:master-cuda -h`
