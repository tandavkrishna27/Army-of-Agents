import { describe, expect, it } from "vitest";
import { instanceSettingsService } from "../services/instance-settings.js";

function makeDb(initialGeneral: Record<string, unknown>) {
  let row = {
    id: "11111111-1111-4111-8111-111111111111",
    singletonKey: "default",
    general: initialGeneral,
    experimental: {},
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    updatedAt: new Date("2026-08-03T00:00:00.000Z"),
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

describe("instance settings migration metadata", () => {
  it("normalizes public settings without letting migration metadata reset them", async () => {
    const { db } = makeDb({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      migrationSnapshots: ["0188"],
    });

    await expect(instanceSettingsService(db as never).getGeneral()).resolves.toMatchObject({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
    });
  });

  it("preserves the private migration snapshot marker across a public settings update", async () => {
    const { db, getRow } = makeDb({
      censorUsernameInLogs: true,
      migrationSnapshots: ["0188"],
    });

    await instanceSettingsService(db as never).updateGeneral({ keyboardShortcuts: true });

    expect(getRow().general).toMatchObject({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      migrationSnapshots: ["0188"],
    });
  });
});
