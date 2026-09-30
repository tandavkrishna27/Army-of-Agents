/**
 * @fileoverview `connectors.json` fetch + cache — the read side of the curated
 * connector shelf.
 *
 * DELIBERATELY IN-MEMORY. The connector catalog is a small file read on a
 * founder-facing page; persisting it would cost a migration and a cache table
 * for no behaviour a process-lifetime cache does not already give us. The
 * trade-off is explicit: a restarted instance re-fetches, and an OFFLINE
 * instance shows an EMPTY shelf. That is correct degradation, not a bug — an
 * empty shelf is honest, and nothing here touches `catalog.json` (the
 * marketplace catalog stays on its own DB-backed sync path either way; see the
 * separation rationale in `@armyofagents/shared`'s `mcp-connector-catalog.ts`).
 *
 * THE `malformed` FLAG IS THE POINT OF THIS MODULE. `parseMcpConnectorCatalog`
 * reports it precisely so this layer can distinguish two states that
 * `entries.length === 0` cannot:
 *
 *   - `malformed: true`  — the envelope was unintelligible (a 404 HTML page, a
 *     truncated body, a redirect to a login wall). This is NOT an answer about
 *     what the shelf contains, so it must be treated exactly like a network
 *     failure: KEEP the last known-good entries and report `stale: true`. If we
 *     let it through, a single bad CDN deploy would silently empty every
 *     instance's shelf.
 *   - `malformed: false` with zero entries — the CDN really did say "no
 *     connectors". A curator removing every entry (a bad connector pulled for
 *     cause, say) is a real, intentional state and MUST propagate, otherwise a
 *     withdrawn connector keeps being offered from a stale cache forever.
 *
 * Per-entry drops are a third, milder case: the envelope was understood and
 * every item was accounted for, so the result replaces the cache and we warn
 * with the dropped ids. Forward-compat property: a future entry shape we do not
 * understand costs us that entry, never the file.
 *
 * `nowMs` is injected rather than read from `Date.now()` so TTL behaviour is
 * testable without fake timers.
 *
 * NOT DONE HERE, on purpose: no in-flight de-duplication and no failure
 * backoff. Consecutive loads past the TTL each attempt a fetch (bounded by
 * `FETCH_TIMEOUT_MS`). Both would be worth adding if the shelf ever moves onto
 * a hot path; today it is one founder-facing page.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseMcpConnectorCatalog,
  type McpConnectorCatalogEntry,
} from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";
import {
  isMcpConnectorBlocked,
  readMcpConnectorEmergencyPolicy,
} from "./mcp-connector-emergency-policy.js";

/**
 * A SECOND CDN artifact alongside `catalog.json`, never inside it — see the
 * separation rationale in the file header and in `@armyofagents/shared`'s
 * `mcp-connector-catalog.ts`.
 *
 * A plain constant with no env override, matching `DEFAULT_CDN_URL` in
 * `aoa-marketplace.ts`. Overriding is done by injecting `url` here (tests) or a
 * whole `ConnectorCatalogService` into the route factory — not by an env var,
 * which would need documenting for CI's undocumented-env guard and would give
 * an operator a way to point the shelf at an arbitrary host.
 */
export const DEFAULT_CONNECTOR_CATALOG_URL =
  "https://meteoritelabs.github.io/aoa-marketplace-cdn/connectors.json";

/** Matches the marketplace catalog sync cadence. */
export const CONNECTOR_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Bounded so a hanging CDN degrades to the "offline" path instead of holding a
 * request open. Without this the empty-shelf guarantee above would not hold.
 */
const FETCH_TIMEOUT_MS = 15_000;

export interface ConnectorCatalogLoadResult {
  entries: McpConnectorCatalogEntry[];
  /** True whenever the entries are NOT from a successful fetch this cycle. */
  stale: boolean;
}

export interface ConnectorCatalogService {
  load(nowMs: number): Promise<ConnectorCatalogLoadResult>;
}

export function applyConnectorEmergencyPolicy(
  service: ConnectorCatalogService,
): ConnectorCatalogService {
  return {
    async load(nowMs: number): Promise<ConnectorCatalogLoadResult> {
      const result = await service.load(nowMs);
      const policy = readMcpConnectorEmergencyPolicy();
      return {
        ...result,
        entries: result.entries.filter(
          (entry) => !isMcpConnectorBlocked(entry.serverName, policy),
        ),
      };
    },
  };
}

