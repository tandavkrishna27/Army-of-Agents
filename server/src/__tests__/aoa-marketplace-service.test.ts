import { describe, it, expect, vi, beforeEach } from "vitest";

const { runUpdateCheckMock } = vi.hoisted(() => ({
  runUpdateCheckMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
}));

vi.mock("../services/marketplace-update-checker.js", () => ({
  runUpdateCheck: runUpdateCheckMock,
}));

vi.mock("@armyofagents/db", () => ({
  marketplaceCatalogCache: {
    id: "id",
    schemaVersion: "schema_version",
    generatedAt: "generated_at",
    itemCount: "item_count",
    catalogJson: "catalog_json",
    lastSyncedAt: "last_synced_at",
    lastSyncStatus: "last_sync_status",
    lastSyncError: "last_sync_error",
    source: "source",
  } as any,
}));

import { MarketplaceCatalogService } from "../services/aoa-marketplace.js";
import { withMarketplaceUpdateLock } from "../services/marketplace-update-coordinator.js";

const VALID_CATALOG = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-04-30T00:00:00.000Z",
  itemCount: 1,
  items: [
    {
      id: "plugin:test/example",
      type: "plugin",
      name: "Test",
      description: "test plugin",
      version: "1.0.0",
      source: {
        adapter: "aoa-curated",
        url: "https://example.com",
        locator: "test",
      },
      trust: { tier: "verified", source: "aoa-curated" },
      status: "active",
      addedAt: "2026-04-30T00:00:00.000Z",
      category: "engineering",
      tags: [],
    },
  ],
};

function makeSelectChain(results: any[]) {
  const queue = [...results];
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (rows: any[]) => any) =>
      Promise.resolve(fn(queue.shift() ?? [])),
    ),
  };
}

