import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  budgetCapacityReservations,
  budgetCapacitySettlements,
  budgetPolicies,
  companySecretBindings,
  costEvents,
  createDb,
  providerConnections,
  type Db,
} from "@armyofagents/db";
import {
  startMigratedDatabase,
  type MigratedDatabase,
} from "./helpers/migrated-database.js";
import { budgetCapacityService } from "../services/budget-capacity.js";
import { secretService } from "../services/secrets.js";
import { voiceMediaCredentialService } from "../services/voice-media-credentials.js";

const integration = describe.skipIf(process.platform === "win32");
const companyId = "84111111-1111-4111-8111-111111111111";
let fixture: MigratedDatabase | undefined;
let db: Db;

integration("B11 restricted credentials and shared Budget capacity", () => {
  beforeAll(async () => {
    process.env.AOA_SECRETS_MASTER_KEY = "12345678901234567890123456789012";
    fixture = await startMigratedDatabase({ label: "aoa-b11-foundations-" });
    db = createDb(fixture.adminUrl);
    await db.execute(
      sql`INSERT INTO companies (organization_id,id,name,issue_prefix) VALUES ('00000000-0000-0000-0000-000000000001',${companyId},'B11 Foundations','B11')`
    );
    await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "company",
        scopeId: companyId,
        amountCents: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        isActive: true,
      });
  }, 180_000);
  afterAll(async () => {
    await fixture?.teardown();
  }, 60_000);

  it("serializes competing voice/media admission and retains unknown exposure", async () => {
    const capacity = budgetCapacityService(db, {
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    const [voice, media] = await Promise.all([
      capacity.reserve({
        companyId,
        operationKind: "voice",
        operationId: "voice-1",
        maximumCostCents: 60,
      }),
      capacity.reserve({
        companyId,
        operationKind: "media",
        operationId: "media-1",
        maximumCostCents: 60,
      }),
    ]);
    expect([voice.outcome, media.outcome].sort()).toEqual([
      "admitted",
      "denied",
    ]);
    const admitted =
      voice.outcome === "admitted"
        ? voice
        : media.outcome === "admitted"
        ? media
        : null;
    expect(admitted).not.toBeNull();
    const reservation = admitted!.reservation;
    await capacity.markUnknown(
      companyId,
      reservation.id,
      "provider_outcome_unknown"
    );
    await expect(
      capacity.releaseUnused(companyId, reservation.id, true)
    ).rejects.toThrow(/cannot be released/i);
    await expect(
      capacity.reserve({
        companyId,
        operationKind: "voice",
        operationId: reservation.operationId,
        maximumCostCents: 61,
      })
    ).rejects.toThrow(/different payload/i);
    const replay = await capacity.reserve({
      companyId,
      operationKind: reservation.operationKind as "voice" | "media",
      operationId: reservation.operationId,
      maximumCostCents: 60,
    });
    expect(replay).toMatchObject({ outcome: "admitted", replayed: true });
  });

  it("settles only canonical charges and never counts a replay twice", async () => {
    const capacity = budgetCapacityService(db, {
      now: () => new Date("2026-09-20T12:00:00Z"),
    });
    const [row] = await db
      .select()
      .from(budgetCapacityReservations)
      .where(eq(budgetCapacityReservations.companyId, companyId));
    await expect(
      capacity.settle(companyId, row.id, "missing-charge")
    ).rejects.toThrow(/canonical cost event/i);
    await db
      .insert(costEvents)
      .values({
        companyId,
        provider: "openai",
        model: "realtime",
        costCents: 25,
        sourceIdempotencyKey: "charge-1",
        occurredAt: new Date("2026-09-20T12:01:00Z"),
      });
    await capacity.settle(companyId, row.id, "charge-1");
    await capacity.settle(companyId, row.id, "charge-1");
    const settlements = await db
      .select()
      .from(budgetCapacitySettlements)
      .where(
        and(
          eq(budgetCapacitySettlements.companyId, companyId),
          eq(budgetCapacitySettlements.chargeId, "charge-1")
        )
      );
    expect(settlements).toHaveLength(1);
  });

  it("denies every generic path and resolves only an exact verified capability binding", async () => {
    const created = await voiceMediaCredentialService(db).create({
      companyId,
      name: "Realtime OpenAI",
      value: "restricted-key",
      provider: "openai",
      capabilities: ["realtime_voice"],
      sharingPolicy: "company_agents",
      createdByUserId: "owner-1",
    });
    const secrets = secretService(db);
    await expect(
      secrets.resolveSecretValue(companyId, created.secret.id, "latest", {
        consumerType: "system",
        consumerId: "legacy",
        actorType: "system",
        configPath: "provider.openai",
      })
    ).rejects.toThrow(/restricted/i);
    await db
      .update(providerConnections)
      .set({
        state: "verified",
        termsAttestedAt: new Date(),
        verifiedAt: new Date(),
      })
      .where(eq(providerConnections.id, created.connection.id));
    const context = {
      consumerType: "provider_connection" as const,
      consumerId: created.connection.id,
      actorType: "user" as const,
      actorId: "owner-1",
      configPath: "voice_media.realtime_voice",
      voiceMedia: {
        connectionId: created.connection.id,
        capability: "realtime_voice" as const,
      },
    };
    await expect(
      secrets.resolveSecretValue(
        companyId,
        created.secret.id,
        "latest",
        context
      )
    ).resolves.toBe("restricted-key");
    await db
      .delete(companySecretBindings)
      .where(eq(companySecretBindings.targetId, created.connection.id));
    await expect(
      secrets.resolveSecretValue(
        companyId,
        created.secret.id,
        "latest",
        context
      )
    ).rejects.toThrow(/restricted/i);
  });
});
