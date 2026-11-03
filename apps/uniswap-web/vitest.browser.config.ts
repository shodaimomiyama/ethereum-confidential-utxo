import { readFile } from 'node:fs/promises';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
export default defineConfig({
  plugins: [{
    name: 'serve-production-worker',
    configureServer(server) {
      // Serve the built bundle verbatim so the dev server cannot rewrite its Worker URL.
      server.middlewares.use('/worker-bundle', (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path || !/^\/(?:assets\/)?[\w.-]+\.js$/.test(path)) return next();
        void readFile(new URL(`./dist/worker${path}`, import.meta.url)).then(bytes => {
          response.setHeader('Content-Type', 'text/javascript'); response.end(bytes);
        }, () => next());
      });
    },
  }],
  test: {
    include: ['test/browser/**/*.test.ts'],
    testTimeout: 30_000,
    browser: { enabled: true, headless: true, screenshotFailures: false, provider: playwright({ launchOptions: { channel: 'chrome' } }), instances: [{ browser: 'chromium' }] },
  },
});
