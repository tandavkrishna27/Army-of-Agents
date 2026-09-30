import { describe, expect, it, vi } from "vitest";
import {
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  instanceUserRoles,
  organizationMemberships,
} from "@armyofagents/db";
import { authorizeCompanyUpgrade } from "../services/upgrade-auth.js";
import {
  authorizeUpgrade,
  enforceLiveEventSocketAuthorization,
  hasActiveCloudMembership,
} from "../realtime/live-events-ws.js";

// Any exact origin string in the trusted allowlist. The board origin that
// better-auth already trusts is threaded through as `trustedOrigins` on the
// cookie branch, so a legit board user always presents a trusted Origin.
const BOARD_ORIGIN = "https://board.example";
const TRUSTED = [BOARD_ORIGIN];

function makeUpgradeAuthDb(input: {
  key?: Record<string, unknown> | null;
  agent?: Record<string, unknown> | null;
  instanceRole?: Record<string, unknown> | null;
  memberships?: Array<Record<string, unknown>>;
  orgMemberships?: Array<Record<string, unknown>>;
  company?: Record<string, unknown> | null;
}) {
  return {
    select: vi.fn(() => {
      let table: unknown = null;
      const chain = {
        from(nextTable: unknown) {
          table = nextTable;
          return chain;
        },
        where() {
          return chain;
        },
        then(resolve: (rows: unknown[]) => unknown) {
          const rows =
            table === agentApiKeys
              ? input.key
                ? [input.key]
                : []
              : table === agents && input.agent
                ? [input.agent]
                : table === instanceUserRoles && input.instanceRole
                  ? [input.instanceRole]
                  : table === companyMemberships
                    ? input.memberships ?? []
                    : table === organizationMemberships
                      ? input.orgMemberships ?? []
                      : table === companies
                        ? input.company
                          ? [input.company]
                          : []
                : [];
          return Promise.resolve(resolve(rows));
        },
      };
      return chain;
    }),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
}

describe("authorizeCompanyUpgrade", () => {
  it("rejects agent API keys for pending or terminated agents", async () => {
    for (const status of ["pending_approval", "terminated"]) {
      const db = makeUpgradeAuthDb({
        key: { id: `key-${status}`, companyId: "company-1", agentId: "agent-1" },
        agent: { id: "agent-1", companyId: "company-1", status },
      });

      const actor = await authorizeCompanyUpgrade(
        db as any,
        { headers: { authorization: "Bearer secret" } } as any,
        "company-1",
        new URL("ws://aoa.local/preview/services/svc-1/ws"),
        { deploymentMode: "authenticated" },
      );

      expect(actor).toBeNull();
      expect(db.update).not.toHaveBeenCalled();
    }
  });

  it("accepts active agent API keys for the same company", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret" } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      { deploymentMode: "authenticated" },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      keyId: "key-1",
    });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("uses namespaced query auth for active agent API keys", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: {} } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws?aoa_preview_token=secret"),
      { deploymentMode: "authenticated" },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      keyId: "key-1",
    });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  // The agent (bearer / query token) branch must be UNAFFECTED by Origin —
  // agents authenticate with a token and browsers don't drive that path.
  it("agent bearer branch ignores an untrusted (or missing) Origin", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret", origin: "https://evil.example" } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      keyId: "key-1",
    });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("does not treat app token query parameters as AoA auth", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws?token=app-token"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "user-1",
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("authenticated: session user with a company membership gets a board actor", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "user-1",
    });
    // Trusted Origin → we proceeded past the Origin gate to session resolution.
    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("authenticated: cookie branch rejects an untrusted Origin BEFORE resolving the session", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: "https://evil.example" } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(actor).toBeNull();
    // The session must never be resolved when the Origin is untrusted.
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("authenticated: cookie branch rejects a MISSING Origin BEFORE resolving the session", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session" } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(actor).toBeNull();
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("cloud_auth: cookie branch rejects an untrusted Origin BEFORE resolving the session", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: "https://evil.example" } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(actor).toBeNull();
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("cloud_auth: session user with org + company membership gets a board actor", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "user-1",
    });
    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: company membership WITHOUT org membership is denied (tenant isolation)", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [],
      memberships: [{ id: "cm-1" }],
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(actor).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: fails closed when the company (org) cannot be resolved", async () => {
    // No companies row → organizationId null → the `if (!organizationId)` branch
    // returns null WITHOUT consulting memberships (even though both exist).
    const db = makeUpgradeAuthDb({
      company: null,
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(actor).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: org membership WITHOUT company membership is denied (both required)", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [],
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(actor).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: session user with neither membership is denied", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [],
      memberships: [],
    });

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(actor).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("local_trusted: a no-token session is trusted board context (Origin check does not apply)", async () => {
    const db = makeUpgradeAuthDb({});

    const actor = await authorizeCompanyUpgrade(
      db as any,
      { headers: {} } as any,
      "company-1",
      new URL("ws://aoa.local/preview/services/svc-1/ws"),
      { deploymentMode: "local_trusted" },
    );

    expect(actor).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "board",
    });
  });
});

