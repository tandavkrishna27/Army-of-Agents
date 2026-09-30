import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import {
  AMBIENT_CLAUDE_CONFIG_POISON,
  FAKE_CLAUDE_CONTROL_PATH,
  FAKE_CLAUDE_INVOCATIONS_PATH,
  seedAmbientClaudeConfigHome,
} from "./helpers/fake-claude";
import { FAKE_CODEX_CONTROL_PATH, FAKE_CODEX_INVOCATIONS_PATH } from "./helpers/fake-codex";
import { FAKE_CREW_CONTROL_PATH } from "./helpers/fake-crew-control";
import { FAKE_EMBEDDER_CONTROL_PATH } from "./helpers/fake-embedder";

// Windows runner can't start embedded-postgres because GitHub's Windows
// runner is `runneradmin` (administrative) and PostgreSQL refuses to
// start as administrative. If DATABASE_URL is provided, AoA uses external
// Postgres instead, so Windows e2e can run normally.
// Linux + macOS coverage is unaffected.
//
// Escape hatch: on a real (non-runneradmin) Windows dev machine, embedded
// postgres starts fine. Set AOA_E2E_FORCE_WINDOWS=1 to run the full e2e suite
// locally on Windows with embedded postgres despite the CI-runner limitation
// (Issue #114). CI leaves this unset, so the runner still skips as before.
const WINDOWS_WITH_EMBEDDED_POSTGRES =
  process.platform === "win32" &&
  !process.env.DATABASE_URL?.trim() &&
  process.env.AOA_E2E_FORCE_WINDOWS !== "1";

