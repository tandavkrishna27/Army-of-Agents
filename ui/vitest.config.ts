import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

// Adapter packages that export a /ui sub-path. The dist/ directories are not
// built during vitest runs, so we alias each /ui sub-path to its TypeScript
// source so the tests can import them directly.
const ADAPTER_UI_ALIASES = [
  "acpx-local",
  "claude-local",
  "codex-local",
  "cursor-cloud",
  "cursor-local",
  "gemini-local",
  "grok-local",
  "openclaw",
  "openclaw-gateway",
  "opencode-local",
  "pi-local",
] as const;

const adapterUiAliases = Object.fromEntries(
  ADAPTER_UI_ALIASES.map((pkg) => [
    `@armyofagents/adapter-${pkg}/ui`,
    path.resolve(__dirname, `../packages/adapters/${pkg}/src/ui/index.ts`),
  ]),
);

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Ensure zod resolves for workspace packages during tests
      zod: path.dirname(require.resolve("zod/package.json")),
      // Resolve workspace adapter sub-path exports to source (dist not built in test env)
      ...adapterUiAliases,
    },
  },
  test: {
    environment: "jsdom",
    hookTimeout: 30_000,
    setupFiles: ["./src/__tests__/setup.ts"],
    globals: true,
    testTimeout: 30_000,
    server: {
      deps: {
        inline: [/@armyofagents\//],
      },
    },
  },
});
