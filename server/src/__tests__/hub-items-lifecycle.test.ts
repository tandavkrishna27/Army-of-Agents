import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { hubItemsService } from "../services/hub-items.js";
import { publishLiveEvent } from "../services/live-events.js";

const mockPerms = vi.hoisted(() => ({
  getEffectiveRole: vi.fn(),
  getTeamLeadDepartments: vi.fn(),
}));

const mockCounterSnapshots = vi.hoisted(() => ({
  invalidateUser: vi.fn(),
  invalidateCompany: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: () => mockPerms,
}));

vi.mock("../services/hub-counter-snapshots.js", () => ({
  hubCounterSnapshotsService: () => mockCounterSnapshots,
}));

function makeSelectChain(rows: unknown[], captured: { where: unknown[] }) {
  const chain = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn((condition: unknown) => {
      captured.where.push(condition);
      return chain;
    }),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function encodeTestCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function makeDb(rows: unknown[] = []) {
  const captured = { where: [] as unknown[] };
  const db = {
    select: vi.fn(() => makeSelectChain(rows, captured)),
  };
  return { db, captured };
}

function makeInsertChain(rows: unknown[]) {
  const chain = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

function makeUpdateChain(rows: unknown[]) {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

function renderWhere(condition: unknown) {
  return new PgDialect().sqlToQuery(condition as never).sql.toLowerCase();
}

function renderWhereQuery(condition: unknown) {
  return new PgDialect().sqlToQuery(condition as never);
}

describe("hubItems lifecycle query semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockPerms.getTeamLeadDepartments.mockResolvedValue([]);
  });

  it("default query hides dismissed and future-snoozed rows for the current user", async () => {
    const { db, captured } = makeDb();
    const svc = hubItemsService(db as never);

    await svc.query("company-1", { actorUserId: "alice", role: "founder" });

    const whereSql = renderWhere(captured.where[0]);
    expect(whereSql).toContain('"hub_item_user_state"."dismissed_at" is null');
    expect(whereSql).toContain('"hub_item_user_state"."snoozed_until" is null');
    expect(whereSql).toContain('"hub_item_user_state"."snoozed_until" <=');
  });

  it("includeSnoozed=true keeps future-snoozed rows in explicit list queries", async () => {
    const { db, captured } = makeDb();
    const svc = hubItemsService(db as never);

    await svc.query("company-1", {
      actorUserId: "alice",
      role: "founder",
      includeSnoozed: true,
    } as never);

    const whereSql = renderWhere(captured.where[0]);
    expect(whereSql).toContain('"hub_item_user_state"."dismissed_at" is null');
    expect(whereSql).not.toContain('"hub_item_user_state"."snoozed_until"');
  });

  it("counts use the same dismissed and future-snoozed visibility filters as the default list", async () => {
    const { db, captured } = makeDb([{ open: 0, unread: 0 }]);
    const svc = hubItemsService(db as never);

    await svc.counts("company-1", "alice", "founder");

    const whereSql = renderWhere(captured.where[0]);
    expect(whereSql).toContain('"hub_item_user_state"."dismissed_at" is null');
    expect(whereSql).toContain('"hub_item_user_state"."snoozed_until" is null');
    expect(whereSql).toContain('"hub_item_user_state"."snoozed_until" <=');
  });

  it("query searches title, summary, source, scope, and semantic fields with escaped LIKE", async () => {
    const { db, captured } = makeDb();
    const svc = hubItemsService(db as never);

    await svc.query("company-1", {
      actorUserId: "alice",
      role: "founder",
      q: String.raw`100%_ready\ship`,
    } as never);

    const where = renderWhereQuery(captured.where[0]);
    const whereSql = where.sql.toLowerCase();
    expect(whereSql).toContain('lower("notifications"."title") like');
    expect(whereSql).toContain('lower("notifications"."summary") like');
    expect(whereSql).toContain('lower("notifications"."source_type") like');
    expect(whereSql).toContain('lower("notifications"."scope_key") like');
    expect(whereSql).toContain('lower("notifications"."semantic_type") like');
    expect(whereSql).toContain("escape '\\'");
    expect(where.params).toContain(String.raw`%100\%\_ready\\ship%`);
  });

  it("query applies stable keyset cursor predicates", async () => {
    const { db, captured } = makeDb();
    const svc = hubItemsService(db as never);

    await svc.query("company-1", {
      actorUserId: "alice",
      role: "founder",
      cursor: encodeTestCursor("2026-06-30T00:00:00.000Z", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
    } as never);

    const whereSql = renderWhere(captured.where[0]);
    expect(whereSql).toContain('"notifications"."created_at" <');
    expect(whereSql).toContain('"notifications"."created_at" =');
    expect(whereSql).toContain('"notifications"."id" <');
  });

  it("invalidates the actor snapshot after personal state changes", async () => {
    const insertChain = makeInsertChain([{ id: "state-1" }]);
    const { db } = makeDb([
      {
        item: {
          id: "hub-1",
          companyId: "company-1",
          semanticType: "approval_request",
          status: "open",
          scopeKey: null,
          sourceType: null,
          groupKey: null,
          slaAt: null,
        },
        readAt: null,
        snoozedUntil: null,
        dismissedAt: null,
      },
    ]);
    Object.assign(db, { insert: vi.fn(() => insertChain) });
    const svc = hubItemsService(db as never);

    await svc.applyPersonalState({
      companyId: "company-1",
      hubItemId: "hub-1",
      actorUserId: "user-1",
      role: "founder",
      state: { kind: "dismiss" },
    });

    expect(mockCounterSnapshots.invalidateUser).toHaveBeenCalledWith("company-1", "user-1");
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "hub.counts.changed",
      payload: { reason: "personal_state_changed" },
    });
  });

  it("invalidates company snapshots after shared lifecycle actions", async () => {
    const current = {
      id: "hub-1",
      companyId: "company-1",
      semanticType: "approval_request",
      status: "open",
      version: 1,
      resolvedAt: null,
      archivedAt: null,
      claimedByUserId: null,
      claimedAt: null,
      ownerPool: null,
    };
    const tx = {
      update: vi.fn(() => makeUpdateChain([{ ...current, status: "resolved", version: 2 }])),
      insert: vi
        .fn()
        .mockReturnValueOnce(makeInsertChain([
          { id: "audit-1", undoDeadline: new Date("2026-06-30T10:00:08.000Z") },
        ]))
        .mockReturnValueOnce(makeInsertChain([])),
    };
    const db = {
      select: vi.fn(() => makeSelectChain([current], { where: [] })),
      transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    const svc = hubItemsService(db as never);

    await svc.recordLifecycleAction({
      companyId: "company-1",
      hubItemId: "hub-1",
      action: "resolve",
      expectedVersion: 1,
      actorType: "user",
      actorId: "user-1",
      actorIsFounder: true,
      authorityBasis: "founder",
    });

    expect(mockCounterSnapshots.invalidateCompany).toHaveBeenCalledWith("company-1");
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "hub.item.changed",
      payload: {
        itemId: "hub-1",
        semanticType: "approval_request",
        lane: "waiting_on_you",
        status: "resolved",
        version: 2,
        change: "resolved",
      },
    });
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: "company-1",
      type: "hub.counts.changed",
      payload: { reason: "item_changed" },
    });
  });
});

