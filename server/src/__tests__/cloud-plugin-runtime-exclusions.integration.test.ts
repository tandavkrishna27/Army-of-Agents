/**
 * FND-008 (Decision #103 CP-003/CP-004) — cloud plugin HTTP route-matrix denial,
 * Linux-CI-authoritative portion.
 *
 * These cases import `pluginRoutes`/`companyPluginRoutes`/`pluginCompanySettingsRoutes`,
 * whose graph pulls `plugin-lifecycle.js`/`plugin-loader.js` and tips vitest into
 * the drizzle-orm `require(esm)` cycle on Windows (finding E0-F005) — so this file
 * fails COLLECTION on Windows exactly like `plugin-tenant-routes.test.ts`, and its
 * verdict binds on Linux CI. The unit-local dispatcher/envelope/sink cases run on
 * every platform in the sibling `cloud-plugin-runtime-exclusions.test.ts`.
 *
 * The RED cases here are the two routes FND-008 newly gates — DELETE `/plugins/:id`
 * (uninstall) and POST `/plugins/:id/disable` — which returned 400 (lifecycle
 * threw → generic catch) on the FND-007 baseline and now return the canonical 503
 * BEFORE any lifecycle effect. The remaining worker-backed routes are passing
 * characterization of the FND-006 gates now reachable because FND-008 MOUNTS
 * these routers in `cloud_auth` (app.ts) instead of leaving them unmounted (404).
 */
import express from "express";
import supertest from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  listInstalledForCompanies: vi.fn(),
  listByStatusForCompanies: vi.fn(),
  getById: vi.fn(),
  getByKeyScoped: vi.fn(),
  getConfig: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  unload: vi.fn(),
  upgrade: vi.fn(),
  blockActivationInCloud: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => registry,
}));
vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => lifecycle,
}));

import { errorHandler } from "../middleware/index.js";
import { companyPluginRoutes } from "../routes/company-plugins.js";
import {
  pluginRoutes,
  pluginCompanySettingsRoutes,
  buildCloudPluginDenialLoader,
  buildCloudPluginDenialLifecycle,
} from "../routes/plugins.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  CloudPluginExecutionBlockedError,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
} from "../services/cloud-plugin-execution.js";

const COMPANY_A = "company-a";
const PLUGIN_A = "11111111-1111-4111-8111-111111111111";

const blockedEnvelope = {
  error: CLOUD_PLUGIN_BLOCK_MESSAGE,
  code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
  docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
};

function plugin(id: string, companyId: string) {
  return {
    id,
    companyId,
    pluginKey: "acme.shared",
    packageName: "@acme/shared",
    packagePath: `/plugins/${companyId}`,
    version: "1.0.0",
    status: "ready",
    statusReasonCode: null,
    manifestJson: { id: "acme.shared", displayName: "Shared", slots: [] },
    lastError: null,
    installedAt: new Date("2026-08-02T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
}

function operator(companyIds: string[] = [COMPANY_A]) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    isInstanceAdmin: false,
    operator: true,
    companyIds,
  };
}

/**
 * Self-hosted loopback identity: `assertCompanyAccess` admits it early in every
 * deployment mode, so the company-scoped routers reach their cloud 503 gate
 * rather than tripping the cloud_auth tenant-membership check first. Mirrors the
 * company-route actor in `plugin-tenant-routes.test.ts`.
 */
function localAdmin(companyIds: string[] = [COMPANY_A]) {
  return {
    type: "board",
    source: "local_implicit",
    userId: "local",
    isInstanceAdmin: true,
    companyIds,
  };
}

/**
 * Mount the three plugin routers the way `app.ts` mounts them in `cloud_auth`
 * (FND-008): the effectful runtime deps ABSENT and the inert cloud-denial
 * loader/lifecycle facades. The mocked lifecycle above stands in for the facade
 * where a route calls a specific method; `blockActivationInCloud` rejects with
 * the typed error to mirror the real facade + the real lifecycle's cloud path.
 */
