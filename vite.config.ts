import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    // SheetJS (~500 kB, ~160 kB gzipped) is its own chunk, loaded only when a spreadsheet is opened.
    chunkSizeWarningLimit: 600
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
});
