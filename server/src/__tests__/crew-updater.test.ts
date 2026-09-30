import { describe, it, expect, vi } from "vitest";

vi.mock("../services/marketplace-install/fetch-resource.js", () => ({
  fetchCatalogResource: vi.fn().mockResolvedValue(JSON.stringify({
    schemaVersion: "agent.v1", id: "aoa-curated/standard-crew/maker", name: "Maker",
    description: "test", instructions: { type: "inline", content: "new instructions" },
    aoa: {
      runtimeConfig: { aoa: { toolAllowlist: ["new_tool"] } },
      skillKeys: ["new-skill"],
      triggers: [{ kind: "mention", config: { role: "maker" } }],
    },
  })),
}));
vi.mock("../services/marketplace-install/agent-create.js", () => ({
  loadMarketplaceInstructionFiles: vi.fn().mockResolvedValue({
    files: { "INSTRUCTIONS.md": "new content" }, entryFile: "INSTRUCTIONS.md",
  }),
}));
vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return {
    agents: tableProxy,
    aoaAgentTriggers: tableProxy,
    marketplacePendingUpdates: tableProxy,
  };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op:eq"),
  and: () => Symbol("op:and"),
  inArray: () => Symbol("op:inArray"),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: {
    updateAvailable: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../services/marketplace-install/skill-auto-updater.js", () => ({
  isWithinUpdateWindow: vi.fn().mockReturnValue(true),
}));

import {
  AgentInstructionsCustomizedError,
  applyCrewAgentUpdate,
  checkCrewUpdates,
} from "../services/marketplace-install/crew-updater.js";

// ── helpers ────────────────────────────────────────────────────────────────

const CATALOG_ITEM = {
  id: "aoa-curated/standard-crew/maker",
  type: "agent" as const,
  name: "Maker",
  version: "0.1.0",
  description: "test",
  source: { adapter: "aoa-curated", url: "https://example.com", locator: "maker", commitSha: "abc" },
  resourceUrl: "https://example.com/agent.json",
  trust: { tier: "verified" as const, source: "aoa-curated" },
  status: "active" as const,
  addedAt: "2026-01-01T00:00:00Z",
  category: "crew",
  tags: [],
  requires: [],
};

const AGENT_ROW = {
  id: "agent-1",
  companyId: "co-1",
  name: "Maker",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: { aoa: { toolAllowlist: ["old_tool"] } },
  skillKeys: ["old-skill"],
  templateVersion: "0.0.1",
  // D22: `false` = AoA materialized this bundle and nothing has edited it since.
  instructionsCustomized: false as boolean | null,
};

/** F2: the single indexed re-read `applyCrewAgentUpdate` does before materializing. */
function liveSelect(state: boolean | null | undefined) {
  return vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(
          state === undefined ? [] : [{ instructionsCustomized: state }],
        ),
      }),
    }),
  });
}

/** Drizzle's builders are thenable AND chainable. `update().set().where()` is
 * awaited directly in some places and `.returning()`-ed in others, so the mock
 * has to be both.
 */
function whereResult(returningRows: unknown[]) {
  return {
    returning: vi.fn().mockResolvedValue(returningRows),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(undefined).then(resolve, reject),
  };
}

function makeTxMock(
  updatedFields: Record<string, unknown>,
  opts?: { agentUpdateReturning?: unknown[] },
) {
  const agentUpdateReturning = opts?.agentUpdateReturning ?? [{ id: "agent-1" }];
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        Object.assign(updatedFields, v);
        return { where: vi.fn().mockReturnValue(whereResult(agentUpdateReturning)) };
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  };
}

/**
 * Top-level db mock for the notify path (pending-update insert).
 *
 * `select` serves BOTH shapes: `checkCrewUpdates`' batch `.from().where()`
 * (awaited directly) and `applyCrewAgentUpdate`'s F2 re-read
 * `.from().where().limit()`. `liveState` defaults to the first row's snapshot
 * value, so an unchanged row behaves as it would in production; pass it
 * explicitly to simulate a founder edit landing mid-pass.
 */
