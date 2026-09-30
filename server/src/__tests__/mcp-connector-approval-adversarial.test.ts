/**
 * @fileoverview Plan 3a Task 12 — ADVERSARIAL regression suite for the
 * `install_mcp_connector` APPROVAL, which in `authenticated` mode is the SOLE
 * connector-activation path.
 *
 * Why this file is separate from `mcp-connector-install-adversarial.test.ts`:
 * that suite drives the connector routes with the service layer mocked; this one
 * needs the REAL `approvalService` over drizzle stubs, which is an incompatible
 * mocking regime in the same module graph.
 *
 * ── THE GOVERNANCE ASYMMETRY UNDER ATTACK ────────────────────────────────────
 * Every connector mutation in `routes/mcp-connectors.ts` — create, PATCH,
 * delete, credentials, agent assignment, catalog install — is
 * `await assertRole(db, req, companyId, "founder")`. And C2 blocks even the
 * FOUNDER from PATCH→active in `authenticated` mode, explicitly so that
 * activation flows through the `install_mcp_connector` approval instead.
 *
 * That makes the approval the connector governance gate. It carries no role
 * check at all. So the gate is strictly weaker than the CRUD it protects, and
 * the HTTP door is weaker than the MCP door for the identical action (the MCP
 * `approval-decision` tool requires founder).
 *
 * `it.fails(...)` blocks below are CONFIRMED DEFECTS whose fix is a governance
 * decision this task deliberately did not guess at (see FU-10). They pass while
 * the defect is present and go RED the moment it is fixed, forcing whoever lands
 * the fix to read the escalation note. Each is paired with a CHARACTERIZATION
 * test pinning the exact current behaviour so neither can be green by accident.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  approvals: makeTableProxy("approvals"),
  approvalComments: makeTableProxy("approval_comments"),
  issues: makeTableProxy("issues"),
  agents: makeTableProxy("agents"),
  companies: makeTableProxy("companies"),
  notifications: makeTableProxy("notifications"),
  agentProjects: makeTableProxy("agent_projects"),
  projects: makeTableProxy("projects"),
  companyMcpConnectors: makeTableProxy("company_mcp_connectors"),
  companyMcpConnectorAgents: makeTableProxy("company_mcp_connector_agents"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../config.js", () => ({
  loadConfig: () => ({ deploymentMode: "authenticated" }),
}));

const mocks = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  agentCreate: vi.fn(),
  terminate: vi.fn(),
  preflightCrewDispatch: vi.fn(),
  dispatchCreatedCrewTasks: vi.fn(),
  logActivity: vi.fn(),
  connGetById: vi.fn(),
  connUpdate: vi.fn(),
  connUpdateIfStatus: vi.fn(),
  connUpdateIfStatusAndSecret: vi.fn(),
  // Route-level observation of the service the handler actually calls.
  svcApprove: vi.fn(),
  svcReject: vi.fn(),
  svcRequestRevision: vi.fn(),
  svcResubmit: vi.fn(),
  svcGetById: vi.fn(),
  listIssuesForApproval: vi.fn(),
  getEffectiveRole: vi.fn(),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    activatePendingApproval: mocks.activatePendingApproval,
    create: mocks.agentCreate,
    terminate: mocks.terminate,
  }),
}));
vi.mock("../services/crew-budget.js", () => ({
  preflightCrewDispatch: mocks.preflightCrewDispatch,
}));
vi.mock("../services/crew-task-service.js", () => ({
  dispatchCreatedCrewTasks: mocks.dispatchCreatedCrewTasks,
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
}));
vi.mock("../services/mcp-connectors-crud.js", () => ({
  mcpConnectorService: () => ({
    getById: mocks.connGetById,
    update: mocks.connUpdate,
    updateIfStatus: mocks.connUpdateIfStatus,
    updateIfStatusAndSecret: mocks.connUpdateIfStatusAndSecret,
  }),
}));

// `services/index.js` is what the ROUTE module resolves its collaborators from.
vi.mock("../services/index.js", () => ({
  approvalService: () => ({
    getById: mocks.svcGetById,
    approve: mocks.svcApprove,
    reject: mocks.svcReject,
    requestRevision: mocks.svcRequestRevision,
    resubmit: mocks.svcResubmit,
    list: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    create: vi.fn(),
  }),
  heartbeatService: () => ({ wakeup: vi.fn() }),
  issueApprovalService: () => ({
    listIssuesForApproval: mocks.listIssuesForApproval,
    linkManyForApproval: vi.fn(),
  }),
  logActivity: mocks.logActivity,
  notifyHireApproved: vi.fn(),
  // Identity: the hire_agent secret normaliser is not under test here, and a
  // stub returning undefined would silently blank the payload the route forwards.
  secretService: () => ({
    normalizeHireApprovalPayloadForPersistence: async (
      _companyId: string,
      payload: unknown,
    ) => payload,
  }),
  trustScoreService: () => ({ updateOnReview: vi.fn() }),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  buildApprovalHubEmit: vi.fn(() => ({})),
  emitHubItem: vi.fn(),
}));
vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({ reconcile: vi.fn() }),
}));

vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({
    getEffectiveRole: mocks.getEffectiveRole,
    isFounder: vi.fn(),
  }),
}));

import {
  applyConnectorApproval,
  applyConnectorRejection,
  approvalService,
  SYSTEM_INTERNAL_APPROVAL_TYPES,
  type ConnectorApprovalTarget,
} from "../services/approvals.js";
import { approvalRoutes } from "../routes/approvals.js";
import { assertRole } from "../middleware/rbac.js";
import { selectConnectorRowsForAgent } from "../services/mcp-connectors.js";
import { resolveConnectorStatus } from "../services/mcp-connector-status.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY = "company-A";
const APPROVAL_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_MEMBER = "11111111-1111-4111-8111-111111111111";
const FOUNDER = "44444444-4444-4444-8444-444444444444";
const TEAM_LEAD = "55555555-5555-4555-8555-555555555555";
const CONNECTOR_ID = "conn-1";
const EVIL_CONNECTOR_ID = "99999999-9999-4999-8999-999999999999";

const boardActor = (userId: string, companyIds = [COMPANY]) => ({
  type: "board" as const,
  source: "session" as const,
  userId,
  companyIds,
  isInstanceAdmin: false,
});

const mcpKeyActor = {
  type: "mcp" as const,
  source: "mcp_key" as const,
  companyId: COMPANY,
  userId: null,
};

/**
 * The REAL approval routes, with only the actor injected. `db.transaction` runs
 * the callback inline so the handler's real control flow executes.
 */