// ── Mirror-model manual-lifecycle guard (R3 + H1) ───────────────────────────
//
// resolve/archive on a still-pending source-backed decision item is
// server-rejected (409); items leave the waiting lane only when the source is
// decided. TWO source classes with DIFFERENT pending checks:
//   - approval_request / join_request → block while the SOURCE reconciler
//     reports non-terminal (pending). terminal/gone source → allow (fail-open).
//   - agent_runtime_decision → block ONLY while decision.status ∈ {created,
//     shown}; answered/relay_failed rows MUST stay clearable (Task 5 sweep).
// dismiss/snooze/claim/release are unaffected.

// A select() mock that returns a DIFFERENT result set per call, in sequence:
// call 1 = the hub item (`current`), call 2 = the backing source row.
function makeSequencedDb(sequence: unknown[][]) {
  let i = 0;
  const db = {
    select: vi.fn(() => {
      const rows = sequence[Math.min(i, sequence.length - 1)] ?? [];
      i += 1;
      return makeSelectChain(rows, { where: [] });
    }),
    transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        update: vi.fn(() => makeUpdateChain([{ status: "resolved", version: 2 }])),
        insert: vi
          .fn()
          .mockReturnValueOnce(
            makeInsertChain([{ id: "audit-1", undoDeadline: new Date("2026-06-30T10:00:08.000Z") }]),
          )
          .mockReturnValueOnce(makeInsertChain([])),
      }),
    ),
  };
  return db;
}

function openHubItem(over: Record<string, unknown> = {}) {
  return {
    id: "hub-1",
    companyId: "company-1",
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: "src-1",
    status: "open",
    version: 1,
    resolvedAt: null,
    archivedAt: null,
    claimedByUserId: null,
    claimedAt: null,
    ownerPool: null,
    ...over,
  };
}

