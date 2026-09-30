import { describe, expect, it, vi } from "vitest";
import {
  crewRowsAccountedForDefaultTeam,
  digestMarketplaceCatalog,
  inspectMarketplaceReconciliation,
  MarketplaceReconciliationRetryRequiredError,
  MarketplaceReconciliationRetryUnsafeError,
  runMarketplaceCrewMaintenance,
  runMarketplaceReconciliation,
  writeMarketplaceReconciliationAudit,
  type MarketplaceReconciliationOperationRecord,
  type MarketplaceReconciliationOperationStore,
} from "../services/marketplace-reconcile.js";
import { MARKETPLACE_SETTINGS_DEFAULTS } from "@armyofagents/shared";
import { withMarketplaceUpdateLock } from "../services/marketplace-update-coordinator.js";

const CATALOG = {
  schemaVersion: "1.0.0",
  generatedAt: "2026-07-28T00:00:00.000Z",
  itemCount: 0,
  items: [],
};
const OPERATION_ID_1 = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID_2 = "22222222-2222-4222-8222-222222222222";

const EMPTY_REPAIR = {
  catalogReady: true,
  inspected: 0,
  repaired: 0,
  skippedFailClosed: 0,
  skippedCooldown: 0,
  skippedOverBudget: 0,
  failed: 0,
  skips: [],
};

const EMPTY_STEWARD = {
  disabled: false,
  catalogReady: true,
  inspected: 0,
  adopted: 0,
  skippedOverBudget: 0,
  failed: 0,
};

const ADMIN_ACTOR = {
  actorType: "user" as const,
  actorId: "admin-1",
};

const EMPTY_UPDATE_CHECK = {
  companiesExamined: 1,
  failures: [],
};

function operationStore(
  overrides: Partial<MarketplaceReconciliationOperationStore> = {},
): MarketplaceReconciliationOperationStore {
  return {
    claim: vi.fn(async () => ({ status: "claimed" as const })),
    heartbeat: vi.fn(async () => undefined),
    markRunning: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
    load: vi.fn(async () => null),
    ...overrides,
  };
}

function runTestReconciliation(
  options: Parameters<typeof runMarketplaceReconciliation>[0],
) {
  return runMarketplaceReconciliation({
    ...options,
    operationStore: options.operationStore ?? operationStore(),
  });
}

function operationRecord(
  overrides: Partial<MarketplaceReconciliationOperationRecord> = {},
): MarketplaceReconciliationOperationRecord {
  return {
    operationId: OPERATION_ID_1,
    state: "running",
    deploymentSha: "reviewed-sha",
    targetCount: 1,
    targetCompanyIds: ["company-a"],
    catalog: null,
    leaseActive: false,
    startedAt: new Date("2026-07-28T00:00:00.000Z"),
    completedAt: null,
    ...overrides,
  };
}

