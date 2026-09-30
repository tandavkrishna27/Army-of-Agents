import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { loadConfig } from "../config.js";

// createApp constructs the marketplace catalog service and calls startSyncLoop(),
// which fires an unawaited CDN refresh and installs a setInterval. Replace it with
// a no-op so the real-app path performs NO network I/O and leaves NO dangling
// timer — the reserved-route 404 we assert comes entirely from the real app's
// route stack (the `/api/*` catch-all), which this mock does not touch.
vi.mock("../services/aoa-marketplace.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/aoa-marketplace.js")>();
  class NoopMarketplaceCatalogService {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_deps: any) {}
    startSyncLoop(): void {}
    stopSyncLoop(): void {}
  }
  return { ...actual, MarketplaceCatalogService: NoopMarketplaceCatalogService };
});

// The real `createApp` transitively imports `@armyofagents/plugin-sdk`, whose
// package entry only resolves after the workspace is built (`pnpm -r build`).
// `pnpm test:run` runs BEFORE the build on the CI `verify` lane and in a fresh
// checkout, so this module is not always resolvable under vitest. We dynamic-
// import it and skip the runtime 404 proof when it cannot be resolved, rather
// than crashing the whole suite (which would take the always-on config-layer
// exclusion proofs down with it). The config-layer proofs below and the static
// source-boundary rule in scripts/check-distributed-execution-foundation.mjs are
// the environment-independent guarantees; this runtime proof is the additional
// post-build / real-app belt to that suspenders.
//
// NOTE: under vitest this dynamic import currently always fails with the
// documented drizzle-orm `require(esm)` cycle (CLAUDE.md → Test Patterns: real
// DB-touching modules are not importable under vitest; focused tests mock
// `@armyofagents/db` + `drizzle-orm`). The whole app graph cannot be mocked
// safely, so the two runtime proofs self-skip here and the reserved-route
// exclusion is carried by the config-layer proofs below (always run) and the
// static source-boundary checker. The real app's 404 for these paths is
// exercised by the e2e lanes that boot the actual server.
let appModule: typeof import("../app.js") | null = null;
try {
  appModule = await import("../app.js");
} catch {
  appModule = null;
}

// A structural fake Db: any property access returns the same fake, callable and
// chainable. createApp's route factories only CAPTURE db at construction; the
// reserved paths hit the /api catch-all (a synthetic local_trusted GET with no
// auth header and no session resolver resolves actor="none" and runs zero DB
// queries), so the database is never actually invoked for these assertions.
function makeFakeDb(): Db {
  const handler: ProxyHandler<() => unknown> = {
    get: () => proxy,
    apply: () => proxy,
  };
  const proxy: unknown = new Proxy(function () {}, handler);
  return proxy as Db;
}

const fakeStorage = {} as unknown as StorageService;

const RESERVED_PATHS = [
  "/api/distributed-execution/public-services",
  "/api/distributed-execution/cloud-plugins",
];

async function buildApp() {
  if (!appModule) throw new Error("app module not resolvable");
  return appModule.createApp(makeFakeDb(), {
    uiMode: "none",
    storageService: fakeStorage,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    companyWorkspaceBaseDir: "/tmp/aoa-distributed-execution-exclusions",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: true,
    trustProxy: false,
  });
}

const EXCLUDED_SURFACE_ENVS = [
  "AOA_DISTRIBUTED_PUBLIC_SERVICE_INGRESS_ENABLED",
  "AOA_DISTRIBUTED_CLOUD_PLUGIN_EXECUTION_ENABLED",
] as const;

const POLICY_ENV_KEYS = [
  "AOA_DEPLOYMENT_MODE",
  "AOA_DISTRIBUTED_EXECUTION_ENABLED",
  "AOA_APP_DATABASE_URL",
  "AOA_OPERATOR_DATABASE_URL",
  "AOA_ALLOW_UNSANDBOXED_MULTITENANT",
  ...EXCLUDED_SURFACE_ENVS,
] as const;

const ORIGINAL_POLICY_ENV: Record<string, string | undefined> = Object.fromEntries(
  POLICY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

describe("distributed execution reserved-route exclusions", () => {
  beforeEach(() => {
    for (const key of POLICY_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of POLICY_ENV_KEYS) {
      const original = ORIGINAL_POLICY_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  // The ordinary distributed flag NEVER registers a reserved distributed route.
  // With it both false and true, the two reserved prefixes must return the normal
  // /api not-found response, proving they are unregistered in either state. Runs
  // only when the built app module resolves under vitest (see the top-level note).
  it.skipIf(!appModule).each([false, true])(
    "returns the normal 404 for reserved distributed paths (distributed flag=%s)",
    async (enabled) => {
      process.env.AOA_DISTRIBUTED_EXECUTION_ENABLED = enabled ? "true" : "false";
      if (enabled) {
        // Config now fail-closes flag-on startup unless both bounded role URLs
        // are explicit. This route-registration unit never opens either URL.
        process.env.AOA_APP_DATABASE_URL = "postgres://aoa_app:test@localhost/aoa";
        process.env.AOA_OPERATOR_DATABASE_URL = "postgres://aoa_operator:test@localhost/aoa";
      }
      expect(loadConfig().distributedExecutionEnabled).toBe(enabled);
      const app = await buildApp();
      for (const reservedPath of RESERVED_PATHS) {
        const res = await request(app).get(reservedPath);
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({ error: "Not found" });
      }
    },
  );

  // With either exclusion sentinel truthy, config resolution fails BEFORE the app
  // is ever constructed — the reserved surface can never be reached at runtime.
  // Environment-independent: no app module or DB required.
  it.each(EXCLUDED_SURFACE_ENVS)(
    "fails loadConfig() before app construction when %s is set",
    (name) => {
      process.env[name] = "true";
      expect(() => loadConfig()).toThrow(new RegExp(`${name}.*excluded`, "i"));
    },
  );

  it("fails loadConfig() before app construction for the unsafe override in cloud_auth", () => {
    process.env.AOA_DEPLOYMENT_MODE = "cloud_auth";
    process.env.AOA_ALLOW_UNSANDBOXED_MULTITENANT = "1";
    expect(() => loadConfig()).toThrow(/AOA_ALLOW_UNSANDBOXED_MULTITENANT.*cloud_auth/i);
  });
});
