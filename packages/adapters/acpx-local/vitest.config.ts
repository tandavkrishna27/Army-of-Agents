import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