describe("marketplace reconciliation", () => {
  it("isolates a company failure and continues the remaining companies", async () => {
    const checkCrewUpdates = vi.fn(
      async ({ companyId }: { companyId: string }) => {
        if (companyId === "company-a") {
          throw new Error("Bearer secret-update-token");
        }
      }
    );
    const runCrewRepair = vi.fn(async (opts) => {
      opts.onFailure?.({
        companyId: "company-a",
        error: new Error("Bearer secret-repair-token"),
      });
      return { ...EMPTY_REPAIR, failed: 1 };
    });
    const runLegacyStewardReconcile = vi.fn(async () => EMPTY_STEWARD);
    const reconcileTeamMembers = vi.fn(
      async ({ companyId }: { companyId: string }) =>
        companyId === "company-b"
          ? { teamsReconciled: 1, membersAdded: 2 }
          : { teamsReconciled: 0, membersAdded: 0 }
    );

    const result = await runMarketplaceCrewMaintenance({
      db: {} as any,
      catalogItems: [],
      mode: "manual",
      instructionsService: {} as any,
      deps: {
        listCompanyIds: async () => ["company-b", "company-a"],
        loadSettings: async () => MARKETPLACE_SETTINGS_DEFAULTS,
        runCrewRepair,
        runLegacyStewardReconcile,
        checkCrewUpdates: checkCrewUpdates as any,
        reconcileTeamMembers: reconcileTeamMembers as any,
      },
    });

    expect(result.companiesExamined).toBe(2);
    expect(checkCrewUpdates).toHaveBeenCalledTimes(2);
    expect(reconcileTeamMembers).toHaveBeenCalledTimes(2);
    expect(runCrewRepair).toHaveBeenCalledWith(
      expect.objectContaining({
        companyIds: ["company-a", "company-b"],
        maxPerPass: 2,
        force: true,
      })
    );
    expect(runLegacyStewardReconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        companyIds: ["company-a", "company-b"],
        maxPerPass: 2,
      })
    );
    expect(result.teamReconcile).toEqual({
      teamsReconciled: 1,
      membersAdded: 2,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyId: "company-a",
        stage: "crew_repair",
        code: "crew_repair_failed",
      }),
      expect.objectContaining({
        companyId: "company-a",
        stage: "crew_update",
        code: "crew_update_failed",
      }),
    ]);
    expect(JSON.stringify(result.failures)).not.toContain("secret-repair-token");
    expect(JSON.stringify(result.failures)).not.toContain("secret-update-token");
  });

  it("reports a swallowed crew-update persistence error as a company failure", async () => {
    const persistenceError = new Error("pending update insert failed");
    const result = await runMarketplaceCrewMaintenance({
      db: {} as any,
      catalogItems: [],
      mode: "manual",
      instructionsService: {} as any,
      deps: {
        listCompanyIds: async () => ["company-a"],
        loadSettings: async () => MARKETPLACE_SETTINGS_DEFAULTS,
        runCrewRepair: vi.fn(async () => EMPTY_REPAIR),
        runLegacyStewardReconcile: vi.fn(async () => EMPTY_STEWARD),
        checkCrewUpdates: vi.fn(async (opts) => {
          opts.onFailure?.({
            companyId: "company-a",
            agentId: "agent-a",
            catalogItemId: "agent:aoa-curated/example",
            stage: "pending_update",
            error: persistenceError,
          });
        }),
        reconcileTeamMembers: vi.fn(async () => ({
          teamsReconciled: 0,
          membersAdded: 0,
        })),
      },
    });

    expect(result.crewUpdates).toEqual({ succeeded: 0, failed: 1 });
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyId: "company-a",
        stage: "crew_update",
        code: "crew_update_failed",
      }),
    ]);
  });

  it("collapses repeated team failures by company and stage", async () => {
    const result = await runMarketplaceCrewMaintenance({
      db: {} as any,
      catalogItems: [],
      instructionsService: {} as any,
      deps: {
        listCompanyIds: async () => ["company-a"],
        loadSettings: async () => MARKETPLACE_SETTINGS_DEFAULTS,
        runCrewRepair: vi.fn(async () => EMPTY_REPAIR),
        runLegacyStewardReconcile: vi.fn(async () => EMPTY_STEWARD),
        checkCrewUpdates: vi.fn(),
        reconcileTeamMembers: vi.fn(async (opts) => {
          opts.onFailure?.({
            companyId: "company-a",
            teamId: "team-a",
            stage: "member_install",
            error: new Error("first member failed"),
          });
          opts.onFailure?.({
            companyId: "company-a",
            teamId: "team-a",
            stage: "member_install",
            error: new Error("second member failed"),
          });
          return { teamsReconciled: 0, membersAdded: 0 };
        }),
      },
    });

    expect(result.failures).toEqual([
      expect.objectContaining({
        companyId: "company-a",
        stage: "team_reconcile",
        code: "team_reconcile_failed",
        occurrences: 2,
      }),
    ]);
  });

  it("returns a stable catalog identity and a successful replay result", async () => {
    const status = {
      lastSyncedAt: "2026-07-28T00:00:01.000Z",
      lastSyncStatus: "success" as const,
      lastSyncError: null,
      source: "cdn" as const,
      schemaVersion: "1.0.0",
      itemCount: 0,
    };
    const catalogService = {
      refresh: vi.fn().mockResolvedValue({
        catalog: CATALOG,
        status,
        outcome: "cdn_success" as const,
        error: null,
      }),
    };
    const maintenance = vi.fn().mockResolvedValue({
      companiesExamined: 1,
      crewRepair: EMPTY_REPAIR,
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
      failures: [],
    });
    const audit = vi.fn().mockResolvedValue(undefined);
    const listCompanyIds = vi.fn().mockResolvedValue(["company-1"]);
    const updateCheck = vi.fn().mockResolvedValue(EMPTY_UPDATE_CHECK);

    const first = await runTestReconciliation({
      db: {} as any,
      catalogService,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_1,
      maintenance,
      listCompanyIds,
      audit,
      updateCheck,
    });
    const replay = await runTestReconciliation({
      db: {} as any,
      catalogService,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_2,
      maintenance,
      listCompanyIds,
      audit,
      updateCheck,
    });

    expect(first.status).toBe("success");
    expect(replay.status).toBe("success");
    expect(replay.catalog).toEqual(first.catalog);
    expect(replay.repairs).toEqual({
      crewCompaniesRepaired: 0,
      legacyStewardsAdopted: 0,
      teamsReconciled: 0,
      teamMembersAdded: 0,
    });
    expect(replay.crewRepair.repaired).toBe(0);
    expect(catalogService.refresh).toHaveBeenCalledTimes(2);
    expect(updateCheck).toHaveBeenCalledTimes(2);
    expect(updateCheck).toHaveBeenNthCalledWith(
      1,
      {},
      CATALOG.items,
      { companyIds: ["company-1"] },
    );
    expect(maintenance).toHaveBeenCalledWith(
      expect.objectContaining({ companyIds: ["company-1"], mode: "manual" }),
    );
    expect(audit).toHaveBeenCalledTimes(4);
    expect(audit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        phase: "started",
        operationId: OPERATION_ID_1,
        actor: ADMIN_ACTOR,
        companyIds: ["company-1"],
      }),
    );
    expect(audit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        phase: "completed",
        operationId: OPERATION_ID_1,
        actor: ADMIN_ACTOR,
        result: expect.objectContaining({ status: "success" }),
      }),
    );
  });

  it("persists one actor-attributed start audit per target company", async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([{ id: "audit-1" }, { id: "audit-2" }]);
    const values = vi.fn().mockReturnValue({ returning });
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
    };

    await writeMarketplaceReconciliationAudit({
      db: db as any,
      phase: "started",
      operationId: "operation-audit",
      actor: ADMIN_ACTOR,
      companyIds: ["company-a", "company-b"],
      catalog: {
        generatedAt: CATALOG.generatedAt,
        canonicalDigestSha256: "a".repeat(64),
        schemaVersion: CATALOG.schemaVersion,
        itemCount: 0,
        source: "cdn",
      },
    });

    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        companyId: "company-a",
        actorType: "user",
        actorId: "admin-1",
        action: "marketplace.reconciliation_started",
        entityType: "marketplace_reconciliation",
        entityId: "operation-audit",
      }),
      expect.objectContaining({
        companyId: "company-b",
        actorType: "user",
        actorId: "admin-1",
        action: "marketplace.reconciliation_started",
        entityId: "operation-audit",
      }),
    ]);
  });

  it("writes only each company's skips and failures to its completion audit", async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([{ id: "audit-1" }, { id: "audit-2" }]);
    const values = vi.fn().mockReturnValue({ returning });
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    const failure = (companyId: string) => ({
      companyId,
      stage: "crew_repair" as const,
      code: "crew_repair_failed" as const,
      message: "Crew repair failed for this company.",
      retry: {
        kind: "after_correction" as const,
        recoveryCode: "review_crew_state" as const,
        message: "Inspect the company crew state before retrying.",
      },
    });
    const skip = (companyId: string) => ({
      companyId,
      stage: "crew_repair" as const,
      category: "fail_closed" as const,
      reason: "unknown_fail_closed" as const,
      message: "Crew repair stopped at an unclassified safety boundary.",
      retry: {
        kind: "after_correction" as const,
        recoveryCode: "review_crew_state" as const,
        message: "Inspect the company and server logs before retrying.",
      },
    });
    const result = {
      operationId: OPERATION_ID_1,
      status: "partial" as const,
      repairs: {
        crewCompaniesRepaired: 0,
        legacyStewardsAdopted: 0,
        teamsReconciled: 0,
        teamMembersAdded: 0,
      },
      catalog: {
        generatedAt: CATALOG.generatedAt,
        canonicalDigestSha256: "a".repeat(64),
        schemaVersion: CATALOG.schemaVersion,
        itemCount: 0,
        source: "cdn" as const,
      },
      companiesExamined: 2,
      crewRepair: { ...EMPTY_REPAIR, skippedFailClosed: 2 },
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 0, failed: 0 },
      teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
      skips: [skip("company-a"), skip("company-b")],
      diagnostics: [],
      failures: [failure("company-a"), failure("company-b")],
    };

    await writeMarketplaceReconciliationAudit({
      db: db as any,
      phase: "completed",
      operationId: OPERATION_ID_1,
      actor: ADMIN_ACTOR,
      companyIds: ["company-a", "company-b"],
      catalog: result.catalog,
      result,
    });

    const inserted = values.mock.calls[0]![0];
    expect(inserted[0].details.companySkips).toEqual([skip("company-a")]);
    expect(inserted[0].details.companyFailures).toEqual([
      failure("company-a"),
    ]);
    expect(inserted[1].details.companySkips).toEqual([skip("company-b")]);
    expect(inserted[1].details.companyFailures).toEqual([
      failure("company-b"),
    ]);
  });

  it("does not run maintenance when the required catalog refresh fails", async () => {
    const maintenance = vi.fn();
    const catalogStatus = {
      lastSyncedAt: "2026-07-28T00:00:01.000Z",
      lastSyncStatus: "failure" as const,
      lastSyncError: "cdn unavailable",
      source: "cdn" as const,
      schemaVersion: "1.0.0",
      itemCount: 0,
    };

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        catalogService: {
          refresh: vi
            .fn()
            .mockResolvedValue({
              catalog: null,
              status: catalogStatus,
              outcome: "failure",
              error: "cdn unavailable",
            }),
        },
        operationId: OPERATION_ID_1,
        maintenance,
        listCompanyIds: async () => ["company-1"],
        audit: vi.fn(),
      })
    ).rejects.toMatchObject({
      operationId: OPERATION_ID_1,
      catalogStatus,
    });
    expect(maintenance).not.toHaveBeenCalled();
  });

  it("fails before fleet mutation when the actor audit cannot be persisted", async () => {
    const maintenance = vi.fn();
    const updateCheck = vi.fn();

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        operationId: OPERATION_ID_1,
        catalogService: {
          refresh: vi.fn().mockResolvedValue({
            catalog: CATALOG,
            status: {
              lastSyncedAt: "2026-07-28T00:00:01.000Z",
              lastSyncStatus: "success",
              lastSyncError: null,
              source: "cdn",
              schemaVersion: "1.0.0",
              itemCount: 0,
            },
            outcome: "cdn_success",
            error: null,
          }),
        },
        maintenance,
        listCompanyIds: async () => ["company-1"],
        audit: vi.fn().mockRejectedValue(new Error("audit insert failed")),
        updateCheck,
      }),
    ).rejects.toMatchObject({
      operationId: OPERATION_ID_1,
    });
    expect(updateCheck).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
  });

  it("requires the current outcome-unknown operation reference before claiming a retry", async () => {
    const store = operationStore({
      claim: vi.fn(async () => ({
        status: "retry_required" as const,
        requiredOperationId: OPERATION_ID_1,
      })),
    });
    const refresh = vi.fn();

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        operationId: OPERATION_ID_2,
        catalogService: { refresh },
        operationStore: store,
      }),
    ).rejects.toBeInstanceOf(
      MarketplaceReconciliationRetryRequiredError,
    );

    expect(store.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID_2,
        retryOfOperationId: undefined,
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("re-inspects a referenced predecessor after claim and fails before mutation when unsafe", async () => {
    const store = operationStore();
    const refresh = vi.fn();
    const inspectRetry = vi.fn(async () => ({
      operationId: OPERATION_ID_1,
      state: "outcome_unknown_after_mutation" as const,
      safeToRetry: false,
    }));

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        operationId: OPERATION_ID_2,
        retryOfOperationId: OPERATION_ID_1,
        inspectRetry: inspectRetry as any,
        catalogService: { refresh },
        operationStore: store,
      }),
    ).rejects.toBeInstanceOf(
      MarketplaceReconciliationRetryUnsafeError,
    );

    expect(store.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID_2,
        retryOfOperationId: OPERATION_ID_1,
      }),
    );
    expect(inspectRetry).toHaveBeenCalledWith(
      expect.anything(),
      OPERATION_ID_1,
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: OPERATION_ID_2,
        state: "failed_before_mutation",
        catalog: null,
      }),
    );
  });

  it("continues a referenced retry only after the current inspection is safe", async () => {
    const store = operationStore();
    const refresh = vi
      .fn()
      .mockRejectedValue(new Error("catalog unavailable"));
    const inspectRetry = vi.fn(async () => ({
      operationId: OPERATION_ID_1,
      state: "outcome_unknown_after_mutation" as const,
      safeToRetry: true,
    }));

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        operationId: OPERATION_ID_2,
        retryOfOperationId: OPERATION_ID_1,
        inspectRetry: inspectRetry as any,
        catalogService: { refresh },
        operationStore: store,
        listCompanyIds: async () => [],
        audit: vi.fn(async () => undefined),
      }),
    ).rejects.toMatchObject({
      operationId: OPERATION_ID_2,
    });

    expect(inspectRetry).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reports outcome unknown when completion audit fails after maintenance", async () => {
    let maintenanceCommitted = false;
    const audit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("completion audit unavailable"));

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        operationId: OPERATION_ID_1,
        catalogService: {
          refresh: vi.fn().mockResolvedValue({
            catalog: CATALOG,
            status: {
              lastSyncedAt: "2026-07-28T00:00:01.000Z",
              lastSyncStatus: "success",
              lastSyncError: null,
              source: "cdn",
              schemaVersion: "1.0.0",
              itemCount: 0,
            },
            outcome: "cdn_success",
            error: null,
          }),
        },
        listCompanyIds: async () => ["company-1"],
        audit,
        updateCheck: vi.fn().mockResolvedValue(EMPTY_UPDATE_CHECK),
        maintenance: vi.fn(async () => {
          maintenanceCommitted = true;
          return {
            companiesExamined: 1,
            crewRepair: EMPTY_REPAIR,
            legacySteward: EMPTY_STEWARD,
            crewUpdates: { succeeded: 1, failed: 0 },
            teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
            failures: [],
          };
        }),
      }),
    ).rejects.toMatchObject({
      operationId: OPERATION_ID_1,
      outcome: "outcome_unknown_after_mutation",
    });
    expect(maintenanceCommitted).toBe(true);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it("runs catalog update mutations only after the start audit succeeds", async () => {
    const order: string[] = [];
    const maintenanceResult = {
      companiesExamined: 1,
      crewRepair: EMPTY_REPAIR,
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
      failures: [],
    };

    await runTestReconciliation({
      db: {} as any,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_1,
      catalogService: {
        refresh: vi.fn(async () => {
          order.push("refresh");
          return {
            catalog: CATALOG,
            status: {
              lastSyncedAt: "2026-07-28T00:00:01.000Z",
              lastSyncStatus: "success" as const,
              lastSyncError: null,
              source: "cdn" as const,
              schemaVersion: "1.0.0",
              itemCount: 0,
            },
            outcome: "cdn_success" as const,
            error: null,
          };
        }),
      },
      listCompanyIds: vi.fn(async () => {
        order.push("targets");
        return ["company-1"];
      }),
      audit: vi.fn(async ({ phase }) => {
        order.push(`audit:${phase}`);
      }),
      updateCheck: vi.fn(async () => {
        order.push("update-check");
        return EMPTY_UPDATE_CHECK;
      }),
      maintenance: vi.fn(async () => {
        order.push("maintenance");
        return maintenanceResult;
      }),
    });

    expect(order).toEqual([
      "targets",
      "audit:started",
      "refresh",
      "update-check",
      "maintenance",
      "audit:completed",
    ]);
  });

  it("holds a concurrent background update behind the audited operation", async () => {
    const order: string[] = [];
    let resolveRefresh!: (value: {
      catalog: typeof CATALOG;
      status: {
        lastSyncedAt: string;
        lastSyncStatus: "success";
        lastSyncError: null;
        source: "cdn";
        schemaVersion: string;
        itemCount: number;
      };
      outcome: "cdn_success";
      error: null;
    }) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const refreshResult = new Promise<Parameters<typeof resolveRefresh>[0]>(
      (resolve) => {
        resolveRefresh = resolve;
      },
    );
    const maintenanceResult = {
      companiesExamined: 1,
      crewRepair: EMPTY_REPAIR,
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
      failures: [],
    };

    const reconciliation = runTestReconciliation({
      db: {} as any,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_1,
      catalogService: {
        refresh: vi.fn(async () => {
          order.push("refresh");
          markRefreshStarted();
          return refreshResult;
        }),
      },
      listCompanyIds: vi.fn(async () => {
        order.push("targets");
        return ["company-1"];
      }),
      audit: vi.fn(async ({ phase }) => {
        order.push(`audit:${phase}`);
      }),
      updateCheck: vi.fn(async () => {
        order.push("admin-update");
        return EMPTY_UPDATE_CHECK;
      }),
      maintenance: vi.fn(async () => {
        order.push("maintenance");
        return maintenanceResult;
      }),
    });
    await refreshStarted;

    const backgroundUpdate = withMarketplaceUpdateLock(async () => {
      order.push("background-update");
    });
    await Promise.resolve();
    expect(order).toEqual(["targets", "audit:started", "refresh"]);

    resolveRefresh({
      catalog: CATALOG,
      status: {
        lastSyncedAt: "2026-07-28T00:00:01.000Z",
        lastSyncStatus: "success",
        lastSyncError: null,
        source: "cdn",
        schemaVersion: "1.0.0",
        itemCount: 0,
      },
      outcome: "cdn_success",
      error: null,
    });
    await reconciliation;
    await backgroundUpdate;

    expect(order).toEqual([
      "targets",
      "audit:started",
      "refresh",
      "admin-update",
      "maintenance",
      "audit:completed",
      "background-update",
    ]);
  });

  it("does not reconcile from a bundled fallback after a failed CDN refresh", async () => {
    const maintenance = vi.fn();
    const catalogStatus = {
      lastSyncedAt: "2026-07-28T00:00:01.000Z",
      lastSyncStatus: "success" as const,
      lastSyncError: null,
      source: "bundled" as const,
      schemaVersion: "1.0.0",
      itemCount: 0,
    };

    await expect(
      runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        catalogService: {
          refresh: vi.fn().mockResolvedValue({
            catalog: CATALOG,
            status: catalogStatus,
            outcome: "fallback_success",
            error: "network down",
          }),
        },
        operationId: OPERATION_ID_1,
        maintenance,
        listCompanyIds: async () => ["company-1"],
        audit: vi.fn(),
      }),
    ).rejects.toMatchObject({
      operationId: OPERATION_ID_1,
      catalogStatus,
      catalogOutcome: "fallback_success",
      catalogError: "network down",
    });
    expect(maintenance).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "uncaptured repair failures",
      crewRepair: { ...EMPTY_REPAIR, failed: 1 },
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      failures: [],
    },
    {
      name: "uncaptured Steward failures",
      crewRepair: EMPTY_REPAIR,
      legacySteward: { ...EMPTY_STEWARD, failed: 1 },
      crewUpdates: { succeeded: 1, failed: 0 },
      failures: [],
    },
    {
      name: "crew update failures",
      crewRepair: EMPTY_REPAIR,
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 0, failed: 1 },
      failures: [],
    },
    {
      name: "cooldown skips",
      crewRepair: { ...EMPTY_REPAIR, skippedCooldown: 1 },
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      failures: [],
    },
    {
      name: "missing crew catalog prerequisite",
      crewRepair: { ...EMPTY_REPAIR, catalogReady: false },
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      failures: [],
    },
    {
      name: "disabled Steward reconciliation",
      crewRepair: EMPTY_REPAIR,
      legacySteward: { ...EMPTY_STEWARD, disabled: true },
      crewUpdates: { succeeded: 1, failed: 0 },
      failures: [],
    },
    {
      name: "missing Steward catalog prerequisite",
      crewRepair: EMPTY_REPAIR,
      legacySteward: { ...EMPTY_STEWARD, catalogReady: false },
      crewUpdates: { succeeded: 1, failed: 0 },
      failures: [],
    },
  ])("reports partial status for $name", async (maintenanceResult) => {
    const result = await runTestReconciliation({
      db: {} as any,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_1,
      catalogService: {
        refresh: vi.fn().mockResolvedValue({
          catalog: CATALOG,
          status: {
            lastSyncedAt: "2026-07-28T00:00:01.000Z",
            lastSyncStatus: "success",
            lastSyncError: null,
            source: "cdn",
            schemaVersion: "1.0.0",
            itemCount: 0,
          },
          outcome: "cdn_success",
          error: null,
        }),
      },
      maintenance: vi.fn().mockResolvedValue({
        companiesExamined: 1,
        teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
        ...maintenanceResult,
      }),
      listCompanyIds: async () => ["company-1"],
      audit: vi.fn(),
      updateCheck: vi.fn().mockResolvedValue(EMPTY_UPDATE_CHECK),
    });

    expect(result.status).toBe("partial");
  });

  it.each([
    {
      internalCode: "resource-temporarily-unavailable",
      publicReason: "skill_resource_temporarily_unavailable",
      extra: {
        httpStatus: 503,
        notBefore: "2026-07-28T00:01:00.000Z",
      },
      expectedContext: {
        catalogItemId: "skill:aoa-curated/example",
        httpStatus: 503,
      },
      retryKind: "after",
    },
    {
      internalCode: "resource-fetch-failed",
      publicReason: "skill_resource_fetch_failed",
      extra: { httpStatus: 404 },
      expectedContext: {
        catalogItemId: "skill:aoa-curated/example",
        httpStatus: 404,
      },
      retryKind: "after_correction",
    },
    {
      internalCode: "resource-invalid",
      publicReason: "skill_resource_invalid",
      extra: {},
      expectedContext: { catalogItemId: "skill:aoa-curated/example" },
      retryKind: "after_correction",
    },
    {
      internalCode: "bundle-materialization-failed",
      publicReason: "skill_bundle_materialization_failed",
      extra: {},
      expectedContext: { catalogItemId: "skill:aoa-curated/example" },
      retryKind: "after_correction",
    },
    {
      internalCode: "bundle-missing",
      publicReason: "skill_bundle_missing",
      extra: {},
      expectedContext: { catalogItemId: "skill:aoa-curated/example" },
      retryKind: "after_correction",
    },
    {
      internalCode: "filesystem-permission-denied",
      publicReason: "skill_filesystem_permission_denied",
      extra: { filesystemOperation: "write" },
      expectedContext: {
        catalogItemId: "skill:aoa-curated/example",
        filesystemOperation: "write",
      },
      retryKind: "after_correction",
    },
  ] as const)(
    "maps $internalCode to the stable public recovery contract",
    async ({
      internalCode,
      publicReason,
      extra,
      expectedContext,
      retryKind,
    }) => {
      const result = await runTestReconciliation({
        db: {} as any,
        actor: ADMIN_ACTOR,
        operationId: OPERATION_ID_1,
        catalogService: {
          refresh: vi.fn().mockResolvedValue({
            catalog: CATALOG,
            status: {
              lastSyncedAt: "2026-07-28T00:00:01.000Z",
              lastSyncStatus: "success",
              lastSyncError: null,
              source: "cdn",
              schemaVersion: "1.0.0",
              itemCount: 0,
            },
            outcome: "cdn_success",
            error: null,
          }),
        },
        maintenance: vi.fn().mockResolvedValue({
          companiesExamined: 1,
          crewRepair: {
            ...EMPTY_REPAIR,
            inspected: 1,
            skippedFailClosed: 1,
            skips: [
              {
                companyId: "company-1",
                category: "fail_closed",
                reason: "skill-install-failed",
                skillFailure: {
                  code: internalCode,
                  catalogItemId: "skill:aoa-curated/example",
                  ...extra,
                },
                ...("notBefore" in extra
                  ? { notBefore: extra.notBefore }
                  : {}),
              },
            ],
          },
          legacySteward: EMPTY_STEWARD,
          crewUpdates: { succeeded: 1, failed: 0 },
          teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
          failures: [],
        }),
        listCompanyIds: async () => ["company-1"],
        audit: vi.fn(),
        updateCheck: vi.fn().mockResolvedValue(EMPTY_UPDATE_CHECK),
      });

      expect(result.status).toBe("partial");
      expect(result.skips).toEqual([
        expect.objectContaining({
          companyId: "company-1",
          stage: "crew_repair",
          category: "fail_closed",
          reason: publicReason,
          retry: expect.objectContaining({ kind: retryKind }),
          context: expectedContext,
        }),
      ]);
      expect(JSON.stringify(result.skips)).not.toContain(
        "skill-install-failed",
      );
    },
  );

  it("reports marketplace update-check failures as a partial audited result", async () => {
    const audit = vi.fn();
    const maintenance = vi.fn().mockResolvedValue({
      companiesExamined: 1,
      crewRepair: EMPTY_REPAIR,
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
      failures: [],
    });

    const result = await runTestReconciliation({
      db: {} as any,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_1,
      catalogService: {
        refresh: vi.fn().mockResolvedValue({
          catalog: CATALOG,
          status: {
            lastSyncedAt: "2026-07-28T00:00:01.000Z",
            lastSyncStatus: "success",
            lastSyncError: null,
            source: "cdn",
            schemaVersion: "1.0.0",
            itemCount: 0,
          },
          outcome: "cdn_success",
          error: null,
        }),
      },
      listCompanyIds: async () => ["company-1"],
      audit,
      updateCheck: vi.fn().mockResolvedValue({
        companiesExamined: 1,
        failures: [
          {
            companyId: "company-1",
            itemType: "skill",
            catalogItemId: "skill:aoa-curated/code-review",
            message: "notification unavailable",
          },
        ],
      }),
      maintenance,
    });

    expect(result.status).toBe("partial");
    expect(result.failures).toEqual([
      expect.objectContaining({
        companyId: "company-1",
        stage: "marketplace_update",
        code: "marketplace_update_failed",
      }),
    ]);
    expect(JSON.stringify(result.failures)).not.toContain(
      "notification unavailable",
    );
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "completed",
        result: expect.objectContaining({
          status: "partial",
          failures: result.failures,
        }),
      }),
    );
  });

  it("serializes scheduled and manual passes in the same process", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const secondListCompanies = vi.fn(async () => []);
    const baseDeps = {
      loadSettings: async () => MARKETPLACE_SETTINGS_DEFAULTS,
      runCrewRepair: vi.fn(async () => EMPTY_REPAIR),
      runLegacyStewardReconcile: vi.fn(async () => EMPTY_STEWARD),
      reconcileTeamMembers: vi.fn(async () => ({
        teamsReconciled: 0,
        membersAdded: 0,
      })),
    };

    const first = runMarketplaceCrewMaintenance({
      db: {} as any,
      catalogItems: [],
      instructionsService: {} as any,
      deps: {
        ...baseDeps,
        listCompanyIds: async () => ["company-a"],
        checkCrewUpdates: vi.fn(async () => {
          markFirstStarted();
          await firstBlocked;
        }),
      },
    });
    await firstStarted;

    const second = runMarketplaceCrewMaintenance({
      db: {} as any,
      catalogItems: [],
      mode: "manual",
      instructionsService: {} as any,
      deps: {
        ...baseDeps,
        listCompanyIds: secondListCompanies,
        checkCrewUpdates: vi.fn(),
      },
    });
    await Promise.resolve();
    expect(secondListCompanies).not.toHaveBeenCalled();

    releaseFirst();
    await Promise.all([first, second]);
    expect(secondListCompanies).toHaveBeenCalledTimes(1);
  });

  it("acquires the maintenance lock before the admin start audit", async () => {
    const order: string[] = [];
    let releaseScheduled!: () => void;
    const scheduledBlocked = new Promise<void>((resolve) => {
      releaseScheduled = resolve;
    });
    let markScheduledStarted!: () => void;
    const scheduledStarted = new Promise<void>((resolve) => {
      markScheduledStarted = resolve;
    });
    const maintenanceResult = {
      companiesExamined: 1,
      crewRepair: EMPTY_REPAIR,
      legacySteward: EMPTY_STEWARD,
      crewUpdates: { succeeded: 1, failed: 0 },
      teamReconcile: { teamsReconciled: 0, membersAdded: 0 },
      failures: [],
    };

    const scheduled = runMarketplaceCrewMaintenance({
      db: {} as any,
      catalogItems: [],
      instructionsService: {} as any,
      deps: {
        listCompanyIds: async () => ["company-a"],
        loadSettings: async () => MARKETPLACE_SETTINGS_DEFAULTS,
        runCrewRepair: vi.fn(async () => EMPTY_REPAIR),
        runLegacyStewardReconcile: vi.fn(async () => EMPTY_STEWARD),
        checkCrewUpdates: vi.fn(async () => {
          order.push("scheduled:start");
          markScheduledStarted();
          await scheduledBlocked;
          order.push("scheduled:end");
        }),
        reconcileTeamMembers: vi.fn(async () => ({
          teamsReconciled: 0,
          membersAdded: 0,
        })),
      },
    });
    await scheduledStarted;

    const audit = vi.fn(async ({ phase }) => {
      order.push(`audit:${phase}`);
    });
    const reconciliation = runTestReconciliation({
      db: {} as any,
      actor: ADMIN_ACTOR,
      operationId: OPERATION_ID_1,
      catalogService: {
        refresh: vi.fn(async () => {
          order.push("refresh");
          return {
            catalog: CATALOG,
            status: {
              lastSyncedAt: "2026-07-28T00:00:01.000Z",
              lastSyncStatus: "success" as const,
              lastSyncError: null,
              source: "cdn" as const,
              schemaVersion: "1.0.0",
              itemCount: 0,
            },
            outcome: "cdn_success" as const,
            error: null,
          };
        }),
      },
      listCompanyIds: async () => ["company-a"],
      audit,
      updateCheck: vi.fn(async () => EMPTY_UPDATE_CHECK),
      maintenance: vi.fn(async () => {
        order.push("admin:maintenance");
        return maintenanceResult;
      }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(audit).not.toHaveBeenCalled();
    expect(order).toEqual(["scheduled:start"]);

    releaseScheduled();
    await Promise.all([scheduled, reconciliation]);
    expect(order).toEqual([
      "scheduled:start",
      "scheduled:end",
      "audit:started",
      "refresh",
      "admin:maintenance",
      "audit:completed",
    ]);
  });

  it("canonicalizes object keys before hashing", () => {
    const reordered = {
      items: [],
      itemCount: 0,
      generatedAt: CATALOG.generatedAt,
      schemaVersion: CATALOG.schemaVersion,
    };
    expect(digestMarketplaceCatalog(reordered)).toBe(
      digestMarketplaceCatalog(CATALOG)
    );
  });

  it("distinguishes running and outcome-unknown operations from durable audit rows", async () => {
    const rows = [
      {
        companyId: "company-a",
        action: "marketplace.reconciliation_started",
        details: {
          operationId: OPERATION_ID_1,
          phase: "started",
          deploymentSha: "reviewed-sha",
          targetCount: 1,
          catalog: null,
        },
        createdAt: new Date("2026-07-28T00:00:00.000Z"),
      },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    };

    const running = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: true,
      loadOperation: vi.fn(async () =>
        operationRecord({ leaseActive: true }),
      ),
    });
    expect(running).toMatchObject({
      state: "running",
      safeToRetry: false,
      deploymentSha: "reviewed-sha",
    });

    const unknown = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () => operationRecord()),
      diagnose: vi.fn(async () => ({
        companyId: "company-a",
        verdict: "healthy" as const,
        teamId: "team-a",
        managedCrew: [
          {
            id: "agent-a",
            name: "Scout",
            templateOrigin: "agent:aoa-curated/aoa-scout",
            templateVersion: "1.0.0",
          },
        ],
        unmanagedCrew: [
          {
            id: "commander-a",
            name: "Commander",
            templateOrigin:
              "aoa-curated/standard-crew/commander@legacy",
            templateVersion: null,
          },
        ],
        operation: null,
      })),
      hasCustomizedRows: vi.fn(async () => false),
      hasActiveWriter: vi.fn(async () => false),
      hasUnaccountedCrewRows: vi.fn(async () => false),
    });
    expect(unknown).toMatchObject({
      state: "outcome_unknown_after_mutation",
      safeToRetry: true,
      targets: [{ companyId: "company-a", crewState: "healthy" }],
    });
  });

  it("uses a consistent terminal ledger and audit set as the canonical result", async () => {
    const rows = [
      {
        companyId: "company-a",
        action: "marketplace.reconciliation_started",
        details: {
          operationId: OPERATION_ID_1,
          phase: "started",
          deploymentSha: "reviewed-sha",
          targetCount: 1,
        },
        createdAt: new Date("2026-07-28T00:00:00.000Z"),
      },
      {
        companyId: "company-a",
        action: "marketplace.reconciliation_completed",
        details: {
          operationId: OPERATION_ID_1,
          phase: "completed",
          status: "success",
          deploymentSha: "reviewed-sha",
          targetCount: 1,
        },
        createdAt: new Date("2026-07-28T00:00:05.000Z"),
      },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    };

    const result = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () =>
        operationRecord({
          state: "success",
          completedAt: new Date("2026-07-28T00:00:05.000Z"),
        }),
      ),
    });

    expect(result).toMatchObject({
      state: "success",
      targetCount: 1,
      safeToRetry: false,
      retry: { kind: "never" },
      targets: [{ companyId: "company-a", crewState: "unknown" }],
    });
  });

  it("requires every non-Commander crew row to be linked exactly once to the default team", () => {
    const managedCrew = [
      {
        id: "agent-scout",
        name: "Scout",
        templateOrigin: "agent:aoa-curated/aoa-scout",
        templateVersion: "1.0.0",
      },
      {
        id: "agent-steward",
        name: "Steward",
        templateOrigin: "agent:aoa-curated/aoa-steward",
        templateVersion: "1.0.0",
      },
    ];
    const commander = {
      id: "agent-commander",
      name: "Ops Lead",
      templateOrigin: "aoa-curated/standard-crew/commander@legacy",
      templateVersion: null,
    };
    const base = {
      teamId: "team-a",
      managedCrew,
      unmanagedCrew: [commander],
    };

    expect(
      crewRowsAccountedForDefaultTeam(base, [
        "agent-scout",
        "agent-steward",
      ]),
    ).toBe(true);
    expect(
      crewRowsAccountedForDefaultTeam(
        {
          ...base,
          managedCrew: [
            ...managedCrew,
            {
              ...managedCrew[0]!,
              id: "agent-scout-duplicate",
            },
          ],
        },
        ["agent-scout", "agent-steward", "agent-scout-duplicate"],
      ),
    ).toBe(false);
    expect(
      crewRowsAccountedForDefaultTeam(
        {
          ...base,
          unmanagedCrew: [
            commander,
            {
              id: "agent-adjutant",
              name: "Adjutant",
              templateOrigin:
                "aoa-curated/standard-crew/adjutant@legacy",
              templateVersion: null,
            },
          ],
        },
        ["agent-scout", "agent-steward"],
      ),
    ).toBe(false);
    expect(
      crewRowsAccountedForDefaultTeam(base, ["agent-scout"]),
    ).toBe(false);
    expect(
      crewRowsAccountedForDefaultTeam(
        { teamId: "team-a", managedCrew: [], unmanagedCrew: [commander] },
        [],
      ),
    ).toBe(false);
  });

  it.each(["healthy", "operation-row-stale"] as const)(
    "blocks an uncertain retry when a %s diagnosis has unaccounted crew rows",
    async (verdict) => {
      const rows = [
        {
          companyId: "company-a",
          action: "marketplace.reconciliation_started",
          details: {
            operationId: OPERATION_ID_1,
            phase: "started",
            deploymentSha: "reviewed-sha",
            targetCount: 1,
          },
          createdAt: new Date("2026-07-28T00:00:00.000Z"),
        },
      ];
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              orderBy: vi.fn().mockResolvedValue(rows),
            })),
          })),
        })),
      };

      const result = await inspectMarketplaceReconciliation({
        db: db as any,
        operationId: OPERATION_ID_1,
        isActive: false,
        loadOperation: vi.fn(async () => operationRecord()),
        diagnose: vi.fn(async () => ({
          companyId: "company-a",
          verdict,
          teamId: "team-a",
          managedCrew: [
            {
              id: "agent-a",
              name: "Scout",
              templateOrigin: "agent:aoa-curated/aoa-scout",
              templateVersion: "1.0.0",
            },
          ],
          unmanagedCrew: [],
          operation: null,
        })),
        hasCustomizedRows: vi.fn(async () => false),
        hasActiveWriter: vi.fn(async () => false),
        hasUnaccountedCrewRows: vi.fn(async () => true),
      });

      expect(result).toMatchObject({
        state: "outcome_unknown_after_mutation",
        safeToRetry: false,
        targets: [
          {
            companyId: "company-a",
            crewState: "blocked",
            diagnosticCode: "unaccounted_crew_rows",
          },
        ],
        retry: {
          kind: "inspect_first",
          recoveryCode: "inspect_operation",
        },
      });
    },
  );

  it("supports a durable successful operation over an empty fleet", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };

    const result = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () =>
        operationRecord({
          state: "success",
          targetCount: 0,
          targetCompanyIds: [],
          completedAt: new Date("2026-07-28T00:00:05.000Z"),
        }),
      ),
    });

    expect(result).toMatchObject({
      state: "success",
      targetCount: 0,
      targets: [],
      safeToRetry: false,
      retry: { kind: "never" },
    });
  });

  it("fails a poisoned terminal audit closed even when the ledger says success", async () => {
    const rows = [
      {
        companyId: "company-a",
        action: "marketplace.reconciliation_started",
        details: {
          operationId: OPERATION_ID_1,
          phase: "started",
          deploymentSha: "reviewed-sha",
          targetCount: 1,
        },
        createdAt: new Date("2026-07-28T00:00:00.000Z"),
      },
      {
        companyId: "company-a",
        action: "marketplace.reconciliation_completed",
        details: {
          operationId: OPERATION_ID_1,
          phase: "completed",
          status: "partial",
          deploymentSha: "reviewed-sha",
          targetCount: 1,
        },
        createdAt: new Date("2026-07-28T00:00:05.000Z"),
      },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    };

    const result = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () =>
        operationRecord({
          state: "success",
          completedAt: new Date("2026-07-28T00:00:05.000Z"),
        }),
      ),
    });

    expect(result).toMatchObject({
      state: "outcome_unknown_after_mutation",
      safeToRetry: false,
      retry: {
        kind: "inspect_first",
        recoveryCode: "inspect_operation",
      },
    });
  });

  it("fails inspection closed on customization, an active writer, or a query failure", async () => {
    const rows = [
      {
        companyId: "company-a",
        action: "marketplace.reconciliation_started",
        details: {
          operationId: OPERATION_ID_1,
          phase: "started",
          deploymentSha: "reviewed-sha",
          targetCount: 1,
        },
        createdAt: new Date("2026-07-28T00:00:00.000Z"),
      },
    ];
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn().mockResolvedValue(rows),
          })),
        })),
      })),
    };
    const diagnosis = {
      companyId: "company-a",
      verdict: "healthy" as const,
      teamId: "team-a",
      managedCrew: [],
      unmanagedCrew: [],
      operation: null,
    };

    const customized = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () => operationRecord()),
      diagnose: vi.fn(async () => diagnosis),
      hasCustomizedRows: vi.fn(async () => true),
      hasActiveWriter: vi.fn(async () => false),
    });
    expect(customized.safeToRetry).toBe(false);
    expect(customized.targets[0]?.crewState).toBe("blocked");

    const activeWriter = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () => operationRecord()),
      diagnose: vi.fn(async () => diagnosis),
      hasCustomizedRows: vi.fn(async () => false),
      hasActiveWriter: vi.fn(async () => true),
    });
    expect(activeWriter).toMatchObject({
      safeToRetry: false,
      targets: [
        {
          companyId: "company-a",
          crewState: "blocked",
          diagnosticCode: "install_in_flight",
        },
      ],
      retry: {
        kind: "inspect_first",
        recoveryCode: "inspect_operation",
      },
    });

    const queryFailure = await inspectMarketplaceReconciliation({
      db: db as any,
      operationId: OPERATION_ID_1,
      isActive: false,
      loadOperation: vi.fn(async () => operationRecord()),
      diagnose: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      hasCustomizedRows: vi.fn(async () => false),
      hasActiveWriter: vi.fn(async () => false),
    });
    expect(queryFailure.safeToRetry).toBe(false);
    expect(queryFailure.targets[0]?.crewState).toBe("unknown");
  });
});
