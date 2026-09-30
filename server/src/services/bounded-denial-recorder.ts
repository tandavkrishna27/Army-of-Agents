import { createHash } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import {
  recordSecurityDenial,
  type SecurityDenialInput,
} from "./security-denial-audit.js";

/**
 * ★ THE WRITE BOUND — E0-F013 Decision 3.2, founder-ruled 2026-09-11.
 *
 * Decision 3.2 sends the fourteen tenant-less deny sites (six `authorizeUpgrade`
 * board/session/`!key` branches, eight plugin-cloud-gate branches) to the
 * operator-only sink (`company_id NULL`, readable only via
 * `GET /instance/security-denials`). Every one of those sites is reachable
 * WITHOUT a valid credential or a validated tenant, and `entityType`/`entityId`
 * on the recorder are caller-supplied free text. So the ruling attached a
 * condition, and it is load-bearing: an UNBOUNDED recorder call at those sites
 * converts fourteen unauthenticated deny paths into fourteen unauthenticated
 * WRITE paths into the operator's ONLY evidence surface. A prober could flood
 * `activity_log` with attacker-chosen rows — cheap to write behind the `0276`
 * partial index, expensive to triage — and drown the real signal.
 * (`DECISION-REQUEST-denial-retention-and-disclosure.md` §5.4, §8 CLASS 2.)
 *
 * This recorder is the bound. It wraps `recordSecurityDenial` with a per-window
 * cap and AGGREGATION: up to `maxRowsPerWindow` full rows land per
 * `(surface, source-key)` bucket per time window, and every further hit in that
 * window is COLLAPSED into a suppressed counter rather than dropped silently.
 * When the window rolls over (the next hit to the bucket, or an explicit
 * `flush`/`sweep`, or an eviction) ONE aggregate row records the suppressed
 * count, so evidence is not lost but the table cannot be flooded. A flood of
 * M ≫ N attempts therefore yields at most N + 1 rows per bucket per window.
 *
 * ★ THE SOURCE KEY MUST BE COARSE AND HARD TO ROTATE. The bucket is keyed on
 * `(surface, sourceKey)`, and the whole bound turns on `sourceKey` being
 * something an attacker cannot trivially vary to mint a fresh bucket per
 * request. It is therefore a COARSE client identifier chosen by the call site
 * (the remote IP, hashed here), NEVER the caller-supplied `companyId`/`entityId`
 * (which a prober varies infinitely — that is exactly the abuse surface the row
 * records). A call site that cannot resolve a coarse key passes `null`, and all
 * such hits share ONE bucket per surface (the strongest bound, safe). The raw
 * key never leaves this module; only a short hash rides the aggregate row.
 *
 * ★ MEMORY IS BOUNDED TOO. A prober rotating the coarse key (e.g. a botnet of
 * IPs) could otherwise grow the bucket map without limit — a second-order flood,
 * against process memory instead of the table. The map is capped at `maxKeys`;
 * inserting past the cap evicts the oldest buckets, FLUSHING any pending
 * suppressed count first so eviction never loses evidence. So the global table
 * growth per window is bounded by `maxKeys * (maxRowsPerWindow + 1)` — finite,
 * whatever the attacker does.
 *
 * ★ IT NEVER THROWS. Like `recordSecurityDenial`, a failure here must not turn a
 * security refusal into a 500 or a denial-of-service lever on the refusal path.
 * Every public method swallows and logs; the deny path stands whatever happens.
 *
 * ★ M1 IS IN-MEMORY AND PROCESS-LOCAL, deliberately, and this is written down
 * rather than hidden. The bucket state lives in this process and resets on
 * restart; across replicas each process holds its own cap, so the effective
 * per-window ceiling is `replicas * maxKeys * (maxRowsPerWindow + 1)`. A
 * restart also drops any un-flushed suppressed tail of a flood that had already
 * stopped. A durable / cross-replica bound (a shared counter store) is the
 * follow-up; the property M1 DOES guarantee — no single process can be made to
 * write unboundedly into `activity_log` from these sites — is the one the
 * founder's condition names.
 */

/** Reason code stamped on the aggregate row that records a suppressed flood. */
export const SUPPRESSED_DENIALS_REASON = "rate_limit_suppressed";
/** Entity type of the aggregate row (its entity id is the hashed source key). */
export const SUPPRESSED_DENIALS_ENTITY_TYPE = "denial_rate_limit";

/** Default cap of full rows written per `(surface, source-key)` bucket per window. */
export const DEFAULT_MAX_ROWS_PER_WINDOW = 50;
/** Default window length. A legitimate client does not earn 50 refusals a minute. */
export const DEFAULT_WINDOW_MS = 60_000;
/** Default cap on live buckets, bounding the map's memory against key rotation. */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * The persistence seam. Defaults to the real `recordSecurityDenial`; a test
 * injects a counting fake so the bound can be proven with no database at all.
 */
