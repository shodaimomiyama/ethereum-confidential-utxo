import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: [
      'tests/environment/**/*.test.ts',
      'tests/environment/**/*.test.mjs',
      'packages/uniswap/test/**/*.test.ts',
      'apps/uniswap-web/test/**/*.test.ts',
      'apps/uniswap-web/test/**/*.test.tsx',
    ],
    exclude: ['experiments/**', 'benchmarks/**', 'tests/environment/check-tools.test.mjs'],
  },
});