function makeNotifyDb(
  rows: unknown[],
  liveState?: boolean | null,
  opts?: {
    pendingRowAlreadyExists?: boolean;
    pendingInsertError?: Error;
    /** The row `checkCrewUpdates` reads back after `onConflictDoNothing` loses. */
    existingPendingRow?: { status: string; latestVersion: string };
  },
) {
  const insertedValues: Record<string, unknown>[] = [];
  /** T2.7: SET payloads of the pending-row status reconcile (top-level, not tx). */
  const pendingUpdateSets: Record<string, unknown>[] = [];
  const resolvedLive =
    liveState !== undefined
      ? liveState
      : ((rows[0] as { instructionsCustomized?: boolean | null } | undefined)
          ?.instructionsCustomized ?? null);
  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi
            .fn()
            .mockResolvedValue(
              opts?.existingPendingRow
                ? [opts.existingPendingRow]
                : [{ instructionsCustomized: resolvedLive }],
            ),
          then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        insertedValues.push(v);
        return {
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: opts?.pendingInsertError
              ? vi.fn().mockRejectedValue(opts.pendingInsertError)
              : vi
                  .fn()
                  .mockResolvedValue(
                    opts?.pendingRowAlreadyExists
                      ? []
                      : [{ id: "pending-1" }],
                  ),
          }),
        };
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((v: Record<string, unknown>) => {
        pendingUpdateSets.push(v);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }),
    transaction: vi.fn(),
  };
  return { db, insertedValues, pendingUpdateSets };
}

const AUTO_SETTINGS = {
  agentUpdatePolicy: "auto" as const,
  updateWindow: "anytime" as const,
  allowTeamLeadPlugins: false,
  teamMemberCanRequestInstall: false,
  requireFounderApproval: false,
  updateCheckHours: 24 as const,
};

// ── tests: applyCrewAgentUpdate ────────────────────────────────────────────