export type DenialSink = (
  db: Db,
  input: SecurityDenialInput,
) => Promise<string | null>;

export interface BoundedDenialRecorderOptions {
  maxRowsPerWindow?: number;
  windowMs?: number;
  maxKeys?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable persistence seam. Defaults to `recordSecurityDenial`. */
  sink?: DenialSink;
}

/** The input to a bounded denial: a normal denial plus the coarse source key. */
export type BoundedDenialInput = SecurityDenialInput & {
  /**
   * The COARSE client identifier this refusal came from — the remote IP, or any
   * shape an attacker cannot cheaply rotate. NEVER `companyId`/`entityId`. `null`
   * or empty means "unknown", which shares one bucket per surface.
   */
  sourceKey?: string | null;
};

export interface BoundedDenialResult {
  /** `"recorded"` — a full row was written; `id` is its row id (or null if the
   * sink itself could not write). `"suppressed"` — the window cap was already
   * reached and this hit was counted into the aggregate instead. */
  outcome: "recorded" | "suppressed";
  id: string | null;
}

interface Bucket {
  windowStartMs: number;
  written: number;
  suppressed: number;
  /** A representative denial kept so the aggregate row carries real attribution. */
  sample: {
    crossing: string;
    surface: string;
    reason: string;
    actorType: SecurityDenialInput["actorType"];
    actorId: string;
    control: string;
  } | null;
  /** The hashed source key, so the aggregate names the bucket without the raw IP. */
  sourceKeyHash: string;
}

function hashSourceKey(sourceKey: string | null | undefined): string {
  const raw = sourceKey && sourceKey.length > 0 ? sourceKey : "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export interface BoundedDenialRecorder {
  record(db: Db, input: BoundedDenialInput): Promise<BoundedDenialResult>;
  /** Emit an aggregate row for every bucket with a pending suppressed count and
   * reset it. Returns how many aggregate rows were written. */
  flush(db: Db): Promise<number>;
  /** Flush and drop every bucket whose window has fully elapsed at `now`. For a
   * future periodic sweeper; returns how many aggregate rows were written. */
  sweep(db: Db, now?: number): Promise<number>;
  /** Test/diagnostic: current live bucket count. */
  size(): number;
  /** Test-only: clear all in-memory state. */
  reset(): void;
}

