import { defineConfig } from 'vite';
export default defineConfig({
  base: "./",
  build: { outDir: 'dist/worker', lib: { entry: 'src/live/worker-client.ts', formats: ['es'], fileName: () => 'worker-client.js' } },
  worker: { format: 'es' },
});