function makeDb(selectQueue: any[]) {
  const inserted: any[] = [];
  const updated: any[] = [];

  const db = {
    select: vi.fn(() => makeSelectChain(selectQueue)),
    insert: vi.fn(() => ({
      values: vi.fn((values: any) => {
        inserted.push(values);
        return {
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: any) => {
        updated.push(values);
        return {
          where: vi.fn().mockResolvedValue([]),
        };
      }),
    })),
  } as any;

  return { db, inserted, updated };
}

describe("MarketplaceCatalogService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("syncs from CDN successfully", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(VALID_CATALOG),
    }) as any;

    // readCache returns empty (no existing cache)
    const { db, inserted } = makeDb([[]]);

    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const result = await service.refresh();
    expect(result.catalog?.schemaVersion).toBe("1.0.0");
    expect(result.outcome).toBe("cdn_success");
    expect(result.catalog?.itemCount).toBe(1);
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted[0].schemaVersion).toBe("1.0.0");
    expect(inserted[0].source).toBe("cdn");
    expect(inserted[0].lastSyncStatus).toBe("success");
    expect(runUpdateCheckMock).not.toHaveBeenCalled();
  });

  it("runs update checks only through the explicit mutating refresh helper", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(VALID_CATALOG),
    }) as any;
    const { db } = makeDb([[]]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const result = await service.refreshAndCheckForUpdates();

    expect(result.outcome).toBe("cdn_success");
    await vi.waitFor(() =>
      expect(runUpdateCheckMock).toHaveBeenCalledTimes(1),
    );
    expect(runUpdateCheckMock).toHaveBeenCalledWith(db, VALID_CATALOG.items);
    await withMarketplaceUpdateLock(async () => undefined);
  });

  it("queues a sync update check behind the shared mutation lock", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(VALID_CATALOG),
    }) as any;
    const { db } = makeDb([[]]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let markLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLockHeld = resolve;
    });
    const held = withMarketplaceUpdateLock(async () => {
      markLockHeld();
      await blocker;
    });
    await lockHeld;

    const result = await service.refreshAndCheckForUpdates();

    expect(result.outcome).toBe("cdn_success");
    expect(runUpdateCheckMock).not.toHaveBeenCalled();
    releaseBlocker();
    await held;
    await vi.waitFor(() =>
      expect(runUpdateCheckMock).toHaveBeenCalledTimes(1),
    );
    await withMarketplaceUpdateLock(async () => undefined);
  });

  it("rejects unsupported schemaVersion", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ ...VALID_CATALOG, schemaVersion: "99.0.0" }),
    }) as any;

    // writeCache(null) -> readCache() returns [] (no existing row, so no update, returns null)
    // writeCache returns null -> no bundled snapshot -> sync returns null
    const { db } = makeDb([[]]);

    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const result = await service.sync();
    // Failed sync + no existing cache + no bundled snapshot -> null
    expect(result).toBeNull();
  });

  it("FU-14: keeps known items when a sibling has an unknown type", async () => {
    const unknownTypeItem = {
      ...VALID_CATALOG.items[0],
      id: "connector:future/thing",
      type: "connector",
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...VALID_CATALOG,
          itemCount: 2,
          items: [VALID_CATALOG.items[0], unknownTypeItem],
        }),
    }) as any;

    const { db, inserted } = makeDb([[]]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const result = await service.sync();
    // Known item survives; unknown dropped; count recomputed to survivors.
    expect(result?.itemCount).toBe(1);
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]?.id).toBe(VALID_CATALOG.items[0].id);
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted[0].lastSyncStatus).toBe("success");
  });

  it("FU-14: broken envelope is a fetch failure that preserves the cache", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      // `items` is not an array → malformed envelope
      json: () => Promise.resolve({ schemaVersion: "1.0.0", items: "nope" }),
    }) as any;

    // readCache returns an existing cached row → writeCache(null) updates status only,
    // returns the existing catalog (cache preserved, never overwritten).
    const existingRow = [
      {
        schemaVersion: "1.0.0",
        generatedAt: new Date("2026-04-30T00:00:00.000Z"),
        itemCount: 1,
        catalogJson: VALID_CATALOG,
        lastSyncedAt: new Date(),
        lastSyncStatus: "success",
        lastSyncError: null,
        source: "cdn",
      },
    ];
    // sync() failure path: writeCache(null) → readCache() (existing), then a
    // second readCache() inside writeCache's update branch is not called; provide
    // the existing row for each readCache invocation.
    const { db, inserted, updated } = makeDb([existingRow, existingRow]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const result = await service.sync();
    // Cache preserved: no fresh insert of catalog rows; status-only update recorded failure.
    expect(inserted.length).toBe(0);
    expect(updated.length).toBeGreaterThan(0);
    expect(updated[0].lastSyncStatus).toBe("failure");
    // Returned catalog is the preserved cache, not null.
    expect(result?.schemaVersion).toBe("1.0.0");
    expect(result?.items).toHaveLength(1);
  });

  it("FU-14: all-items-unparseable preserves the cache (not an empty-catalog answer)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          ...VALID_CATALOG,
          itemCount: 1,
          items: [{ id: "x", type: "connector" }], // every item drops
        }),
    }) as any;

    const existingRow = [
      {
        schemaVersion: "1.0.0",
        generatedAt: new Date("2026-04-30T00:00:00.000Z"),
        itemCount: 1,
        catalogJson: VALID_CATALOG,
        lastSyncedAt: new Date(),
        lastSyncStatus: "success",
        lastSyncError: null,
        source: "cdn",
      },
    ];
    const { db, inserted, updated } = makeDb([existingRow, existingRow]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const result = await service.sync();
    expect(inserted.length).toBe(0);
    expect(updated[0].lastSyncStatus).toBe("failure");
    expect(result?.items).toHaveLength(1); // preserved cache
  });

  it("falls back to bundled snapshot on CDN failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    // writeCache(null) -> readCache() returns [] (no existing row, so no update, returns null)
    // writeCache returns null -> triggers bundled snapshot path
    const { db, inserted } = makeDb([[]]);

    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => VALID_CATALOG as any,
    });

    const result = await service.refresh();
    expect(result.catalog?.schemaVersion).toBe("1.0.0");
    expect(result.outcome).toBe("fallback_success");
    // bundled snapshot written via insert
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted[0].source).toBe("bundled");
    expect(inserted[0].lastSyncStatus).toBe("success");
  });

  it("joins concurrent refreshes and returns attempt-scoped status", async () => {
    let resolveFetch!: (value: unknown) => void;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as any;
    const statusRow = {
      schemaVersion: "1.0.0",
      generatedAt: new Date("2026-04-30T00:00:00.000Z"),
      itemCount: 1,
      catalogJson: VALID_CATALOG,
      lastSyncedAt: new Date("2026-07-28T00:00:00.000Z"),
      lastSyncStatus: "success",
      lastSyncError: null,
      source: "cdn",
    };
    const { db } = makeDb([[statusRow]]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    const first = service.refresh();
    const concurrent = service.refresh();
    expect(concurrent).toBe(first);
    resolveFetch({
      ok: true,
      json: () => Promise.resolve(VALID_CATALOG),
    });

    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(concurrentResult).toEqual(firstResult);
    expect(firstResult.catalog?.schemaVersion).toBe("1.0.0");
    expect(firstResult.outcome).toBe("cdn_success");
    expect(firstResult.status).toMatchObject({
      lastSyncStatus: "success",
      source: "cdn",
      schemaVersion: "1.0.0",
      itemCount: 1,
    });
  });

  it("lets startup maintenance join the sync loop's exact first refresh", async () => {
    let resolveFetch!: (value: unknown) => void;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    ) as any;
    const statusRow = {
      schemaVersion: "1.0.0",
      generatedAt: new Date("2026-04-30T00:00:00.000Z"),
      itemCount: 1,
      catalogJson: VALID_CATALOG,
      lastSyncedAt: new Date("2026-07-29T00:00:00.000Z"),
      lastSyncStatus: "success",
      lastSyncError: null,
      source: "cdn",
    };
    const { db } = makeDb([[statusRow]]);
    const service = new MarketplaceCatalogService({
      db,
      cdnUrl: "https://example.com/catalog.json",
      bundledSnapshotProvider: async () => null,
    });

    service.startSyncLoop();
    const maintenanceJoin = service.waitForInitialRefresh();
    const secondJoin = service.waitForInitialRefresh();

    expect(maintenanceJoin).toBe(secondJoin);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    resolveFetch({
      ok: true,
      json: () => Promise.resolve(VALID_CATALOG),
    });
    const result = await maintenanceJoin;
    service.stopSyncLoop();
    await withMarketplaceUpdateLock(async () => undefined);

    expect(result.catalog).toEqual(VALID_CATALOG);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
