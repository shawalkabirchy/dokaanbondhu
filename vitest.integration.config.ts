import { defineConfig } from "vitest/config";

// Integration tests (spec 18.3): they need the CI container's databases and run in the integration job only.
// The files run one after another: the worker's jobs (health probe, catalog sync) act on every active connection in
// the shared database, and each file encrypts its connections with its own key, so a probe running beside another
// file's chat test would mark that file's connection as failed.
export default defineConfig({
  test: {
    include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