function makeApp(db: unknown, actor: object = operator()) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    })
  );
  app.use((req, _res, next) => {
    (req as unknown as { actor: object }).actor = actor;
    next();
  });
  // Mirror app.ts cloud-branch mount order (FND-008).
  app.use(
    pluginRoutes(
      db as never,
      buildCloudPluginDenialLoader(),
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle as never
    )
  );
  app.use(pluginCompanySettingsRoutes(db as never, lifecycle as never));
  app.use(
    "/companies/:companyId/plugins",
    companyPluginRoutes(
      db as never,
      lifecycle as never,
      buildCloudPluginDenialLoader()
    )
  );
  app.use(errorHandler);
  return supertest(app);
}

/** Chainable select stub returning `rows` at any chain depth. */
function selectDb(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.orderBy = () => Promise.resolve(rows);
  chain.limit = () => Promise.resolve(rows);
  chain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return {
    select: () => chain,
    insert: () => ({ values: () => ({ returning: () => Promise.resolve(rows) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown;
}

beforeEach(() => {
  setDeploymentMode("local_trusted");
  for (const m of Object.values(registry)) m.mockReset();
  for (const m of Object.values(lifecycle)) m.mockReset();
  registry.getById.mockResolvedValue(null);
  registry.getByKeyScoped.mockResolvedValue(null);
  registry.getConfig.mockResolvedValue(null);
  registry.listInstalledForCompanies.mockResolvedValue([]);
  registry.listByStatusForCompanies.mockResolvedValue([]);
  lifecycle.blockActivationInCloud.mockRejectedValue(
    new CloudPluginExecutionBlockedError()
  );
});

afterEach(() => setDeploymentMode("local_trusted"));

describe("FND-008 — instance plugin routes deny with 503 in cloud_auth", () => {
  it("RED→GREEN: uninstall (DELETE) 503s at the new entry gate before any lifecycle effect", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    const res = await makeApp(selectDb([])).delete(`/plugins/${PLUGIN_A}`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual(blockedEnvelope);
    expect(lifecycle.unload).not.toHaveBeenCalled();
  });

  it("RED→GREEN: disable (POST) 503s at the new entry gate before any lifecycle effect", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    const res = await makeApp(selectDb([]))
      .post(`/plugins/${PLUGIN_A}/disable`)
      .send({ reason: "x" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual(blockedEnvelope);
    expect(lifecycle.disable).not.toHaveBeenCalled();
  });

  it("characterization: install / enable / upgrade / tools / bridge / stream / jobs / webhooks / config-test / ui-contributions all 503", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      status: "disabled",
    });
    const cases: Array<{ method: "get" | "post"; path: string }> = [
      { method: "post", path: "/plugins/install" },
      { method: "post", path: `/plugins/${PLUGIN_A}/enable` },
      { method: "post", path: `/plugins/${PLUGIN_A}/upgrade` },
      { method: "post", path: "/plugins/tools/execute" },
      { method: "post", path: `/plugins/${PLUGIN_A}/bridge/data` },
      { method: "post", path: `/plugins/${PLUGIN_A}/bridge/action` },
      { method: "post", path: `/plugins/${PLUGIN_A}/data/read` },
      { method: "post", path: `/plugins/${PLUGIN_A}/actions/write` },
      { method: "post", path: `/plugins/${PLUGIN_A}/config/test` },
      { method: "post", path: `/plugins/${PLUGIN_A}/jobs/j1/trigger` },
      { method: "post", path: `/plugins/${PLUGIN_A}/webhooks/push` },
      {
        method: "get",
        path: `/plugins/ui-contributions?companyId=${COMPANY_A}`,
      },
      {
        method: "get",
        path: `/plugins/${PLUGIN_A}/bridge/stream/ev?companyId=${COMPANY_A}`,
      },
    ];
    for (const c of cases) {
      const req = makeApp(selectDb([]));
      const res =
        c.method === "get"
          ? await req.get(c.path)
          : await req.post(c.path).send({ packageName: "@acme/shared" });
      expect(res.status, c.path).toBe(503);
      expect(res.body, c.path).toEqual(blockedEnvelope);
    }
  });

  it("metadata-only reads still succeed and project the blocked state (persisted data, no manifest eval)", async () => {
    setDeploymentMode("cloud_auth");
    registry.listInstalledForCompanies.mockResolvedValue([
      plugin(PLUGIN_A, COMPANY_A),
    ]);
    const list = await makeApp(selectDb([])).get("/plugins");
    expect(list.status).toBe(200);
    expect(list.body[0]).toMatchObject({
      id: PLUGIN_A,
      status: "error",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
      lastError: CLOUD_PLUGIN_BLOCK_MESSAGE,
    });

    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    const detail = await makeApp(selectDb([])).get(`/plugins/${PLUGIN_A}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: "error",
      statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
    });
  });

  it("self-hosted positive: off-cloud, uninstall + disable reach the lifecycle (no 503 gate)", async () => {
    setDeploymentMode("local_trusted");
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    lifecycle.unload.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    lifecycle.disable.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      status: "disabled",
    });

    const del = await makeApp(selectDb([])).delete(`/plugins/${PLUGIN_A}`);
    expect(del.status).not.toBe(503);
    expect(lifecycle.unload).toHaveBeenCalledWith(PLUGIN_A, false);

    const dis = await makeApp(selectDb([]))
      .post(`/plugins/${PLUGIN_A}/disable`)
      .send({});
    expect(dis.status).not.toBe(503);
    expect(lifecycle.disable).toHaveBeenCalled();
  });
});

describe("FND-008 — company + legacy-settings plugin routes deny with 503 in cloud_auth", () => {
  it("company upgrade / approve / rollback / settings-enable + legacy PUT enable all 503", async () => {
    setDeploymentMode("cloud_auth");
    const readyRow = { ...plugin(PLUGIN_A, COMPANY_A) };
    const actor = localAdmin();
    const db = () => selectDb([readyRow]);

    const upgrade = await makeApp(db(), actor)
      .post(`/companies/${COMPANY_A}/plugins/${PLUGIN_A}/upgrade`)
      .send({});
    expect(upgrade.status).toBe(503);
    expect(upgrade.body).toEqual(blockedEnvelope);

    const approve = await makeApp(db(), actor).post(
      `/companies/${COMPANY_A}/plugins/${PLUGIN_A}/upgrade/approve`
    );
    expect(approve.status).toBe(503);

    const rollback = await makeApp(db(), actor).post(
      `/companies/${COMPANY_A}/plugins/${PLUGIN_A}/upgrade/rollback`
    );
    expect(rollback.status).toBe(503);
    expect(rollback.body).toEqual(blockedEnvelope);

    const settings = await makeApp(db(), actor)
      .patch(`/companies/${COMPANY_A}/plugins/${PLUGIN_A}/settings`)
      .send({ enabled: true });
    expect(settings.status).toBe(503);

    const legacyPut = await makeApp(db(), actor)
      .put(`/companies/${COMPANY_A}/plugin-settings/${PLUGIN_A}`)
      .send({ enabled: true });
    expect(legacyPut.status).toBe(503);
  });
});

describe("FND-008 — inert cloud-denial facades", () => {
  it("every loader + lifecycle method throws CloudPluginExecutionBlockedError", async () => {
    const loader = buildCloudPluginDenialLoader() as unknown as {
      installPlugin: (o: unknown) => Promise<unknown>;
      upgradePlugin: (id: string, o: unknown) => Promise<unknown>;
    };
    const lc = buildCloudPluginDenialLifecycle();
    await expect(loader.installPlugin({})).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );
    await expect(loader.upgradePlugin("p", {})).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );
    await expect(lc.blockActivationInCloud("p", "direct")).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );
    await expect(lc.load("p")).rejects.toBeInstanceOf(
      CloudPluginExecutionBlockedError
    );
  });
});
