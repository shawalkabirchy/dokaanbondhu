import { defineConfig } from "vitest/config";

// The engine's unit tests run whole conversations against fake shop apps. A test that walks every button takes under
// a second alone, but several while every package's tests run at once on a laptop, so the limit is 20 s, not 5 s.
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
