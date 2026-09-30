import express from "express";
import supertest from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
  listInstalledForCompanies: vi.fn(),
  listByStatusForCompanies: vi.fn(),
  getById: vi.fn(),
  getByKey: vi.fn(),
  getByKeyScoped: vi.fn(),
  getConfig: vi.fn(),
}));
const lifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
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
import {
  companyPluginRoutes,
} from "../routes/company-plugins.js";
import {
  pluginCompanySettingsRoutes,
  pluginRoutes,
} from "../routes/plugins.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  CloudPluginExecutionBlockedError,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
} from "../services/cloud-plugin-execution.js";

const COMPANY_A = "company-a";
const COMPANY_B = "company-b";
const PLUGIN_A = "11111111-1111-4111-8111-111111111111";
const PLUGIN_B = "22222222-2222-4222-8222-222222222222";

function plugin(id: string, companyId: string, pluginKey = "acme.shared") {
  return {
    id,
    companyId,
    pluginKey,
    packageName: `@acme/${companyId}`,
    packagePath: `/plugins/${companyId}`,
    version: "1.0.0",
    status: "ready",
    manifestJson: { id: pluginKey, displayName: pluginKey, slots: [] },
    lastError: null,
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  };
}

function makeActor(companyIds: string[] = [COMPANY_A], operator = false) {
  return {
    type: "board",
    source: "session",
    userId: "user-a",
    isInstanceAdmin: false,
    operator,
    companyIds,
  };
}

function makeApp(
  actor: object = makeActor(),
  options: {
    bridgeDeps?: any;
    jobDeps?: any;
    toolDeps?: any;
    webhookDeps?: any;
    db?: any;
    loader?: any;
    sourceIp?: string;
  } = {}
) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody =
          Buffer.from(buffer);
      },
    })
  );
  app.use((req, _res, next) => {
    if (options.sourceIp) {
      Object.defineProperty(req, "ip", {
        value: options.sourceIp,
        configurable: true,
      });
    }
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      options.db ?? ({} as any),
      options.loader ?? ({} as any),
      options.jobDeps,
      options.webhookDeps,
      options.toolDeps,
      options.bridgeDeps
    )
  );
  app.use(errorHandler);
  return supertest(app);
}

beforeEach(() => {
  setDeploymentMode("local_trusted");
  for (const mock of Object.values(registry)) mock.mockReset();
  for (const mock of Object.values(lifecycle)) mock.mockReset();
  registry.listInstalledForCompanies.mockResolvedValue([]);
  registry.listByStatusForCompanies.mockResolvedValue([]);
  registry.getById.mockResolvedValue(null);
  registry.getByKey.mockResolvedValue(null);
  registry.getByKeyScoped.mockResolvedValue(null);
  registry.getConfig.mockResolvedValue(null);
});

afterEach(() => {
  setDeploymentMode("local_trusted");
});

