import os from "node:os";
import { defineConfig } from "vitest/config";

// CPU headroom: every server integration test spawns its own embedded-postgres
// process alongside the vitest worker, so running one fork per core oversubscribes
// the CI runner (worker + embedded-pg both fighting for the same core). Under that
// contention a heavy synchronous test (whole-tree AST scans, tsc compiler probes)
// can stall a worker's event loop past vitest's fixed 60s birpc timeout, surfacing as
// a spurious `[vitest-worker]: Timeout calling "onTaskUpdate"` that fails an otherwise
// all-green run. Cap forks at half the available parallelism (min 2) so each worker
// and its embedded-pg get a core; correctness is unaffected, only wall-clock.
const availableParallelism =
  typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const maxForks = Math.max(2, Math.floor(availableParallelism / 2));

export default defineConfig({
  test: {
    hookTimeout: 30_000,
    testTimeout: 30_000,
    pool: "forks",
    poolOptions: {
      forks: { maxForks, minForks: 1 },
    },
    projects: ["packages/adapter-utils", "packages/shared", "packages/db", "packages/worker-protocol", "packages/worker-daemon", "packages/sandbox-provider-contract", "packages/sandbox-fake-provider", "packages/browser-runtime", "packages/sandbox-e2b-provider", "packages/provider-capability", "packages/provider-wire", "packages/adapter-manager", "packages/worker-keystore", "packages/worker-networked-host", "packages/adapters/opencode-local", "packages/adapters/gemini-local", "packages/adapters/codex-local", "packages/adapters/claude-local", "packages/adapters/grok-local", "packages/adapters/pi-local", "packages/adapters/acpx-local", "packages/adapters/cursor-local", "packages/adapters/cursor-cloud", "packages/adapters/openclaw", "packages/adapters/openclaw-gateway", "server", "ui", "cli", "packages/plugins/examples/plugin-authoring-smoke-example"],
  },
});