export function createBoundedDenialRecorder(
  options: BoundedDenialRecorderOptions = {},
): BoundedDenialRecorder {
  const maxRowsPerWindow = Math.max(0, options.maxRowsPerWindow ?? DEFAULT_MAX_ROWS_PER_WINDOW);
  const windowMs = Math.max(1, options.windowMs ?? DEFAULT_WINDOW_MS);
  const maxKeys = Math.max(1, options.maxKeys ?? DEFAULT_MAX_KEYS);
  const now = options.now ?? (() => Date.now());
  const sink = options.sink ?? recordSecurityDenial;

  // Insertion-ordered so eviction can drop the oldest bucket first (JS Map keeps
  // insertion order). Refreshed to the tail on each touch (delete + re-set).
  const buckets = new Map<string, Bucket>();

  function bucketKey(surface: string, sourceKeyHash: string): string {
    return `${surface}::${sourceKeyHash}`;
  }

  /** Write ONE aggregate row for a bucket's pending suppressed count. Best-effort. */
  async function emitAggregate(db: Db, bucket: Bucket): Promise<boolean> {
    if (bucket.suppressed <= 0 || !bucket.sample) return false;
    const suppressedCount = bucket.suppressed;
    const sample = bucket.sample;
    try {
      await sink(db, {
        companyId: null,
        organizationId: null,
        crossing: sample.crossing,
        surface: sample.surface,
        reason: SUPPRESSED_DENIALS_REASON,
        actorType: sample.actorType,
        actorId: sample.actorId,
        entityType: SUPPRESSED_DENIALS_ENTITY_TYPE,
        entityId: bucket.sourceKeyHash,
        control: sample.control,
        details: {
          suppressedCount,
          windowMs,
          windowStartMs: bucket.windowStartMs,
          representativeReason: sample.reason,
          representativeControl: sample.control,
          sourceKeyHash: bucket.sourceKeyHash,
          bound: "per-surface-per-source",
        },
      });
    } catch (err) {
      logger.error(
        {
          service: "bounded-denial-recorder",
          event: "denial_aggregate_write_failed",
          surface: sample.surface,
          suppressedCount,
        },
        "failed to record a suppressed-denial aggregate — the bound held but this window's suppressed count is now unattributable",
      );
      return false;
    }
    return true;
  }

  /** Evict the oldest buckets until the map is under `maxKeys`, flushing each. */
  async function evictIfNeeded(db: Db): Promise<void> {
    while (buckets.size >= maxKeys) {
      const oldest = buckets.keys().next();
      if (oldest.done) return;
      const key = oldest.value;
      const bucket = buckets.get(key);
      buckets.delete(key);
      if (bucket) await emitAggregate(db, bucket);
    }
  }

  return {
    async record(db: Db, input: BoundedDenialInput): Promise<BoundedDenialResult> {
      try {
        const nowMs = now();
        const sourceKeyHash = hashSourceKey(input.sourceKey);
        const key = bucketKey(input.surface, sourceKeyHash);

        let bucket = buckets.get(key);
        if (bucket && nowMs - bucket.windowStartMs >= windowMs) {
          // ★ CLAIM-THEN-AWAIT. Window rolled over. The reset MUST happen
          // synchronously — in this same tick, before any `await` — or the bound
          // is bypassed under concurrency: `await emitAggregate` yields the event
          // loop, and every other denial that arrived after the window expired
          // would observe the SAME still-expired bucket, each roll it over, each
          // emit an aggregate AND each claim a fresh full-row slot (with cap 1, N
          // concurrent rollovers → N aggregates + N full rows). So we SNAPSHOT the
          // prior window's tail into a local, put the SHARED bucket into the new
          // window immediately (no await between the check and the reset), and only
          // THEN await the aggregate off the private snapshot. A concurrent caller
          // now sees `windowStartMs === nowMs` and does not roll over — exactly one
          // rollover happens, so at most one aggregate + at most `maxRowsPerWindow`
          // full rows are written per bucket per window even under N parallel calls.
          const priorWindow: Bucket = {
            windowStartMs: bucket.windowStartMs,
            written: bucket.written,
            suppressed: bucket.suppressed,
            sample: bucket.sample,
            sourceKeyHash: bucket.sourceKeyHash,
          };
          bucket.windowStartMs = nowMs;
          bucket.written = 0;
          bucket.suppressed = 0;
          bucket.sample = null;
          await emitAggregate(db, priorWindow);
        }

        if (!bucket) {
          await evictIfNeeded(db);
          bucket = {
            windowStartMs: nowMs,
            written: 0,
            suppressed: 0,
            sample: null,
            sourceKeyHash,
          };
        }

        // Refresh recency: re-insert at the tail so eviction targets true LRU.
        buckets.delete(key);
        buckets.set(key, bucket);

        if (bucket.written < maxRowsPerWindow) {
          // ★ CLAIM-THEN-AWAIT (full-row path). The slot is claimed SYNCHRONOUSLY
          // — `written` is incremented BEFORE the `await`, so a concurrent
          // invocation that runs its own synchronous prefix during this await sees
          // the already-incremented count and cannot also claim the same slot. The
          // cap therefore holds even when N calls race the boundary.
          bucket.written += 1;
          const id = await sink(db, stripSourceKey(input));
          return { outcome: "recorded", id };
        }

        // Over the cap: count into the aggregate instead of writing a row. The
        // suppressed increment is likewise synchronous (no await), so a race adds
        // to the same counter rather than minting extra aggregate rows.
        bucket.suppressed += 1;
        if (!bucket.sample) {
          bucket.sample = {
            crossing: input.crossing,
            surface: input.surface,
            reason: input.reason,
            actorType: input.actorType,
            actorId: input.actorId,
            control: input.control,
          };
        }
        return { outcome: "suppressed", id: null };
      } catch (err) {
        logger.error(
          {
            service: "bounded-denial-recorder",
            event: "bounded_denial_record_failed",
            surface: input.surface,
            crossing: input.crossing,
          },
          "bounded denial recorder threw — the refusal still stands, but it is now unattributable",
        );
        return { outcome: "recorded", id: null };
      }
    },

    async flush(db: Db): Promise<number> {
      let emitted = 0;
      for (const bucket of buckets.values()) {
        if (await emitAggregate(db, bucket)) emitted += 1;
        bucket.suppressed = 0;
        bucket.sample = null;
      }
      return emitted;
    },

    async sweep(db: Db, sweepNow?: number): Promise<number> {
      const nowMs = sweepNow ?? now();
      let emitted = 0;
      for (const [key, bucket] of [...buckets.entries()]) {
        if (nowMs - bucket.windowStartMs < windowMs) continue;
        if (await emitAggregate(db, bucket)) emitted += 1;
        buckets.delete(key);
      }
      return emitted;
    },

    size(): number {
      return buckets.size;
    },

    reset(): void {
      buckets.clear();
    },
  };
}

/** The `sourceKey` is a bucketing input only; it must not reach the row. */
function stripSourceKey(input: BoundedDenialInput): SecurityDenialInput {
  const { sourceKey: _sourceKey, ...rest } = input;
  return rest;
}

/**
 * The shared process-wide bound. The fourteen tenant-less sites all record
 * through this instance, so a single `maxKeys` cap bounds the whole process's
 * denial-write memory and one sweep drains every surface.
 */
export const sharedBoundedDenialRecorder: BoundedDenialRecorder =
  createBoundedDenialRecorder();
