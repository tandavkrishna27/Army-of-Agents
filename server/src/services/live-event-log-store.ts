import { and, asc, eq, gt, lte, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, liveEventLog, liveEventSequences } from "@armyofagents/db";
import type { LiveEventType } from "@armyofagents/shared";
import { withTenantTx } from "../db/with-tenant-tx.js";
import {
  buildDurableNotifyPayload,
  type DurableAppendRecord,
  type DurableLiveEvent,
  type LiveEventLogStore,
} from "./live-events.js";

// MIG-003 — the Postgres-backed durable-log store. It is the ONLY writer of
// `live_event_log` / `live_event_sequences` and the reader for cross-replica
// fan-out + `?sinceSeq=N` catch-up. Every write runs under tenant context
// (`withTenantTx` sets `aoa.organization_id`) so the FORCE-RLS tenant policy is
// satisfied whether the serving role is the owner (default deployment) or
// `aoa_app` (distributed). The per-company seq is assigned CONTIGUOUSLY by
// bumping the `live_event_sequences` counter with `UPDATE ... RETURNING` in the
// same tx as the insert (serialized on the company row), mirroring the
// discussions `entrySeq` pattern — never a global Postgres sequence.

const NOTIFY_CHANNEL = "live_events";

const DEFAULT_SINCE_LIMIT = 500;

export const LIVE_EVENTS_NOTIFY_CHANNEL = NOTIFY_CHANNEL;

function projectRow(row: {
  companyId: string;
  seq: number;
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}): DurableLiveEvent {
  return {
    // `id` is the durable seq for the React list key on the replay path (the
    // process-local counter is only meaningful for same-replica local emits).
    id: row.seq,
    companyId: row.companyId,
    type: row.type as LiveEventType,
    createdAt: row.createdAt.toISOString(),
    payload: row.payload ?? {},
    seq: row.seq,
    // Carried so the per-replica drainer can suppress same-replica-origin events.
    eventId: row.eventId,
  };
}

/** Retain the last N events per company by default (bounded-growth trim). */
const DEFAULT_RETENTION_WINDOW = 5_000;

