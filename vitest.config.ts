import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/environment/**/*.test.ts'],
    exclude: ['experiments/**', 'benchmarks/**'],
  },
});
