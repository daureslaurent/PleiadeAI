import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url));

/** `'0'` disables a feature; unset or anything else enables it. Mirrors `src/lib/features.ts`. */
const on = (value: string | undefined) => value !== '0';

/**
 * Keep a switched-off feature's dependency out of the module graph entirely.
 *
 * `React.lazy` and `import()` split a *chunk*; Rollup still parses and transforms every module
 * behind them, so neither does anything for peak build memory. mermaid (cytoscape + dagre + katex +
 * elkjs) and monaco (an editor plus three worker bundles) are most of this graph, and on a small
 * VPS compiling them is the difference between a build and a reboot.
 *
 * Redirecting at `resolveId` rather than by an `alias` entry is deliberate on two counts: it matches
 * the *package* wherever it is imported from — so a new import site can't quietly reintroduce the
 * weight — and `enforce: 'pre'` puts it ahead of Vite's own resolution, before the dependency is
 * ever pre-bundled. `src/lib/features.ts` carries the matching runtime constants so the UI renders
 * a fallback instead of calling into a stub.
 */
function stubHeavyDeps(): Plugin {
  const stubs = new Map<string, string>();
  if (!on(process.env.VITE_FEATURE_MERMAID)) {
    stubs.set('mermaid', src('stubs/mermaid.ts'));
  }
  if (!on(process.env.VITE_FEATURE_MONACO)) {
    stubs.set('@monaco-editor/react', src('stubs/monaco-react.tsx'));
    // `lib/monacoSetup` is the only importer of `monaco-editor` and of the three `?worker` bundles,
    // so stubbing it covers all four without any rule having to match a query suffix.
    stubs.set('monacoSetup', src('stubs/monaco-setup.ts'));
  }
  if (!on(process.env.VITE_FEATURE_NOVNC)) {
    stubs.set('@novnc/novnc', src('stubs/novnc.ts'));
  }

  return {
    name: 'pleiades:stub-heavy-deps',
    enforce: 'pre',
    resolveId(source) {
      // `monacoSetup` is imported relatively (`../lib/monacoSetup`), so match on the tail.
      const key = source === 'monacoSetup' || source.endsWith('/monacoSetup') ? 'monacoSetup' : source;
      return stubs.get(key) ?? null;
    },
  };
}

// Builds to ./dist, which the Dockerfile copies into the Nginx html root.
export default defineConfig({
  plugins: [stubHeavyDeps(), react()],
  server: { port: 3000, host: true },
  // es2022 so top-level await (used by @novnc/novnc 1.7's WebCodecs probe) is supported, in both the
  // production build and the dev dep-optimizer.
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Rollup fans out to 20 concurrent file transforms by default; with monaco/mermaid in the
    // graph that peaks well past a small VPS's RAM. Trading a little build time for a flatter
    // memory curve keeps `docker compose build` alive on a 2GB box.
    //
    // Measured: default(20) 3.51GB → 2 gives 2.95GB, at no build-time cost. It saturates there —
    // 1 measures the same as 2, because what remains is the retained module graph, not concurrent
    // transforms. Squeezing further is a job for the feature flags above and the heap cap (see
    // Dockerfile), not this knob.
    rollupOptions: { maxParallelFileOps: 2 },
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' },
    // A stubbed package must not be pre-bundled either, or `vite dev` would pay for it anyway.
    exclude: [
      ...(on(process.env.VITE_FEATURE_MERMAID) ? [] : ['mermaid']),
      ...(on(process.env.VITE_FEATURE_MONACO) ? [] : ['monaco-editor', '@monaco-editor/react']),
      ...(on(process.env.VITE_FEATURE_NOVNC) ? [] : ['@novnc/novnc']),
    ],
  },
});
