# image-gen

Self-hosted **GGUF image generation** server for PleiadesAI, using
[`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp)'s `sd-server` in Docker.
It exposes an **OpenAI-compatible** endpoint — `POST /v1/images/generations` — so it plugs in the
same way a remote `llama.cpp` box does for chat. Defaults to **FLUX.1-dev** (GGUF, non-commercial license).

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

```bash
curl http://localhost:1234/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a lovely cat, cinematic lighting","n":1,"size":"512x512"}'
```

Returns OpenAI-shaped JSON: `{ "data": [ { "b64_json": "<base64 PNG>" } ] }`.

## Configuration (`.env`)

- `SD_PORT` / `SD_BIND` — listen port and host interface (`0.0.0.0` for LAN, `127.0.0.1` local-only).
- `SD_IMAGE` — container image. Default is CPU/Vulkan `master`; for NVIDIA use a CUDA tag **and**
  uncomment the `deploy` GPU block in `docker-compose.yml` (needs the NVIDIA Container Toolkit).
- `SD_DIFFUSION_MODEL` / `SD_T5XXL` / `SD_CLIP_L` / `SD_VAE` — the four FLUX files under `./models`.
  To run a **single-file** model (e.g. SD 1.5 GGUF), edit `docker-compose.yml`'s `command:` to a
  single `-m /models/<file>` instead of the four `--diffusion-model/--t5xxl/--clip_l/--vae` flags.

## Notes

- **FLUX.1-dev is licensed for non-commercial use only** (unlike the Apache-2.0 schnell). The GGUF
  weights come from the ungated `city96/FLUX.1-dev-gguf` re-quant, and the VAE from the schnell repo
  (byte-identical to dev's gated `ae.safetensors`), so no Hugging Face token is needed.
- Dev is not a distilled 4-step model — use ~20–28 steps with guidance ~3.5 for good results
  (`sd-server`'s defaults already suit this). Pass `steps`/`n`/`size` in the request to tune.
- To switch back to the faster Apache-2.0 **FLUX.1-schnell**, set `SD_DIFFUSION_MODEL=flux1-schnell-Q4_0.gguf`
  in `.env` and add its download URL to `run.sh`'s `FILES` map.
- CPU works but FLUX is slow (tens of seconds+). For usable speed use a GPU (CUDA/Vulkan) build.
- `./models` and `./output` are gitignored — weights are large and downloaded on demand.
- Confirm exact flags for your build with:
  `docker run --rm --entrypoint /sd-server ghcr.io/leejet/stable-diffusion.cpp:master -h`
