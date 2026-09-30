import { beforeEach, describe, expect, it, vi } from "vitest";
import { hubItemsService } from "../services/hub-items.js";
import { runtimeDecisionSourceSnapshot } from "../services/agent-runtime-decisions.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

function thenableRows<T>(rows: T[]) {
  return {
    then: (resolve: (value: T[]) => unknown) => Promise.resolve(resolve(rows)),
  };
}

// Walk a drizzle SQL expression tree collecting bound Param values (drizzle
// Params carry `value` + `encoder`). Lets us assert which literals ended up in
// the reconcile WHERE without executing SQL.
function collectSqlParamValues(expr: unknown, out: unknown[] = []): unknown[] {
  if (!expr || typeof expr !== "object") return out;
  const record = expr as Record<string, unknown>;
  if ("value" in record && "encoder" in record) {
    out.push(record.value);
    return out;
  }
  if (Array.isArray(record.queryChunks)) {
    for (const chunk of record.queryChunks) collectSqlParamValues(chunk, out);
  }
  return out;
}

// db double for the CLOSE path: reconcile's open-items select, the reconciler's
// decision-row select, then applyGuardedTransition's guarded
// update().set().where().returning() + insert(hubAudit).values().
function makeCloseDb(openHubItem: Record<string, unknown>, decisionRow: Record<string, unknown>) {
  const archivedRow = {
    ...openHubItem,
    status: "archived",
    version: (openHubItem.version as number) + 1,
    archivedAt: new Date("2026-07-04T00:00:00.000Z"),
  };
  let selectCount = 0;
  let capturedOpenWhere: unknown = null;
  const updateReturning = vi.fn(async () => [archivedRow]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const insertValues = vi.fn(async () => []);
  const db = {
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        return {
          from: () => ({
            where: (cond: unknown) => {
              capturedOpenWhere = cond;
              return thenableRows([openHubItem]);
            },
          }),
        };
      }
      return {
        from: () => ({
          where: () => ({
            limit: () => thenableRows([decisionRow]),
          }),
        }),
      };
    }),
    update: vi.fn(() => ({ set })),
    insert: vi.fn(() => ({ values: insertValues })),
  };
  return {
    db: db as never,
    archivedRow,
    set,
    insertValues,
    getOpenWhere: () => capturedOpenWhere,
  };
}

