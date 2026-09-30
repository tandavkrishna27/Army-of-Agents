/**
 * T2.3 / R8 — `companies.create` has a SECOND caller: company-bundle import in
 * `new_company` mode (`company-portability.ts`).
 *
 * Neither the plan nor the original T2.3 tests considered it, so an imported
 * company silently started marketplace-provisioning a crew. That behaviour is
 * now **deliberate**, and this suite pins it — the point of the file is that
 * the decision is asserted rather than incidental, so flipping it has to be a
 * conscious act that breaks a test.
 *
 * Why provision on import: skipping it would mint a second class of
 * permanently-`@legacy` companies that `crew-updater.ts` can never touch —
 * precisely the state Phase 2 exists to eliminate.
 *
 * ⚠️ **Scope of this file.** These tests mock `companyService` wholesale, so
 * they pin ONLY the pass-through — that import calls `create` with per-create
 * options carrying the importing actor. They do **not** exercise the crew
 * install, and they do **not** prove the `kind` separation below; that is
 * asserted against a real database in
 * `crew-marketplace-bootstrap.integration.test.ts`.
 *
 * Why it is safe against the bundle's own agents: the crew is `kind='aoa'` and
 * every import/export agent path is `kind='org'` (`agentService.list()` defaults
 * to org), so the imported roster and the crew never see each other and the
 * import's normalized-name merge cannot touch a crew row.
 *
 * **Known widening, deliberately NOT fixed here:**
 * `assertCompanyShortnameAvailable` DOES see `kind='aoa'` rows, so a bundle
 * agent named e.g. "Reviewer" now collides where it previously would not — the
 * marketplace roster has 9 members to the legacy seeders' 8. Pre-existing in
 * kind (the legacy crew collided the same way for its 8), wider in practice.
 * Flagged rather than fixed: changing shortname scoping is its own decision.
 */
import { describe, expect, it, vi } from "vitest";

const createMock = vi.hoisted(() =>
  vi.fn(async (input: { name: string }) => ({ id: "created-co", name: input.name })),
);

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => ({ id, name: "Target Co" })),
    create: createMock,
    // P3: importBundle now creates via the atomic `createWithOperator`; delegate
    // to `createMock` so its call-args assertions (requestedByUserId passthrough)
    // still hold, then provision the operator via the passed access factory.
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
    backfillHumanAtTop: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
  }),
}));

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    ensureMembership: vi.fn(async () => undefined),
    ensureRealOperator: vi.fn(async () => "operator-user-id"),
  }),
}));

import { companyPortabilityService } from "../services/company-portability.js";
import type { CompanyPortabilityManifest } from "@armyofagents/shared";

function baseManifest(): CompanyPortabilityManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-24T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: false },
    company: {
      path: "COMPANY.md",
      name: "Imported Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
      agentCompletionPolicyDefault: "review_required",
      agentCompletionReviewGuardrail: false,
    },
    agents: [],
    projects: [],
    issues: [],
    skills: [],
    routines: [],
  } as unknown as CompanyPortabilityManifest;
}

const svc = companyPortabilityService({
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
} as never);

describe("company-bundle import into a new company provisions the crew (R8)", () => {
  it("passes the importing actor through as the crew install's requestedByUserId", async () => {
    createMock.mockClear();

    await svc.importBundle(
      {
        source: {
          type: "inline" as const,
          manifest: baseManifest(),
          files: { "COMPANY.md": "---\nkind: company\nname: Imported Co\n---\n" },
        },
        target: { mode: "new_company" as const, newCompanyName: "Imported Co" },
        include: { company: true, agents: false },
      } as never,
      "importing-user-1",
    );

    expect(createMock).toHaveBeenCalledOnce();
    const [data, opts] = createMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { requestedByUserId?: string | null } | undefined,
    ];
    expect(data.name).toBe("Imported Co");
    // The discriminator: `create(data)` with no second argument would leave the
    // install operation attributed to the synthetic system actor, and — more
    // importantly — would mean nobody had considered this caller at all.
    expect(opts).toBeDefined();
    expect(opts?.requestedByUserId).toBe("importing-user-1");
  });

  it("a board import with no user id still provisions, attributed to null", async () => {
    createMock.mockClear();

    await svc.importBundle(
      {
        source: {
          type: "inline" as const,
          manifest: baseManifest(),
          files: { "COMPANY.md": "---\nkind: company\nname: Imported Co\n---\n" },
        },
        target: { mode: "new_company" as const, newCompanyName: "Imported Co" },
        include: { company: true, agents: false },
      } as never,
      null,
    );

    const [, opts] = createMock.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { requestedByUserId?: string | null } | undefined,
    ];
    expect(opts?.requestedByUserId).toBeNull();
  });
});
