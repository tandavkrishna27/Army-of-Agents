/**
 * @fileoverview Marketplace catalog sync service
 *
 * Polls the CDN for the latest catalog.json on a schedule, validates
 * schema version, and stores the result in the marketplaceCatalogCache table.
 * Falls back to the bundled snapshot if CDN unreachable and cache empty.
 *
 * Per spec §5.7.
 */

import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { marketplaceCatalogCache } from "@armyofagents/db";
import {
  parseMarketplaceCatalog,
  isSchemaVersionSupported,
  type CatalogSyncStatus,
  type MarketplaceCatalogFile,
  type MarketplacePackage,
} from "@armyofagents/shared";
import { derivePackages } from "./derivePackages.js";
import { runUpdateCheck } from "./marketplace-update-checker.js";
import { withMarketplaceUpdateLock } from "./marketplace-update-coordinator.js";
import { logger } from "../middleware/logger.js";
import { serializeSafeError } from "./safe-error.js";

const DEFAULT_CDN_URL =
  "https://meteoritelabs.github.io/aoa-marketplace-cdn/catalog.json";
const SYNC_TIMEOUT_MS = 30_000;
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h, M.4 makes this configurable

/**
 * How long a caller that NEEDS a catalog (today: the company-create crew
 * bootstrap) will wait for one before degrading.
 *
 * Sized to cover a cold boot: `startSyncLoop()` fires its first sync
 * unawaited, so a company created seconds after boot would otherwise read an
 * empty cache and be provisioned from the legacy seeders — permanently
 * `@legacy`, permanently excluded from the update pipeline, and invisible
 * afterwards. `ensureCatalogAvailable` joins that in-flight sync instead of
 * racing it.
 *
 * Deliberately shorter than SYNC_TIMEOUT_MS: a *hung* CDN must not hold
 * onboarding open for 30s. The bounded wait covers the common cold-cache case
 * (CDN answers, or fails fast and the bundled snapshot lands); a genuinely
 * stalled CDN degrades to the legacy seeders.
 */
export const CATALOG_AVAILABILITY_TIMEOUT_MS = 12_000;

/**
 * After a sync attempt produces no catalog, `ensureCatalogAvailable` short-circuits
 * to cache-only for this long (R4 — negative caching).
 *
 * Without it, an instance with an empty cache, an unreachable CDN, and no bundled
 * snapshot (any image built without `pnpm fetch-catalog` — the file is gitignored)
 * never fills the cache, so EVERY company create starts a fresh 30s-timeout fetch
 * and burns the full availability budget. The cooldown makes the second and
 * subsequent creates degrade instantly instead.
 */
export const CATALOG_SYNC_FAILURE_COOLDOWN_MS = 60_000;

interface MarketplaceCatalogServiceDeps {
  db: Db;
  cdnUrl?: string;
  bundledSnapshotProvider: () => Promise<MarketplaceCatalogFile | null>;
}

/**
 * Read the catalog from the DB cache without needing a service instance.
 *
 * This is the cache-only half of catalog resolution — it does NOT fetch and
 * does NOT fall back to the bundled snapshot, so on a cold cache it returns
 * `null` even though a catalog is moments away. Callers that need a catalog
 * (the company-create crew bootstrap) must go through
 * {@link resolveCatalogForBootstrap}, which layers the bounded wait on top.
 */
export async function loadCachedCatalog(db: Db): Promise<MarketplaceCatalogFile | null> {
  const rows = await db
    .select()
    .from(marketplaceCatalogCache)
    .where(eq(marketplaceCatalogCache.id, 1))
    .limit(1);
  if (rows.length === 0) return null;
  const row = rows[0];
  const candidate = {
    schemaVersion: row.schemaVersion,
    generatedAt: row.generatedAt.toISOString(),
    itemCount: row.itemCount,
    items: (row.catalogJson as { items?: unknown }).items ?? [],
  };
  // FU-14: per-item parse so a single drifted cached item (e.g. written by a newer
  // app version) drops itself instead of nulling the whole cache and forcing a fallback.
  const { catalog, dropped, malformed } = parseMarketplaceCatalog(candidate);
  if (malformed || !catalog) {
    logger.warn(
      { schemaVersion: row.schemaVersion },
      "marketplace: cached catalog envelope malformed (loadCachedCatalog)",
    );
    return null;
  }
  if (dropped.length > 0) {
    logger.warn(
      { dropped },
      `marketplace: dropped ${dropped.length} unparseable cached item(s) (loadCachedCatalog)`,
    );
  }
  return catalog;
}

