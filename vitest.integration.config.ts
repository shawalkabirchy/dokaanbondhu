import { defineConfig } from "vitest/config";

// Integration tests (spec 18.3): they need the CI container's databases and run in the integration job only.
export default defineConfig({
  test: {
    include: ["packages/**/*.integration.test.ts", "apps/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
