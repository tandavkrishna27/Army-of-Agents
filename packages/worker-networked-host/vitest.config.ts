import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "packages/worker-networked-host",
    environment: "node",
  },
});
