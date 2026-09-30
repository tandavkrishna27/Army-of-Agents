import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const t = new Proxy({}, { get: () => Symbol("col") });
  return {
    plugins: t,
    pluginConfig: t,
    pluginCompanySettings: t,
    pluginVersionSnapshots: t,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  desc: () => Symbol("desc"),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  assertCanManageInstanceSettings: vi.fn(),
}));

import { companyPluginRoutes } from "../routes/company-plugins.js";
import { pluginCompanySettingsRoutes } from "../routes/plugins.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  CLOUD_PLUGIN_EXECUTION_DOC_PATH,
  CloudPluginExecutionBlockedError,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
} from "../services/cloud-plugin-execution.js";

// Helper: extract a named route handler from the Express router
function getRouteHandler(router: any, method: string, path: string) {
  const layer = router.stack.find(
    (l: any) =>
      l.route?.path === path && l.route?.methods?.[method.toLowerCase()]
  );
  if (!layer) throw new Error(`Route ${method} ${path} not found`);
  return layer.route.stack[0].handle as (
    req: any,
    res: any,
    next: any
  ) => Promise<void>;
}

describe("POST /:pluginId/upgrade — auto-rollback snapshot cleanup", () => {
  it("deletes the consumed snapshot after a successful auto-rollback", async () => {
    const deletedWhereArgs: unknown[] = [];

    // Mock DB:
    // - Plugin lookup: db.select().from(plugins).where(...) — awaited directly (no .limit())
    // - Snapshot lookup: db.select().from(snapshots).where(...).orderBy(...).limit(1) — awaited after .limit()
    // - delete() chain: captures the call so we can assert it happened
    let fromCallN = 0;
    const mockDb = {
      select: () => ({
        from: () => {
          fromCallN++;
          const callN = fromCallN;
          if (callN === 1) {
            // Plugin lookup — where() is awaited directly
            const whereResult = {
              then: (resolve: any) =>
                resolve([
                  {
                    id: "plugin-1",
                    pluginKey: "test.plugin",
                    companyId: "co-a",
                    status: "ready",
                  },
                ]),
              // also support .orderBy().limit() just in case
              orderBy: () => ({ limit: () => Promise.resolve([]) }),
            };
            return { where: () => whereResult };
          } else {
            // Snapshot lookup — where().orderBy().limit() is awaited
            return {
              where: () => ({
                then: (resolve: any) => resolve([]), // if awaited directly (shouldn't happen)
                orderBy: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        id: "snap-1",
                        packageName: "@test/plugin",
                        version: "1.0.0",
                        companyId: "co-a",
                        pluginId: "plugin-1",
                      },
                    ]),
                }),
              }),
            };
          }
        },
      }),
      delete: () => ({
        where: (cond: unknown) => {
          deletedWhereArgs.push(cond);
          return Promise.resolve();
        },
      }),
    };

    const mockLifecycle = {
      upgrade: vi
        .fn()
        .mockRejectedValue(new Error("upgrade failed intentionally")),
      load: vi.fn().mockResolvedValue(undefined),
    };
    const mockLoader = {
      upgradePlugin: vi.fn().mockResolvedValue(undefined),
    };

    const router = companyPluginRoutes(
      mockDb as any,
      mockLifecycle as any,
      mockLoader as any
    );

    const handler = getRouteHandler(router, "post", "/:pluginId/upgrade");

    const req = {
      params: { companyId: "co-a", pluginId: "plugin-1" },
      body: {},
    } as any;
    const res = {
      json: vi.fn(),
      status: vi.fn().mockReturnThis(),
    } as any;

    await handler(req, res, vi.fn());

    // Rollback must have fired
    expect(mockLoader.upgradePlugin).toHaveBeenCalledWith("plugin-1", {
      packageName: "@test/plugin",
      version: "1.0.0",
    });
    expect(mockLifecycle.load).toHaveBeenCalledWith("plugin-1");

    // Snapshot must have been deleted after successful rollback
    expect(deletedWhereArgs).toHaveLength(1);
  });

  it("rejects foreign plugin settings before inserting a company overlay", async () => {
    const insert = vi.fn();
    const update = vi.fn();
    const mockDb = {
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      insert,
      update,
    };
    const router = companyPluginRoutes(mockDb as any, {} as any, {} as any);
    const handler = getRouteHandler(router, "patch", "/:pluginId/settings");
    const req = {
      params: { companyId: "company-a", pluginId: "plugin-b" },
      body: { enabled: false },
    } as any;
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await handler(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("persists a company disable and tears down the shared runtime lifecycle", async () => {
    let selectCall = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(
              selectCall++ === 0 ? [{ id: "plugin-1", status: "ready" }] : []
            ),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ enabled: false }]),
        }),
      }),
    };
    const lifecycle = {
      disable: vi.fn(),
      enable: vi.fn(),
      blockActivationInCloud: vi.fn(),
    };
    const router = companyPluginRoutes(
      mockDb as any,
      lifecycle as any,
      {} as any
    );
    const handler = getRouteHandler(router, "patch", "/:pluginId/settings");
    const req = {
      params: { companyId: "company-a", pluginId: "plugin-1" },
      body: { enabled: false },
    } as any;
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await handler(req, res, vi.fn());

    expect(lifecycle.disable).toHaveBeenCalledWith(
      "plugin-1",
      "Disabled for company"
    );
    expect(res.json).toHaveBeenCalledWith({ enabled: false });
  });

  it("persists a company enable and activates the shared runtime lifecycle", async () => {
    let selectCall = 0;
    const mockDb = {
      select: () => ({
        from: () => ({
          where: () =>
            Promise.resolve(
              selectCall++ === 0 ? [{ id: "plugin-1", status: "disabled" }] : []
            ),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ enabled: true }]),
        }),
      }),
    };
    const lifecycle = {
      disable: vi.fn(),
      enable: vi.fn(),
      blockActivationInCloud: vi.fn(),
    };
    const router = companyPluginRoutes(
      mockDb as any,
      lifecycle as any,
      {} as any
    );
    const handler = getRouteHandler(router, "patch", "/:pluginId/settings");
    const req = {
      params: { companyId: "company-a", pluginId: "plugin-1" },
      body: { enabled: true },
    } as any;
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await handler(req, res, vi.fn());

    expect(lifecycle.enable).toHaveBeenCalledWith("plugin-1");
    expect(res.json).toHaveBeenCalledWith({ enabled: true });
  });

  it("reconciles a company enable in cloud before overlay mutation", async () => {
    setDeploymentMode("cloud_auth");
    try {
      const db = {
        select: vi.fn(() => ({
          from: () => ({
            where: () =>
              Promise.resolve([{ id: "plugin-1", status: "disabled" }]),
          }),
        })),
        insert: vi.fn(),
        update: vi.fn(),
      };
      const lifecycle = {
        disable: vi.fn(),
        enable: vi.fn(),
        blockActivationInCloud: vi
          .fn()
          .mockRejectedValue(new CloudPluginExecutionBlockedError()),
      };
      const router = companyPluginRoutes(
        db as any,
        lifecycle as any,
        {} as any
      );
      const handler = getRouteHandler(router, "patch", "/:pluginId/settings");
      const req = {
        params: { companyId: "company-a", pluginId: "plugin-1" },
        body: { enabled: true },
      } as any;
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

      await handler(req, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: CLOUD_PLUGIN_BLOCK_MESSAGE,
        code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
        docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
      });
      expect(db.select).toHaveBeenCalledOnce();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(lifecycle.blockActivationInCloud).toHaveBeenCalledWith(
        "plugin-1",
        "direct"
      );
      expect(lifecycle.enable).not.toHaveBeenCalled();
    } finally {
      setDeploymentMode("local_trusted");
    }
  });

  it("reconciles the legacy cloud enable route before overlay mutation", async () => {
    setDeploymentMode("cloud_auth");
    try {
      const db = {
        select: vi.fn(() => ({
          from: () => ({
            where: () =>
              Promise.resolve([{ id: "plugin-1", status: "disabled" }]),
          }),
        })),
        insert: vi.fn(),
        update: vi.fn(),
      };
      const lifecycle = {
        disable: vi.fn(),
        enable: vi.fn(),
        blockActivationInCloud: vi
          .fn()
          .mockRejectedValue(new CloudPluginExecutionBlockedError()),
      };
      const router = pluginCompanySettingsRoutes(db as any, lifecycle as any);
      const handler = getRouteHandler(
        router,
        "put",
        "/companies/:companyId/plugin-settings/:pluginId"
      );
      const req = {
        params: { companyId: "company-a", pluginId: "plugin-1" },
        body: { enabled: true },
      } as any;
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

      await handler(req, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: CLOUD_PLUGIN_BLOCK_MESSAGE,
        code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
        docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
      });
      expect(db.select).toHaveBeenCalledOnce();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(lifecycle.blockActivationInCloud).toHaveBeenCalledWith(
        "plugin-1",
        "direct"
      );
      expect(lifecycle.enable).not.toHaveBeenCalled();
    } finally {
      setDeploymentMode("local_trusted");
    }
  });

  it("does NOT delete the snapshot if rollback (installPlugin) throws", async () => {
    const deletedWhereArgs: unknown[] = [];

    let fromCallN2 = 0;
    const mockDb = {
      select: () => ({
        from: () => {
          fromCallN2++;
          const callN = fromCallN2;
          if (callN === 1) {
            // Plugin lookup — where() is awaited directly
            const whereResult = {
              then: (resolve: any) =>
                resolve([
                  {
                    id: "plugin-1",
                    pluginKey: "test.plugin",
                    companyId: "co-a",
                    status: "ready",
                  },
                ]),
              orderBy: () => ({ limit: () => Promise.resolve([]) }),
            };
            return { where: () => whereResult };
          } else {
            // Snapshot lookup — where().orderBy().limit() is awaited
            return {
              where: () => ({
                then: (resolve: any) => resolve([]),
                orderBy: () => ({
                  limit: () =>
                    Promise.resolve([
                      {
                        id: "snap-1",
                        packageName: "@test/plugin",
                        version: "1.0.0",
                        companyId: "co-a",
                        pluginId: "plugin-1",
                      },
                    ]),
                }),
              }),
            };
          }
        },
      }),
      delete: () => ({
        where: (cond: unknown) => {
          deletedWhereArgs.push(cond);
          return Promise.resolve();
        },
      }),
    };

    const mockLifecycle = {
      upgrade: vi.fn().mockRejectedValue(new Error("upgrade failed")),
      load: vi.fn().mockResolvedValue(undefined),
    };
    const mockLoader = {
      // installPlugin throws — rollback failed
      upgradePlugin: vi.fn().mockRejectedValue(new Error("reinstall failed")),
    };

    const router = companyPluginRoutes(
      mockDb as any,
      mockLifecycle as any,
      mockLoader as any
    );

    const handler = getRouteHandler(router, "post", "/:pluginId/upgrade");
    const req = {
      params: { companyId: "co-a", pluginId: "plugin-1" },
      body: {},
    } as any;
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

    await handler(req, res, vi.fn());

    // Snapshot must NOT be deleted when rollback fails
    expect(deletedWhereArgs).toHaveLength(0);
  });

  it("FND-006: blocks manual rollback on cloud_auth at the loader gate (canonical 503 before any DB/authz)", async () => {
    setDeploymentMode("cloud_auth");
    try {
      const db = { select: vi.fn() };
      const lifecycle = { load: vi.fn() };
      const loader = { upgradePlugin: vi.fn() };
      const router = companyPluginRoutes(
        db as any,
        lifecycle as any,
        loader as any
      );
      const handler = getRouteHandler(
        router,
        "post",
        "/:pluginId/upgrade/rollback"
      );
      const req = {
        params: { companyId: "company-1", pluginId: "plugin-1" },
        actor: {
          type: "board",
          source: "session",
          userId: "operator-1",
          operator: true,
          isInstanceAdmin: false,
          companyIds: ["company-1"],
        },
      } as any;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      // Decision #103 amendment / FND-006: the loader sink fails closed on
      // cloud_auth, so the rollback route short-circuits with the canonical 503
      // denial envelope BEFORE any assertCompanyAccess / DB / loader work.
      await handler(req, res, vi.fn());

      expect(res.status).toHaveBeenCalledWith(503);
      expect(db.select).not.toHaveBeenCalled();
      expect(loader.upgradePlugin).not.toHaveBeenCalled();
      expect(lifecycle.load).not.toHaveBeenCalled();
    } finally {
      setDeploymentMode("local_trusted");
    }
  });

  it("returns canonical cloud denial before upgrade-approval status validation", async () => {
    setDeploymentMode("cloud_auth");
    try {
      const mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ id: "plugin-1", status: "error" }]),
          }),
        }),
      };
      const lifecycle = {
        blockActivationInCloud: vi
          .fn()
          .mockRejectedValue(new CloudPluginExecutionBlockedError()),
        load: vi.fn(),
      };
      const router = companyPluginRoutes(
        mockDb as any,
        lifecycle as any,
        {} as any
      );
      const handler = getRouteHandler(
        router,
        "post",
        "/:pluginId/upgrade/approve"
      );
      const req = {
        params: { companyId: "company-a", pluginId: "plugin-1" },
        body: {},
      } as any;
      const res = { json: vi.fn(), status: vi.fn().mockReturnThis() } as any;

      await handler(req, res, vi.fn());

      expect(lifecycle.blockActivationInCloud).toHaveBeenCalledWith(
        "plugin-1",
        "direct"
      );
      expect(lifecycle.load).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: CLOUD_PLUGIN_BLOCK_MESSAGE,
        code: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
        docs: CLOUD_PLUGIN_EXECUTION_DOC_PATH,
      });
    } finally {
      setDeploymentMode("local_trusted");
    }
  });
});
