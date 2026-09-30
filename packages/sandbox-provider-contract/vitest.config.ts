import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // port-conformance.test.ts is a COMPILE-TIME-only conformance file (enforced
    // by `tsc --noEmit` via tsconfig `files`), not a runtime suite — keep vitest
    // from treating it as an empty test file.
    exclude: [...configDefaults.exclude, "**/port-conformance.test.ts"],
  },
});
