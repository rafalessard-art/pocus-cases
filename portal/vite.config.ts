import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// The portal is served from /app on the existing site. `npm run build` (see
// scripts/build-site.mjs) writes it to dist/app next to the untouched static
// pages.
export default defineConfig({
  root: resolve(__dirname),
  base: '/app/',
  envDir: resolve(__dirname, '..'),
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../dist/app'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
  },
  server: {
    port: 5173,
  },
});
