import { randomUUID } from "node:crypto";
import { and, eq, or, isNull, sql } from "drizzle-orm";
import { companies, companyImportOperations, type Db, type ImportCheckpoint } from "@armyofagents/db";
import { conflict } from "../errors.js";
import { accessService } from "./access.js";
import { companyService } from "./companies.js";

const DEFAULT_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
type CompanyData = Parameters<ReturnType<typeof companyService>["createWithOperator"]>[0];

export async function claimCompanyImport(db: Db, input: {
  operationId: string; fingerprint: string; actorUserId: string | null; company: CompanyData;
}) {
  const organizationId = input.company.organizationId ?? DEFAULT_ORGANIZATION_ID;
  const identity = and(eq(companyImportOperations.organizationId, organizationId),
    eq(companyImportOperations.operationId, input.operationId));
  let [row] = await db.select().from(companyImportOperations).where(identity);
  function assertRequest(candidate: typeof companyImportOperations.$inferSelect | undefined) {
    if (!candidate || candidate.fingerprint !== input.fingerprint || candidate.actorUserId !== input.actorUserId) {
      throw conflict("Import operation does not match this request", { code: "import_conflict", operationId: input.operationId });
    }
  }
  if (!row) {
    // The existing creation request lock serializes company/founder/operation
    // creation. The callback joins that exact transaction, before seeders run.
    try {
      await companyService(db).createWithOperator({ ...input.company, creationRequestId: input.operationId },
        { requestedByUserId: input.actorUserId, validateReplay: async (tx) => {
          const [existing] = await tx.select().from(companyImportOperations).where(identity);
          assertRequest(existing);
        } }, input.actorUserId, (tx) => accessService(tx), async (tx, company) => {
          await tx.insert(companyImportOperations).values({ companyId: company.id, organizationId,
            operationId: input.operationId, actorUserId: input.actorUserId, fingerprint: input.fingerprint });
        });
    } catch (err) {
      if ((err as { details?: { code?: string } })?.details?.code === "import_conflict") throw err;
      throw conflict("Import creation interrupted; retry with the same operation ID and bundle", {
        code: "import_failed", operationId: input.operationId, resumable: true,
      });
    }
    [row] = await db.select().from(companyImportOperations).where(identity);
  }
  assertRequest(row);
  if (!row) throw conflict("Import operation is missing", { code: "import_conflict", operationId: input.operationId });
  const company = (await db.select().from(companies).where(eq(companies.id, row.companyId)))[0];
  const details = { companyId: row.companyId, operationId: input.operationId };
  if (!company) throw conflict("Import company is missing", { ...details, code: "import_conflict" });
  const token = randomUUID();
  if (row.status !== "completed") {
    // Read first so a sibling holding the checkpoint row lock gets an immediate
    // busy answer. The conditional UPDATE remains the authority in a race.
    const [live] = await db.select({ id: companyImportOperations.id }).from(companyImportOperations)
      .where(and(identity, sql`${companyImportOperations.leaseUntil} > clock_timestamp()`));
    if (live) throw conflict("Import is already running; retry this operation later", { ...details, code: "import_busy" });
    const [claimed] = await db.update(companyImportOperations).set({ status: "running", claimToken: token,
      leaseUntil: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: new Date() })
      .where(and(identity, sql`${companyImportOperations.status} <> 'completed'`,
        or(isNull(companyImportOperations.leaseUntil), sql`${companyImportOperations.leaseUntil} <= clock_timestamp()`)))
      .returning();
    if (!claimed) throw conflict("Import claim changed; retry this operation", { ...details, code: "import_busy" });
    row = claimed;
  }
  const operationRowId = row.id;
  let checkpoints = row.checkpoints;
  let completed = row.status === "completed";
  const currentClaim = and(eq(companyImportOperations.id, operationRowId), eq(companyImportOperations.claimToken, token),
    eq(companyImportOperations.status, "running"), sql`${companyImportOperations.leaseUntil} > clock_timestamp()`);

  async function lock(tx: Db) {
    const [owned] = await tx.select().from(companyImportOperations)
      .where(currentClaim).for("update");
    if (!owned) throw conflict("Import lease lost", { ...details, code: "import_busy" });
    return owned;
  }

  return {
    company,
    operationId: input.operationId,
    async checkpoint(key: string, effect: (tx: Db) => Promise<ImportCheckpoint>): Promise<ImportCheckpoint> {
      if (Object.hasOwn(checkpoints, key)) {
        if (!completed) {
          const [saved] = await db.update(companyImportOperations).set({
            leaseUntil: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: new Date(),
          }).where(currentClaim).returning({ id: companyImportOperations.id });
          if (!saved) throw conflict("Import lease lost", { ...details, code: "import_busy" });
        }
        return checkpoints[key];
      }
      if (completed) throw conflict("Import checkpoint missing", { ...details, code: "import_conflict" });
      const value = await db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as Db;
        const owned = await lock(tx);
        if (Object.hasOwn(owned.checkpoints, key)) return owned.checkpoints[key];
        const result = await effect(tx);
        const next = { ...owned.checkpoints, [key]: result };
        const [saved] = await tx.update(companyImportOperations).set({ checkpoints: next,
          leaseUntil: sql`clock_timestamp() + interval '60 seconds'`, updatedAt: new Date() }).where(currentClaim).returning({ id: companyImportOperations.id });
        if (!saved) throw conflict("Import lease lost", { ...details, code: "import_busy" });
        return result;
      });
      checkpoints = { ...checkpoints, [key]: value };
      return value;
    },
    async complete() {
      if (completed) return;
      await db.transaction(async (txHandle) => {
        const tx = txHandle as unknown as Db;
        await lock(tx);
        await tx.update(companies).set({ agentExecutionSetupState: "ready", updatedAt: new Date() }).where(eq(companies.id, company.id));
        const [saved] = await tx.update(companyImportOperations).set({ status: "completed", claimToken: null,
          leaseUntil: null, updatedAt: new Date() }).where(currentClaim).returning({ id: companyImportOperations.id });
        if (!saved) throw conflict("Import lease lost", { ...details, code: "import_busy" });
      });
      completed = true;
    },
    async fail() {
      // No raw exception/source material is persisted or returned. A stale
      // worker cannot change the new owner's status (including failure).
      // An outage may also prevent releasing the claim; expiry still permits
      // recovery, and database exception text must not escape diagnostics.
      await db.update(companyImportOperations).set({ status: "failed", claimToken: null, leaseUntil: null,
        updatedAt: new Date() }).where(currentClaim).catch(() => undefined);
      return conflict("Import interrupted; retry with the same operation ID and bundle", {
        ...details, code: "import_failed", resumable: true,
      });
    },
  };
}
