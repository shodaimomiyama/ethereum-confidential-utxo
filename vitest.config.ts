import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/environment/**/*.test.ts', 'tests/environment/**/*.test.mjs'],
    exclude: ['experiments/**', 'benchmarks/**', 'tests/environment/check-tools.test.mjs'],
  },
});