describe("applyCrewAgentUpdate", () => {
  it("calls materializeManagedBundle with replaceExisting:true and bumps templateVersion", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: { updated: true } });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);
    const db = {
      select: liveSelect(false),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    await applyCrewAgentUpdate({
      db: db as any,
      agentRow: AGENT_ROW,
      catalogItem: CATALOG_ITEM,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    // Must call with replaceExisting: true
    expect(mockMaterialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.any(Object),
      expect.objectContaining({ replaceExisting: true }),
    );
    // Must bump templateVersion
    expect(updatedFields.templateVersion).toBe("0.1.0");
  });

  it("replaces triggers: deletes old, inserts new from template", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);
    const db = {
      select: liveSelect(false),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    await applyCrewAgentUpdate({
      db: db as any,
      agentRow: AGENT_ROW,
      catalogItem: CATALOG_ITEM,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    // delete aoaAgentTriggers called once
    expect(txMock.delete).toHaveBeenCalled();
    // insert called for new trigger + pending update mark
    expect(txMock.insert).toHaveBeenCalled();
  });

  it("updates skillKeys from the new catalog template", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);
    const db = {
      select: liveSelect(false),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    await applyCrewAgentUpdate({
      db: db as any,
      agentRow: AGENT_ROW,
      catalogItem: CATALOG_ITEM,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    // skillKeys should be replaced with template value (["new-skill"] from mocked fetch)
    expect(updatedFields.skillKeys).toBeDefined();
  });
});

// ── tests: D22 instruction-customization guard ─────────────────────────────

describe("applyCrewAgentUpdate — D22 customization guard", () => {
  it("refuses a customized agent BEFORE materializeManagedBundle can delete the edits", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);
    const db = {
      select: liveSelect(false),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    await expect(
      applyCrewAgentUpdate({
        db: db as any,
        agentRow: { ...AGENT_ROW, instructionsCustomized: true },
        catalogItem: CATALOG_ITEM,
        instructionsService: { materializeManagedBundle: mockMaterialize } as any,
      }),
    ).rejects.toBeInstanceOf(AgentInstructionsCustomizedError);

    // The destructive half (fs.rm on the founder's instructions root) must never run.
    expect(mockMaterialize).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses a row whose customization state is unknown (pre-D22 row)", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const db = { select: liveSelect(false), transaction: vi.fn() };

    await expect(
      applyCrewAgentUpdate({
        db: db as any,
        agentRow: { ...AGENT_ROW, instructionsCustomized: null },
        catalogItem: CATALOG_ITEM,
        instructionsService: { materializeManagedBundle: mockMaterialize } as any,
      }),
    ).rejects.toBeInstanceOf(AgentInstructionsCustomizedError);
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  // F2: the batch snapshot `checkCrewUpdates` hands us is stale by every
  // preceding agent's full apply cycle. The re-read is what actually protects
  // the disk.
  it("re-reads the row before materializing and refuses if the founder edited mid-pass", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const db = {
      // Snapshot said `false`; the live row now says `true`.
      select: liveSelect(true),
      transaction: vi.fn(),
    };

    await expect(
      applyCrewAgentUpdate({
        db: db as any,
        agentRow: { ...AGENT_ROW, instructionsCustomized: false },
        catalogItem: CATALOG_ITEM,
        instructionsService: { materializeManagedBundle: mockMaterialize } as any,
      }),
    ).rejects.toBeInstanceOf(AgentInstructionsCustomizedError);

    expect(db.select).toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("refuses when the row vanished between the snapshot and the re-read", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const db = { select: liveSelect(undefined), transaction: vi.fn() };

    await expect(
      applyCrewAgentUpdate({
        db: db as any,
        agentRow: { ...AGENT_ROW, instructionsCustomized: false },
        catalogItem: CATALOG_ITEM,
        instructionsService: { materializeManagedBundle: mockMaterialize } as any,
      }),
    ).rejects.toBeInstanceOf(AgentInstructionsCustomizedError);
    expect(mockMaterialize).not.toHaveBeenCalled();
  });

  it("throws rather than reporting success when a concurrent edit wins the optimistic lock", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    // Empty RETURNING = the `instructions_customized = false` predicate no longer matched.
    const txMock = makeTxMock(updatedFields, { agentUpdateReturning: [] });
    const db = {
      select: liveSelect(false),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    await expect(
      applyCrewAgentUpdate({
        db: db as any,
        agentRow: AGENT_ROW,
        catalogItem: CATALOG_ITEM,
        instructionsService: { materializeManagedBundle: mockMaterialize } as any,
      }),
    ).rejects.toBeInstanceOf(AgentInstructionsCustomizedError);
  });

  it("re-asserts instructionsCustomized=false on a successful apply", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);
    const db = {
      select: liveSelect(false),
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    await applyCrewAgentUpdate({
      db: db as any,
      agentRow: AGENT_ROW,
      catalogItem: CATALOG_ITEM,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    expect(updatedFields.instructionsCustomized).toBe(false);
  });
});

describe("checkCrewUpdates — D22 routing", () => {
  it("does NOT auto-apply a customized agent, even on policy=auto inside the window", async () => {
    const { db, insertedValues } = makeNotifyDb([
      {
        ...AGENT_ROW,
        companyId: "co-1",
        templateOrigin: CATALOG_ITEM.id,
        kind: "aoa",
        instructionsCustomized: true,
      },
    ]);
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings: AUTO_SETTINGS,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
    // Routed to the EXISTING notify machinery — pending row + updateAvailable.
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({ catalogItemId: CATALOG_ITEM.id, itemType: "agent" });
    const { marketplaceNotifications } = await import("../services/marketplace-notifications.js");
    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalled();
  });

  it("does NOT auto-apply a row with unknown customization state (pre-D22 row)", async () => {
    const { db, insertedValues } = makeNotifyDb([
      {
        ...AGENT_ROW,
        companyId: "co-1",
        templateOrigin: CATALOG_ITEM.id,
        kind: "aoa",
        instructionsCustomized: null,
      },
    ]);
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings: AUTO_SETTINGS,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    expect(db.transaction).not.toHaveBeenCalled();
    expect(mockMaterialize).not.toHaveBeenCalled();
    expect(insertedValues).toHaveLength(1);
  });

  // THE DISCRIMINATOR. Without this, an implementation that simply disabled
  // instruction updates for every agent would pass every test above.
  it("still auto-applies an UNTOUCHED agent (instructionsCustomized=false)", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);
    const { db, insertedValues } = makeNotifyDb([
      {
        ...AGENT_ROW,
        companyId: "co-1",
        templateOrigin: CATALOG_ITEM.id,
        kind: "aoa",
        instructionsCustomized: false,
      },
    ]);
    db.transaction = vi
      .fn()
      .mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock));

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings: AUTO_SETTINGS,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    expect(db.transaction).toHaveBeenCalled();
    expect(mockMaterialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "agent-1" }),
      expect.any(Object),
      expect.objectContaining({ replaceExisting: true }),
    );
    expect(updatedFields.templateVersion).toBe("0.1.0");
    // Auto-apply is silent: no pending row, no "update available" notification.
    expect(insertedValues).toHaveLength(0);
  });
});

// ── tests: T2.7 — the `conflict` status is WRITTEN ─────────────────────────
//
// Before T2.7 `conflict` was read in three places and written in none: the
// apply route's stale-status guard, `UpdateCard`'s badge and
// `MarketplaceUpdatesPanel`'s filter all handled a value nothing produced.
// These tests exist so it cannot quietly go back to being dead.

