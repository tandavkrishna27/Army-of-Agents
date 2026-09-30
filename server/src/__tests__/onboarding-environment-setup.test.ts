import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));
vi.mock("@armyofagents/db", () => ({
  environments: new Proxy({}, { get: (_t, p) => Symbol(String(p)) }),
  companies: new Proxy({}, { get: (_t, p) => Symbol(String(p)) }),
}));

import {
  setupOnboardingEnvironment,
  ONBOARDING_ENVIRONMENT_NAME,
} from "../services/onboarding-environment.js";

describe("setupOnboardingEnvironment", () => {
  it("blocks (no writes) when the probe fails", async () => {
    const inserted: any[] = [];
    const updated: any[] = [];
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: (v: any) => ({ returning: async () => { inserted.push(v); return [{ id: "e1", ...v }]; } }) }),
      update: () => ({ set: (v: any) => ({ where: async () => { updated.push(v); } }) }),
    };
    const probe = vi.fn(async () => ({
      ok: false,
      driver: "local" as const,
      summary: "no perms",
      checks: [{ name: "config.path", status: "failed" as const, message: "denied" }],
    }));
    const res = await setupOnboardingEnvironment(db, { companyId: "c1", rootFolder: "/tmp/acme", probe });
    expect(res.ok).toBe(false);
    expect(res.environmentId).toBeNull();
    expect(probe).toHaveBeenCalled();
    // Blocking: nothing persisted when the probe fails.
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("creates env + sets rootFolder when none exists and the probe passes", async () => {
    const inserted: any[] = [];
    const companyUpdates: any[] = [];
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      insert: () => ({ values: (v: any) => ({ returning: async () => { inserted.push(v); return [{ id: "e1", ...v }]; } }) }),
      update: () => ({ set: (v: any) => ({ where: async () => { companyUpdates.push(v); } }) }),
    };
    const probe = vi.fn(async () => ({ ok: true, driver: "local" as const, summary: "ok" }));
    const res = await setupOnboardingEnvironment(db, { companyId: "c1", rootFolder: "/tmp/acme", probe });
    expect(res.ok).toBe(true);
    expect(res.environmentId).toBe("e1");
    expect(res).toMatchObject({ created: true });
    expect(inserted[0]).toMatchObject({
      companyId: "c1",
      name: ONBOARDING_ENVIRONMENT_NAME,
      driver: "local",
    });
    expect(inserted[0].config).toMatchObject({ path: "/tmp/acme" });
    // rootFolder persisted on the company.
    expect(companyUpdates.some((u) => u.rootFolder === "/tmp/acme")).toBe(true);
  });

  it("re-entry updates the existing env (no duplicate) when the probe passes", async () => {
    const inserted: any[] = [];
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "e1", name: ONBOARDING_ENVIRONMENT_NAME }] }) }) }),
      insert: () => ({ values: (v: any) => ({ returning: async () => { inserted.push(v); return [{ id: "nope" }]; } }) }),
      update: () => ({ set: () => ({ where: async () => {} }) }),
    };
    const probe = vi.fn(async () => ({ ok: true, driver: "local" as const, summary: "ok" }));
    const res = await setupOnboardingEnvironment(db, { companyId: "c1", rootFolder: "/tmp/acme", probe });
    expect(res.ok).toBe(true);
    expect(res.environmentId).toBe("e1");
    expect(res).toMatchObject({ created: false });
    expect(inserted).toHaveLength(0);
  });
});
