import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to ./dist, which the Dockerfile copies into the Nginx html root.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, host: true },
  // es2022 so top-level await (used by @novnc/novnc 1.7's WebCodecs probe) is supported, in both the
  // production build and the dev dep-optimizer.
  build: { outDir: 'dist', target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
