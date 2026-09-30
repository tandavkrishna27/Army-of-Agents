import { describe, expect, it, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          cols[prop] ??= Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    hubPreferences: makeTable("hub_preferences"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
}));

import { hubPreferencesService } from "../services/hub-preferences.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let deleteIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const deletes = config.deletes ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "values", "returning", "set", "onConflictDoUpdate"]) {
      chain[method] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (value: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => deletes[deleteIdx++] ?? []),
  } as any;
}

describe("hubPreferencesService", () => {
  it("returns default hub preferences when no row exists", async () => {
    const svc = hubPreferencesService(createSequenceDb({ selects: [[]] }));

    await expect(svc.get("user-1", "11111111-1111-1111-1111-111111111111")).resolves.toEqual({
      defaultLanding: "home",
      visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
      groupMode: "auto",
      density: "comfortable",
      showAutopilotEntry: true,
      updatedAt: null,
    });
  });

  it("returns stored company-scoped preferences", async () => {
    const updatedAt = new Date("2026-06-30T00:00:00.000Z");
    const svc = hubPreferencesService(
      createSequenceDb({
        selects: [[
          {
            defaultLanding: "notifications",
            visibleLanes: ["notifications", "suggestions"],
            groupMode: "source",
            density: "compact",
            showAutopilotEntry: false,
            updatedAt,
          },
        ]],
      }),
    );

    await expect(svc.get("user-1", "11111111-1111-1111-1111-111111111111")).resolves.toEqual({
      defaultLanding: "notifications",
      visibleLanes: ["notifications", "suggestions"],
      groupMode: "source",
      density: "compact",
      showAutopilotEntry: false,
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("upsert merges omitted fields with existing preferences", async () => {
    const updatedAt = new Date("2026-06-30T01:00:00.000Z");
    const svc = hubPreferencesService(
      createSequenceDb({
        selects: [[
          {
            defaultLanding: "notifications",
            visibleLanes: ["notifications", "suggestions"],
            groupMode: "source",
            density: "comfortable",
            showAutopilotEntry: true,
            updatedAt: new Date("2026-06-29T00:00:00.000Z"),
          },
        ]],
        inserts: [[
          {
            defaultLanding: "notifications",
            visibleLanes: ["notifications", "suggestions"],
            groupMode: "source",
            density: "compact",
            showAutopilotEntry: true,
            updatedAt,
          },
        ]],
      }),
    );

    const result = await svc.upsert("user-1", "11111111-1111-1111-1111-111111111111", {
      density: "compact",
    });

    expect(result).toMatchObject({
      defaultLanding: "notifications",
      visibleLanes: ["notifications", "suggestions"],
      groupMode: "source",
      density: "compact",
      showAutopilotEntry: true,
      updatedAt: updatedAt.toISOString(),
    });
  });

  it("normalizes a hidden default landing to home", async () => {
    const svc = hubPreferencesService(
      createSequenceDb({
        selects: [[]],
        inserts: [[
          {
            defaultLanding: "home",
            visibleLanes: ["notifications"],
            groupMode: "auto",
            density: "comfortable",
            showAutopilotEntry: true,
            updatedAt: new Date("2026-06-30T02:00:00.000Z"),
          },
        ]],
      }),
    );

    await expect(
      svc.upsert("user-1", "11111111-1111-1111-1111-111111111111", {
        defaultLanding: "waiting_on_you",
        visibleLanes: ["notifications"],
      }),
    ).resolves.toMatchObject({
      defaultLanding: "home",
      visibleLanes: ["notifications"],
    });
  });

  it("reset restores defaults", async () => {
    const svc = hubPreferencesService(
      createSequenceDb({
        inserts: [[
          {
            defaultLanding: "home",
            visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
            groupMode: "auto",
            density: "comfortable",
            showAutopilotEntry: true,
            updatedAt: new Date("2026-06-30T03:00:00.000Z"),
          },
        ]],
      }),
    );

    await expect(svc.reset("user-1", "11111111-1111-1111-1111-111111111111")).resolves.toMatchObject({
      defaultLanding: "home",
      visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
      groupMode: "auto",
      density: "comfortable",
      showAutopilotEntry: true,
    });
  });
});