describe("live-events authorizeUpgrade", () => {
  it("agent bearer branch ignores an untrusted Origin", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret", origin: "https://evil.example" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(context).toEqual({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      keyId: "key-1",
    });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("agent branch rejects a TERMINATED agent even with a valid key", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "terminated" },
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(context).toBeNull();
  });

  it("agent branch rejects a PENDING_APPROVAL agent even with a valid key", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "pending_approval" },
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(context).toBeNull();
  });

  it("agent branch rejects a MISSING agent row even with a valid key", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: null,
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(context).toBeNull();
  });

  it("agent branch rejects a company-mismatched agent row", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-2", status: "idle" },
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(context).toBeNull();
  });

  it("agent branch admits an ACTIVE agent with a valid key", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1" },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { authorization: "Bearer secret" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "authenticated", trustedOrigins: TRUSTED },
    );

    expect(context).toEqual({
      companyId: "company-1",
      actorType: "agent",
      actorId: "agent-1",
      keyId: "key-1",
    });
  });

  it("authenticated: session user with a company membership gets a board actor (trusted Origin)", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(context).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "user-1",
    });
    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
  });

  it("authenticated: cookie branch rejects an untrusted Origin BEFORE resolving the session", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: "https://evil.example" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(context).toBeNull();
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("authenticated: cookie branch rejects a MISSING Origin BEFORE resolving the session", async () => {
    const db = makeUpgradeAuthDb({
      memberships: [{ companyId: "company-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(context).toBeNull();
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("local_trusted: a no-token session is trusted board context (Origin check does not apply)", async () => {
    const db = makeUpgradeAuthDb({});

    const context = await authorizeUpgrade(
      db as any,
      { headers: {} } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      { deploymentMode: "local_trusted" },
    );

    expect(context).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "board",
    });
  });

  it("cloud_auth: session user with org + company membership gets a board actor", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(context).toEqual({
      companyId: "company-1",
      actorType: "board",
      actorId: "user-1",
    });
    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: company membership WITHOUT org membership is denied (tenant isolation)", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [],
      memberships: [{ id: "cm-1" }],
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(context).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: session user with neither membership is denied", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [],
      memberships: [],
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(context).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: fails closed when the company (org) cannot be resolved", async () => {
    const db = makeUpgradeAuthDb({
      company: null,
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: BOARD_ORIGIN } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: async () => ({ user: { id: "user-1" } }) as any,
      },
    );

    expect(context).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("cloud_auth: cookie branch rejects an untrusted Origin BEFORE resolving the session", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "user-1" } }) as any);

    const context = await authorizeUpgrade(
      db as any,
      { headers: { cookie: "aoa_session=session", origin: "https://evil.example" } } as any,
      "company-1",
      new URL("ws://aoa.local/api/companies/company-1/events/ws"),
      {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders,
      },
    );

    expect(context).toBeNull();
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });
});