async function catchStatus(fn: () => Promise<unknown>): Promise<number | "ok"> {
  try {
    await fn();
    return "ok";
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

describe("hubItems mirror-model lifecycle guard (R3 + H1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPerms.getEffectiveRole.mockResolvedValue("founder");
    mockPerms.getTeamLeadDepartments.mockResolvedValue([]);
  });

  const founderArgs = {
    companyId: "company-1",
    hubItemId: "hub-1",
    expectedVersion: 1,
    actorType: "user" as const,
    actorId: "founder-1",
    actorIsFounder: true,
    authorityBasis: "founder",
  };

  it.each(["resolve", "archive"] as const)(
    "%s on an OPEN approval_request whose source is PENDING → 409",
    async (action) => {
      const db = makeSequencedDb([
        [openHubItem({ semanticType: "approval_request", sourceType: "approval" })],
        [{ status: "pending", decisionNote: null, updatedAt: new Date() }],
      ]);
      const svc = hubItemsService(db as never);
      expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action }))).toBe(409);
    },
  );

  it("resolve on an approval_request whose source is DECIDED (row still open) → allowed", async () => {
    const db = makeSequencedDb([
      [openHubItem({ semanticType: "approval_request", sourceType: "approval" })],
      [{ status: "approved", decisionNote: "ok", updatedAt: new Date() }],
    ]);
    const svc = hubItemsService(db as never);
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "resolve" }))).toBe("ok");
  });

  it("archive on an approval_request whose source ROW IS GONE → allowed (fail-open)", async () => {
    const db = makeSequencedDb([
      [openHubItem({ semanticType: "approval_request", sourceType: "approval" })],
      [], // reconciler → terminal:true
    ]);
    const svc = hubItemsService(db as never);
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "archive" }))).toBe("ok");
  });

  it("archive on an OPEN join_request whose source is PENDING → 409", async () => {
    const db = makeSequencedDb([
      [openHubItem({ semanticType: "join_request", sourceType: "join_request" })],
      [{ requestType: "agent", status: "pending_approval", agentName: "Scout", requestEmailSnapshot: null, adapterType: "claude_local", updatedAt: new Date() }],
    ]);
    const svc = hubItemsService(db as never);
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "archive" }))).toBe(409);
  });

  it("archive on a join_request whose source is SETTLED → allowed", async () => {
    const db = makeSequencedDb([
      [openHubItem({ semanticType: "join_request", sourceType: "join_request" })],
      [{ requestType: "agent", status: "approved", agentName: "Scout", requestEmailSnapshot: null, adapterType: "claude_local", updatedAt: new Date() }],
    ]);
    const svc = hubItemsService(db as never);
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "archive" }))).toBe("ok");
  });

  it.each(["resolve", "archive"] as const)(
    "%s on an OPEN work_question whose source is unanswered → 409",
    async (action) => {
      const db = makeSequencedDb([
        [openHubItem({ semanticType: "work_question", sourceType: "work_question" })],
        [{
          status: "open",
          title: "Choose launch cohort",
          question: "Which cohort should the agent use?",
          currentRecipientUserId: "founder-1",
          version: 0,
          updatedAt: new Date(),
        }],
      ]);
      const svc = hubItemsService(db as never);
      expect(await catchStatus(() => svc.recordLifecycleAction({
        ...founderArgs,
        action,
      }))).toBe(409);
    },
  );

  it.each(["created", "shown"] as const)(
    "resolve on a %s agent_runtime_decision item → 409",
    async (status) => {
      const db = makeSequencedDb([
        [openHubItem({ semanticType: "agent_runtime_decision", sourceType: "runtime_decision" })],
        [{ status }],
      ]);
      const svc = hubItemsService(db as never);
      expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "resolve" }))).toBe(409);
    },
  );

  it("archive on an ANSWERED agent_runtime_decision item → ALLOWED (Task 5 collision guard)", async () => {
    const db = makeSequencedDb([
      [openHubItem({ semanticType: "agent_runtime_decision", sourceType: "runtime_decision" })],
      [{ status: "answered" }],
    ]);
    const svc = hubItemsService(db as never);
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "archive" }))).toBe("ok");
  });

  it("resolve on a relay_failed agent_runtime_decision item → ALLOWED (dead-run stall stays clearable)", async () => {
    const db = makeSequencedDb([
      [openHubItem({ semanticType: "agent_runtime_decision", sourceType: "runtime_decision" })],
      [{ status: "relay_failed" }],
    ]);
    const svc = hubItemsService(db as never);
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "resolve" }))).toBe("ok");
  });

  it("claim/release on a pending approval_request are UNAFFECTED by the guard", async () => {
    // claim requires ownerPool='board'; release requires an existing claimant.
    const claimDb = makeSequencedDb([
      [openHubItem({ semanticType: "approval_request", sourceType: "approval", ownerPool: "board" })],
    ]);
    const svc = hubItemsService(claimDb as never);
    // The guard is scoped to resolve|archive — claim reaches the claim branch, not
    // a source lookup (a single hub-item select, no 409 from the mirror guard).
    expect(await catchStatus(() => svc.recordLifecycleAction({ ...founderArgs, action: "claim" }))).toBe("ok");

    const releaseDb = makeSequencedDb([
      [openHubItem({ semanticType: "approval_request", sourceType: "approval", claimedByUserId: "founder-1" })],
    ]);
    const svc2 = hubItemsService(releaseDb as never);
    expect(await catchStatus(() => svc2.recordLifecycleAction({ ...founderArgs, action: "release" }))).toBe("ok");
  });
});
