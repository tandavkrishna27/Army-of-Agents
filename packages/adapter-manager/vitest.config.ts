import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "packages/adapter-manager",
    environment: "node",
  },
});