describe("checkCrewUpdates — conflict status (T2.7)", () => {
  const NOTIFY_SETTINGS = { ...AUTO_SETTINGS, agentUpdatePolicy: "notify" as const };

  async function runNotify(
    instructionsCustomized: boolean | null,
    settings = AUTO_SETTINGS,
    opts?: {
      pendingRowAlreadyExists?: boolean;
      existingPendingRow?: { status: string; latestVersion: string };
    },
  ) {
    const harness = makeNotifyDb(
      [
        {
          ...AGENT_ROW,
          companyId: "co-1",
          templateOrigin: CATALOG_ITEM.id,
          kind: "aoa",
          instructionsCustomized,
        },
      ],
      undefined,
      opts,
    );
    await checkCrewUpdates({
      db: harness.db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings,
      instructionsService: { materializeManagedBundle: vi.fn().mockResolvedValue({ adapterConfig: {} }) } as any,
    });
    return harness;
  }

  it("records a CUSTOMIZED agent's pending update as `conflict`", async () => {
    const { insertedValues } = await runNotify(true);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]!.status).toBe("conflict");
  });

  it("records an UNKNOWN-provenance agent's pending update as `conflict`", async () => {
    // The T2.6 backlog: every crew agent installed before migration 0182.
    const { insertedValues } = await runNotify(null);
    expect(insertedValues[0]!.status).toBe("conflict");
  });

  // THE DISCRIMINATOR. An implementation that stamped every agent update
  // `conflict` would satisfy both tests above and make the badge meaningless
  // again — a permanent red flag on updates that are held back only by policy
  // and would apply with one click.
  it("records an UNTOUCHED agent held back by POLICY as `pending`, not `conflict`", async () => {
    const { insertedValues } = await runNotify(false, NOTIFY_SETTINGS);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]!.status).toBe("pending");
  });

  it("promotes an ALREADY-EXISTING pending row to `conflict` when the agent diverged", async () => {
    const { insertedValues, pendingUpdateSets } = await runNotify(true, AUTO_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: { status: "pending", latestVersion: "0.0.9" },
    });
    // The insert lost the race with an existing row, so the status has to be
    // reconciled by an explicit UPDATE — `onConflictDoNothing` alone would leave
    // a stale `pending` row on a now-divergent agent forever.
    expect(insertedValues).toHaveLength(1);
    expect(pendingUpdateSets).toHaveLength(1);
    expect(pendingUpdateSets[0]).toMatchObject({
      status: "conflict",
      latestVersion: CATALOG_ITEM.version,
    });
  });

  it("demotes an existing row back to `pending` once the divergence is gone", async () => {
    const { pendingUpdateSets } = await runNotify(false, NOTIFY_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: { status: "conflict", latestVersion: "0.0.9" },
    });
    expect(pendingUpdateSets[0]).toMatchObject({ status: "pending" });
  });

  it("retries the idempotent notification for an existing live agent update", async () => {
    const { marketplaceNotifications } =
      await import("../services/marketplace-notifications.js");
    vi.mocked(marketplaceNotifications.updateAvailable).mockClear();

    await runNotify(false, NOTIFY_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: {
        status: "pending",
        latestVersion: CATALOG_ITEM.version,
      },
    });

    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalledOnce();
  });

  // ── F4: this block is the ONLY writer of `itemType: "agent"` rows ─────────
  //
  // `upsertPendingUpdate`, which owns re-opening for skills and plugins, has no
  // agent caller (`checkCompany` still carries `TODO: Add agent + team template
  // checks`). Without the re-open here, `onConflictDoNothing` + the unique
  // index made dismiss permanent PER AGENT rather than per version, and an
  // agent that ever took an update never announced another one.

  it("re-opens a DISMISSED row for a genuinely newer release", async () => {
    const { pendingUpdateSets } = await runNotify(true, AUTO_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: { status: "dismissed", latestVersion: "0.0.5" },
    });
    expect(pendingUpdateSets[0]).toMatchObject({
      status: "conflict",
      latestVersion: CATALOG_ITEM.version,
    });
    const { marketplaceNotifications } = await import("../services/marketplace-notifications.js");
    expect(marketplaceNotifications.updateAvailable).toHaveBeenCalled();
  });

  it("re-opens an APPLIED row for a genuinely newer release", async () => {
    const { pendingUpdateSets } = await runNotify(false, NOTIFY_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: { status: "applied", latestVersion: "0.0.5" },
    });
    expect(pendingUpdateSets[0]).toMatchObject({ status: "pending" });
  });

  // THE DISCRIMINATOR for the re-open: a dismissal must still hold for the
  // version it was made against, or "dismiss" would mean nothing at all.
  it("does NOT re-open a dismissed row at the SAME version", async () => {
    const { pendingUpdateSets } = await runNotify(true, AUTO_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: { status: "dismissed", latestVersion: CATALOG_ITEM.version },
    });
    expect(pendingUpdateSets).toHaveLength(0);
  });

  it("refreshes currentVersion so the card cannot render a stale range", async () => {
    // F7. The agent's version can move by another path (a merge, an adoption);
    // a row still carrying the version it was minted at renders a wrong
    // "0.0.1 → 0.1.0".
    const { pendingUpdateSets } = await runNotify(true, AUTO_SETTINGS, {
      pendingRowAlreadyExists: true,
      existingPendingRow: { status: "pending", latestVersion: "0.0.9" },
    });
    expect(pendingUpdateSets[0]).toMatchObject({ currentVersion: AGENT_ROW.templateVersion });
  });
});

