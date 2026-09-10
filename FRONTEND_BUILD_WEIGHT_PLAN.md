# Frontend build weight — making a 7 GB VPS survive `docker compose build`

## The problem

`docker compose build` on the OVH VPS (7 GB, **no swap**, ~3 GB actually free once mongo, qdrant,
the llama.cpp embeddings server and searxng are resident) freezes the box hard enough to need a
reboot. It always happens during the **frontend** stage.

Two knobs were already spent on this and are not enough:

- `vite.config.ts` → `build.rollupOptions.maxParallelFileOps: 2` (default 20)
- `frontend/Dockerfile` → `NODE_OPTIONS=--max-old-space-size=2048`

The heap cap bounds the JS heap, not RSS; Rollup's peak sits well above it. With no swap, the
kernel has nowhere to spill and the box thrashes to death instead of OOM-killing one process.

## What is actually in the graph (~6166 modules)

| Dep | Split at runtime? | Build cost |
|---|---|---|
| `mermaid` (86 MB src) | yes, dynamic `import()` | **still fully compiled** — pulls cytoscape, dagre, katex, elkjs |
| `monaco-editor` (76 MB) | yes, `React.lazy` | **still fully compiled**, plus 3 worker bundles |
| `react-syntax-highlighter` | no | the `Prism` export registers **~300 languages** via refractor |
| `@xyflow/react` (5 MB) | no | moderate, left alone |
| `@novnc/novnc` (0.8 MB) | yes, `React.lazy` | small |

The key point: **`import()` defers download, not compilation.** Cutting build memory needs the
module to be genuinely absent from the graph, not merely deferred.

## Decisions (operator, 2026-09-11)

- No prebuilt images / registry. Builds keep happening on the VPS.
- Per-feature **build-time flags**, defaulting **on**; in production only **mermaid** is switched off.
- The frontend must degrade gracefully when a feature is compiled out — no blank screens.
- Cheap no-tradeoff fixes on top.

## Work

1. **`src/lib/features.ts`** — build-time constants from `VITE_FEATURE_MERMAID` / `_MONACO` /
   `_NOVNC` (`'0'` = off, anything else = on), so dead branches tree-shake.
2. **Stub resolution plugin in `vite.config.ts`** — a `resolveId` hook that redirects the heavy
   package specifiers to tiny local stubs when their flag is off, so the package never enters the
   module graph at all. Aliasing the *package* (not the importer) means a future import site can't
   silently reintroduce the weight.
3. **Graceful degradation** — mermaid fences render as ordinary code blocks; `CodeEditor` falls back
   to a plain `<textarea>` honouring the same `value`/`onChange` contract; the visual-desktop hook
   reports an unavailable status instead of connecting.
4. **`PrismLight`** — register ~12 languages explicitly instead of shipping all ~300. No visible
   change, pure win, applies to every build.
5. **Compose + `.env.example` wiring** — flags as build args, documented.

## Measurements

All on a 23-core / 31 GB builder, `maxParallelFileOps: 2`, one build per row.

Peak RSS turned out to be the wrong thing to measure: it sits within ~150 MB of whatever
`--max-old-space-size` is set to, in *every* configuration (full build at a 2048 cap peaks at
2.29 GB; mermaid off at the same cap peaks at 2.08 GB). V8 simply spends the headroom it is given.
The question that matters is therefore **how low the cap can go before the build OOMs**, because
that is what determines whether the box survives.

| flags | modules | bundle | lowest cap that builds | build time |
|---|---|---|---|---|
| full | 6278 | 20 MB | **2048** (1536 fails) | 34 s |
| `VITE_FEATURE_MERMAID=0` | 4378 | 16 MB | **1280** (1024 fails) | 28 s |
| mermaid + monaco off | 3160 | — | **512** (384 fails) | — |
| all three off | 3109 | — | **512** (384 fails) | — |

The first row is the finding: **at the full feature set the floor is exactly the 2048 default.** The
build had no margin at all, so any competition for RAM — mongo, qdrant, the llama.cpp embeddings
server, searxng, all resident during a `docker compose build` — pushes it over. With no swap the
kernel has nowhere to spill, so instead of one clean OOM kill the box thrashes until it needs a
reboot.

Note also how little the last two rows buy: monaco is worth a lot of *bundle*, but past mermaid the
build floor is already down at 512 MB. **Turning mermaid off alone is essentially the whole win.**

## Recommended setting for the 7 GB OVH box (~3 GB free)

```dotenv
VITE_FEATURE_MERMAID=0
FRONTEND_BUILD_HEAP_MB=1280
```

That is a ~1.5 GB peak against ~3 GB free — a real margin rather than none. Monaco and the live
desktop stay in.

Two things worth doing on the host regardless, neither of them a code change:

- **Add swap.** A swapless box turns any overshoot into a hang instead of a failed build. Even
  2 GB of swapfile converts a reboot into a slow build.
- **Build with the stack down** (`docker compose down` first, or build only the frontend service).
  The embeddings llama.cpp container alone is a large resident set to be competing with.

## Verified

- `npm run typecheck` passes (types are resolved by tsc against the *real* packages regardless of
  the flags, so a lite build is typechecked exactly like a full one).
- A `VITE_FEATURE_MERMAID=0` build completes and its output contains no cytoscape/dagre/elkjs/katex
  code — the only surviving matches are the theme descriptors' `mermaid: {...}` palette values and
  the `mermaid-svg` CSS class name.

## Considered and rejected

- **`PrismLight` with a curated language list.** Expected to be a free win, since the default
  `Prism` export registers all ~300 refractor languages. Measured: it *added* 31 modules (6278 →
  6309), because the all-languages export resolves to one prebuilt refractor bundle while a curated
  list pulls 30 separate files. It did trim ~1 MB off the main chunk, but that is a runtime win
  working against the build-weight goal, so it was reverted to keep this change set focused.
- **Route-level `React.lazy` for the ~40 views in `App.tsx`.** Improves first-load time, but splits
  chunks without removing modules, so it does nothing for the build floor.
- **Prebuilt images in a registry.** The real permanent fix, but explicitly out of scope: builds
  stay on the VPS.