function makeApp(actor: unknown) {
  const db = {
    transaction: async (fn: (tx: unknown) => unknown) => fn({}),
  } as never;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(db));
  app.use(errorHandler);
  return app;
}

const installApproval = (overrides: Record<string, unknown> = {}) => ({
  id: APPROVAL_ID,
  companyId: COMPANY,
  status: "pending",
  type: "install_mcp_connector",
  payload: { connectorId: CONNECTOR_ID, serverName: "notion" },
  requestedByAgentId: null,
  requestedByUserId: FOUNDER,
  decidedByUserId: null,
  decidedAt: null,
  ...overrides,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.logActivity.mockResolvedValue(undefined);
  // Finding 6: the secret-aware guard returns a truthy row by default so the
  // approve path's optimistic retry converges on the first attempt.
  mocks.connUpdateIfStatusAndSecret.mockResolvedValue({ id: CONNECTOR_ID, status: "active" });
  mocks.listIssuesForApproval.mockResolvedValue([]);
  mocks.getEffectiveRole.mockResolvedValue("team_member");
  mocks.svcGetById.mockResolvedValue(installApproval());
  mocks.svcApprove.mockResolvedValue(installApproval({ status: "approved" }));
  mocks.svcReject.mockResolvedValue(installApproval({ status: "rejected" }));
  mocks.svcRequestRevision.mockResolvedValue(installApproval({ status: "revision_requested" }));
  mocks.svcResubmit.mockResolvedValue(installApproval({ status: "pending" }));
});

// ═══════════════════════════════════════════════════════════════════════════
// [ESC-1] — CLOSED (FU-17). The connector governance approval is now
// founder-or-team_lead only, type-scoped.
//
// Founder decision 2026-07-24: `founder` and `team_lead` may resolve an
// `install_mcp_connector` approval; `team_member` may not. `request-revision` is
// gated alongside approve/reject because for THIS type it is irreversible — the
// type is on SYSTEM_INTERNAL_APPROVAL_TYPES, so a revision_requested connector
// approval can never be resubmitted, making it a stronger veto than reject.
//
// The blocks below were `it.fails` characterizations of the defect; they are now
// real assertions. The CONTROL and REGRESSION FLOOR cases are unchanged and pin
// the two ways a fix could have overshot: breaking the founder, or founder-gating
// every approval type.
// ═══════════════════════════════════════════════════════════════════════════