// ── tests: checkCrewUpdates ────────────────────────────────────────────────

describe("checkCrewUpdates", () => {
  it("reports a pending-update persistence failure to its caller", async () => {
    const persistenceError = new Error("pending insert failed");
    const onFailure = vi.fn();
    const { db } = makeNotifyDb(
      [
        {
          ...AGENT_ROW,
          companyId: "co-1",
          templateOrigin: CATALOG_ITEM.id,
          kind: "aoa",
        },
      ],
      undefined,
      { pendingInsertError: persistenceError },
    );

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings: { ...AUTO_SETTINGS, agentUpdatePolicy: "notify" },
      instructionsService: {} as any,
      onFailure,
    });

    expect(onFailure).toHaveBeenCalledWith({
      companyId: "co-1",
      agentId: "agent-1",
      catalogItemId: CATALOG_ITEM.id,
      stage: "pending_update",
      error: persistenceError,
    });
  });

  it("auto-applies when policy=auto and within update window", async () => {
    const { isWithinUpdateWindow } = await import("../services/marketplace-install/skill-auto-updater.js");
    vi.mocked(isWithinUpdateWindow).mockReturnValue(true);

    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });
    const updatedFields: Record<string, unknown> = {};
    const txMock = makeTxMock(updatedFields);

    const { db: notifyDb } = makeNotifyDb([
      { ...AGENT_ROW, companyId: "co-1", templateOrigin: CATALOG_ITEM.id, kind: "aoa" },
    ]);
    const db = {
      ...notifyDb,
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(txMock)),
    };

    const settings = {
      agentUpdatePolicy: "auto" as const,
      updateWindow: "anytime" as const,
      allowTeamLeadPlugins: false,
      teamMemberCanRequestInstall: false,
      requireFounderApproval: false,
      updateCheckHours: 24 as const,
    };

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    // transaction should have been called (auto-apply ran)
    expect(db.transaction).toHaveBeenCalled();
  });

  it("skips agents with @legacy templateOrigin", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              ...AGENT_ROW, companyId: "co-1",
              templateOrigin: "aoa-curated/standard-crew/maker@legacy",
              kind: "aoa",
            },
          ]),
        }),
      }),
      transaction: vi.fn(),
    };

    const settings = {
      agentUpdatePolicy: "auto" as const,
      updateWindow: "anytime" as const,
      allowTeamLeadPlugins: false,
      teamMemberCanRequestInstall: false,
      requireFounderApproval: false,
      updateCheckHours: 24 as const,
    };

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    // @legacy agents are skipped — no transaction
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("skips agents where catalog version matches templateVersion", async () => {
    const mockMaterialize = vi.fn().mockResolvedValue({ adapterConfig: {} });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              ...AGENT_ROW,
              companyId: "co-1",
              templateOrigin: CATALOG_ITEM.id,
              templateVersion: CATALOG_ITEM.version, // same version = no update needed
              kind: "aoa",
            },
          ]),
        }),
      }),
      transaction: vi.fn(),
    };

    const settings = {
      agentUpdatePolicy: "auto" as const,
      updateWindow: "anytime" as const,
      allowTeamLeadPlugins: false,
      teamMemberCanRequestInstall: false,
      requireFounderApproval: false,
      updateCheckHours: 24 as const,
    };

    await checkCrewUpdates({
      db: db as any,
      companyId: "co-1",
      catalogItems: [CATALOG_ITEM],
      settings,
      instructionsService: { materializeManagedBundle: mockMaterialize } as any,
    });

    expect(db.transaction).not.toHaveBeenCalled();
  });
});
