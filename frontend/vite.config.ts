import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to ./dist, which the Dockerfile copies into the Nginx html root.
export default defineConfig({
  plugins: [react()],
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
    // transforms. Squeezing further is a job for the heap cap (see Dockerfile), not this knob.
    rollupOptions: { maxParallelFileOps: 2 },
  },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