describe("hubItems runtime decision reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes open runtime decision items while relay_failed remains actionable", async () => {
    const openHubItem = {
      id: "hub-1",
      companyId: "company-1",
      sourceId: "decision-1",
      sourceType: "runtime_decision",
      semanticType: "agent_runtime_decision",
      status: "open",
      title: "Old title",
      summary: "Old summary",
      message: "Old summary",
      sourcePermissionRevision: "1",
      ownerUserId: "founder-1",
      ownerPool: null,
      scopeKey: null,
      version: 0,
      resolvedAt: null,
      archivedAt: null,
    };
    const runtimeDecision = {
      id: "decision-1",
      companyId: "company-1",
      status: "relay_failed",
      title: "Allow command?",
      summary: "Adapter hook disconnected",
      promptText: "pnpm test:run",
      relayError: "Adapter hook disconnected",
      sourceRevision: 2,
    };

    let selectCount = 0;
    const set = vi.fn(() => ({ where: vi.fn(async () => []) }));
    const db = {
      select: vi.fn(() => {
        selectCount += 1;
        if (selectCount === 1) {
          return { from: () => ({ where: () => thenableRows([openHubItem]) }) };
        }
        return {
          from: () => ({
            where: () => ({
              limit: () => thenableRows([runtimeDecision]),
            }),
          }),
        };
      }),
      update: vi.fn(() => ({ set })),
    } as never;

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "runtime_decision",
      sourceId: "decision-1",
    });

    expect(result).toEqual({ healed: 1, closed: 0, refreshed: 1 });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Allow command?",
        summary: "Adapter hook disconnected",
        message: "Adapter hook disconnected",
        sourcePermissionRevision: "2",
      }),
    );
  });

  // INVERTED (BUG-2, 2026-07-04): this test previously asserted the parked-
  // cancelled prompt STAYED OPEN with timeout context ({ closed: 0,
  // refreshed: 1 }) — that behavior WAS the bug (phantom answerable items in
  // Waiting-on-you, inflated badge, 409s). Terminal transitions now archive
  // the waiting-lane item; escalate-visibility is carried by a notifications-
  // lane agent_error follow-up emitted at expiry (Decisions #105/#106,
  // mechanism amended 2026-07-04). Do NOT read this inversion as a regression.
  it("closes parked runtime decision timeouts and publishes the archive in realtime", async () => {
    const openHubItem = {
      id: "hub-1",
      companyId: "company-1",
      sourceId: "decision-1",
      sourceType: "runtime_decision",
      semanticType: "agent_runtime_decision",
      status: "open",
      title: "Old title",
      summary: "Old summary",
      message: "Old summary",
      sourcePermissionRevision: "1",
      ownerUserId: "founder-1",
      ownerPool: null,
      scopeKey: null,
      version: 0,
      resolvedAt: null,
      archivedAt: null,
    };
    const runtimeDecision = {
      id: "decision-1",
      companyId: "company-1",
      status: "cancelled",
      title: "Need direction",
      summary: "Original question",
      promptText: "Which path should I take?",
      relayError: "timeout policy parked the run",
      timeoutPolicy: "park_run",
      sourceRevision: 3,
    };

    const { db, set, insertValues } = makeCloseDb(openHubItem, runtimeDecision);

    const snapshot = runtimeDecisionSourceSnapshot(runtimeDecision as never);
    expect(snapshot.terminal).toBe(true); // BUG-2: parked-cancelled IS terminal now

    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "runtime_decision",
      sourceId: "decision-1",
    });

    expect(result).toEqual({ healed: 1, closed: 1, refreshed: 0 });
    // Version-guarded archive via applyGuardedTransition (system actor).
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "archived", version: 1 }),
    );
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reconcile_close",
        actorType: "system",
        actorId: "reconciler",
        sourceRevision: "3",
      }),
    );
    // Realtime close: the archive is pushed to clients (item + counts).
    expect(publishLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "hub.item.changed",
        payload: expect.objectContaining({
          itemId: "hub-1",
          status: "archived",
          change: "archived",
        }),
      }),
    );
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "hub.counts.changed",
      payload: { reason: "item_changed" },
    });
  });

  it("scopes the runtime_decision sweep to agent_runtime_decision items only", async () => {
    // The expiry path emits an `agent_error` follow-up with the SAME
    // sourceType/sourceId as the archived waiting-lane item. The reconcile
    // sweep must therefore be narrowed to semanticType
    // "agent_runtime_decision", or it would instantly archive the follow-up
    // it just created (the source decision is terminal by definition there).
    const openHubItem = {
      id: "hub-1",
      companyId: "company-1",
      sourceId: "decision-1",
      sourceType: "runtime_decision",
      semanticType: "agent_runtime_decision",
      status: "open",
      title: "Old title",
      summary: "Old summary",
      message: "Old summary",
      sourcePermissionRevision: "1",
      ownerUserId: "founder-1",
      ownerPool: null,
      scopeKey: null,
      version: 0,
      resolvedAt: null,
      archivedAt: null,
    };
    const runtimeDecision = {
      id: "decision-1",
      companyId: "company-1",
      status: "cancelled",
      title: "Need direction",
      relayError: "timeout policy escalated the run",
      timeoutPolicy: "escalate",
      sourceRevision: 3,
    };

    const { db, getOpenWhere } = makeCloseDb(openHubItem, runtimeDecision);

    await hubItemsService(db).reconcile("company-1", {
      sourceType: "runtime_decision",
      sourceId: "decision-1",
    });

    const boundValues = collectSqlParamValues(getOpenWhere());
    expect(boundValues).toContain("agent_runtime_decision");
  });

  // INVERTED (BUG-2, 2026-07-04): previously asserted the parked row was
  // non-terminal and REFRESHED in place. The canonical snapshot now reports
  // parked-cancelled as terminal, so delegation is proven through the CLOSE
  // path instead (audit sourceRevision = snapshot.permissionRevision).
  it("reconciler output equals runtimeDecisionSourceSnapshot for parked timeout row", async () => {
    // Prove the reconciler delegates correctly — the output must match
    // runtimeDecisionSourceSnapshot(row) for the parked-timeout branch (the
    // branch most likely to drift if the logic is ever re-inlined).
    const parkedRow = {
      id: "decision-park",
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      adapterType: "claude_local",
      adapterSessionId: null,
      adapterSessionParams: null,
      kind: "permission",
      status: "cancelled",
      nonce: "abc123",
      sourceRevision: 5,
      promptHash: null,
      sourceUniqueKey: null,
      title: "Parked: approve shell command?",
      summary: "Command was paused",
      promptText: "Run rm -rf /tmp/old?",
      toolName: "bash",
      command: "rm -rf /tmp/old",
      commandHash: null,
      cwd: null,
      path: "/tmp/old",
      networkTarget: null,
      riskClass: "high",
      options: null,
      timeoutPolicy: "park_run",
      expiresAt: null,
      decision: null,
      answerPayload: null,
      answerIdempotencyKey: null,
      answeredByUserId: null,
      answeredAt: null,
      relayedAt: null,
      relayError: "timeout policy parked the run",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T01:00:00Z"),
    } as Parameters<typeof runtimeDecisionSourceSnapshot>[0];

    const openHubItem = {
      id: "hub-park",
      companyId: "company-1",
      sourceId: "decision-park",
      sourceType: "runtime_decision",
      semanticType: "agent_runtime_decision",
      status: "open",
      title: "Old title",
      summary: "Old summary",
      message: "Old summary",
      sourcePermissionRevision: "1",
      ownerUserId: "founder-1",
      ownerPool: null,
      scopeKey: null,
      version: 0,
      resolvedAt: null,
      archivedAt: null,
    };

    const { db, set, insertValues } = makeCloseDb(
      openHubItem,
      parkedRow as unknown as Record<string, unknown>,
    );

    // The expected snapshot via the canonical function
    const expected = runtimeDecisionSourceSnapshot(parkedRow);

    // BUG-2 (2026-07-04): the parked row IS terminal now (the old carve-out
    // kept it open forever — that was the bug). The summary branch survives
    // for pre-close refreshes, and the revision still comes from the snapshot.
    expect(expected.terminal).toBe(true);
    expect(expected.summary).toBe("timeout policy parked the run"); // relayError branch
    expect(expected.permissionRevision).toBe("5");

    // The reconciler must act on the same values — it delegates to that function
    const result = await hubItemsService(db).reconcile("company-1", {
      sourceType: "runtime_decision",
      sourceId: "decision-park",
    });

    expect(result).toEqual({ healed: 1, closed: 1, refreshed: 0 });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "archived" }),
    );
    // The close audit row carries the snapshot's permissionRevision — proving
    // the reconciler consulted runtimeDecisionSourceSnapshot for this row.
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "reconcile_close",
        sourceRevision: expected.permissionRevision,
      }),
    );
  });
});
