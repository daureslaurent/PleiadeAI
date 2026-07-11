# image-gen

Self-hosted **GGUF image generation** server for PleiadesAI, using
[`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp)'s `sd-server` in Docker.
It exposes an **OpenAI-compatible** endpoint — `POST /v1/images/generations` — so it plugs in the
same way a remote `llama.cpp` box does for chat. Defaults to **FLUX.1-dev** (GGUF, non-commercial
license), configured per upstream's [FLUX guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/flux.md).

## Quick start

```bash
cp .env.example .env      # optional: edit port / model files
./run.sh                  # downloads FLUX.1-dev weights into ./models, then starts the server
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

## Calling it

The OpenAI route is a **compatibility shim**: it reads only `prompt`, `n`, `size`, `output_format`
and `output_compression` from the body ([`api.md`](https://github.com/leejet/stable-diffusion.cpp/blob/master/examples/server/api.md)).
Top-level `steps` / `cfg_scale` / `guidance` / `seed` / `negative_prompt` are **silently ignored** —
they only take effect through the native schema, embedded in the prompt as an `<sd_cpp_extra_args>`
block that the server extracts and strips before generating:

```bash
curl http://localhost:1234/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "a lovely cat, cinematic lighting <sd_cpp_extra_args>{\"seed\":-1,\"sample_params\":{\"sample_method\":\"euler\",\"sample_steps\":24,\"guidance\":{\"txt_cfg\":1.0,\"distilled_guidance\":3.5}}}</sd_cpp_extra_args>",
    "n": 1,
    "size": "1024x1024"
  }'
```

Returns OpenAI-shaped JSON: `{ "data": [ { "b64_json": "<base64 PNG>" } ] }`.
The backend does exactly this — see `backend/src/inference/image-generate.ts`.

Anything not sent per-request falls back to the server's **CLI defaults** (the `SD_CFG_SCALE`,
`SD_GUIDANCE`, `SD_SAMPLING_METHOD`, `SD_STEPS` values in `.env`), so those must be FLUX-correct too.

## Configuration (`.env`)

- `SD_PORT` / `SD_BIND` / `SD_HOST_PORT` — listen port, host interface (`0.0.0.0` LAN, `127.0.0.1`
  local-only), and the published host port (set a private one when fronting with `gpu-broker`).
- `SD_IMAGE` — container image. Upstream publishes accelerator tags only: `master-cuda` (default),
  `master-vulkan`, `master-sycl`, `master-musa`. Non-NVIDIA hosts must also delete the `deploy` GPU
  block in `docker-compose.yml`.
- `SD_DIFFUSION_MODEL` / `SD_T5XXL` / `SD_CLIP_L` / `SD_VAE` — the four FLUX files under `./models`.
  `run.sh` derives the download URL from the file name, so any `city96/FLUX.1-dev-gguf` quant works
  without editing the script. To run a **single-file** model (e.g. SD 1.5 GGUF), edit
  `docker-compose.yml`'s `command:` to a single `-m /models/<file>` instead of the four flags.
- `SD_CFG_SCALE` / `SD_GUIDANCE` / `SD_SAMPLING_METHOD` / `SD_STEPS` — default generation params.
- `SD_BACKEND` / `SD_EXTRA_ARGS` — module placement and raw extra flags (see below).

## Notes

- **Real CFG vs distilled guidance are different knobs.** FLUX.1-dev is guidance-*distilled*: real
  CFG (`--cfg-scale` / `txt_cfg`) must stay at **1.0**, per upstream's flux.md. `sd-server`'s stock
  default is **7.0**, which runs an unconditional pass FLUX was never trained for — burnt,
  oversaturated output at ~2x the compute. `--cfg-scale 1.0` is passed explicitly for that reason.
  A **negative prompt is a no-op** while real CFG is off.
  The distilled `--guidance` (~3.5) is the one that actually shapes a FLUX image.
- Dev is not a distilled 4-step model — use ~20–28 steps (`SD_STEPS=24`). For **FLUX.1-schnell**
  (Apache-2.0, faster) set `SD_DIFFUSION_MODEL=flux1-schnell-Q4_K_S.gguf`, `SD_STEPS=4`, and point
  `run.sh`'s diffusion URL at `city96/FLUX.1-schnell-gguf`.
- **VRAM.** Text encoders sit on the CPU (`SD_BACKEND=te=cpu`, upstream's deprecated `--clip-on-cpu`),
  so the GPU budget goes entirely to the diffusion weights — that's how FLUX fits in 6 GB with no RAM
  offload. Pick the largest quant that fits: Q4_K_S ~6.9 GB < Q5_K_S ~8.3 GB < Q6_K ~9.9 GB <
  Q8_0 ~12.7 GB. A quant that does *not* fit needs weight streaming via `SD_EXTRA_ARGS`, e.g.
  `--params-backend diffusion=cpu --max-vram cuda0=11 --stream-layers` (slower — weights cross PCIe
  every step). Never add `--auto-fit`: it overrides `--backend`/`--params-backend` and re-OOMs.
- **FLUX.1-dev is licensed for non-commercial use only** (unlike the Apache-2.0 schnell). The GGUF
  weights come from the ungated `city96/FLUX.1-dev-gguf` re-quant, and the VAE from an ungated
  schnell mirror (byte-identical to dev's gated `ae.safetensors`), so no Hugging Face token is needed.
- CPU works but FLUX is slow (tens of seconds+). For usable speed use a GPU (CUDA/Vulkan) build.
- `./models` and `./output` are gitignored — weights are large and downloaded on demand.
- Confirm exact flags for your build with:
  `docker run --rm --entrypoint /sd-server ghcr.io/leejet/stable-diffusion.cpp:master-cuda -h`
