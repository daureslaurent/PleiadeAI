# Backend build weight — the other half of `docker compose build`

Companion to `FRONTEND_BUILD_WEIGHT_PLAN.md`. That one made the frontend stage survivable on the
7 GB swapless OVH box; this one asks what the **backend** stage is holding at the same time, because
`docker compose up --build` builds the two concurrently and it is the *sum* that decides whether the
box thrashes.

## What the backend build was actually doing

BuildKit runs independent stages in parallel. The old two-stage Dockerfile had no edge between the
builder and the runtime stage until the final `COPY --from=builder /app/dist`, so its four heavy
steps were free to interleave:

| step | stage | measured |
|---|---|---|
| `npm ci` (full tree, 279 packages) | builder | 366 MB RSS, ~6 s |
| `npm ci --only=production` | **runner** | 366 MB RSS, ~6 s |
| `tsc -p tsconfig.json` (307 files, 3.3 MB src) | builder | **858 MB RSS**, ~7 s |
| `apk add … make g++ … ffmpeg` | runner | ~4 s, disk/network bound |

Two things stand out. The dependency tree is installed **twice** — once with dev dependencies for
the compile, once without for the image — and the second install lives in a stage that has no reason
to wait for the first, so on an unlucky schedule it is resident *while* `tsc` is. And `make`/`g++`
were installed into the runtime image for node-gyp, on a tree where nothing compiles natively: no
`binding.gyp`, no `.node` anywhere, and the only install scripts are esbuild's (which downloads a
prebuilt binary) and fsevents' (macOS-only, optional).

## The change

Four stages instead of two, each keyed on *either* the lockfile or `src/`, never both:

```
deps        ← package-lock.json     npm ci                (the one install)
  ├─ prod-deps                      npm prune --omit=dev  (what the image gets)
  └─ builder  ← src/                tsc
runner      ← apk + prod-deps + builder/dist
```

- **One registry install.** `prod-deps` prunes the tree `deps` already built rather than fetching it
  again, so there is no second install left to overlap the compile. Safe to carry across stages
  precisely because nothing in the tree builds natively and both stages are the same
  `node:22-alpine` — verified by diffing `ls node_modules` between the old and new images, which is
  identical.
- **`node_modules` comes from a stage that never saw `src/`.** This matters more than it looks: an
  earlier attempt pruned inside the builder, which made every source change re-export ~170 MB of
  dependencies and cost 3 s per rebuild. Splitting `prod-deps` out puts that layer back on the
  lockfile's cache key.
- **BuildKit npm cache mount** (`--mount=type=cache,target=/root/.npm`), so a lockfile change
  re-resolves without re-downloading, and the cache never enters an image layer.
- **`make` and `g++` dropped** from the runtime image. The pip/npm installs that do appear in the
  codebase are in `isolation/dockerfile.template.ts` and `visual.template.ts` — those build the
  *agent* images, not this one.
- **`BACKEND_BUILD_HEAP_MB`** (default 1024) caps `tsc`, mirroring the frontend's knob.

## Measurements

23-core / 31 GB builder, cold (`--no-cache`) unless noted.

| | before | after |
|---|---|---|
| image size | 1.14 GB | **722 MB** (−37%) |
| cold build | 34 s | **27 s** (−21%) |
| source-change rebuild | 13 s | 14 s |
| peak summed node RSS | 880 MB | 872 MB |

The heap floor, by bisection on `--max-old-space-size`:

| cap | result | peak RSS |
|---|---|---|
| none | ok | 858 MB |
| 1024 | ok | 815 MB |
| 768 | ok | 805 MB |
| **640** | **ok** | 745 MB |
| 576 | OOM | — |

**Be honest about the last row of the first table: the peak did not move.** `tsc` dominates it at
~860 MB, and on this builder the production install happened to finish before the compile started,
so the two never actually stacked. The win is that they now *cannot* — the second install no longer
exists — rather than a reduction that was observed here. On a two-core VPS where a registry install
takes far longer than six seconds, that overlap is the likely case, not the unlucky one.

Note also that `tsc` behaves differently from Rollup under a cap. The frontend's peak RSS tracks
`--max-old-space-size` closely, because V8 spends whatever headroom it is given; `tsc`'s sits at
745–860 MB whatever the cap, because most of its footprint is outside the JS heap. So
`BACKEND_BUILD_HEAP_MB` is a ceiling against drift, not a dial to tune down, and it costs about 1 s
(~15%) of compile time to impose. The default of 1024 is a 60% margin over the measured floor.

## Recommended setting for the 7 GB OVH box (~3 GB free)

The default is fine — `BACKEND_BUILD_HEAP_MB=1024` puts the backend at ~800 MB against the
frontend's ~1.5 GB at `FRONTEND_BUILD_HEAP_MB=1280`. If the box still cannot hold both, build them
one at a time rather than shrinking either:

```sh
docker compose build backend && docker compose build frontend && docker compose up -d
```

## Considered and rejected

- **Dropping `python3`/`ffmpeg` from the runtime image.** Both are load-bearing: Python skills run
  in a spawned subprocess in this container, and `ffmpeg` backs the `video_compose` flow node.
- **Keeping `npm ci --omit=dev` in the runner and merely ordering it after the builder.** There is
  no clean way to express "start this later" in a Dockerfile except a fake dependency, and it would
  still do the same install twice.
- **`tsc --incremental` with the `.tsbuildinfo` on a cache mount.** Would cut the rebuild compile,
  but the build already runs in a container whose `src/` layer is invalidated wholesale by any
  change, so the win is small and the failure mode (a stale buildinfo emitting nothing) is bad.
- **Prebuilt images in a registry.** Still the real permanent fix, still out of scope: builds stay
  on the VPS.