// Use a dedicated port so e2e tests always start their own server in local_trusted mode,
// even when the dev server is running on :3100 in authenticated mode.
const PORT = Number(process.env.AOA_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const EPHEMERAL_PORT_MIN = 49_152;
const EPHEMERAL_PORT_MAX = 65_535;
async function pickAvailablePort(preferredPort: number): Promise<number> {
  for (let port = preferredPort; port <= 65535; port += 1) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (available) return port;
  }
  throw new Error(`No available e2e embedded Postgres port at or after ${preferredPort}`);
}
function parsePort(raw: string, name: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}="${raw}" is not a valid TCP port`);
  }
  return port;
}
const E2E_DB_PORT = process.env.AOA_E2E_DB_PORT?.trim()
  ? parsePort(process.env.AOA_E2E_DB_PORT, "AOA_E2E_DB_PORT")
  : await pickAvailablePort(
      EPHEMERAL_PORT_MIN + Math.floor(Math.random() * (EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN + 1)),
    );
process.env.AOA_E2E_DB_PORT = String(E2E_DB_PORT);
// Skip the temp-dir setup on unsupported Windows embedded-postgres runs so we
// don't pay setup cost when no tests will run.
const AOA_HOME = WINDOWS_WITH_EMBEDDED_POSTGRES
  ? ""
  : fs.mkdtempSync(path.join(os.tmpdir(), "aoa-e2e-home-"));

// Keep provider-status E2E hermetic as well as the AoA instance itself. The
// production Codex status path intentionally reads the server's shared
// CODEX_HOME/config.toml, so inheriting the developer's ~/.codex would make
// model-resolution assertions depend on the host's current login/config.
const CODEX_HOME = WINDOWS_WITH_EMBEDDED_POSTGRES
  ? ""
  : fs.mkdtempSync(path.join(os.tmpdir(), "aoa-e2e-codex-home-"));
if (CODEX_HOME) {
  fs.writeFileSync(path.join(CODEX_HOME, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
}

// UNCONDITIONAL startup cleanup (eng-review fix 2): delete any leftover
// fake-crew control file from a prior run that died on a signal (afterEach
// doesn't run on SIGKILL/Ctrl-C, and os.tmpdir() persists across local runs).
// Unlike the fake-claude control (which only affects specs that script it),
// this control file changes the DEFAULT Adjutant behavior — a stale file
// silently rewires the controller-mode branch for legacy specs that never
// touch it (e.g. full-discussion-to-workspace-cycle waits 75s for a
// scope-proposal-card the controller branch never emits). Runs once at config
// load, before any worker/server launches, so no spec inherits a stale file.
try {
  fs.unlinkSync(FAKE_CREW_CONTROL_PATH);
} catch {
  /* absent — fine */
}

// D9 (crew-config-isolation.spec.ts): give the server process a REAL ambient
// Claude config to leak, so the crew-run env strip is proven against something
// rather than asserted against an absence that was always absent. The directory
// is POPULATED (credential + the contamination entries), not just created: crew
// provisioning copies the credential out of it, so an empty directory would make
// every crew run fail credentials-missing, and the contamination is what the
// "nothing else was copied" assertion needs in order to be falsifiable.
// Harmless to every other spec: the fake CLIs ignore all of it, extraction/
// Commander run through the same fakes, and no spec asserts on Anthropic key
// presence.
if (!WINDOWS_WITH_EMBEDDED_POSTGRES) {
  seedAmbientClaudeConfigHome();
}

// Commander viewer e2e (commander-viewer.spec.ts): resolve `claude` to the
// deterministic fake CLI. cli-mode.ts looks the binary up via `which`/`where`
// and spawns the literal name "claude", both using the server's PATH —
// prepending the fixture dir wins the lookup without touching real installs.
const FAKE_CLAUDE_BIN_DIR = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "fake-claude",
);

// Commander codex e2e (commander-codex-*.spec.ts): resolve `codex` to the
// deterministic fake CLI. Same mechanism as fake-claude — prepend dir wins
// `which codex` without touching any real codex install.
const FAKE_CODEX_BIN_DIR = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "fake-codex",
);

// Connector shelf e2e (connector-install.spec.ts): the curated shelf's only
// input is a remote `connectors.json` on a 6h TTL, so pin it to a local fixture
// (see `resolveConnectorCatalogService`). A FILE path, not a URL — the seam
// cannot be used to point a deployment's shelf at an arbitrary host.
const CONNECTOR_CATALOG_FIXTURE = path.join(
  fileURLToPath(new URL(".", import.meta.url)),
  "fixtures",
  "connectors.json",
);

export default defineConfig({
  testDir: ".",
  testMatch: WINDOWS_WITH_EMBEDDED_POSTGRES
    ? "**/windows-embedded-postgres-skip.spec.ts"
    : "**/*.spec.ts",
  // The standard job boots local_trusted mode. Authenticated Commander coverage
  // and real-provider lifecycle coverage have dedicated configs that bootstrap
  // their own database, auth mode, and provider campaign; including them here
  // makes this job fail before the intended setup can run.
  testIgnore: [
    "**/commander-cockpit-authenticated.spec.ts",
    "**/commander-lifecycle/**/*.live.spec.ts",
  ],
  timeout: 60_000,
  // Retry up to twice on CI to absorb transient React refetch/remount churn that
  // detaches elements mid-interaction (the dominant e2e flake class). Kept at
  // 0 locally so flakes surface during development. `trace: "on-first-retry"`
  // (below) captures a trace on the retry for root-causing. Damage control —
  // not a substitute for fixing the underlying churn (see
  // docs/aoa/plans/2026-07-01-e2e-flake-stabilization-plan.md).
  retries: process.env.CI ? 2 : 0,
  // Single worker: e2e specs share an embedded-postgres-backed instance
  // (one AOA_HOME per config run). Seed-and-cleanup helpers in helpers/
  // are not worker-safe; multiple workers race on /api/companies. Force
  // sequential execution until per-worker isolation lands.
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // The webServer directive bootstraps a throwaway AoA instance.
  // `onboard --yes --run` works in a non-interactive temp AOA_HOME.
  // On Windows without DATABASE_URL: skip the WebServer entirely so
  // embedded-postgres never tries to start (it would fail because the runner
  // is `runneradmin`).
  webServer: WINDOWS_WITH_EMBEDDED_POSTGRES
    ? undefined
    : {
        command: `corepack pnpm@9.15.4 aoa onboard --yes --run`,
        url: `${BASE_URL}/api/health`,
        // Always boot a dedicated throwaway instance for e2e so browser tests
        // never attach to the developer's active AoA home/server.
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PORT: String(PORT),
          AOA_HOME,
          CODEX_HOME,
          AOA_INSTANCE_ID: "playwright-e2e",
          AOA_BIND: "loopback",
          AOA_DEPLOYMENT_MODE: "local_trusted",
          AOA_DEPLOYMENT_EXPOSURE: "private",
          // Post auth-redesign, local_trusted no longer grants the synthetic
          // loopback board admin by default — it is gated behind this dev escape
          // hatch (server/src/middleware/auth.ts, config.ts). Without it EVERY
          // board-authenticated e2e request resolves actor {type:"none"} → 401,
          // so the whole suite would fail to authenticate. (HANDOFF §6.5.)
          AOA_DEV_LOCAL_IDENTITY: "1",
          COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
          AOA_E2E_DB_PORT: String(E2E_DB_PORT),
          AOA_EMBEDDED_POSTGRES_PORT: String(E2E_DB_PORT),
          AOA_EMBEDDED_POSTGRES_STRICT_PORT: "1",
          AOA_VITE_HMR_PORT: String(PORT + 10_000),
          AOA_E2E_FAKE_AWS_SECRETS_MANAGER: "1",
          AOA_E2E_FAKE_CREW_LLM: "1",
          AOA_E2E_FAKE_CREW_CONTROL: FAKE_CREW_CONTROL_PATH,
          AOA_THREAD_EVENT_DEBOUNCE_MS: "250",
          // Pin e2e marketplace data to the copied bundled fixture. The
          // service falls back to bundled data when the CDN cannot be reached.
          AOA_MARKETPLACE_CDN_URL: "http://127.0.0.1:1/catalog.json",
          // Connector shelf: pin `connectors.json` to a local fixture instead of
          // the CDN. Without this the shelf is empty in CI (correct degradation,
          // but nothing to browse) and — because `POST …/install` resolves
          // `entryId` against the SERVER's catalog — there is no install to make.
          AOA_E2E_CONNECTOR_CATALOG_PATH: CONNECTOR_CATALOG_FIXTURE,
          // Commander viewer e2e: `claude` resolves to the deterministic
          // fake CLI (tests/e2e/fixtures/fake-claude). The control file is
          // rewritten by the spec before each send to script the next turn.
          // Commander codex e2e: `codex` resolves to the deterministic fake
          // CLI (tests/e2e/fixtures/fake-codex). workers:1 + reuseExistingServer:
          // false means the single global control/invocations files are race-free.
          PATH: `${FAKE_CLAUDE_BIN_DIR}${path.delimiter}${FAKE_CODEX_BIN_DIR}${path.delimiter}${process.env.PATH ?? ""}`,
          AOA_E2E_FAKE_CLAUDE_CONTROL: FAKE_CLAUDE_CONTROL_PATH,
          AOA_E2E_FAKE_CLAUDE_INVOCATIONS: FAKE_CLAUDE_INVOCATIONS_PATH,
          AOA_E2E_FAKE_CODEX_CONTROL: FAKE_CODEX_CONTROL_PATH,
          AOA_E2E_FAKE_CODEX_INVOCATIONS: FAKE_CODEX_INVOCATIONS_PATH,
          // Fake embedder seam (T15): makes all embedding flows deterministic
          // in CI/e2e without a real OpenAI key. The fake embedder returns a
          // fixed 1536-dim vector; forced-error scenarios are controlled via
          // FAKE_EMBEDDER_CONTROL_PATH (write JSON before the triggering action).
          AOA_E2E_FAKE_EMBEDDER: "1",
          AOA_E2E_FAKE_EMBEDDER_CONTROL: FAKE_EMBEDDER_CONTROL_PATH,
          // Embeddings: NO instance-level OPENAI_API_KEY. The fake embedder
          // (AOA_E2E_FAKE_EMBEDDER=1) supplies vectors without a real key, and
          // tests that need semantic availability add a PER-COMPANY key via
          // POST /secrets. We force this EMPTY (not just omit it) so the no-key
          // path is deterministic even if the dev shell exports a real
          // OPENAI_API_KEY — otherwise resolveSemanticAvailable's env fallback
          // would report semantic "available" for keyless companies and the
          // no-llm-key-banner tests would fail under pgvector.
          OPENAI_API_KEY: "",
          // D9 ambient-leak poison — see AMBIENT_CLAUDE_CONFIG_POISON. Listed
          // LAST so it wins over anything the dev shell exported.
          ...AMBIENT_CLAUDE_CONFIG_POISON,
        },
      },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
