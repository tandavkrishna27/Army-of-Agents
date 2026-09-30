/**
 * @fileoverview CRUD layer for marketplace_install_operations table.
 *
 * Pure data access — no orchestration, no live-events, no installer dispatch.
 * The orchestrator (orchestrator.ts) sits one layer above and composes these
 * primitives with the installers.
 *
 * Idempotency: 24h window enforced in app via createdAt cutoff (not DB
 * constraint, since the unique index is unbounded — see schema for details).
 */

import { eq, and, gt, lt, or, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { marketplaceInstallOperations } from "@armyofagents/db";
import type { CascadeStepResult } from "@armyofagents/db";
import type { CatalogItem } from "@armyofagents/shared";

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OperationRow {
  id: string;
  companyId: string;
  catalogItemId: string;
  itemType: "plugin" | "skill" | "agent" | "team" | "package";
  targetDepartmentId: string | null;
  status: "pending" | "running" | "success" | "failure" | "requested";
  resultEntityId: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  errorDocs: string | null;
  cascadeResults: CascadeStepResult[] | null;
  idempotencyKey: string | null;
  requestedByUserId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export interface CreateOperationInput {
  companyId: string;
  catalogItem: CatalogItem;
  targetDepartmentId?: string;
  idempotencyKey?: string;
  requestedByUserId: string;
}

export interface CreatePackageOperationInput {
  companyId: string;
  packageId: string;
  targetDepartmentId?: string;
  idempotencyKey?: string;
  requestedByUserId: string;
}

/**
 * Look up a recent operation by idempotency key (within 24h window).
 * Returns null if no match — caller proceeds with createOperation.
 */
export async function findExistingByIdempotencyKey(
  db: Db,
  companyId: string,
  idempotencyKey: string,
): Promise<OperationRow | null> {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
  const rows = await db
    .select()
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, companyId),
        eq(marketplaceInstallOperations.idempotencyKey, idempotencyKey),
        gt(marketplaceInstallOperations.createdAt, cutoff),
      ),
    )
    .limit(1);
  return (rows[0] as OperationRow | undefined) ?? null;
}

/**
 * Insert a new operation row in `pending` status.
 *
 * Uses `.onConflictDoNothing().returning()` so that a stale idempotency-key
 * row (past the 24h app-level window but still present in the DB's unbounded
 * unique index) does not cause a constraint violation. When the insert is
 * suppressed by the conflict, we fetch and return the existing row so the
 * caller gets a usable OperationRow regardless.
 */
export async function createOperation(db: Db, input: CreateOperationInput): Promise<OperationRow> {
  const [row] = await db
    .insert(marketplaceInstallOperations)
    .values({
      companyId: input.companyId,
      catalogItemId: input.catalogItem.id,
      itemType: input.catalogItem.type,
      targetDepartmentId: input.targetDepartmentId ?? null,
      status: "pending",
      idempotencyKey: input.idempotencyKey ?? null,
      requestedByUserId: input.requestedByUserId,
    })
    // ON CONFLICT DO NOTHING (targetless form): Drizzle cannot express partial-index
    // predicates in a conflict target, so we suppress any constraint violation on this
    // insert. The only expected conflict is the (companyId, idempotencyKey) partial unique
    // index — null idempotencyKey values do not trigger it.
    .onConflictDoNothing()
    .returning();

  if (row) return row as OperationRow;

  // Insert was suppressed by the unique index on (companyId, idempotencyKey).
  // Fetch the existing row so the caller gets a valid OperationRow back.
  const existing = await db
    .select()
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, input.companyId),
        eq(marketplaceInstallOperations.idempotencyKey, input.idempotencyKey!),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    throw new Error(
      `createOperation: idempotency conflict for key "${input.idempotencyKey}" but row not found — possible concurrent delete`,
    );
  }

  return existing[0] as OperationRow;
}

