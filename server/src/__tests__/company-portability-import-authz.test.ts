/**
 * D2 (H2 + H3) — importBundle authorization + operator-scoping unit tests.
 *
 *  - new_company threads the resolved organizationId into companies.create and
 *    provisions the IMPORTER as a real operator (ensureRealOperator), never a
 *    bare "board" membership.
 *  - existing_company + include.agents does NOT call ensureRealOperator (no
 *    caller promotion); agent restoration parents to the pre-existing founder
 *    (proven at the DB layer in mt-import-authz.integration.test.ts).
 *  - getImportAuthorizationContext surfaces importsAgents so the route can gate
 *    agent imports on founder/team_lead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() =>
  vi.fn(async (input: { name: string; organizationId?: string | null }) => ({
    id: "created-co",
    name: input.name,
  })),
);
const ensureRealOperatorMock = vi.hoisted(() => vi.fn(async () => "operator-user-id"));
const ensureMembershipMock = vi.hoisted(() => vi.fn(async () => undefined));
const agentCreateMock = vi.hoisted(() =>
  vi.fn(async (_companyId: string, patch: { name: string }) => ({ id: "agent-1", name: patch.name })),
);

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => ({ id, name: "Target Co" })),
    create: createMock,
    // P3: importBundle now creates via the atomic `createWithOperator`; delegate
    // to `createMock` (so the organizationId-threading assertion holds) and call
    // ensureRealOperator via the passed access factory (so the operator-scoping
    // assertion holds).
    createWithOperator: vi.fn(async (input: any, opts: any, ownerUserId: any, buildAccess: any) => {
      const company = await createMock(input, opts);
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId ?? null);
      return { company, operatorId };
    }),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      id,
      name: (patch.name as string) ?? "Target Co",
    })),
  }),
}));

vi.mock("../services/agents.js", () => ({
  agentService: () => ({
    backfillHumanAtTop: vi.fn(async () => 0),
    list: vi.fn(async () => []),
    create: agentCreateMock,
    update: vi.fn(),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: ensureMembershipMock,
    ensureRealOperator: ensureRealOperatorMock,
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

const AGENT_MD = "---\nname: Atlas\nslug: atlas\n---\nDo the thing.\n";

function manifestWithAgent(): CompanyPortabilityManifest {
  return {
    schemaVersion: 2,
    generatedAt: "2026-07-31T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: true },
    company: {
      path: "COMPANY.md",
      name: "Imported Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [
      {
        slug: "atlas",
        name: "Atlas",
        path: "agents/atlas/AGENTS.md",
        role: "Engineer",
        title: null,
        icon: null,
        capabilities: null,
        reportsToSlug: null,
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        metadata: null,
      },
    ],
    requiredSecrets: [],
  } as unknown as CompanyPortabilityManifest;
}

const svc = companyPortabilityService({
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
} as never);

const files = {
  "COMPANY.md": "---\nkind: company\nname: Imported Co\n---\n",
  "agents/atlas/AGENTS.md": AGENT_MD,
};

const ORG = "00000000-0000-0000-0000-0000000000a1";

describe("importBundle authorization + operator scoping (D2)", () => {
  // vi.clearAllMocks() clears call history only; the vi.hoisted async
  // implementations survive, so the mocked services keep behaving between tests.
  beforeEach(() => vi.clearAllMocks());

  it("new_company threads organizationId into create and provisions the importer via ensureRealOperator", async () => {
    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: manifestWithAgent(), files },
        target: { mode: "new_company" as const, newCompanyName: "Imported Co" },
        include: { company: true, agents: true },
      } as never,
      "importing-user-1",
      undefined,
      { organizationId: ORG },
    );

    // (H3) the resolved org is stamped on the create.
    expect(createMock).toHaveBeenCalledOnce();
    expect(createMock.mock.calls[0][0]).toMatchObject({ organizationId: ORG });

    // (no self-lockout) the importer is seeded as a real operator (founder + org owner),
    // NOT a bare "board" company membership.
    expect(ensureRealOperatorMock).toHaveBeenCalledWith("created-co", "importing-user-1");
    expect(ensureMembershipMock).not.toHaveBeenCalled();
  });

  it("existing_company + include.agents does NOT promote the caller (no ensureRealOperator)", async () => {
    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: manifestWithAgent(), files },
        target: { mode: "existing_company" as const, companyId: "11111111-1111-4111-8111-111111111111" },
        include: { company: false, agents: true },
      } as never,
      "member-user-2",
    );

    // (H2) the existing-company path must NEVER re-own the caller.
    expect(ensureRealOperatorMock).not.toHaveBeenCalled();
    // agent restoration still runs (parenting to the pre-existing founder is proven in the integration suite).
    expect(agentCreateMock).toHaveBeenCalledOnce();
  });

  it("getImportAuthorizationContext (via authorize) reports importsAgents=true when agents are imported", async () => {
    const authorize = vi.fn(async () => undefined);
    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: manifestWithAgent(), files },
        target: { mode: "existing_company" as const, companyId: "11111111-1111-4111-8111-111111111111" },
        include: { company: false, agents: true },
      } as never,
      "member-user-2",
      authorize,
    );
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ importsAgents: true }));
  });

  it("importsAgents=false for a company-only import (no agents section)", async () => {
    const authorize = vi.fn(async () => undefined);
    const m = manifestWithAgent();
    (m as unknown as { agents: unknown[] }).agents = [];
    await svc.importBundle(
      {
        source: { type: "inline" as const, manifest: m, files: { "COMPANY.md": files["COMPANY.md"] } },
        target: { mode: "existing_company" as const, companyId: "11111111-1111-4111-8111-111111111111" },
        include: { company: true, agents: false },
      } as never,
      "member-user-2",
      authorize,
    );
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ importsAgents: false }));
  });
});