describe("[ESC-1] install_mcp_connector approval is founder/team_lead only (FU-17)", () => {
  it("CONTROL: the same actor IS refused by the founder gate every connector CRUD route uses", async () => {
    const req = { actor: boardActor(TEAM_MEMBER) } as never;
    await expect(assertRole({} as never, req, COMPANY, "founder")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("CONTROL: an out-of-company board actor IS refused, so the actor plumbing is real", async () => {
    const res = await request(makeApp(boardActor(TEAM_MEMBER, ["some-other-company"])))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({ decisionNote: "ok" });
    expect(res.status).toBe(403);
    expect(mocks.svcApprove).not.toHaveBeenCalled();
  });

  it("CONTROL: an unauthenticated caller is refused", async () => {
    const res = await request(makeApp({ type: "none" }))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({});
    expect(res.status).toBe(401);
    expect(mocks.svcApprove).not.toHaveBeenCalled();
  });

  it("FIXED: a plain team_member is 403 on approve, and the role WAS consulted", async () => {
    const res = await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({ decisionNote: "ok" });

    expect(res.status).toBe(403);
    expect(mocks.svcApprove).not.toHaveBeenCalled();
    // The gate actually ran — not an incidental 403 from somewhere else.
    expect(mocks.getEffectiveRole).toHaveBeenCalledWith(COMPANY, TEAM_MEMBER);
  });

  it("FIXED: the same team_member can no longer REJECT a founder's pending connector", async () => {
    const res = await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/reject`)
      .send({ decisionNote: "no" });
    expect(res.status).toBe(403);
    expect(mocks.svcReject).not.toHaveBeenCalled();
    expect(mocks.getEffectiveRole).toHaveBeenCalledWith(COMPANY, TEAM_MEMBER);
  });

  it("FIXED: ...nor park it in revision_requested (irreversible for this type)", async () => {
    // `install_mcp_connector` is on SYSTEM_INTERNAL_APPROVAL_TYPES, so a
    // revision_requested connector approval can NEVER be resubmitted. Parking it
    // is a permanent veto — a stronger power than reject, so it is gated too.
    const res = await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/request-revision`)
      .send({ decisionNote: "n" });
    expect(res.status).toBe(403);
    expect(mocks.svcRequestRevision).not.toHaveBeenCalled();
  });

  it("FIXED: a TEAM LEAD may resolve it — the founder's decision, not founder-only", async () => {
    mocks.getEffectiveRole.mockResolvedValue("team_lead");
    const approve = await request(makeApp(boardActor(TEAM_LEAD)))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({ decisionNote: "ok" });
    expect(approve.status).toBe(200);
    expect(mocks.svcApprove).toHaveBeenCalledWith(APPROVAL_ID, COMPANY, TEAM_LEAD, "ok");

    const reject = await request(makeApp(boardActor(TEAM_LEAD)))
      .post(`/api/approvals/${APPROVAL_ID}/reject`)
      .send({ decisionNote: "no" });
    expect(reject.status).toBe(200);
  });

  it("FIXED: an unrecognised/absent role fails CLOSED", async () => {
    // `getEffectiveRole` answering anything outside {founder, team_lead} must 403
    // rather than fall through.
    for (const role of ["team_member", "guest", undefined, null]) {
      mocks.svcApprove.mockClear();
      mocks.getEffectiveRole.mockResolvedValue(role);
      const res = await request(makeApp(boardActor(TEAM_MEMBER)))
        .post(`/api/approvals/${APPROVAL_ID}/approve`)
        .send({});
      expect({ role, status: res.status }).toEqual({ role, status: 403 });
      expect(mocks.svcApprove).not.toHaveBeenCalled();
    }
  });

  it("FIXED: a non-board principal (MCP API key) never reaches the gate — assertBoard 403s first", async () => {
    // Load-bearing ordering: `assertRole` RETURNS EARLY for agent actors, so if
    // the gate ran before `assertBoard` an agent/MCP principal would sail past it.
    // `assertBoard` runs first and refuses every non-board actor.
    for (const actor of [
      mcpKeyActor,
      { type: "agent", source: "token", companyId: COMPANY, agentId: "agent-1" },
    ]) {
      mocks.svcApprove.mockClear();
      const res = await request(makeApp(actor))
        .post(`/api/approvals/${APPROVAL_ID}/approve`)
        .send({});
      expect(res.status).toBe(403);
      expect(mocks.svcApprove).not.toHaveBeenCalled();
    }
  });

  it("FIXED: an agent actor cannot REJECT a connector approval either", async () => {
    const res = await request(
      makeApp({ type: "agent", source: "token", companyId: COMPANY, agentId: "agent-1" }),
    )
      .post(`/api/approvals/${APPROVAL_ID}/reject`)
      .send({});
    expect(res.status).toBe(403);
    expect(mocks.svcReject).not.toHaveBeenCalled();
  });

  it("CHARACTERIZATION: the pending payload is still returned UNREDACTED to any board member", async () => {
    // `redactEventPayload` is real here; `connectorId` is not a secret-shaped key,
    // so a team_member can read exactly which id to aim a resubmit at.
    const res = await request(makeApp(boardActor(TEAM_MEMBER))).get(
      `/api/approvals/${APPROVAL_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({ connectorId: CONNECTOR_ID, serverName: "notion" });
  });

  it("CHARACTERIZATION: the real side-effect then activates the connector", async () => {
    // The genuine `applyConnectorApproval`, unmocked, over a structural stub.
    mocks.connUpdateIfStatusAndSecret.mockResolvedValue({ id: CONNECTOR_ID, status: "active" });
    const svc: ConnectorApprovalTarget = {
      getById: async () => ({
        companyId: COMPANY,
        status: "pending_approval",
        requiresSecret: false,
        secretRef: "mcp:notion",
      }),
      update: mocks.connUpdate,
      updateIfStatus: mocks.connUpdateIfStatus,
      updateIfStatusAndSecret: mocks.connUpdateIfStatusAndSecret,
    };
    await applyConnectorApproval(svc, COMPANY, CONNECTOR_ID, "authenticated");
    // Finding 6: the guard re-checks secret-boundness — this connector has a bound
    // secret, so expectSecretBound=true.
    expect(mocks.connUpdateIfStatusAndSecret).toHaveBeenCalledWith(
      CONNECTOR_ID,
      "pending_approval",
      true,
      { status: "active" },
    );
  });

  it("CHARACTERIZATION: and delivery needs no further founder step — Commander picks it up immediately", async () => {
    // D3 exempts Commander from the founder-only per-agent opt-in, so activation
    // alone is sufficient for the connector to reach a CLI.
    const before = selectConnectorRowsForAgent({
      connectors: [{ id: CONNECTOR_ID, status: "pending_approval" }],
      enabledConnectorIds: new Set(),
      isCommander: true,
    });
    const after = selectConnectorRowsForAgent({
      connectors: [{ id: CONNECTOR_ID, status: "active" }],
      enabledConnectorIds: new Set(),
      isCommander: true,
    });
    expect(before).toEqual([]);
    expect(after.map((c) => c.id)).toEqual([CONNECTOR_ID]);
  });

  it("CHARACTERIZATION: the real rejection side-effect disables it (terminal in authenticated)", async () => {
    const svc: ConnectorApprovalTarget = {
      getById: async () => ({
        companyId: COMPANY,
        status: "pending_approval",
        requiresSecret: false,
        secretRef: null,
      }),
      update: mocks.connUpdate,
      updateIfStatus: mocks.connUpdateIfStatus,
      updateIfStatusAndSecret: mocks.connUpdateIfStatusAndSecret,
    };
    await applyConnectorRejection(svc, COMPANY, CONNECTOR_ID);
    expect(mocks.connUpdate).toHaveBeenCalledWith(CONNECTOR_ID, { status: "disabled" });
  });

  // [ESC-1] — was `it.fails` while the defect stood; now the real assertion.
  it.each(["approve", "reject", "request-revision"])(
    "[ESC-1] a team_member gets 403 on /%s of an install_mcp_connector approval",
    async (action) => {
      const res = await request(makeApp(boardActor(TEAM_MEMBER)))
        .post(`/api/approvals/${APPROVAL_ID}/${action}`)
        .send({ decisionNote: "x" });
      expect(res.status).toBe(403);
    },
  );

  it("[ESC-1] a team_member's decision never reaches the service", async () => {
    await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({});
    expect(mocks.svcApprove).not.toHaveBeenCalled();
  });

  it("[ESC-1] the refusal happens BEFORE the transaction — no partial write, no hub emit", async () => {
    // The gate sits above `db.transaction`, so a refused decision cannot have
    // logged an activity row or reconciled a hub item on its way out.
    await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/reject`)
      .send({});
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("local_trusted loopback is unaffected — the synthetic board user still resolves it", async () => {
    // `assertRole` short-circuits on `source: "local_implicit"`. That is the
    // deployment-wide trust boundary, not a hole: there is one implicitly-trusted
    // human at the loopback. A fix that broke this would break every solo install.
    const res = await request(
      makeApp({
        type: "board",
        source: "local_implicit",
        userId: null,
        companyIds: [COMPANY],
        isInstanceAdmin: true,
      }),
    )
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({});
    expect(res.status).toBe(200);
    expect(mocks.svcApprove).toHaveBeenCalledWith(APPROVAL_ID, COMPANY, "local-board", undefined);
  });

  it("REGRESSION FLOOR: a FOUNDER must still be able to resolve it once the gate lands", async () => {
    mocks.getEffectiveRole.mockResolvedValue("founder");
    const res = await request(makeApp(boardActor(FOUNDER)))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({ decisionNote: "ok" });
    expect(res.status).toBe(200);
    expect(mocks.svcApprove).toHaveBeenCalledWith(APPROVAL_ID, COMPANY, FOUNDER, "ok");
  });

  it("REGRESSION FLOOR: other approval types stay board-resolvable (the gate must be type-scoped)", async () => {
    // hire_agent / approve_ceo_strategy are genuinely board decisions. A fix that
    // founder-gated EVERY approval would be a different, larger change.
    mocks.svcGetById.mockResolvedValue(
      installApproval({ type: "hire_agent", payload: { agentId: "agent-9" } }),
    );
    mocks.svcApprove.mockResolvedValue(
      installApproval({ type: "hire_agent", status: "approved", payload: { agentId: "agent-9" } }),
    );
    mocks.svcReject.mockResolvedValue(
      installApproval({ type: "hire_agent", status: "rejected", payload: { agentId: "agent-9" } }),
    );
    for (const action of ["approve", "reject", "request-revision"]) {
      const res = await request(makeApp(boardActor(TEAM_MEMBER)))
        .post(`/api/approvals/${APPROVAL_ID}/${action}`)
        .send({});
      expect({ action, status: res.status }).toEqual({ action, status: 200 });
    }
    // And the gate did not even run for a non-connector type.
    expect(mocks.getEffectiveRole).not.toHaveBeenCalled();
  });

  it("REGRESSION FLOOR: crew_dispatch — the other system-internal type — also stays board-resolvable", async () => {
    // FU-17 was scoped to install_mcp_connector deliberately. crew_dispatch is a
    // different governance question and was NOT part of the founder's decision.
    mocks.svcGetById.mockResolvedValue(
      installApproval({ type: "crew_dispatch", payload: { taskIds: ["t1"] } }),
    );
    mocks.svcApprove.mockResolvedValue(
      installApproval({ type: "crew_dispatch", status: "approved", payload: { taskIds: ["t1"] } }),
    );
    const res = await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/approve`)
      .send({});
    expect(res.status).toBe(200);
    expect(mocks.getEffectiveRole).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FIXED — the resubmit payload-swap (confused-deputy) vector
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A sequence-driven db for the REAL `approvalService`. `select()` returns the
 * seeded approval; `update(approvals)` returns the row the service would have
 * written, and every `.set()` payload is recorded.
 */
function makeServiceDb(existing: Record<string, unknown>, updated: unknown) {
  const sets: Array<Record<string, unknown>> = [];
  const makeSelectChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.then = (resolve: (r: unknown[]) => unknown) => resolve(rows);
    return chain;
  };
  return {
    sets,
    db: {
      select: () => makeSelectChain([existing]),
      update: (table: { _?: { name?: string } }) => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            if (table?._?.name === "approvals") sets.push(values);
            return {
              returning: () => ({
                then: (resolve: (r: unknown[]) => unknown) =>
                  resolve(table?._?.name === "approvals" ? [updated] : []),
              }),
            };
          },
        }),
      }),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
      delete: () => ({ where: () => Promise.resolve() }),
    } as never,
  };
}

describe("resubmit cannot rewrite an install_mcp_connector payload (FIXED in Task 12)", () => {
  it("the type is on the system-internal denylist", () => {
    expect(SYSTEM_INTERNAL_APPROVAL_TYPES.has("install_mcp_connector")).toBe(true);
    expect(SYSTEM_INTERNAL_APPROVAL_TYPES.has("crew_dispatch")).toBe(true);
  });

  it("resubmit throws 422 and writes NOTHING — the connectorId cannot be swapped", async () => {
    const { db, sets } = makeServiceDb(
      installApproval({ status: "revision_requested" }),
      installApproval({ status: "pending" }),
    );
    await expect(
      approvalService(db).resubmit(APPROVAL_ID, COMPANY, {
        connectorId: EVIL_CONNECTOR_ID, // the stdio connector
        serverName: "notion", // ...still displayed as the benign one
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(sets).toEqual([]);
  });

  it("the message names the type, so the refusal is legible in a log", async () => {
    const { db } = makeServiceDb(
      installApproval({ status: "revision_requested" }),
      installApproval(),
    );
    await expect(
      approvalService(db).resubmit(APPROVAL_ID, COMPANY, { connectorId: EVIL_CONNECTOR_ID }),
    ).rejects.toThrow(/install_mcp_connector/);
  });

  it("a resubmit with NO payload is refused too — the type is off-limits, not just the rewrite", async () => {
    // `payload` is optional on the schema; permitting the no-payload form would
    // still resurrect a decided approval for re-decision by a lower role.
    const { db, sets } = makeServiceDb(
      installApproval({ status: "revision_requested" }),
      installApproval(),
    );
    await expect(
      approvalService(db).resubmit(APPROVAL_ID, COMPANY, undefined),
    ).rejects.toMatchObject({ status: 422 });
    expect(sets).toEqual([]);
  });

  it("CONTROL: crew_dispatch is still refused (the pre-existing guard is intact)", async () => {
    const { db } = makeServiceDb(
      installApproval({ type: "crew_dispatch", status: "revision_requested" }),
      installApproval(),
    );
    await expect(
      approvalService(db).resubmit(APPROVAL_ID, COMPANY, { taskIds: ["t1"] }),
    ).rejects.toThrow(/crew_dispatch/);
  });

  it("CONTROL: a legitimately resubmittable type still works — the guard is type-scoped", async () => {
    const { db, sets } = makeServiceDb(
      installApproval({ type: "hire_agent", status: "revision_requested" }),
      installApproval({ type: "hire_agent", status: "pending" }),
    );
    const result = await approvalService(db).resubmit(APPROVAL_ID, COMPANY, { agentId: "a1" });
    expect(result).toBeTruthy();
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ status: "pending", payload: { agentId: "a1" } });
  });

  it("END TO END: the route 403s a non-board MCP key BEFORE the service denylist even runs (FU-18)", async () => {
    // Post-FU-18 the resubmit route is gated to board-OR-requesting-agent, so an
    // `mcp` API key is refused at the route (403) and never reaches the service.
    // Defense in depth: even the service would 422 install_mcp_connector.
    mocks.svcGetById.mockResolvedValue(installApproval({ status: "revision_requested" }));
    mocks.svcResubmit.mockRejectedValue(
      Object.assign(new Error("System-internal install_mcp_connector approvals cannot be resubmitted"), {
        status: 422,
      }),
    );
    const res = await request(makeApp(mcpKeyActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { connectorId: EVIL_CONNECTOR_ID, serverName: "notion" } });
    expect(res.status).toBe(403);
    expect(mocks.svcResubmit).not.toHaveBeenCalled();
  });

  it("END TO END: a BOARD actor reaches the service, which 422s the install_mcp_connector resubmit", async () => {
    // The service-level denylist is what closes the connector vector for the
    // principals the route DOES admit (board / requesting agent).
    mocks.svcGetById.mockResolvedValue(installApproval({ status: "revision_requested" }));
    mocks.svcResubmit.mockRejectedValue(
      Object.assign(new Error("System-internal install_mcp_connector approvals cannot be resubmitted"), {
        status: 422,
      }),
    );
    const res = await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { connectorId: EVIL_CONNECTOR_ID, serverName: "notion" } });
    expect(res.status).toBe(422);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// [ESC-2] — CLOSED (FU-18). The resubmit ROUTE is now gated to "board OR the
// requesting agent".
//
// The route previously carried only `assertCompanyAccess` plus ONE actor check
// that fired only for `req.actor.type === "agent"`, so a same-company `mcp`
// API-key actor reached the handler and could rewrite `payload` wholesale. The
// fix is NOT a blanket `assertBoard` (that would 403 the agent-resubmits-its-own
// path this route deliberately supports); it is "board OR requesting agent".
//
// The two blocks that used to CHARACTERIZE the buggy 200s are now real 403
// assertions, and the former `it.fails` DESIRED case is a real assertion.
// ═══════════════════════════════════════════════════════════════════════════

describe("[ESC-2] POST /approvals/:id/resubmit is board-OR-requesting-agent (FU-18)", () => {
  it("FIXED: an MCP API key — not a board user — is now 403 and never reaches the service", async () => {
    mocks.svcGetById.mockResolvedValue(installApproval({ type: "hire_agent", status: "revision_requested" }));
    const res = await request(makeApp(mcpKeyActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "a1" } });
    expect(res.status).toBe(403);
    expect(mocks.svcResubmit).not.toHaveBeenCalled();
  });

  it("a board team_member may still resubmit (board OR requesting agent — role is not narrowed here)", async () => {
    // Resubmit mirrors the sibling approve/reject board gate: any board member
    // passes. FU-17's founder/team_lead narrowing is specific to
    // install_mcp_connector, which is separately denylisted from resubmit (422).
    mocks.svcGetById.mockResolvedValue(installApproval({ type: "hire_agent", status: "revision_requested" }));
    const res = await request(makeApp(boardActor(TEAM_MEMBER)))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "a1" } });
    expect(res.status).toBe(200);
    expect(mocks.getEffectiveRole).not.toHaveBeenCalled();
  });

  it("only the requesting agent passes among agents — a NON-requesting agent is refused", async () => {
    mocks.svcGetById.mockResolvedValue(
      installApproval({ type: "hire_agent", status: "revision_requested", requestedByAgentId: "agent-1" }),
    );
    const res = await request(
      makeApp({ type: "agent", source: "token", companyId: COMPANY, agentId: "agent-2" }),
    )
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: {} });
    expect(res.status).toBe(403);
    expect(mocks.svcResubmit).not.toHaveBeenCalled();
  });

  it("CONTROL: cross-company access IS still enforced on this route", async () => {
    const res = await request(makeApp(boardActor(TEAM_MEMBER, ["elsewhere"])))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: {} });
    expect(res.status).toBe(403);
    expect(mocks.svcResubmit).not.toHaveBeenCalled();
  });

  it("[ESC-2] FIXED: a non-board, non-requesting-agent principal (MCP key) is refused", async () => {
    mocks.svcGetById.mockResolvedValue(installApproval({ type: "hire_agent", status: "revision_requested" }));
    const res = await request(makeApp(mcpKeyActor))
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "a1" } });
    expect(res.status).toBe(403);
  });

  it("REGRESSION FLOOR: the REQUESTING agent must keep working after any fix", async () => {
    mocks.svcGetById.mockResolvedValue(
      installApproval({ type: "hire_agent", status: "revision_requested", requestedByAgentId: "agent-1" }),
    );
    const res = await request(
      makeApp({ type: "agent", source: "token", companyId: COMPANY, agentId: "agent-1" }),
    )
      .post(`/api/approvals/${APPROVAL_ID}/resubmit`)
      .send({ payload: { agentId: "a1" } });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INVARIANT 1 on the APPROVAL path — approving never activates an
// uncredentialed connector, in any mode
// ═══════════════════════════════════════════════════════════════════════════

describe("[inv-1] applyConnectorApproval never yields active without a bound secret", () => {
  const modes = ["local_trusted", "authenticated"] as const;
  const bools = [false, true] as const;

  function targetFor(row: Record<string, unknown>): ConnectorApprovalTarget {
    return {
      getById: async () => row as never,
      update: mocks.connUpdate,
      updateIfStatus: mocks.connUpdateIfStatus,
      // Finding 6: the approve path now writes through the secret-aware guard.
      // Return a truthy row so the optimistic retry converges on the first attempt.
      updateIfStatusAndSecret: mocks.connUpdateIfStatusAndSecret,
    };
  }

  it("drives every (mode × status × requiresSecret × hasSecret) through the real helper", async () => {
    const statuses = ["pending_approval", "needs_credentials", "active", "disabled"] as const;
    let combos = 0;

    for (const mode of modes) {
      for (const status of statuses) {
        for (const requiresSecret of bools) {
          for (const hasSecret of bools) {
            mocks.connUpdate.mockClear();
            mocks.connUpdateIfStatusAndSecret.mockClear();
            combos += 1;

            await applyConnectorApproval(
              targetFor({
                companyId: COMPANY,
                status,
                requiresSecret,
                secretRef: hasSecret ? "mcp:notion" : null,
              }),
              COMPANY,
              CONNECTOR_ID,
              mode,
            );

            const writes = [
              ...mocks.connUpdate.mock.calls.map((c) => c[1]),
              // Finding 6: the guarded write's patch is now the 4th arg (id,
              // expectedStatus, expectSecretBound, patch).
              ...mocks.connUpdateIfStatusAndSecret.mock.calls.map((c) => c[3]),
            ] as Array<{ status?: string }>;

            if (requiresSecret && !hasSecret) {
              expect({
                mode,
                status,
                requiresSecret,
                hasSecret,
                wrote: writes.map((w) => w.status),
              }).toEqual({
                mode,
                status,
                requiresSecret,
                hasSecret,
                wrote: writes.map(() => expect.not.stringMatching(/^active$/)),
              });
            }
            // `disabled` is terminal: approving must never resurrect it.
            if (status === "disabled") expect(writes).toEqual([]);
          }
        }
      }
    }
    expect(combos).toBe(32);
  });

  it("a malformed requiresSecret fails CLOSED rather than activating", async () => {
    for (const raw of [undefined, null, 0, 1, "", "false", "true", {}]) {
      mocks.connUpdateIfStatusAndSecret.mockClear();
      await applyConnectorApproval(
        targetFor({
          companyId: COMPANY,
          status: "pending_approval",
          requiresSecret: raw,
          secretRef: null,
        }),
        COMPANY,
        CONNECTOR_ID,
        "authenticated",
      );
      const wrote = mocks.connUpdateIfStatusAndSecret.mock.calls[0]?.[3] as
        | { status?: string }
        | undefined;
      expect(wrote?.status ?? "no-write").not.toBe("active");
    }
  });

  it("an empty-string secretRef is NOT a bound credential", async () => {
    await applyConnectorApproval(
      targetFor({
        companyId: COMPANY,
        status: "pending_approval",
        requiresSecret: true,
        secretRef: "",
      }),
      COMPANY,
      CONNECTOR_ID,
      "authenticated",
    );
    // Empty-string secretRef → hasSecret=false → expectSecretBound=false.
    expect(mocks.connUpdateIfStatusAndSecret).toHaveBeenCalledWith(
      CONNECTOR_ID,
      "pending_approval",
      false,
      { status: "needs_credentials" },
    );
  });

  it("a connector from ANOTHER company is never touched, whoever approved", async () => {
    await applyConnectorApproval(
      targetFor({
        companyId: "company-OTHER",
        status: "pending_approval",
        requiresSecret: false,
        secretRef: null,
      }),
      COMPANY,
      CONNECTOR_ID,
      "authenticated",
    );
    expect(mocks.connUpdate).not.toHaveBeenCalled();
    expect(mocks.connUpdateIfStatusAndSecret).not.toHaveBeenCalled();
  });

  it("the resolver stays the single decision-maker: the helper writes exactly what it says", async () => {
    for (const requiresSecret of bools) {
      for (const hasSecret of bools) {
        mocks.connUpdateIfStatusAndSecret.mockClear();
        const expected = resolveConnectorStatus({
          deploymentMode: "authenticated",
          approved: true,
          requiresSecret,
          hasSecret,
        });
        await applyConnectorApproval(
          targetFor({
            companyId: COMPANY,
            status: "pending_approval",
            requiresSecret,
            secretRef: hasSecret ? "mcp:notion" : null,
          }),
          COMPANY,
          CONNECTOR_ID,
          "authenticated",
        );
        if (expected === "pending_approval") {
          expect(mocks.connUpdateIfStatusAndSecret).not.toHaveBeenCalled();
        } else {
          expect(mocks.connUpdateIfStatusAndSecret).toHaveBeenCalledWith(
            CONNECTOR_ID,
            "pending_approval",
            hasSecret,
            { status: expected },
          );
        }
      }
    }
  });
});
