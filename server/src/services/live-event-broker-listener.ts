import type { Db } from "@armyofagents/db";
import { sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import {
  parseDurableNotifyPayload,
  type DurableLiveEvent,
  type LiveEventLogStore,
} from "./live-events.js";
import { LIVE_EVENTS_NOTIFY_CHANNEL } from "./live-event-log-store.js";

// MIG-003 — the per-replica broker: one `LISTEN live_events` connection wakes the
// replica to pull the durable-log tail and fan it to that replica's sockets
// (through the WS layer's per-event RBAC + dedup + backpressure path). A bounded
// safety poll pulls any tail a dropped NOTIFY missed — this is what makes broker
// loss a DELAY, not a loss (Invariant 2). The drain logic is split out
// (createBrokerDrainer) so it is unit-testable without a real LISTEN connection.

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DRAIN_LIMIT = 500;

export interface BrokerDrainer {
  /** Pull + fan the tail for one company (NOTIFY-driven or poll-driven). */
  drain(companyId: string, triggerSeq?: number): Promise<void>;
}

/**
 * The pure drain core. Tracks a per-company high-water so it fans ONLY new rows,
 * never re-pulling an already-fanned window. On first sight of a company:
 *   - a NOTIFY-driven drain anchors just below the triggering seq (`triggerSeq-1`)
 *     — the correct low anchor for the wake it received;
 *   - a POLL-driven drain (no triggerSeq) anchors at the retention FLOOR (just
 *     below the oldest retained row), NOT `currentSeq`. Anchoring at `currentSeq`
 *     (the old behavior, defect #5) skipped a tail that had already been appended
 *     but whose NOTIFY was lost under LISTEN loss — the very case the safety poll
 *     exists to recover. The per-socket seq cursor downstream absorbs any re-fan.
 * Events this replica itself published are suppressed via `isLocallyPublished`
 * (they were already delivered seq-less by the local emit) — the robust model's
 * same-replica dedup, so the drainer delivers only peer + catch-up events.
 */
export function createBrokerDrainer(input: {
  store: LiveEventLogStore;
  fanout: (companyId: string, event: DurableLiveEvent) => void;
  /** Suppress events THIS replica published (already emitted locally, seq-less). */
  isLocallyPublished?: (eventId: string | undefined) => boolean;
}): BrokerDrainer {
  const { store, fanout } = input;
  const isLocallyPublished = input.isLocallyPublished ?? (() => false);
  const lastDrained = new Map<string, number>();
  // Coalesce concurrent drains per company so overlapping NOTIFY + poll don't
  // double-pull the same window.
  const inFlight = new Map<string, Promise<void>>();

  async function drainOnce(companyId: string, triggerSeq?: number): Promise<void> {
    let from = lastDrained.get(companyId);
    if (from === undefined) {
      if (triggerSeq !== undefined) {
        from = Math.max(0, triggerSeq - 1);
      } else {
        // Poll first-sight: anchor just below the oldest retained row so a tail
        // whose NOTIFY was dropped is still delivered (defect #5). `retentionFloor`
        // is 0 when nothing is trimmed → anchor 0 → the whole retained tail.
        const floor = await store.retentionFloor(companyId);
        from = Math.max(0, floor - 1);
      }
      lastDrained.set(companyId, from);
    }
    const rows = await store.since(companyId, from, DRAIN_LIMIT);
    for (const row of rows) {
      if (isLocallyPublished(row.eventId)) continue; // same-replica: already emitted
      fanout(companyId, row);
    }
    if (rows.length > 0) {
      lastDrained.set(companyId, rows[rows.length - 1]!.seq);
    }
  }

  return {
    drain(companyId: string, triggerSeq?: number): Promise<void> {
      const running = inFlight.get(companyId);
      if (running) {
        // Chain so a NOTIFY arriving mid-drain re-pulls afterwards (no lost tail).
        const next = running.then(() => drainOnce(companyId, triggerSeq));
        inFlight.set(companyId, next.catch(() => {}));
        return next;
      }
      const started = drainOnce(companyId, triggerSeq).finally(() => {
        if (inFlight.get(companyId) === started) inFlight.delete(companyId);
      });
      inFlight.set(
        companyId,
        started.catch(() => {}),
      );
      return started;
    },
  };
}

export interface LiveEventBrokerListener {
  stop(): Promise<void>;
}

/**
 * Attach the real `LISTEN live_events` connection + safety poll. `activeCompanies`
 * returns the companies this replica currently has sockets for (so the poll is a
 * true backstop even for a company whose very first NOTIFY was dropped). Safe on
 * a single node: a missed NOTIFY is covered by the poll and by reconnect cursors.
 */
export async function attachLiveEventBrokerListener(input: {
  db: Db;
  drainer: BrokerDrainer;
  activeCompanies: () => Iterable<string>;
  pollIntervalMs?: number;
}): Promise<LiveEventBrokerListener> {
  const { db, drainer, activeCompanies } = input;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // postgres-js exposes a dedicated LISTEN connection via `sql.listen`.
  const client = (db as unknown as {
    $client: {
      listen: (
        channel: string,
        onNotify: (payload: string) => void,
      ) => Promise<{ unlisten: () => Promise<void> }>;
    };
  }).$client;

  let subscription: { unlisten: () => Promise<void> } | null = null;
  try {
    subscription = await client.listen(LIVE_EVENTS_NOTIFY_CHANNEL, (payload) => {
      const parsed = parseDurableNotifyPayload(payload);
      if (!parsed) return;
      void drainer.drain(parsed.companyId, parsed.seq).catch((err) => {
        logger.warn({ err, companyId: parsed.companyId }, "live event NOTIFY drain failed");
      });
    });
  } catch (err) {
    // A replica that can't LISTEN still functions via the safety poll below.
    logger.warn({ err }, "live event broker LISTEN attach failed; relying on safety poll");
  }

  const pollTimer = setInterval(() => {
    for (const companyId of activeCompanies()) {
      void drainer.drain(companyId).catch((err) => {
        logger.warn({ err, companyId }, "live event safety-poll drain failed");
      });
    }
  }, pollIntervalMs);
  // Do not keep the process alive solely for the poll.
  (pollTimer as unknown as { unref?: () => void }).unref?.();

  return {
    async stop() {
      clearInterval(pollTimer);
      try {
        await subscription?.unlisten();
      } catch (err) {
        logger.warn({ err }, "live event broker unlisten failed");
      }
    },
  };
}

/** Exposed for the notify-path integration lane. */
export async function notifyRaw(db: Db, payload: string): Promise<void> {
  await db.execute(sql`SELECT pg_notify(${LIVE_EVENTS_NOTIFY_CHANNEL}, ${payload})`);
}
