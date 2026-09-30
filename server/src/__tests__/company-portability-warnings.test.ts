import { describe, expect, it, vi } from "vitest";

vi.mock("../services/companies.js", () => ({
  companyService: () => ({
    getById: vi.fn(async (id: string) => ({ id, name: "Target Co" })),
    create: vi.fn(async (input: { name: string }) => ({ id: "created-co", name: input.name })),
    // P3: importBundle creates via the atomic `createWithOperator`.
    createWithOperator: vi.fn(async (input: { name: string }, _opts: any, ownerUserId: any, buildAccess: any) => {
      const company = { id: "created-co", name: input.name };
      const operatorId = await buildAccess(undefined).ensureRealOperator(company.id, ownerUserId ?? null);
      return { company, operatorId };
    }),
    update: vi.fn(async (id: string, patch: any) => ({ id, name: patch.name ?? "Target Co" })),
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

function baseManifest(overrides: Partial<CompanyPortabilityManifest> = {}): CompanyPortabilityManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-04-21T00:00:00.000Z",
    source: null,
    includes: { company: true, agents: true },
    company: {
      path: "COMPANY.md",
      name: "Test Co",
      description: null,
      brandColor: null,
      requireBoardApprovalForNewAgents: true,
    },
    agents: [],
    requiredSecrets: [],
    ...overrides,
  };
}

function buildInlineSource(manifest: unknown, files: Record<string, string> = { "COMPANY.md": "---\nkind: company\nname: Test Co\n---\n" }) {
  return {
    source: { type: "inline" as const, manifest: manifest as CompanyPortabilityManifest, files },
    target: { mode: "new_company" as const, newCompanyName: "Imported" },
    include: { company: true, agents: false },
  };
}

describe("company-portability warnings", () => {
  const svc = companyPortabilityService({ select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as any);

  it("returns warning for unknown top-level section in manifest", async () => {
    const manifest = {
      ...baseManifest(),
      legacyBriefs: [{ key: "eng" }],
    };
    const preview = await svc.previewImport(buildInlineSource(manifest));
    expect(preview.warnings).toContainEqual(
      expect.objectContaining({
        kind: "unknown_section",
        section: "legacyBriefs",
        count: 1,
      }),
    );
  });

  it("warns with count undefined when unknown section is a non-array value", async () => {
    const manifest = {
      ...baseManifest(),
      custom: { note: "hello" },
    };
    const preview = await svc.previewImport(buildInlineSource(manifest));
    const warn = preview.warnings.find((w) => w.kind === "unknown_section" && w.section === "custom");
    expect(warn).toBeDefined();
    expect(warn?.count).toBeUndefined();
  });

  it("warns on unsupported schemaVersion > 2", async () => {
    const manifest = { ...baseManifest(), schemaVersion: 99 };
    const preview = await svc.previewImport(buildInlineSource(manifest));
    expect(preview.warnings.some((w) => w.kind === "unsupported_version")).toBe(true);
  });

  it("accepts schemaVersion 1 and 2 without unsupported_version warning", async () => {
    for (const v of [1, 2]) {
      const manifest = { ...baseManifest(), schemaVersion: v };
      const preview = await svc.previewImport(buildInlineSource(manifest));
      expect(preview.warnings.some((w) => w.kind === "unsupported_version")).toBe(false);
    }
  });

  it("importBundle propagates warnings from preview step", async () => {
    const manifest = {
      ...baseManifest(),
      legacyBriefs: [{ key: "some-brief" }],
    };
    const result = await svc.importBundle(buildInlineSource(manifest), "user-1");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.kind === "unknown_section" && w.section === "legacyBriefs")).toBe(true);
  });

  it("no warnings for clean v1 bundle with only company + agents", async () => {
    const manifest = baseManifest();
    const preview = await svc.previewImport(buildInlineSource(manifest));
    expect(preview.warnings).toEqual([]);
  });
});
