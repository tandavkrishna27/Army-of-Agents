// server/src/__tests__/marketplace-packages-route.test.ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMarketplaceRouter } from "../routes/marketplace.js";
import { errorHandler } from "../middleware/index.js";
import type { MarketplacePackage } from "@armyofagents/shared";

const mockService = vi.hoisted(() => ({
  readCache: vi.fn(),
  refresh: vi.fn(),
  getStatus: vi.fn(),
  getPackages: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api/marketplace", createMarketplaceRouter({ service: mockService as any }));
  app.use(errorHandler);
  return app;
}

const SAMPLE_PACKAGE: MarketplacePackage = {
  id: "garrytan/gstack",
  name: "gstack",
  sourceUrl: "https://github.com/garrytan/gstack",
  memberItemIds: ["skill:gstack/office-hours", "skill:gstack/qa"],
  count: 2,
  verified: true,
  explicit: false,
};

describe("GET /api/marketplace/packages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with the package list when catalog is cached", async () => {
    mockService.getPackages.mockResolvedValue([SAMPLE_PACKAGE]);

    const res = await request(createApp()).get("/api/marketplace/packages");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ packages: [SAMPLE_PACKAGE] });
    expect(mockService.getPackages).toHaveBeenCalledTimes(1);
  });

  it("returns 503 when no catalog has been cached yet", async () => {
    mockService.getPackages.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/marketplace/packages");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/not yet synced/i) });
  });

  it("returns an empty array when catalog has zero packages", async () => {
    mockService.getPackages.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/marketplace/packages");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ packages: [] });
  });
});