/**
 * Why catalog resolution produced nothing. Each reason is a DIFFERENT
 * operational story and must stay distinguishable in the degrade log (R7):
 * `no-service-registered` is a wiring regression, the others are outages.
 */
export type CatalogUnavailableReason =
  | "no-service-registered"
  | "sync-cooldown"
  | "sync-unavailable"
  | "cache-read-error";

export type CatalogAvailability =
  | { status: "ok"; catalog: MarketplaceCatalogFile; source: "cache" | "sync" }
  | { status: "unavailable"; reason: CatalogUnavailableReason };

export interface MarketplaceCatalogRefreshResult {
  catalog: MarketplaceCatalogFile | null;
  /** Status captured before the shared sync lock is released. */
  status: CatalogSyncStatus | null;
  /** Whether this attempt actually fetched the CDN or used an availability fallback. */
  outcome: "cdn_success" | "fallback_success" | "failure";
  /** Attempt-scoped CDN/cache error, preserved even when fallback succeeds. */
  error: string | null;
}

export class MarketplaceCatalogService {
  private readonly db: Db;
  private readonly cdnUrl: string;
  private readonly bundledSnapshotProvider: () => Promise<MarketplaceCatalogFile | null>;
  private syncTimer: NodeJS.Timeout | null = null;
  private inFlightSync: Promise<MarketplaceCatalogRefreshResult> | null = null;
  private initialRefresh: Promise<MarketplaceCatalogRefreshResult> | null = null;
  /** Epoch ms of the last sync attempt that produced no catalog (R4 backoff). */
  private lastSyncFailureAt: number | null = null;

  constructor(deps: MarketplaceCatalogServiceDeps) {
    this.db = deps.db;
    this.cdnUrl = deps.cdnUrl ?? DEFAULT_CDN_URL;
    this.bundledSnapshotProvider = deps.bundledSnapshotProvider;
  }

  /** Start the periodic sync loop. */
  startSyncLoop(): void {
    if (this.syncTimer) return;
    this.initialRefresh ??= this.refreshAndCheckForUpdates();
    this.syncTimer = setInterval(() => {
      void this.refreshAndCheckForUpdates();
    }, SYNC_INTERVAL_MS);
  }

  /**
   * Join the exact refresh attempt started by `startSyncLoop()`. Startup
   * maintenance uses this instead of racing a cache-only read. If a caller uses
   * the service before the loop starts, this method starts and retains the same
   * single initial attempt.
   */
  waitForInitialRefresh(): Promise<MarketplaceCatalogRefreshResult> {
    this.initialRefresh ??= this.refreshAndCheckForUpdates();
    return this.initialRefresh;
  }

  stopSyncLoop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Run `sync()`, but share one in-flight attempt across concurrent callers so
   * the boot sync and a simultaneous company-create bootstrap issue a single
   * CDN fetch rather than two. Never rejects — `sync()` already handles CDN
   * failure internally; anything past that (e.g. a cache write error) is logged
   * and reported as `null`.
   */
  private runDedupedSync(): Promise<MarketplaceCatalogRefreshResult> {
    if (this.inFlightSync) return this.inFlightSync;
    const started = this.performSync()
      .then(async (attempt) => ({
        ...attempt,
        status: await this.getStatus(),
      }))
      .catch((err) => {
        logger.error(
          { error: serializeSafeError(err) },
          "marketplace: catalog sync failed",
        );
        return {
          catalog: null,
          status: null,
          outcome: "failure" as const,
          error: err instanceof Error ? err.message : String(err),
        };
      })
      .then((result) => {
        // R4: "no catalog produced" is the condition worth backing off from —
        // a CDN failure that still resolved from cache/snapshot is a success.
        this.lastSyncFailureAt = result.catalog ? null : Date.now();
        return result;
      });
    this.inFlightSync = started;
    void started.finally(() => {
      if (this.inFlightSync === started) this.inFlightSync = null;
    });
    return started;
  }