export function createConnectorCatalogService(opts: {
  url: string;
  fetchFn?: typeof fetch;
  /**
   * Build-time bundled snapshot (offline/air-gapped fallback). Used ONLY when the
   * live cache has never been populated (the CDN was unreachable on the very first
   * load) — an online instance that has fetched even once serves its own cache and
   * never touches this. Mirrors the main catalog's `bundledSnapshotProvider`
   * (app.ts). Absent/empty → the shelf degrades to empty, exactly as before.
   */
  snapshot?: readonly McpConnectorCatalogEntry[];
}): ConnectorCatalogService {
  const doFetch = opts.fetchFn ?? fetch;

  let cached: McpConnectorCatalogEntry[] | null = null;
  let fetchedAtMs = 0;

  /**
   * Last known-good; else the bundled snapshot if we have one and have never
   * fetched successfully; else an empty shelf. Always a copy. `stale: true` — a
   * cache/snapshot result is by definition not a fresh CDN answer.
   */
  const serveCache = (): ConnectorCatalogLoadResult => {
    if (cached) return { entries: [...cached], stale: true };
    if (opts.snapshot && opts.snapshot.length > 0) {
      return { entries: [...opts.snapshot], stale: true };
    }
    return { entries: [], stale: true };
  };

  return {
    async load(nowMs: number): Promise<ConnectorCatalogLoadResult> {
      if (cached !== null && nowMs - fetchedAtMs < CONNECTOR_CATALOG_TTL_MS) {
        return { entries: [...cached], stale: false };
      }

      let body: unknown;
      try {
        const res = await doFetch(opts.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) {
          // Do not parse an error body — an HTML 503 page must never be able to
          // be read as "the shelf is empty".
          throw new Error(`HTTP ${res.status}`);
        }
        body = await res.json();
      } catch (err) {
        logger.warn(
          { err, url: opts.url, hasCache: cached !== null },
          "connector catalog: fetch failed — serving last known-good shelf",
        );
        return serveCache();
      }

      const { entries, dropped, malformed } = parseMcpConnectorCatalog(body);

      if (malformed) {
        // Unintelligible envelope: NOT an answer about the shelf's contents.
        // Keep whatever we already had. Notably we also do NOT refresh
        // `fetchedAtMs`, so the next load retries rather than pinning garbage
        // in place for six hours.
        logger.warn(
          { url: opts.url, hasCache: cached !== null },
          "connector catalog: malformed response envelope — keeping cached shelf",
        );
        return serveCache();
      }

      // FU-22 — kept-ZERO but dropped-MANY is NOT a real "empty shelf" answer.
      // Every raw entry failed to parse (a schema we tighten later, or a genuinely
      // malformed publish that `.strip()` cannot rescue), so treat it exactly like a
      // malformed envelope: keep the last known-good cache, report `stale: true`, and
      // do NOT refresh `fetchedAtMs` (so the next load retries rather than pinning an
      // empty shelf for the full TTL). This is the backstop behind the schema's
      // `.strip()`: `.strip()` stops an ADDITIVE field from ever reaching here, and
      // this stops the NEXT class (a genuinely unparseable batch) from blanking the
      // shelf. A LEGITIMATELY empty shelf (`dropped.length === 0`) still replaces the
      // cache below — a curator withdrawing every connector is a real, intended state.
      if (entries.length === 0 && dropped.length > 0) {
        logger.warn(
          { url: opts.url, dropped, hasCache: cached !== null },
          "connector catalog: every entry was dropped — keeping cached shelf",
        );
        return serveCache();
      }

      if (dropped.length > 0) {
        logger.warn(
          { url: opts.url, dropped, kept: entries.length },
          "connector catalog: dropped unparseable entries",
        );
      }

      // Real answer from the CDN — including a legitimately empty one.
      cached = entries;
      fetchedAtMs = nowMs;
      return { entries: [...entries], stale: false };
    },
  };
}

/**
 * The service the app actually wires up.
 *
 * E2E SEAM (`AOA_E2E_CONNECTOR_CATALOG_PATH`). The shelf's whole input is a
 * remote file on a 6h TTL, so an end-to-end browse→install→bind journey has no
 * deterministic shelf to browse — and `install` resolves `entryId` against the
 * SERVER's catalog, so faking the response in the browser would only produce a
 * 404 at the write. The seam is a local FILE PATH, deliberately not a URL: it
 * cannot point a deployment's shelf at an arbitrary host, which is exactly the
 * reason `DEFAULT_CONNECTOR_CATALOG_URL` has no env override. Same shape and the
 * same `NODE_ENV !== "production"` fuse as the other `AOA_E2E_FAKE_*` harness
 * seams (see `AOA_E2E_FAKE_EMBEDDER`), and documented in
 * `docs/deploy/environment-variables.md`.
 *
 * It injects a `fetchFn` rather than a whole service so the fixture path runs
 * through the SAME parse, drop, malformed and cache logic as the CDN path — a
 * bypass would make the e2e prove something production never does.
 */
/**
 * Best-effort synchronous read of the build-time bundled connector snapshot
 * (`ui/src/aoa-connectors-snapshot.json`, gitignored — written by
 * `pnpm fetch-connectors` before boot, mirroring `fetch-catalog`). Returns the
 * validated entries, or `undefined` if the file is absent/unreadable/malformed.
 *
 * Reused via `parseMcpConnectorCatalog`, so a drifted snapshot drops its bad
 * entries exactly like the CDN path rather than crashing the boot. The path is
 * three levels up from this module in both `server/src/services` (dev, tsx) and
 * `server/dist/services` (prod) — identical depth — so one relative path works
 * for both. Any failure is swallowed: the snapshot is a pure fallback and must
 * never fail the server if it is missing (the common case until connectors are
 * published).
 */
function loadBundledConnectorSnapshot(): readonly McpConnectorCatalogEntry[] | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const snapshotPath = join(here, "..", "..", "..", "ui", "src", "aoa-connectors-snapshot.json");
    const body = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const { entries } = parseMcpConnectorCatalog(body);
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
}

export function resolveConnectorCatalogService(): ConnectorCatalogService {
  const fixturePath = process.env.AOA_E2E_CONNECTOR_CATALOG_PATH?.trim();
  if (fixturePath && process.env.NODE_ENV !== "production") {
    logger.warn({ fixturePath }, "connector catalog: serving E2E fixture instead of the CDN");
    return applyConnectorEmergencyPolicy(createConnectorCatalogService({
      url: fixturePath,
      fetchFn: async (input) => {
        const { readFile } = await import("node:fs/promises");
        const body = await readFile(String(input), "utf8");
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }));
  }
  return applyConnectorEmergencyPolicy(createConnectorCatalogService({
    url: DEFAULT_CONNECTOR_CATALOG_URL,
    snapshot: loadBundledConnectorSnapshot(),
  }));
}