export function createLiveEventLogStore(db: Db): LiveEventLogStore {
  // companyId → organizationId cache. Company↔org binding is immutable, so a
  // hit never goes stale; a miss resolves once and memoizes.
  const orgByCompany = new Map<string, string>();

  async function resolveOrganizationId(companyId: string): Promise<string | null> {
    const cached = orgByCompany.get(companyId);
    if (cached) return cached;
    const [row] = await db
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!row?.organizationId) return null;
    orgByCompany.set(companyId, row.organizationId);
    return row.organizationId;
  }

  return {
    async append(record: DurableAppendRecord): Promise<number | null> {
      const organizationId = await resolveOrganizationId(record.companyId);
      if (!organizationId) return null;

      return withTenantTx(db, organizationId, async (tx) => {
        // Atomic per-company counter bump — serializes concurrent publishers on
        // the company row so seq stays contiguous. Seeds the row at 1 on first use.
        const [{ nextSeq }] = await tx
          .insert(liveEventSequences)
          .values({ companyId: record.companyId, organizationId, nextSeq: 1 })
          .onConflictDoUpdate({
            target: liveEventSequences.companyId,
            set: {
              nextSeq: sql`${liveEventSequences.nextSeq} + 1`,
              updatedAt: new Date(),
            },
          })
          .returning({ nextSeq: liveEventSequences.nextSeq });

        const seq = nextSeq;

        const inserted = await tx
          .insert(liveEventLog)
          .values({
            organizationId,
            companyId: record.companyId,
            seq,
            eventId: record.eventId,
            type: record.type,
            payload: record.payload,
          })
          // Idempotent re-delivery of the SAME event id is a no-op append.
          .onConflictDoNothing({
            target: [liveEventLog.organizationId, liveEventLog.eventId],
          })
          .returning({ seq: liveEventLog.seq });

        if (inserted.length > 0) return inserted[0]!.seq;

        // eventId already present (idempotent redelivery): return its original
        // seq. The counter bump above burned this seq — an acceptable rare gap,
        // exactly as the discussions entrySeq path tolerates (a monotonic cursor
        // only requires strict increase, not perfect density).
        const [existing] = await tx
          .select({ seq: liveEventLog.seq })
          .from(liveEventLog)
          .where(
            and(
              eq(liveEventLog.organizationId, organizationId),
              eq(liveEventLog.eventId, record.eventId),
            ),
          )
          .limit(1);
        return existing?.seq ?? null;
      });
    },

    async notify(companyId: string, seq: number): Promise<void> {
      // Data-free wake (D7): only `(companyId, seq)`. `pg_notify` runs outside a
      // tenant tx — it carries no row data, so no RLS concern.
      await db.execute(
        sql`SELECT pg_notify(${NOTIFY_CHANNEL}, ${buildDurableNotifyPayload(companyId, seq)})`,
      );
    },

    async since(
      companyId: string,
      sinceSeq: number,
      limit: number = DEFAULT_SINCE_LIMIT,
    ): Promise<DurableLiveEvent[]> {
      const organizationId = await resolveOrganizationId(companyId);
      if (!organizationId) return [];
      return withTenantTx(db, organizationId, async (tx) => {
        const rows = await tx
          .select({
            companyId: liveEventLog.companyId,
            seq: liveEventLog.seq,
            eventId: liveEventLog.eventId,
            type: liveEventLog.type,
            payload: liveEventLog.payload,
            createdAt: liveEventLog.createdAt,
          })
          .from(liveEventLog)
          .where(
            and(eq(liveEventLog.companyId, companyId), gt(liveEventLog.seq, sinceSeq)),
          )
          .orderBy(asc(liveEventLog.seq))
          .limit(limit);
        return rows.map(projectRow);
      });
    },

    async retentionFloor(companyId: string): Promise<number> {
      const organizationId = await resolveOrganizationId(companyId);
      if (!organizationId) return 0;
      return withTenantTx(db, organizationId, async (tx) => {
        const [row] = await tx
          .select({ minSeq: sql<number | null>`min(${liveEventLog.seq})` })
          .from(liveEventLog)
          .where(eq(liveEventLog.companyId, companyId));
        return row?.minSeq ?? 0;
      });
    },

    async currentSeq(companyId: string): Promise<number> {
      const organizationId = await resolveOrganizationId(companyId);
      if (!organizationId) return 0;
      // The sequence counter is authoritative for the high-water mark; fall back
      // to the log itself if the counter row hasn't been seeded yet.
      return withTenantTx(db, organizationId, async (tx) => {
        const [row] = await tx
          .select({ nextSeq: liveEventSequences.nextSeq })
          .from(liveEventSequences)
          .where(eq(liveEventSequences.companyId, companyId))
          .limit(1);
        return row?.nextSeq ?? 0;
      });
    },

    async trimRetention(
      retainWindow: number = DEFAULT_RETENTION_WINDOW,
      extraCompanies: Iterable<string> = [],
    ): Promise<number> {
      // Gather (companyId → organizationId) to trim. The `live_event_sequences`
      // self-read has ONE row per company; on a superuser/owner deployment it
      // returns every company (RLS bypass → GLOBAL trim), and on the distributed
      // aoa_app role (FORCE-RLS, no org GUC set here) it returns nothing, so the
      // `extraCompanies` set (this replica's active companies) drives the trim
      // there — bounded for the companies actually generating events.
      const targets = new Map<string, string>();
      try {
        const rows = await db
          .select({
            companyId: liveEventSequences.companyId,
            organizationId: liveEventSequences.organizationId,
          })
          .from(liveEventSequences);
        for (const r of rows) {
          if (r.companyId && r.organizationId) targets.set(r.companyId, r.organizationId);
        }
      } catch {
        // A read failure here is non-fatal — fall through to extraCompanies.
      }
      for (const companyId of extraCompanies) {
        if (targets.has(companyId)) continue;
        const organizationId = await resolveOrganizationId(companyId);
        if (organizationId) targets.set(companyId, organizationId);
      }

      let deleted = 0;
      for (const [companyId, organizationId] of targets) {
        deleted += await withTenantTx(db, organizationId, async (tx) => {
          // The counter's next_seq IS the max assigned seq (seeded at 1, bumped
          // +1 per append), so cutoff = maxSeq − window keeps the last `window`.
          const [seqRow] = await tx
            .select({ nextSeq: liveEventSequences.nextSeq })
            .from(liveEventSequences)
            .where(eq(liveEventSequences.companyId, companyId))
            .limit(1);
          const maxSeq = seqRow?.nextSeq ?? 0;
          const cutoff = maxSeq - retainWindow;
          if (cutoff <= 0) return 0;
          const result = await tx
            .delete(liveEventLog)
            .where(and(eq(liveEventLog.companyId, companyId), lte(liveEventLog.seq, cutoff)));
          return (result as unknown as { rowCount?: number }).rowCount ?? 0;
        });
      }
      return deleted;
    },
  };
}
