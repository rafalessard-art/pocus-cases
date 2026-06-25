import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

// Library build: one ESM bundle + bundled stylesheet (dist/style.css) + rolled-up types.
// react / react-dom stay external so consuming apps (and the design agent runtime) provide them.
export default defineConfig({
  plugins: [
    react(),
    dts({
      include: ['src'],
      exclude: ['**/*.stories.tsx'],
      rollupTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
    },
    cssCodeSplit: false,
  },
});
