# syntax=docker/dockerfile:1
#
# Build weight (see BACKEND_BUILD_WEIGHT_PLAN.md). This image is built *concurrently* with the
# frontend's by `docker compose up --build`, so what matters is not how fast this stage is on its
# own but what it holds while the frontend stage is holding ~2 GB of its own. BuildKit runs
# independent stages in parallel, so the shape of the graph is the lever: everything below is keyed
# on package-lock.json or on src/, never on both, and the dependency tree is installed exactly once.

# --- Dependencies (keyed on the lockfile alone) ---
# Installed once, for both the compile and the runtime image. The npm cache is a BuildKit cache
# mount rather than a layer: it survives across builds without being baked into the image.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# --- Production tree ---
# The same install with the dev dependencies pruned away, which is what the runtime stage copies.
# A second `npm ci --omit=dev` would do the same work twice, and — being an independent stage —
# would run its ~370 MB resident set *alongside* the compile rather than after it. Pruning is safe
# to carry across stages here because nothing in the tree builds natively (no binding.gyp, no
# .node; esbuild ships a prebuilt binary) and both stages are the same node:22-alpine.
FROM deps AS prod-deps
RUN npm prune --omit=dev

# --- Build Stage ---
FROM deps AS builder
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

# Bound the compile. Measured on this tree: `tsc` needs a cap of ~640 MB (576 fails) and peaks at
# ~750-860 MB RSS whichever cap it is given — unlike Rollup, most of its footprint lives outside the
# JS heap, so this is a ceiling against drift rather than a dial to tune down. Raise it if a build
# ever dies with "JavaScript heap out of memory".
ARG BACKEND_BUILD_HEAP_MB=1024
ENV NODE_OPTIONS=--max-old-space-size=$BACKEND_BUILD_HEAP_MB
RUN npm run build

# --- Runtime Stage ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install Python 3 + bash for dynamic skill execution and the `bash` terminal tool, plus the
# Docker CLI so the backend can build per-agent isolation images and run/exec their containers
# through the mounted host /var/run/docker.sock (see docker-compose.yml). openssh-client backs the
# Isolation page's "scan host key" / "test connection" actions for the `ssh` network mode.
# tzdata gives Python's zoneinfo the IANA database (skills doing timezone math need it).
# ffmpeg backs the `video_compose` flow node (concat / mux / still) — assembling a per-shot clip and
# stitching a finished video is CPU work, and routing it through ComfyUI would burn GPU time on it.
#
# No `make`/`g++`: they were here for node-gyp, and nothing in the dependency tree compiles. The
# pip/npm installs in the isolation Dockerfile templates run in the *agent* images, not this one.
RUN apk add --no-cache python3 bash docker-cli openssh-client tzdata ffmpeg

# Working directory used by the `bash` terminal tool (BASH_CWD).
RUN mkdir -p /workspace

COPY package*.json ./

# node_modules before dist, and from a stage that never saw src/: a source-only change then
# re-exports the compiled output alone instead of ~170 MB of dependencies with it.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# MongoDB migrations + their config: applied automatically at boot (see src/db/migrate.ts) so an
# app update / restart never runs new code against an un-migrated schema. Plain CommonJS, no build step.
COPY migrate-mongo-config.js ./
COPY migrations ./migrations

EXPOSE 4000
CMD ["node", "dist/index.js"]
