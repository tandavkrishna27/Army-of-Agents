import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createMarketplaceRouter } from "../routes/marketplace.js";
import { HttpError } from "../errors.js";

vi.mock("../routes/authz.js", () => ({
  assertBoard: (req: any) => {
    if (req?.actor?.type !== "board") {
      throw new HttpError(403, "Board access required");
    }
  },
  assertCanManageInstanceSettings: (req: any) => {
    if (req?.actor?.type !== "board") {
      throw new HttpError(403, "Board access required");
    }
  },
}));

const VALID_CATALOG = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00.000Z",
  itemCount: 0,
  items: [],
};

describe("marketplace routes", () => {
  it("GET /catalog returns 503 when not synced", async () => {
    const service = {
      readCache: async () => null,
      refresh: async () => ({ catalog: null, status: null }),
      refreshAndCheckForUpdates: async () => ({ catalog: null, status: null }),
      getStatus: async () => null,
    } as any;

    const app = express();
    app.use((req: any, _res, next) => { req.actor = { type: "board" }; next(); });
    app.use("/api/marketplace", createMarketplaceRouter({ service }));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const res = await request(app).get("/api/marketplace/catalog");
    expect(res.status).toBe(503);
  });

  it("GET /catalog returns cached catalog", async () => {
    const service = {
      readCache: async () => VALID_CATALOG,
      refresh: async () => ({ catalog: VALID_CATALOG, status: null }),
      refreshAndCheckForUpdates: async () => ({
        catalog: VALID_CATALOG,
        status: null,
      }),
      getStatus: async () => null,
    } as any;

    const app = express();
    app.use((req: any, _res, next) => { req.actor = { type: "board" }; next(); });
    app.use("/api/marketplace", createMarketplaceRouter({ service }));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const res = await request(app).get("/api/marketplace/catalog");
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe("1.0.0");
  });

  it("POST /catalog/sync triggers sync and returns status", async () => {
    const status = {
      lastSyncedAt: "2026-04-30T00:00:00.000Z",
      lastSyncStatus: "success",
      source: "cdn",
      schemaVersion: "1.0.0",
      itemCount: 0,
    };
    const refreshAndCheckForUpdates = vi.fn().mockResolvedValue({
      catalog: VALID_CATALOG,
      status,
    });
    const service = {
      readCache: async () => VALID_CATALOG,
      refresh: async () => ({ catalog: VALID_CATALOG, status }),
      refreshAndCheckForUpdates,
      getStatus: async () => status,
    } as any;

    const app = express();
    // Attach a minimal actor so assertBoard's req.actor check passes
    app.use((req: any, _res, next) => {
      req.actor = { type: "board" };
      next();
    });
    app.use("/api/marketplace", createMarketplaceRouter({ service }));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const res = await request(app).post("/api/marketplace/catalog/sync");
    expect(res.status).toBe(200);
    expect(res.body.itemCount).toBe(0);
    expect(refreshAndCheckForUpdates).toHaveBeenCalledTimes(1);
  });

  it("POST /catalog/sync returns 403 for non-board actor", async () => {
    const service = {
      readCache: async () => null,
      refresh: async () => ({ catalog: null, status: null }),
      refreshAndCheckForUpdates: async () => ({ catalog: null, status: null }),
      getStatus: async () => null,
    } as any;

    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "agent" }; // not board
      next();
    });
    app.use("/api/marketplace", createMarketplaceRouter({ service }));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const res = await request(app).post("/api/marketplace/catalog/sync");
    expect(res.status).toBe(403);
  });

  it("GET /catalog/status returns sync metadata", async () => {
    const service = {
      readCache: async () => VALID_CATALOG,
      refresh: async () => ({ catalog: VALID_CATALOG, status: null }),
      refreshAndCheckForUpdates: async () => ({
        catalog: VALID_CATALOG,
        status: null,
      }),
      getStatus: async () => ({
        lastSyncedAt: "2026-04-30T00:00:00.000Z",
        lastSyncStatus: "success",
        source: "cdn",
        schemaVersion: "1.0.0",
        itemCount: 0,
      }),
    } as any;

    const app = express();
    app.use((req: any, _res, next) => { req.actor = { type: "board" }; next(); });
    app.use("/api/marketplace", createMarketplaceRouter({ service }));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.status ?? 500).json({ error: err.message });
    });

    const res = await request(app).get("/api/marketplace/catalog/status");
    expect(res.status).toBe(200);
    expect(res.body.lastSyncStatus).toBe("success");
  });
});
