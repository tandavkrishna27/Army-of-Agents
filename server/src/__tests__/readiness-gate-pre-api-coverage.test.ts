/**
 * DEP-003 (E6 deployment harness) — FIX 1 regression proof: the readiness gate must
 * cover ALL `/api` routes, not just the ones inside the main `api` Router.
 *
 * ~13 DB-backed routers mount DIRECTLY on `app` at `/api` (app.ts pre-api block:
 * authProfile, onboarding, provider-credentials, provider-connections, …) BEFORE the
 * main `api` Router mounts. When the readiness gate lived INSIDE the `api` Router,
 * Express served those pre-api routers first and they bypassed the gate entirely —
 * including the tenant-scoped GET /api/companies/:id/provider-credentials.
 *
 * This exercises the REAL `createApp` mount topology (not a reconstruction). It proves
 * a representative PRE-API DB route 503s while not-ready, mirroring the existing
 * /api/companies gate proof, while liveness + readiness still answer.
 *
 * Self-skips if the built app module can't resolve under vitest (the drizzle-orm
 * require(esm) cycle in a pre-build checkout) — same guard used by
 * distributed-execution-exclusions.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import type { ReadinessSnapshot } from "../routes/readiness.js";

// createApp constructs the marketplace catalog service and calls startSyncLoop(),
// which fires an unawaited CDN refresh and installs a setInterval. Replace it with a
// no-op so this test performs NO network I/O and leaves NO dangling timer.
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

let appModule: typeof import("../app.js") | null = null;
try {
  appModule = await import("../app.js");
} catch {
  appModule = null;
}

// Structural fake Db: any property access returns the same callable/chainable proxy.
// createApp's route factories only CAPTURE db at construction; the paths asserted here
// resolve actor="none" (local_trusted, no session resolver) and 401 BEFORE any query,
// or are short-circuited by the readiness gate, so the database is never invoked.
function makeFakeDb(): Db {
  const handler: ProxyHandler<() => unknown> = {
    get: () => proxy,
    apply: () => proxy,
  };
  const proxy: unknown = new Proxy(function () {}, handler);
  return proxy as Db;
}

const fakeStorage = {} as unknown as StorageService;

const NOT_READY: ReadinessSnapshot = {
  live: true,
  ready: false,
  schemaCompatible: false,
  dependencies: { postgres: "ok", minio: "not_checked" },
};
const READY: ReadinessSnapshot = {
  live: true,
  ready: true,
  schemaCompatible: true,
  dependencies: { postgres: "ok", minio: "not_checked" },
};

// A representative PRE-API DB route: providerCredentialRoutes is mounted directly on
// `app` at /api (app.ts pre-api block), BEFORE the main `api` Router — the FIX target.
const PRE_API_ROUTE =
  "/api/companies/00000000-0000-0000-0000-000000000000/provider-credentials";
// A route INSIDE the `api` Router — covered before AND after the fix (regression guard).
const API_ROUTER_ROUTE = "/api/companies";

async function buildApp(readiness?: {
  probe: () => Promise<ReadinessSnapshot>;
  gateEnabled: boolean;
}) {
  if (!appModule) throw new Error("app module not resolvable");
  return appModule.createApp(makeFakeDb(), {
    uiMode: "none",
    storageService: fakeStorage,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    companyWorkspaceBaseDir: "/tmp/aoa-readiness-gate-pre-api",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: true,
    companyDeletionEnabled: true,
    trustProxy: false,
    readiness,
  });
}

describe.skipIf(!appModule)(
  "DEP-003 readiness gate covers PRE-API /api routes (FIX 1)",
  () => {
    it("503s a PRE-API DB route while not-ready, not just api-Router routes", async () => {
      const app = await buildApp({ probe: async () => NOT_READY, gateEnabled: true });
      // The pre-api router (mounted before the `api` Router) MUST be gated.
      expect((await request(app).get(PRE_API_ROUTE)).status).toBe(503);
      // The already-covered api-Router route stays gated (regression guard).
      expect((await request(app).get(API_ROUTER_ROUTE)).status).toBe(503);
      // Liveness always answers; readiness always answers (503 body, never a crash).
      expect((await request(app).get("/api/health/live")).status).toBe(200);
      const ready = await request(app).get("/api/ready");
      expect(ready.status).toBe(503);
      expect(ready.body).toMatchObject({ ready: false, live: true });
    });

    it("does NOT gate when the probe reports ready (gate enabled)", async () => {
      const app = await buildApp({ probe: async () => READY, gateEnabled: true });
      // Pre-api route reaches its own handler (401 unauth) rather than a 503 gate.
      expect((await request(app).get(PRE_API_ROUTE)).status).not.toBe(503);
      expect((await request(app).get("/api/ready")).status).toBe(200);
    });

    it("stays fully dormant with no readiness option (flag-off startup unchanged)", async () => {
      const app = await buildApp(undefined);
      // No gate: the pre-api route reaches its handler; /api/ready always-answers 200.
      expect((await request(app).get(PRE_API_ROUTE)).status).not.toBe(503);
      expect((await request(app).get("/api/ready")).status).toBe(200);
    });
  },
);