export async function createPackageOperation(
  db: Db,
  input: CreatePackageOperationInput,
): Promise<OperationRow> {
  const [row] = await db
    .insert(marketplaceInstallOperations)
    .values({
      companyId: input.companyId,
      catalogItemId: input.packageId,
      itemType: "package",
      targetDepartmentId: input.targetDepartmentId ?? null,
      status: "pending",
      idempotencyKey: input.idempotencyKey ?? null,
      requestedByUserId: input.requestedByUserId,
    })
    .onConflictDoNothing()
    .returning();

  if (row) return row as OperationRow;

  const existing = await db
    .select()
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.companyId, input.companyId),
        eq(marketplaceInstallOperations.idempotencyKey, input.idempotencyKey!),
      ),
    )
    .limit(1);

  if (!existing[0]) {
    throw new Error(
      `createPackageOperation: idempotency conflict for key "${input.idempotencyKey}" but row not found - possible concurrent delete`,
    );
  }

  return existing[0] as OperationRow;
}

/**
 * Patch an operation row. Only the status-transition columns are writable
 * via this helper — id, companyId, itemType, etc. are immutable by contract.
 */
export async function updateOperation(
  db: Db,
  id: string,
  patch: Partial<Pick<OperationRow, "status" | "resultEntityId" | "errorMessage" | "errorCode" | "errorDocs" | "cascadeResults" | "completedAt">>,
): Promise<void> {
  await db
    .update(marketplaceInstallOperations)
    .set(patch)
    .where(eq(marketplaceInstallOperations.id, id));
}

/**
 * How long an operation may sit in `running` before another caller may assume
 * its owner died. Generous relative to CREW_INSTALL_DEADLINE_MS (30s) so a
 * live install is never stolen mid-flight.
 */
export const OPERATION_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Atomically take ownership of an operation for dispatch.
 *
 * `startInstallOperation` is a check-then-act on the idempotency key: two
 * concurrent callers can both receive the same row while it is still `pending`
 * (the loser's conflict-fetch in {@link createOperation} returns the winner's
 * row before the winner has written `running`), so a status READ cannot decide
 * ownership. This conditional UPDATE can: exactly one caller sees a row back.
 *
 * Claimable:
 * - `pending` — nobody has started it.
 * - `failure` — nobody owns it and nothing was installed, so a repair pass must
 *   be able to retry.
 * - `running` **older than {@link OPERATION_CLAIM_STALE_AFTER_MS}** — the owner
 *   died mid-install. Without this the row is stranded FOREVER: after 24h
 *   `findExistingByIdempotencyKey` misses, `createOperation`'s INSERT trips the
 *   unbounded unique index, `onConflictDoNothing` suppresses it, and the
 *   fallback SELECT (which has no `createdAt` cutoff) hands back the same stale
 *   `running` row — so the caller reports "already dispatched", skips the
 *   legacy seeders too, and the company ends up with NO crew and no repair path.
 *
 * Not claimable: a fresh `running` (someone owns it), `success` (done), and
 * `requested` (a founder-approval state — claiming it would hijack a pending
 * human decision).
 *
 * `startedAt` is reset so the staleness clock measures THIS attempt, and
 * `errorMessage`/`completedAt` are cleared so a retried-and-succeeded operation
 * does not end up `success` still carrying the previous attempt's error text.
 *
 * @returns true if THIS caller now owns the dispatch.
 */
export async function claimOperationForDispatch(db: Db, id: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - OPERATION_CLAIM_STALE_AFTER_MS);
  const rows = await db
    .update(marketplaceInstallOperations)
    .set({
      status: "running",
      startedAt: new Date(),
      errorMessage: null,
      errorCode: null,
      errorDocs: null,
      completedAt: null,
    })
    .where(
      and(
        eq(marketplaceInstallOperations.id, id),
        or(
          inArray(marketplaceInstallOperations.status, ["pending", "failure"]),
          and(
            eq(marketplaceInstallOperations.status, "running"),
            lt(marketplaceInstallOperations.startedAt, staleBefore),
          ),
        ),
      ),
    )
    .returning({ id: marketplaceInstallOperations.id });
  return rows.length > 0;
}

/**
 * Look up an operation by id, scoped to companyId for RBAC isolation.
 * Returns null if the row doesn't exist OR belongs to another company —
 * the route handler maps both to 404 to avoid leaking presence/absence.
 */
export async function findOperationById(db: Db, id: string, companyId: string): Promise<OperationRow | null> {
  const rows = await db
    .select()
    .from(marketplaceInstallOperations)
    .where(
      and(
        eq(marketplaceInstallOperations.id, id),
        eq(marketplaceInstallOperations.companyId, companyId),
      ),
    )
    .limit(1);
  return (rows[0] as OperationRow | undefined) ?? null;
}
