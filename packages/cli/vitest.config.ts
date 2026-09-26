import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  test: {
    include: ["packages/cli/test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
