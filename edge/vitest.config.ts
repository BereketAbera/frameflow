import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Bundles the Worker once, the way a deploy would, before any test starts a local runtime with it.
    globalSetup: ["local/build-worker.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