  /**
   * Force a fresh catalog attempt while joining any sync already in progress.
   * Catalog and status describe the same attempt because status is captured
   * before this shared in-flight promise is released.
   */
  refresh(): Promise<MarketplaceCatalogRefreshResult> {
    return this.runDedupedSync();
  }

  /**
   * Refresh the catalog and then launch the ordinary fleet update check.
   *
   * Keep this explicit rather than hiding the mutation inside `refresh()`:
   * privileged reconciliation must be able to fetch and validate a fresh
   * catalog, persist its actor-attributed start audit, and only then create
   * pending-update rows or notifications.
   */
  async refreshAndCheckForUpdates(): Promise<MarketplaceCatalogRefreshResult> {
    const result = await this.refresh();
    const catalog = result.catalog;
    if (catalog && result.outcome === "cdn_success") {
      void withMarketplaceUpdateLock(() =>
        runUpdateCheck(this.db, catalog.items),
      ).catch((err) =>
        logger.error(
          { error: serializeSafeError(err) },
          "marketplace: update check failed after sync",
        ),
      );
    }
    return result;
  }

  /**
   * Return a usable catalog, waiting up to `timeoutMs` for one if the cache is
   * cold. Cache hit → immediate. Cache miss → join (or start) a sync, which
   * itself falls back to the bundled snapshot when the CDN is unreachable.
   * Returns `null` if no catalog is available within the budget — callers MUST
   * treat that as "degrade", never as "fail".
   *
   * This exists because `startSyncLoop()` fires its first sync unawaited: any
   * caller that merely *reads* the cache races the boot sync and loses
   * non-deterministically.
   */
  async ensureCatalogAvailable(
    timeoutMs: number = CATALOG_AVAILABILITY_TIMEOUT_MS,
  ): Promise<CatalogAvailability> {
    // This IS the cold-path cache read — callers must not pre-read (R10).
    const cached = await this.readCache();
    if (cached) return { status: "ok", catalog: cached, source: "cache" };

    // R4: a recent failed attempt means the next create would pay the full
    // budget for the same doomed fetch. Degrade immediately instead.
    //
    // …unless a sync is ALREADY in flight (F8): that attempt is fresh and may
    // be about to succeed, and joining it costs nothing extra — the cooldown
    // exists to stop us STARTING doomed fetches, not to refuse a free ride on
    // one already running.
    if (
      this.lastSyncFailureAt !== null &&
      Date.now() - this.lastSyncFailureAt < CATALOG_SYNC_FAILURE_COOLDOWN_MS &&
      !this.inFlightSync
    ) {
      return { status: "unavailable", reason: "sync-cooldown" };
    }

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    try {
      const synced = await Promise.race([this.runDedupedSync(), budget]);
      if (synced?.catalog) {
        return { status: "ok", catalog: synced.catalog, source: "sync" };
      }
      return { status: "unavailable", reason: "sync-unavailable" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Backward-compatible catalog-only sync API. It joins the same in-flight
   * attempt as the boot loop and operator recovery.
   */
  async sync(): Promise<MarketplaceCatalogFile | null> {
    return (await this.refresh()).catalog;
  }

  /** Fetch catalog from CDN and cache. Returns the synced catalog or null on failure. */
  private async performSync(): Promise<{
    catalog: MarketplaceCatalogFile | null;
    outcome: MarketplaceCatalogRefreshResult["outcome"];
    error: string | null;
  }> {
    try {
      const res = await fetch(this.cdnUrl, {
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();

      // FU-14: per-item, drop-and-warn parse. A single unknown-`type` (or otherwise
      // unparseable) item must NOT fail the whole file — that would preserve the old
      // cache forever on every older instance the moment the CDN publishes something
      // this build doesn't understand. Only a broken ENVELOPE is a fetch failure.
      const { catalog: parsed, dropped, malformed } = parseMarketplaceCatalog(json);
      if (malformed || !parsed) {
        // Unintelligible envelope (not an object, or `items` missing/not-an-array):
        // NOT an answer about the catalog's contents. Keep the last known-good cache.
        throw new Error("Malformed catalog envelope");
      }
      // kept-ZERO but dropped-MANY is not a real "empty catalog" answer — every item
      // failed to parse (a schema we tighten later, or a genuinely malformed publish).
      // Treat it like a malformed envelope: keep the last known-good cache rather than
      // blanking the shelf. A legitimately empty catalog (dropped === 0) still replaces.
      if (parsed.items.length === 0 && dropped.length > 0) {
        throw new Error(
          `All ${dropped.length} catalog item(s) were unparseable`,
        );
      }
      if (dropped.length > 0) {
        logger.warn(
          { dropped, kept: parsed.items.length },
          `marketplace: dropped ${dropped.length} unparseable catalog item(s)`,
        );
      }
      if (!isSchemaVersionSupported(parsed.schemaVersion)) {
        throw new Error(
          `Unsupported catalog schemaVersion: ${parsed.schemaVersion}`,
        );
      }
      await this.writeCache(parsed, "cdn", "success", null);
      return { catalog: parsed, outcome: "cdn_success", error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cached = await this.writeCache(null, "cdn", "failure", message);

      // Fall back to bundled snapshot if cache is empty
      if (!cached) {
        const bundled = await this.bundledSnapshotProvider();
        if (bundled) {
          await this.writeCache(bundled, "bundled", "success", null);
          return {
            catalog: bundled,
            outcome: "fallback_success",
            error: message,
          };
        }
      }
      return { catalog: cached, outcome: "failure", error: message };
    }
  }

  /**
   * Read the current cached catalog (or null if none).
   *
   * Delegates to {@link loadCachedCatalog} — same query, same Zod validation.
   * They were duplicated and ran back-to-back on the cold bootstrap path (R10).
   */
  async readCache(): Promise<MarketplaceCatalogFile | null> {
    // FU-14 per-item parse now lives in the shared loadCachedCatalog helper.
    return loadCachedCatalog(this.db);
  }

  /**
   * Read the cached catalog and derive the marketplace package list.
   * Returns `null` if no catalog has been cached yet (caller should respond
   * 503 to mirror `readCache()` semantics).
   *
   * Derivation is in-memory and cheap (~hundreds of items max). No DB write.
   */
  async getPackages(): Promise<MarketplacePackage[] | null> {
    const catalog = await this.readCache();
    if (!catalog) return null;
    return derivePackages(catalog.items);
  }

  async getStatus(): Promise<CatalogSyncStatus | null> {
    const rows = await this.db
      .select()
      .from(marketplaceCatalogCache)
      .where(eq(marketplaceCatalogCache.id, 1))
      .limit(1);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      lastSyncedAt: row.lastSyncedAt.toISOString(),
      lastSyncStatus: row.lastSyncStatus,
      lastSyncError: row.lastSyncError,
      source: row.source,
      schemaVersion: row.schemaVersion,
      itemCount: row.itemCount,
    };
  }

  private async writeCache(
    catalog: MarketplaceCatalogFile | null,
    source: "cdn" | "bundled",
    status: "success" | "failure",
    error: string | null,
  ): Promise<MarketplaceCatalogFile | null> {
    if (!catalog) {
      // Failed sync — only update the status row (preserve existing catalog if any)
      const existing = await this.readCache();
      if (existing) {
        await this.db
          .update(marketplaceCatalogCache)
          .set({
            lastSyncedAt: new Date(),
            lastSyncStatus: status,
            lastSyncError: error,
          })
          .where(eq(marketplaceCatalogCache.id, 1));
      }
      return existing;
    }

    // Upsert the singleton row
    await this.db
      .insert(marketplaceCatalogCache)
      .values({
        id: 1,
        schemaVersion: catalog.schemaVersion,
        generatedAt: new Date(catalog.generatedAt),
        itemCount: catalog.itemCount,
        catalogJson: catalog,
        lastSyncedAt: new Date(),
        lastSyncStatus: status,
        lastSyncError: error,
        source,
      })
      .onConflictDoUpdate({
        target: marketplaceCatalogCache.id,
        set: {
          schemaVersion: catalog.schemaVersion,
          generatedAt: new Date(catalog.generatedAt),
          itemCount: catalog.itemCount,
          catalogJson: catalog,
          lastSyncedAt: new Date(),
          lastSyncStatus: status,
          lastSyncError: error,
          source,
        },
      });
    return catalog;
  }
}

// ── Process-wide catalog-service registry ────────────────────────────────────
//
// `MarketplaceCatalogService` is constructed in `app.ts` (it needs the bundled
// snapshot provider, which is an app-layer concern). The company-create path
// lives far below the route layer and cannot reach that instance by
// construction, so app.ts registers it here on boot.
//
// The registry is deliberately allowed to be empty: in unit/integration tests
// nothing registers a service, so `resolveCatalogForBootstrap` degrades to
// "cache only". That is what keeps tests off the network — a test that WANTS
// the marketplace path either seeds `marketplace_catalog_cache` or registers
// its own service instance.

let activeCatalogService: MarketplaceCatalogService | null = null;

/**
 * Register the process-wide catalog service (app.ts on boot). Pass `null` to clear.
 *
 * ⚠️ **Last-writer-wins.** Two `createApp` calls in one process (multi-app
 * tests) would otherwise leave the first instance's 6-hourly `setInterval`
 * running against a DB it no longer owns while the registry points at the
 * second — so registering a DIFFERENT service stops the displaced one's sync
 * loop here. That is the only teardown: a service constructed outside
 * `createApp` and never registered still owns its own lifecycle.
 *
 * Vitest's per-file isolation means no cross-test leak has ever been observed;
 * this is a latent hazard, closed cheaply rather than left named.
 */
export function registerMarketplaceCatalogService(service: MarketplaceCatalogService | null): void {
  if (activeCatalogService && activeCatalogService !== service) {
    activeCatalogService.stopSyncLoop();
  }
  activeCatalogService = service;
}

export function getMarketplaceCatalogService(): MarketplaceCatalogService | null {
  return activeCatalogService;
}

/**
 * Resolve a catalog for the company-create crew bootstrap:
 * cached catalog → (if a service is registered) a bounded wait on the live
 * sync, which itself falls back to the bundled snapshot → unavailable.
 *
 * Never throws: a marketplace outage cannot break onboarding. An `unavailable`
 * result carries WHY, so a wiring regression (`no-service-registered`) is not
 * mistaken for a CDN blip in the logs (R7).
 *
 * ⚠️ `db` is used ONLY when no service is registered — with one registered,
 * `ensureCatalogAvailable` owns the read (R10). In production a service is
 * always registered, so in production `db` goes unused and `cache-read-error`
 * is unreachable; both exist for the no-registry path that tests and any future
 * non-`createApp` entry point take. Do not read `cache-read-error` in a log as
 * "production hit a cache problem" — production cannot produce it.
 */
export async function resolveCatalogForBootstrap(
  db: Db,
  timeoutMs: number = CATALOG_AVAILABILITY_TIMEOUT_MS,
): Promise<CatalogAvailability> {
  const service = activeCatalogService;

  // With a service registered, ensureCatalogAvailable performs the cache read
  // itself — pre-reading here would run the same query + Zod parse twice (R10).
  if (service) {
    try {
      return await service.ensureCatalogAvailable(timeoutMs);
    } catch (err) {
      logger.warn(
        { error: serializeSafeError(err) },
        "marketplace: catalog availability wait failed during crew bootstrap",
      );
      return { status: "unavailable", reason: "sync-unavailable" };
    }
  }

  try {
    const cached = await loadCachedCatalog(db);
    if (cached) return { status: "ok", catalog: cached, source: "cache" };
  } catch (err) {
    logger.warn(
      { error: serializeSafeError(err) },
      "marketplace: cached catalog read failed during crew bootstrap",
    );
    return { status: "unavailable", reason: "cache-read-error" };
  }
  return { status: "unavailable", reason: "no-service-registered" };
}