describe("tenant-scoped plugin collections", () => {
  it("scopes the installed list to the board actor's companies", async () => {
    registry.listInstalledForCompanies.mockResolvedValue([
      plugin(PLUGIN_A, COMPANY_A),
    ]);

    const response = await makeApp(makeActor([COMPANY_A], true)).get(
      "/api/plugins"
    );

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(registry.listInstalledForCompanies).toHaveBeenCalledWith([
      COMPANY_A,
    ]);
  });

  it("U10: no longer projects non-ready plugin rows as blocked in cloud list responses", async () => {
    setDeploymentMode("cloud_auth");
    registry.listInstalledForCompanies.mockResolvedValue([
      {
        ...plugin(PLUGIN_A, COMPANY_A),
        status: "disabled",
        statusReasonCode: null,
        lastError: null,
      },
    ]);

    const response = await makeApp(makeActor([COMPANY_A], true)).get(
      "/api/plugins"
    );

    // isCloudPluginExecutionBlocked() is always false now (host-resident
    // worker model) — the live block-projection is a no-op, so the row's
    // real status/reason/error pass through untouched instead of being
    // rewritten to "error"/blocked.
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      id: PLUGIN_A,
      status: "disabled",
      statusReasonCode: null,
      lastError: null,
    });
  });

  it("U10: no longer projects ready rows as blocked across detail, health, and dashboard reads", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));

    const detail = await makeApp(makeActor([COMPANY_A], true))
      .get(`/api/plugins/${PLUGIN_A}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      status: "ready",
      lastError: null,
    });
    expect(detail.body.statusReasonCode).not.toBe(PLUGIN_WORKER_BLOCKED_IN_CLOUD);

    const health = await makeApp(makeActor([COMPANY_A], true))
      .get(`/api/plugins/${PLUGIN_A}/health`)
      .expect(200);
    // Health may still be unhealthy for unrelated reasons in this minimal
    // fixture (e.g. no worker process running) — the invariant U10 cares
    // about is that the cloud-block message/reason is gone.
    expect(health.body.lastError).not.toBe(CLOUD_PLUGIN_BLOCK_MESSAGE);

    const dashboard = await makeApp(makeActor([COMPANY_A], true))
      .get(`/api/plugins/${PLUGIN_A}/dashboard`)
      .expect(200);
    expect(dashboard.body.health.lastError).not.toBe(CLOUD_PLUGIN_BLOCK_MESSAGE);
  });

  it("scopes status-filtered lists and short-circuits an actor with no companies", async () => {
    await makeApp(makeActor([], true))
      .get("/api/plugins?status=ready")
      .expect(200, []);

    expect(registry.listByStatusForCompanies).toHaveBeenCalledWith("ready", []);
  });

  it("rejects a non-operator before listing global plugin records", async () => {
    await makeApp().get("/api/plugins").expect(403);
    expect(registry.listInstalledForCompanies).not.toHaveBeenCalled();
  });

  it("preserves all-access list semantics for local_implicit", async () => {
    await makeApp({
      type: "board",
      source: "local_implicit",
      userId: "local",
      isInstanceAdmin: false,
      companyIds: [],
    })
      .get("/api/plugins")
      .expect(200, []);

    expect(registry.listInstalledForCompanies).toHaveBeenCalledWith(undefined);
  });

  it("requires and enforces an explicit company for UI contributions", async () => {
    await makeApp().get("/api/plugins/ui-contributions").expect(400);
    await makeApp()
      .get(`/api/plugins/ui-contributions?companyId=${COMPANY_A}`)
      .expect(200, []);

    expect(registry.listByStatusForCompanies).toHaveBeenCalledWith("ready", [
      COMPANY_A,
    ]);
  });

  it("does not publish UI contributions disabled for the company", async () => {
    registry.listByStatusForCompanies.mockResolvedValue([
      plugin(PLUGIN_A, COMPANY_A),
    ]);
    const chain: Record<string, any> = {
      from() {
        return chain;
      },
      where: vi.fn(async () => [{ pluginId: PLUGIN_A }]),
    };
    const db = { select: vi.fn(() => chain) };

    await makeApp(makeActor(), { db })
      .get(`/api/plugins/ui-contributions?companyId=${COMPANY_A}`)
      .expect(200, []);
  });
});

describe("legacy company plugin settings cloud projection", () => {
  it("U10: clears a historical cloud-blocked row's reason/error instead of re-affirming it", async () => {
    setDeploymentMode("cloud_auth");
    let selectIndex = 0;
    let installedPredicate: unknown;
    const db = {
      select: () => ({
        from: () => ({
          where: async (predicate: unknown) => {
            selectIndex += 1;
            if (selectIndex !== 1) return [];
            installedPredicate = predicate;
            return [{
              ...plugin(PLUGIN_A, COMPANY_A),
              status: "error",
              statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
              lastError: CLOUD_PLUGIN_BLOCK_MESSAGE,
            }];
          },
        }),
      }),
    } as any;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "local_implicit",
        userId: "local",
        isInstanceAdmin: true,
        companyIds: [COMPANY_A],
      } as never;
      next();
    });
    app.use("/api", pluginCompanySettingsRoutes(db, lifecycle as never));
    app.use(errorHandler);

    const response = await supertest(app)
      .get(`/api/companies/${COMPANY_A}/plugin-settings`)
      .expect(200);
    // isCloudPluginExecutionBlocked() is always false now, so this historical
    // row (persisted from before the host-resident-worker model shipped) is
    // recoverable: the projection clears the stale reason/error in the read
    // response instead of re-affirming the live block. `status` is left as
    // the persisted "error" — only a successful lifecycle write clears it.
    expect(response.body[0]).toMatchObject({
      pluginId: PLUGIN_A,
      status: "error",
      statusReasonCode: null,
      lastError: null,
    });

    const query = new PgDialect().sqlToQuery(installedPredicate as never);
    expect(query.sql).toBe(
      '("plugins"."company_id" = $1 and ("plugins"."status" in ($2, $3) or ' +
        '("plugins"."status" = $4 and "plugins"."status_reason_code" = $5)))'
    );
    expect(query.params).toEqual([
      COMPANY_A,
      "ready",
      "disabled",
      "error",
      PLUGIN_WORKER_BLOCKED_IN_CLOUD,
    ]);
  });
});

describe("primary company plugin list", () => {
  it("excludes soft-uninstalled rows at the database boundary", async () => {
    let selectIndex = 0;
    let installedPredicate: unknown;
    const db = {
      select: () => {
        const current = selectIndex++;
        return {
          from: () => ({
            where: (predicate: unknown) => {
              if (current === 0) {
                installedPredicate = predicate;
                return { orderBy: async () => [plugin(PLUGIN_A, COMPANY_A)] };
              }
              return Promise.resolve([]);
            },
          }),
        };
      },
    } as any;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "local_implicit",
        userId: "local",
        isInstanceAdmin: true,
        companyIds: [COMPANY_A],
      } as never;
      next();
    });
    app.use(
      "/api/companies/:companyId/plugins",
      companyPluginRoutes(db, lifecycle as never, {} as never)
    );
    app.use(errorHandler);

    await supertest(app)
      .get(`/api/companies/${COMPANY_A}/plugins`)
      .expect(200);

    const query = new PgDialect().sqlToQuery(installedPredicate as never);
    expect(query.sql).toBe(
      '("plugins"."company_id" = $1 and "plugins"."status" <> $2)'
    );
    expect(query.params).toEqual([COMPANY_A, "uninstalled"]);
  });
});

describe("tenant-scoped plugin install target", () => {
  it("requires companyId for a multi-company actor", async () => {
    const installPlugin = vi.fn();
    await makeApp(makeActor([COMPANY_A, COMPANY_B], true), {
      loader: { installPlugin },
    })
      .post("/api/plugins/install")
      .send({ packageName: "@acme/shared" })
      .expect(400);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("passes an explicitly selected accessible company to the loader", async () => {
    const installPlugin = vi.fn(async () => ({
      manifest: { id: "acme.shared", displayName: "Shared", version: "1.0.0" },
    }));
    await makeApp(makeActor([COMPANY_A, COMPANY_B], true), {
      loader: { installPlugin },
    })
      .post("/api/plugins/install")
      .send({ packageName: "@acme/shared", companyId: COMPANY_B })
      .expect(500);
    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        packageName: "@acme/shared",
        companyId: COMPANY_B,
      })
    );
  });
});

describe("tenant-scoped bare plugin reads", () => {
  it("rejects a non-operator before resolving the global config route", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_B, COMPANY_B));

    await makeApp().get(`/api/plugins/${PLUGIN_B}/config`).expect(403);

    expect(registry.getById).not.toHaveBeenCalled();
    expect(registry.getConfig).not.toHaveBeenCalled();
  });

  it("returns 404 for a foreign plugin config even when the operator lacks company access", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_B, COMPANY_B));

    await makeApp(makeActor([COMPANY_A], true))
      .get(`/api/plugins/${PLUGIN_B}/config`)
      .expect(404);

    expect(registry.getConfig).not.toHaveBeenCalled();
  });

  it("returns an own-company config", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    registry.getConfig.mockResolvedValue({
      pluginId: PLUGIN_A,
      configJson: { secretRef: "own" },
    });

    const response = await makeApp(makeActor([COMPANY_A], true))
      .get(`/api/plugins/${PLUGIN_A}/config`)
      .expect(200);

    expect(response.body.configJson).toEqual({ secretRef: "own" });
    expect(registry.getConfig).toHaveBeenCalledWith(PLUGIN_A);
  });

  it("rejects a plugin key that is ambiguous across accessible companies", async () => {
    registry.getById.mockResolvedValue(null);
    registry.getByKeyScoped.mockImplementation(
      async (_key: string, companyId: string) =>
        companyId === COMPANY_A
          ? plugin(PLUGIN_A, COMPANY_A)
          : plugin(PLUGIN_B, COMPANY_B)
    );

    await makeApp(makeActor([COMPANY_A, COMPANY_B], true))
      .get("/api/plugins/acme.shared/config")
      .expect(409);

    expect(registry.getConfig).not.toHaveBeenCalled();
    expect(registry.getByKey).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous plugin key for local all-access actors", async () => {
    registry.getById.mockRejectedValue({ code: "22P02" });
    registry.listInstalledForCompanies.mockResolvedValue([
      plugin(PLUGIN_A, COMPANY_A),
      plugin(PLUGIN_B, COMPANY_B),
    ]);
    await makeApp({
      type: "board",
      source: "local_implicit",
      userId: "local",
      isInstanceAdmin: false,
      companyIds: [],
    })
      .get("/api/plugins/acme.shared/config")
      .expect(409);
    expect(registry.getConfig).not.toHaveBeenCalled();
  });

  const siblingReads = [
    `/api/plugins/${PLUGIN_B}`,
    `/api/plugins/${PLUGIN_B}/health`,
    `/api/plugins/${PLUGIN_B}/logs`,
    `/api/plugins/${PLUGIN_B}/config`,
    `/api/plugins/${PLUGIN_B}/jobs`,
    `/api/plugins/${PLUGIN_B}/jobs/job-1/runs`,
    `/api/plugins/${PLUGIN_B}/dashboard`,
    `/api/plugins/${PLUGIN_B}/version-history`,
  ];

  for (const path of siblingReads) {
    it(`does not expose a foreign plugin through ${path}`, async () => {
      registry.getById.mockResolvedValue(plugin(PLUGIN_B, COMPANY_B));
      const jobStore = {
        listJobs: vi.fn(),
        getJobByIdForPlugin: vi.fn(),
        listRunsByJob: vi.fn(),
      };

      await makeApp(makeActor([COMPANY_A], true), {
        jobDeps: { jobStore, scheduler: {} },
      })
        .get(path)
        .expect(404);

      expect(jobStore.listJobs).not.toHaveBeenCalled();
      expect(jobStore.getJobByIdForPlugin).not.toHaveBeenCalled();
      expect(registry.getConfig).not.toHaveBeenCalled();
    });
  }
});

describe("global plugin lifecycle overlay synchronization", () => {
  function overlayDb() {
    const values = vi.fn(async () => undefined);
    return {
      db: {
        select: () => ({
          from: () => ({ where: () => Promise.resolve([]) }),
        }),
        insert: () => ({ values }),
      } as any,
      values,
    };
  }

  it("persists enabled=true before a bare global enable", async () => {
    registry.getById.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      status: "disabled",
    });
    lifecycle.enable.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      status: "ready",
    });
    const { db, values } = overlayDb();

    await makeApp(makeActor([COMPANY_A], true), { db }).post(
      `/api/plugins/${PLUGIN_A}/enable`
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: PLUGIN_A,
        companyId: COMPANY_A,
        enabled: true,
      })
    );
    expect(lifecycle.enable).toHaveBeenCalledWith(PLUGIN_A);
  });

  it("persists enabled=false before a bare global disable", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    lifecycle.disable.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      status: "disabled",
    });
    const { db, values } = overlayDb();

    await makeApp(makeActor([COMPANY_A], true), { db })
      .post(`/api/plugins/${PLUGIN_A}/disable`)
      .send({ reason: "maintenance" });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: PLUGIN_A,
        companyId: COMPANY_A,
        enabled: false,
      })
    );
    expect(lifecycle.disable).toHaveBeenCalledWith(PLUGIN_A, "maintenance");
  });
});

describe("tenant-scoped plugin runtime calls", () => {
  const blockedEnvelope = {
    error: CLOUD_PLUGIN_BLOCK_MESSAGE,
    code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
    docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  };

  it("U10: no longer short-circuits any cloud worker-backed route at the (now-lifted) block gate", async () => {
    setDeploymentMode("cloud_auth");
    const operator = makeActor([COMPANY_A], true);
    const cases: Array<{
      method: "get" | "post";
      path: string;
      body?: Record<string, unknown>;
      actor?: object;
    }> = [
      {
        method: "post",
        path: "/api/plugins/tools/execute",
        body: {},
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/bridge/data`,
        body: {},
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/bridge/action`,
        body: {},
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/data/read`,
        body: {},
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/actions/write`,
        body: {},
      },
      {
        method: "get",
        path: `/api/plugins/ui-contributions?companyId=${COMPANY_A}`,
      },
      {
        method: "get",
        path: `/api/plugins/${PLUGIN_A}/bridge/stream/events?companyId=${COMPANY_A}`,
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/config/test`,
        body: {},
        actor: operator,
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/jobs/job-1/trigger`,
        body: {},
        actor: operator,
      },
      {
        method: "post",
        path: `/api/plugins/${PLUGIN_A}/webhooks/push`,
        body: {},
      },
    ];

    for (const testCase of cases) {
      const request = makeApp(testCase.actor ?? makeActor(), {
        sourceIp: "198.51.100.250",
      });
      const response =
        testCase.method === "get"
          ? await request.get(testCase.path)
          : await request.post(testCase.path).send(testCase.body ?? {});
      // isCloudPluginExecutionBlocked() is always false now (U10: the plugin
      // worker is host-resident, reached over the broker with run-JWT authz).
      // Every `rejectBlockedCloudExecution` call site is a no-op, so none of
      // these routes can ever surface the canonical blocked envelope anymore
      // — each request instead proceeds to its normal authz/business logic
      // (whatever that resolves to for this minimal fixture).
      expect(response.body, testCase.path).not.toEqual(blockedEnvelope);
    }
  });

  it("U10: no longer short-circuits install at the (now-lifted) cloud block gate", async () => {
    setDeploymentMode("cloud_auth");
    const installed = plugin(PLUGIN_A, COMPANY_A);
    registry.getByKeyScoped.mockResolvedValue(installed);
    const installPlugin = vi.fn(async () => ({
      manifest: {
        id: installed.pluginKey,
        displayName: "Shared",
        version: "1.0.0",
      },
    }));
    const response = await makeApp(makeActor([COMPANY_A], true), {
      loader: { installPlugin },
    })
      .post("/api/plugins/install")
      .send({ packageName: "@acme/shared", companyId: COMPANY_A });

    // The `rejectBlockedCloudExecution({ sink: "loader" })` gate immediately
    // after input validation is now inert — the request proceeds past it
    // into real company-resolution/authz logic instead of short-circuiting
    // at 503 with the blocked envelope.
    expect(response.status).not.toBe(503);
    expect(response.body).not.toEqual(blockedEnvelope);
  });

  it("persists the cloud reason before enable without mutating the company overlay", async () => {
    setDeploymentMode("cloud_auth");
    registry.getById.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      status: "disabled",
    });
    const values = vi.fn();
    lifecycle.blockActivationInCloud.mockRejectedValueOnce(
      new CloudPluginExecutionBlockedError()
    );
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: () => Promise.resolve([]) }),
      })),
      insert: vi.fn(() => ({ values })),
    };

    const response = await makeApp(makeActor([COMPANY_A], true), { db }).post(
      `/api/plugins/${PLUGIN_A}/enable`
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual(blockedEnvelope);
    expect(registry.getById).toHaveBeenCalledWith(PLUGIN_A);
    expect(lifecycle.blockActivationInCloud).toHaveBeenCalledWith(
      PLUGIN_A,
      "direct"
    );
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
    expect(lifecycle.enable).not.toHaveBeenCalled();
  });

  it("returns the canonical 503 before upgrade auto-rollback side effects", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_A, COMPANY_A));
    lifecycle.upgrade.mockRejectedValueOnce(
      new CloudPluginExecutionBlockedError()
    );
    const db = { select: vi.fn() };

    const response = await makeApp(makeActor([COMPANY_A], true), { db })
      .post(`/api/plugins/${PLUGIN_A}/upgrade`)
      .send({ version: "2.0.0" });

    expect(response.status).toBe(503);
    expect(response.body).toEqual(blockedEnvelope);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("U10: no longer short-circuits rollback at the (now-lifted) cloud block gate", async () => {
    setDeploymentMode("cloud_auth");
    const upgradePlugin = vi.fn();
    const db = { select: vi.fn() };

    const response = await makeApp(makeActor([COMPANY_A], true), {
      db,
      loader: { upgradePlugin },
    }).post(`/api/plugins/${PLUGIN_A}/rollback`);

    // The `rejectBlockedCloudExecution` gate at the top of the rollback
    // handler is now inert — the route proceeds to actually resolve the
    // plugin (and 404s because this fixture never registers PLUGIN_A),
    // instead of short-circuiting at 503 with the blocked envelope.
    expect(response.body).not.toEqual(blockedEnvelope);
    expect(registry.getById).toHaveBeenCalled();
    expect(upgradePlugin).not.toHaveBeenCalled();
    expect(lifecycle.load).not.toHaveBeenCalled();
  });

  const bridgePaths = [
    {
      path: `/api/plugins/${PLUGIN_B}/bridge/data`,
      body: { key: "read", companyId: COMPANY_A },
    },
    {
      path: `/api/plugins/${PLUGIN_B}/bridge/action`,
      body: { key: "write", companyId: COMPANY_A },
    },
    {
      path: `/api/plugins/${PLUGIN_B}/data/read`,
      body: { companyId: COMPANY_A },
    },
    {
      path: `/api/plugins/${PLUGIN_B}/actions/write`,
      body: { companyId: COMPANY_A },
    },
  ];

  for (const testCase of bridgePaths) {
    it(`rejects a foreign worker before dispatch for ${testCase.path}`, async () => {
      registry.getById.mockResolvedValue(plugin(PLUGIN_B, COMPANY_B));
      const call = vi.fn();
      const bridgeDeps = { workerManager: { call, getWorker: vi.fn() } };

      await makeApp(makeActor(), { bridgeDeps })
        .post(testCase.path)
        .send(testCase.body)
        .expect(404);

      expect(call).not.toHaveBeenCalled();
    });
  }

  it("rejects a foreign SSE plugin before subscribing", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_B, COMPANY_B));
    const subscribe = vi.fn();
    const bridgeDeps = {
      workerManager: { call: vi.fn(), getWorker: vi.fn() },
      streamBus: { subscribe },
    };

    await makeApp(makeActor(), { bridgeDeps })
      .get(
        `/api/plugins/${PLUGIN_B}/bridge/stream/events?companyId=${COMPANY_A}`
      )
      .expect(404);

    expect(subscribe).not.toHaveBeenCalled();
  });

  it("requires company scope when listing operator-visible plugin tools", async () => {
    const listToolsForAgent = vi.fn();
    const toolDispatcher = { listToolsForAgent };
    await makeApp(makeActor([COMPANY_A], true), {
      toolDeps: { toolDispatcher },
    })
      .get("/api/plugins/tools")
      .expect(400);
    expect(listToolsForAgent).not.toHaveBeenCalled();
  });

  it("lists only tools for an accessible requested company", async () => {
    const listToolsForAgent = vi.fn(() => []);
    const toolDispatcher = { listToolsForAgent };
    await makeApp(makeActor([COMPANY_A], true), {
      toolDeps: { toolDispatcher },
    })
      .get(`/api/plugins/tools?companyId=${COMPANY_A}&pluginId=acme.shared`)
      .expect(200, []);
    expect(listToolsForAgent).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      pluginId: "acme.shared",
    });
  });

  it("rejects a tool whose registered plugin belongs to another company", async () => {
    registry.getById.mockResolvedValue(plugin(PLUGIN_B, COMPANY_B));
    const executeTool = vi.fn();
    const toolDispatcher = {
      getTool: vi.fn(() => ({ pluginDbId: PLUGIN_B })),
      executeTool,
      listToolsForAgent: vi.fn(),
    };

    await makeApp(makeActor(), { toolDeps: { toolDispatcher } })
      .post("/api/plugins/tools/execute")
      .send({
        tool: "acme.shared:run",
        parameters: {},
        runContext: {
          agentId: "agent-a",
          runId: "run-a",
          companyId: COMPANY_A,
          projectId: "project-a",
        },
      })
      .expect(404);

    expect(executeTool).not.toHaveBeenCalled();
  });

  it("rejects a bare legacy webhook key before registry or worker access", async () => {
    const call = vi.fn();
    await makeApp(makeActor(), {
      webhookDeps: { workerManager: { call } },
    })
      .post("/api/plugins/acme.shared/webhooks/push")
      .send({})
      .expect(404);
    expect(registry.listInstalledForCompanies).not.toHaveBeenCalled();
    expect(registry.getById).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps rejecting a bare key regardless of how many tenants use it", async () => {
    registry.listInstalledForCompanies.mockResolvedValue([
      plugin(PLUGIN_A, COMPANY_A),
      plugin(PLUGIN_B, COMPANY_B),
    ]);
    const call = vi.fn();
    await makeApp(makeActor(), { webhookDeps: { workerManager: { call } } })
      .post("/api/plugins/acme.shared/webhooks/push")
      .send({})
      .expect(404);
    expect(registry.listInstalledForCompanies).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("dispatches a declared webhook when addressed by installation UUID", async () => {
    registry.getById.mockResolvedValue({
      ...plugin(PLUGIN_A, COMPANY_A),
      manifestJson: {
        id: "acme.shared",
        displayName: "Shared",
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey: "push", displayName: "Push" }],
      },
    });
    const call = vi.fn(async () => undefined);
    const where = vi.fn(async () => undefined);
    const values = vi.fn(() => ({
      returning: vi.fn(async () => [{ id: "delivery-1" }]),
    }));
    const db = {
      select: vi.fn(() => ({
        from: () => ({ where: vi.fn(async () => []) }),
      })),
      insert: vi.fn(() => ({
        values,
      })),
      update: vi.fn(() => ({
        set: () => ({ where }),
      })),
    };

    await makeApp(makeActor(), {
      db,
      webhookDeps: { workerManager: { call } },
      sourceIp: "198.51.100.240",
    })
      .post(`/api/plugins/${PLUGIN_A}/webhooks/push`)
      .set("X-Hook-Secret", "secret-a")
      .send({ hello: "world" })
      .expect(200, { deliveryId: "delivery-1", status: "success" });

    expect(registry.getById).toHaveBeenCalledWith(PLUGIN_A);
    expect(call).toHaveBeenCalledWith(
      PLUGIN_A,
      "handleWebhook",
      expect.objectContaining({
        endpointKey: "push",
        rawBody: '{"hello":"world"}',
        parsedBody: { hello: "world" },
        headers: expect.objectContaining({ "x-hook-secret": "secret-a" }),
      })
    );
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: PLUGIN_A,
        webhookKey: "push",
        payload: { hello: "world" },
        headers: expect.objectContaining({ "x-hook-secret": "secret-a" }),
      })
    );
    expect(where).toHaveBeenCalledOnce();
  });

  it("rate-limits public webhooks before UUID lookup, DB writes, or worker RPC", async () => {
    const call = vi.fn();
    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    };
    const appA = makeApp(makeActor(), {
      db,
      webhookDeps: { workerManager: { call } },
      sourceIp: "198.51.100.241",
    });

    for (let index = 0; index < 300; index += 1) {
      await appA
        .post("/api/plugins/not-a-uuid/webhooks/push")
        .send({ index })
        .expect(404);
    }

    const limited = await appA
      .post("/api/plugins/not-a-uuid/webhooks/push")
      .send({ index: 300 })
      .expect(429);
    expect(limited.body).toMatchObject({ error: "rate_limited" });
    expect(limited.body.retryAfter).toBeGreaterThanOrEqual(1);
    expect(limited.headers).toHaveProperty("ratelimit-policy");
    expect(limited.headers).toHaveProperty("ratelimit");
    expect(limited.headers).not.toHaveProperty("x-ratelimit-limit");
    expect(registry.getById).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();

    // The limiter is keyed by source IP, so another caller has a fresh bucket.
    await makeApp(makeActor(), {
      db,
      webhookDeps: { workerManager: { call } },
      sourceIp: "198.51.100.242",
    })
      .post("/api/plugins/not-a-uuid/webhooks/push")
      .send({})
      .expect(404);
  });
});