describe("hasActiveCloudMembership", () => {
  it("returns true with active org + active company membership and an owning organization", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });

    await expect(hasActiveCloudMembership(db as any, "company-1", "user-1")).resolves.toBe(true);
  });

  it("returns false when the org membership is missing", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [],
      memberships: [{ id: "cm-1" }],
    });

    await expect(hasActiveCloudMembership(db as any, "company-1", "user-1")).resolves.toBe(false);
  });

  it("returns false when the company membership is missing", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [{ id: "om-1" }],
      memberships: [],
    });

    await expect(hasActiveCloudMembership(db as any, "company-1", "user-1")).resolves.toBe(false);
  });

  it("returns false when the company has no owning organization", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: null },
      orgMemberships: [{ id: "om-1" }],
      memberships: [{ id: "cm-1" }],
    });

    await expect(hasActiveCloudMembership(db as any, "company-1", "user-1")).resolves.toBe(false);
  });
});

describe("live-events open-socket authorization re-validation", () => {
  function socket() {
    return { readyState: 1, close: vi.fn() };
  }

  it("keeps an active exact agent key and eligible agent connected", async () => {
    const db = makeUpgradeAuthDb({
      key: { id: "key-1", companyId: "company-1", agentId: "agent-1", revokedAt: null },
      agent: { id: "agent-1", companyId: "company-1", status: "idle" },
    });
    const ws = socket();

    await expect(enforceLiveEventSocketAuthorization(
      db as any,
      ws,
      { companyId: "company-1", actorType: "agent", actorId: "agent-1", keyId: "key-1" },
      "authenticated",
    )).resolves.toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked exact key", { id: "key-1", companyId: "company-1", agentId: "agent-1", revokedAt: new Date() }, { id: "agent-1", companyId: "company-1", status: "idle" }],
    ["different active key", { id: "key-2", companyId: "company-1", agentId: "agent-1", revokedAt: null }, { id: "agent-1", companyId: "company-1", status: "idle" }],
    ["terminated agent", { id: "key-1", companyId: "company-1", agentId: "agent-1", revokedAt: null }, { id: "agent-1", companyId: "company-1", status: "terminated" }],
    ["pending agent", { id: "key-1", companyId: "company-1", agentId: "agent-1", revokedAt: null }, { id: "agent-1", companyId: "company-1", status: "pending_approval" }],
  ])("closes for %s", async (_label, key, agent) => {
    const db = makeUpgradeAuthDb({ key, agent });
    const ws = socket();

    await expect(enforceLiveEventSocketAuthorization(
      db as any,
      ws,
      { companyId: "company-1", actorType: "agent", actorId: "agent-1", keyId: "key-1" },
      "authenticated",
    )).resolves.toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1008, "authorization revoked");
  });

  it("closes a cloud board socket when membership is revoked", async () => {
    const db = makeUpgradeAuthDb({
      company: { organizationId: "org-1" },
      orgMemberships: [],
      memberships: [{ id: "cm-1" }],
    });
    const ws = socket();

    await expect(enforceLiveEventSocketAuthorization(
      db as any,
      ws,
      { companyId: "company-1", actorType: "board", actorId: "user-1" },
      "cloud_auth",
    )).resolves.toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1008, "authorization revoked");
  });

  it("fails closed when a re-validation query errors", async () => {
    const error = new Error("database unavailable");
    const onError = vi.fn();
    const db = { select: vi.fn(() => { throw error; }) };
    const ws = socket();

    await expect(enforceLiveEventSocketAuthorization(
      db as any,
      ws,
      { companyId: "company-1", actorType: "board", actorId: "user-1" },
      "cloud_auth",
      onError,
    )).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(error);
    expect(ws.close).toHaveBeenCalledWith(1011, "authorization re-validation failed");
  });

  it("still fails closed when error reporting throws", async () => {
    const db = { select: vi.fn(() => { throw new Error("database unavailable"); }) };
    const ws = socket();

    await expect(enforceLiveEventSocketAuthorization(
      db as any,
      ws,
      { companyId: "company-1", actorType: "board", actorId: "user-1" },
      "cloud_auth",
      () => { throw new Error("logger unavailable"); },
    )).resolves.toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1011, "authorization re-validation failed");
  });

  it("does not query cloud membership for a non-cloud board socket", async () => {
    const db = { select: vi.fn(() => { throw new Error("must not query"); }) };
    const ws = socket();

    await expect(enforceLiveEventSocketAuthorization(
      db as any,
      ws,
      { companyId: "company-1", actorType: "board", actorId: "user-1" },
      "authenticated",
    )).resolves.toBe(true);
    expect(db.select).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });
});
