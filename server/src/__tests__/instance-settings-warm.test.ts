import { describe, expect, it } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";

function makeDb(initialExperimental: Record<string, unknown> = {}) {
  let row = {
    id: "11111111-1111-4111-8111-111111111111",
    singletonKey: "default",
    general: {},
    experimental: initialExperimental,
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
    updatedAt: new Date("2026-08-07T00:00:00.000Z"),
  };

  const db = {
    select: () => ({
      from: () => ({
        where: async () => [row],
      }),
    }),
    update: () => ({
      set: (values: Partial<typeof row>) => ({
        where: () => ({
          returning: async () => {
            row = { ...row, ...values };
            return [row];
          },
        }),
      }),
    }),
  };

  return { db, getRow: () => row };
}

describe("instance settings — warm sandbox fields (U7.3)", () => {
  it("getExperimental() returns the warm-sandbox defaults when nothing is stored", async () => {
    const { db } = makeDb({});
    const experimental = await instanceSettingsService(db as never).getExperimental();
    expect(experimental.warmSandboxDefaultForSoftwareDev).toBe(true);
    expect(experimental.warmSandboxIdleTtlMinutes).toBe(30);
    expect(experimental.enableWarmSandboxReaper).toBe(true);
  });

  it("defaults warmCommanderConversations to true", async () => {
    const { db } = makeDb({});
    const exp = await instanceSettingsService(db as never).getExperimental();
    expect(exp.warmCommanderConversations).toBe(true);
  });

  it("preserves an explicitly stored warmCommanderConversations override", async () => {
    const { db } = makeDb({ warmCommanderConversations: false });
    const exp = await instanceSettingsService(db as never).getExperimental();
    expect(exp.warmCommanderConversations).toBe(false);
  });

  it("returns the warmCommanderConversations default on the fallback (invalid stored) branch", async () => {
    const { db } = makeDb("not-an-object" as unknown as Record<string, unknown>);
    const exp = await instanceSettingsService(db as never).getExperimental();
    expect(exp.warmCommanderConversations).toBe(true);
  });

  it("getExperimental() preserves an explicitly stored override", async () => {
    const { db } = makeDb({
      warmSandboxDefaultForSoftwareDev: false,
      warmSandboxIdleTtlMinutes: 60,
      enableWarmSandboxReaper: false,
    });
    const experimental = await instanceSettingsService(db as never).getExperimental();
    expect(experimental.warmSandboxDefaultForSoftwareDev).toBe(false);
    expect(experimental.warmSandboxIdleTtlMinutes).toBe(60);
    expect(experimental.enableWarmSandboxReaper).toBe(false);
  });

  it("getExperimental() still returns the warm-sandbox defaults on the fallback (invalid stored) branch", async () => {
    // Not an object -> instanceExperimentalSettingsSchema.safeParse fails ->
    // normalizeExperimentalSettings must hit its hardcoded fallback branch.
    const { db } = makeDb("not-an-object" as unknown as Record<string, unknown>);
    const experimental = await instanceSettingsService(db as never).getExperimental();
    expect(experimental.warmSandboxDefaultForSoftwareDev).toBe(true);
    expect(experimental.warmSandboxIdleTtlMinutes).toBe(30);
    expect(experimental.enableWarmSandboxReaper).toBe(true);
  });

  it("updateExperimental() persists a warm-sandbox patch alongside existing fields", async () => {
    const { db } = makeDb({ enableIsolatedWorkspaces: true });
    const updated = await instanceSettingsService(db as never).updateExperimental({
      warmSandboxIdleTtlMinutes: 15,
    });
    expect(updated.experimental.warmSandboxIdleTtlMinutes).toBe(15);
    expect(updated.experimental.enableIsolatedWorkspaces).toBe(true);
    expect(updated.experimental.warmSandboxDefaultForSoftwareDev).toBe(true);
    expect(updated.experimental.enableWarmSandboxReaper).toBe(true);
  });
});
