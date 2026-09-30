import { describe, expect, it, vi } from "vitest";
import { runStartupMarketplaceMaintenance } from "../services/marketplace-startup-maintenance.js";

describe("runStartupMarketplaceMaintenance", () => {
  it("waits for the initial refresh and uses that exact catalog", async () => {
    let resolveInitial!: (value: unknown) => void;
    const initial = new Promise((resolve) => {
      resolveInitial = resolve;
    });
    const catalogService = {
      waitForInitialRefresh: vi.fn(() => initial),
    };
    const runMaintenance = vi.fn().mockResolvedValue({ failures: [] });
    const pending = runStartupMarketplaceMaintenance({
      db: { marker: "db" } as any,
      catalogService: catalogService as any,
      runMaintenance,
    });

    expect(catalogService.waitForInitialRefresh).toHaveBeenCalledTimes(1);
    expect(runMaintenance).not.toHaveBeenCalled();

    const catalog = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-29T00:00:00.000Z",
      itemCount: 1,
      items: [{ id: "agent:aoa-curated/reviewer" }],
    };
    resolveInitial({ catalog, outcome: "cdn_success", status: null, error: null });
    await pending;

    expect(runMaintenance).toHaveBeenCalledWith({
      db: { marker: "db" },
      catalogItems: catalog.items,
      mode: "scheduled",
    });
  });

  it("does not mutate when the initial refresh produces no catalog", async () => {
    const runMaintenance = vi.fn();
    const result = await runStartupMarketplaceMaintenance({
      db: {} as any,
      catalogService: {
        waitForInitialRefresh: vi.fn().mockResolvedValue({
          catalog: null,
          outcome: "failure",
          status: null,
          error: "unavailable",
        }),
      } as any,
      runMaintenance,
    });

    expect(result).toBeNull();
    expect(runMaintenance).not.toHaveBeenCalled();
  });

  it("does not mutate from a preserved stale cache when the initial refresh fails", async () => {
    const runMaintenance = vi.fn();
    const staleCatalog = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-28T00:00:00.000Z",
      itemCount: 1,
      items: [{ id: "agent:aoa-curated/old-reviewer" }],
    };
    const result = await runStartupMarketplaceMaintenance({
      db: {} as any,
      catalogService: {
        waitForInitialRefresh: vi.fn().mockResolvedValue({
          catalog: staleCatalog,
          outcome: "failure",
          status: {
            lastSyncStatus: "failure",
            source: "cdn",
          },
          error: "HTTP 503",
        }),
      } as any,
      runMaintenance,
    });

    expect(result).toBeNull();
    expect(runMaintenance).not.toHaveBeenCalled();
  });

  it("runs maintenance from a fresh bundled fallback", async () => {
    const fallbackCatalog = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-07-29T00:00:00.000Z",
      itemCount: 1,
      items: [{ id: "agent:aoa-curated/reviewer" }],
    };
    const runMaintenance = vi.fn().mockResolvedValue({ failures: [] });

    await runStartupMarketplaceMaintenance({
      db: { marker: "db" } as any,
      catalogService: {
        waitForInitialRefresh: vi.fn().mockResolvedValue({
          catalog: fallbackCatalog,
          outcome: "fallback_success",
          status: null,
          error: "HTTP 503",
        }),
      } as any,
      runMaintenance,
    });

    expect(runMaintenance).toHaveBeenCalledWith({
      db: { marker: "db" },
      catalogItems: fallbackCatalog.items,
      mode: "scheduled",
    });
  });
});
