import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds to ./dist, which the Dockerfile copies into the Nginx html root.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, host: true },
  build: { outDir: 'dist' },
});
