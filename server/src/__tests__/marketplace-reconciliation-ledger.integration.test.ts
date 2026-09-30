import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  type Db,
} from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import {
  MarketplaceReconciliationLeaseLostError,
  marketplaceReconciliationOperationStore,
} from "../services/marketplace-reconcile.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

describe.skipIf(process.platform === "win32")(
  "marketplace reconciliation operation ledger (real PostgreSQL)",
  () => {
    beforeAll(async () => {
      try {
        dataDir = await mkdtemp(
          join(tmpdir(), "aoa-marketplace-reconciliation-ledger-"),
        );
        const { default: EmbeddedPostgres } = (await import(
          "embedded-postgres"
        )) as { default: EmbeddedPostgresCtor };
        const port = await allocateEmbeddedPgPort();
        pg = new EmbeddedPostgres({
          databaseDir: join(dataDir, "db"),
          user: "test",
          password: "test",
          port,
          persistent: false,
          initdbFlags: ["--encoding=UTF8", "--locale=C"],
        });
        await pg.initialise();
        await pg.start();
        const databaseUrl = `postgres://test:test@localhost:${port}/postgres`;
        await applyPendingMigrations(databaseUrl);
        db = createDb(databaseUrl);
      } catch (error) {
        setupError = error;
      }
    }, 180_000);

    afterAll(async () => {
      try {
        if (pg) await pg.stop();
      } finally {
        if (dataDir) {
          await rm(dataDir, { recursive: true, force: true });
        }
      }
    }, 60_000);

    it("enforces one leased fleet operation and fences stale owners", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed: ${String(setupError)}`,
        );
      }

      const firstOperationId = randomUUID();
      const secondOperationId = randomUUID();
      const thirdOperationId = randomUUID();
      const fourthOperationId = randomUUID();
      const fifthOperationId = randomUUID();
      const firstOwnerId = randomUUID();
      const secondOwnerId = randomUUID();
      const thirdOwnerId = randomUUID();
      const fourthOwnerId = randomUUID();
      const fifthOwnerId = randomUUID();
      const actor = { actorType: "user" as const, actorId: "admin-test" };
      const claim = (
        operationId: string,
        leaseOwnerId: string,
        retryOfOperationId?: string,
      ) =>
        marketplaceReconciliationOperationStore.claim({
          db,
          operationId,
          leaseOwnerId,
          actor,
          deploymentSha: "test-sha",
          retryOfOperationId,
        });

      await expect(claim(firstOperationId, firstOwnerId)).resolves.toEqual({
        status: "claimed",
      });
      await expect(claim(firstOperationId, randomUUID())).resolves.toEqual({
        status: "already_exists",
      });
      await expect(claim(secondOperationId, secondOwnerId)).resolves.toEqual({
        status: "operation_in_flight",
        activeOperationId: firstOperationId,
      });

      await marketplaceReconciliationOperationStore.markRunning({
        db,
        operationId: firstOperationId,
        leaseOwnerId: firstOwnerId,
        companyIds: [],
      });
      await expect(
        marketplaceReconciliationOperationStore.finish({
          db,
          operationId: firstOperationId,
          leaseOwnerId: randomUUID(),
          state: "success",
          catalog: null,
        }),
      ).rejects.toBeInstanceOf(MarketplaceReconciliationLeaseLostError);
      await marketplaceReconciliationOperationStore.finish({
        db,
        operationId: firstOperationId,
        leaseOwnerId: firstOwnerId,
        state: "success",
        catalog: null,
      });

      await expect(claim(secondOperationId, secondOwnerId)).resolves.toEqual({
        status: "claimed",
      });
      await db.execute(sql`
        update marketplace_reconciliation_operations
        set lease_expires_at = now() - interval '1 second'
        where operation_id = ${secondOperationId}
      `);

      await expect(claim(thirdOperationId, thirdOwnerId)).resolves.toEqual({
        status: "retry_required",
        requiredOperationId: secondOperationId,
      });
      await expect(
        claim(thirdOperationId, thirdOwnerId, secondOperationId),
      ).resolves.toEqual({
        status: "claimed",
      });
      await expect(
        marketplaceReconciliationOperationStore.load(db, secondOperationId),
      ).resolves.toMatchObject({
        state: "outcome_unknown_after_mutation",
        leaseActive: false,
      });
      await expect(
        marketplaceReconciliationOperationStore.load(db, thirdOperationId),
      ).resolves.toMatchObject({
        state: "claimed",
        leaseActive: true,
      });

      await marketplaceReconciliationOperationStore.markRunning({
        db,
        operationId: thirdOperationId,
        leaseOwnerId: thirdOwnerId,
        companyIds: [],
      });
      await marketplaceReconciliationOperationStore.finish({
        db,
        operationId: thirdOperationId,
        leaseOwnerId: thirdOwnerId,
        state: "failed_before_mutation",
        catalog: null,
      });
      await expect(
        claim(fourthOperationId, fourthOwnerId),
      ).resolves.toEqual({
        status: "retry_required",
        requiredOperationId: secondOperationId,
      });
      await expect(
        claim(fourthOperationId, fourthOwnerId, secondOperationId),
      ).resolves.toEqual({
        status: "claimed",
      });
      await marketplaceReconciliationOperationStore.markRunning({
        db,
        operationId: fourthOperationId,
        leaseOwnerId: fourthOwnerId,
        companyIds: [],
      });
      await marketplaceReconciliationOperationStore.finish({
        db,
        operationId: fourthOperationId,
        leaseOwnerId: fourthOwnerId,
        state: "success",
        catalog: null,
      });
      await expect(
        claim(fifthOperationId, fifthOwnerId),
      ).resolves.toEqual({
        status: "claimed",
      });
    });
  },
);
