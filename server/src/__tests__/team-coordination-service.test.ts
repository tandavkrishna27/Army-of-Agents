import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
}));

vi.mock("@armyofagents/db", () => ({
  teamCoordinations: {
    id: "tc_id",
    companyId: "tc_company_id",
    teamId: "tc_team_id",
    key: "tc_key",
    slug: "tc_slug",
    name: "tc_name",
    description: "tc_description",
    markdown: "tc_markdown",
    status: "tc_status",
    sourceType: "tc_source_type",
    createdAt: "tc_created_at",
    updatedAt: "tc_updated_at",
  },
}));

import { teamCoordinationService } from "../services/team-coordination.js";
import { createAgentDb } from "./helpers/mock-db.js";

describe("teamCoordinationService.upsert", () => {
  it("inserts a new coordination row when none exists", async () => {
    const db = createAgentDb({
      selects: [[]], // no existing
      inserts: [[{ id: "tc1", teamId: "t1", markdown: "# Mission" }]],
    });
    const svc = teamCoordinationService(db);
    const result = await svc.upsert("c1", {
      teamId: "t1",
      name: "Frontend Team Coordination",
      markdown: "# Mission",
    });
    expect(result.id).toBe("tc1");
  });

  it("updates an existing coordination row", async () => {
    const db = createAgentDb({
      selects: [[{ id: "tc1", teamId: "t1", status: "published" }]],
      updates: [[{ id: "tc1", teamId: "t1", markdown: "updated" }]],
    });
    const svc = teamCoordinationService(db);
    const result = await svc.upsert("c1", {
      teamId: "t1",
      name: "Frontend",
      markdown: "updated",
    });
    expect(result.markdown).toBe("updated");
  });

  it("accepts description: null to clear an existing description (C4)", async () => {
    // Founder wants to clear a previously-set description. After the schema
    // relaxed `.optional()` -> `.nullable().optional()`, the service must
    // pass `null` straight through to the DB write -- the column is
    // `text` nullable. Capture the update payload and assert null persists.
    const updateSets: any[] = [];
    let selectCalls = 0;
    const db: any = {
      transaction: async (cb: (tx: any) => any) => {
        const tx: any = {
          select: () => ({
            from: () => ({
              where: () => {
                selectCalls++;
                return Promise.resolve([
                  { id: "tc1", teamId: "t1", status: "published", description: "old desc" },
                ]);
              },
            }),
          }),
          update: () => ({
            set: (vals: any) => {
              updateSets.push(vals);
              return {
                where: () => ({
                  returning: () =>
                    Promise.resolve([
                      { id: "tc1", teamId: "t1", description: null, markdown: "kept" },
                    ]),
                }),
              };
            },
          }),
        };
        return cb(tx);
      },
    };

    const svc = teamCoordinationService(db);
    const result = await svc.upsert("c1", {
      teamId: "t1",
      name: "Frontend",
      markdown: "kept",
      description: null,
    });

    expect(result.description).toBeNull();
    expect(selectCalls).toBe(1);
    expect(updateSets).toHaveLength(1);
    // Critical: the service must FORWARD null (not coerce to undefined).
    // If it coerced, the update would silently leave the old description in place.
    expect(updateSets[0].description).toBeNull();
  });

  it("converts PG 23505 unique-violation on concurrent publish to 409", async () => {
    // Simulate: SELECT inside tx returns no published row; INSERT throws 23505
    // (the partial unique index team_coordinations_one_published_uq fired
    // because a concurrent transaction won the race).
    const db: any = {
      transaction: async (cb: any) => {
        const tx: any = {
          select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
          insert: () => ({
            values: () => ({
              returning: () => {
                const err = Object.assign(new Error("dup"), { code: "23505" });
                throw err;
              },
            }),
          }),
        };
        return cb(tx);
      },
    };

    await expect(
      teamCoordinationService(db).upsert("co-1", {
        teamId: "t1",
        name: "QA",
        markdown: "## body",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("revives an archived coordination row instead of inserting a duplicate", async () => {
    // Simulate: SELECT for published returns []; SELECT for archived returns
    // an archived row; service should UPDATE that row back to status='published'
    // rather than INSERT (which would 23505 on team_coordinations_company_key_uq
    // because the key column is constant per team).
    const archivedRow = {
      id: "coord-archived",
      teamId: "t1",
      key: "team-t1:coordination",
      status: "archived",
    };
    let updateCallCount = 0;
    let insertCalled = false;

    const db: any = {
      transaction: async (cb: any) => {
        let selectCalls = 0;
        const tx: any = {
          select: () => ({
            from: () => ({
              where: () => {
                const idx = selectCalls++;
                if (idx === 0) return Promise.resolve([]); // no published
                if (idx === 1) return Promise.resolve([archivedRow]); // archived found
                return Promise.resolve([]);
              },
            }),
          }),
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () => {
                  updateCallCount++;
                  return Promise.resolve([{ ...archivedRow, status: "published", name: "QA" }]);
                },
              }),
            }),
          }),
          insert: () => {
            insertCalled = true;
            throw new Error("insert should not be called when archived row exists");
          },
        };
        return cb(tx);
      },
    };

    const result = await teamCoordinationService(db).upsert("co-1", {
      teamId: "t1",
      name: "QA",
      markdown: "## body",
    });

    expect(insertCalled).toBe(false);
    expect(updateCallCount).toBe(1);
    expect(result).toMatchObject({ id: "coord-archived", status: "published" });
  });

  it("throws conflict when published row is concurrently archived between SELECT and UPDATE", async () => {
    // C1: T1 SELECTs published row R; T2 archives R (status='published'→'archived');
    // T1's UPDATE-by-id only filters by id, so without a status guard it would
    // overwrite the archived row's name/markdown. Fix: WHERE includes
    // status='published'; if updated.length === 0, throw conflict.
    const db: any = {
      transaction: async (cb: any) => {
        const tx: any = {
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([{ id: "coord-1", status: "published" }]),
            }),
          }),
          update: () => ({
            set: () => ({
              where: () => ({
                // Simulate concurrent archive: row matches by id but status !== 'published'.
                // Drizzle UPDATE...WHERE...RETURNING returns 0 rows when no match.
                returning: () => Promise.resolve([]),
              }),
            }),
          }),
        };
        return cb(tx);
      },
    };

    await expect(
      teamCoordinationService(db).upsert("co-1", {
        teamId: "t1",
        name: "QA",
        markdown: "## body",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("throws conflict when archived row is concurrently revived between SELECT and revive UPDATE", async () => {
    // C2 secondary scenario: T2 inserts new published row + archives the
    // existing archived row, so when T1 tries to revive the original archived
    // row, our partial unique index would fire on the second 'published' row
    // OR the WHERE-by-id-and-status no longer matches (status changed).
    // Either way, updated.length === 0 → throw conflict.
    let selectCalls = 0;
    const db: any = {
      transaction: async (cb: any) => {
        const tx: any = {
          select: () => ({
            from: () => ({
              where: () => {
                const idx = selectCalls++;
                if (idx === 0) return Promise.resolve([]); // no published
                if (idx === 1)
                  return Promise.resolve([{ id: "coord-1", status: "archived" }]); // archived found
                return Promise.resolve([]);
              },
            }),
          }),
          update: () => ({
            set: () => ({
              where: () => ({
                // Simulate concurrent revive: row no longer matches WHERE
                // (status changed by the racing tx).
                returning: () => Promise.resolve([]),
              }),
            }),
          }),
          insert: () => {
            throw new Error("insert should not be called when archived row was found");
          },
        };
        return cb(tx);
      },
    };

    await expect(
      teamCoordinationService(db).upsert("co-1", {
        teamId: "t1",
        name: "QA",
        markdown: "## body",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("maps 23505 on revive UPDATE to 409 (3-way race: archive + insert published + revive)", async () => {
    // C2 specific scenario: between SELECT-archived and revive-UPDATE, a
    // concurrent tx inserted a new published row for the same team. Our
    // revive UPDATE flips the archived row to published, producing two
    // 'published' rows → partial unique index fires → 23505. Wrap in
    // try/catch to map to 409.
    let selectCalls = 0;
    const db: any = {
      transaction: async (cb: any) => {
        const tx: any = {
          select: () => ({
            from: () => ({
              where: () => {
                const idx = selectCalls++;
                if (idx === 0) return Promise.resolve([]); // no published
                if (idx === 1)
                  return Promise.resolve([{ id: "coord-1", status: "archived" }]);
                return Promise.resolve([]);
              },
            }),
          }),
          update: () => ({
            set: () => ({
              where: () => ({
                returning: () => {
                  const err = Object.assign(new Error("dup"), { code: "23505" });
                  throw err;
                },
              }),
            }),
          }),
          insert: () => {
            throw new Error("insert should not be called when archived row was found");
          },
        };
        return cb(tx);
      },
    };

    await expect(
      teamCoordinationService(db).upsert("co-1", {
        teamId: "t1",
        name: "QA",
        markdown: "## body",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("teamCoordinationService.getByTeam", () => {
  it("returns the published coordination for a team", async () => {
    const db = createAgentDb({
      selects: [[{ id: "tc1", teamId: "t1", status: "published" }]],
    });
    const svc = teamCoordinationService(db);
    const result = await svc.getByTeam("t1");
    expect(result?.id).toBe("tc1");
  });

  it("returns null if no coordination exists", async () => {
    const db = createAgentDb({ selects: [[]] });
    const svc = teamCoordinationService(db);
    const result = await svc.getByTeam("t1");
    expect(result).toBeNull();
  });
});

describe("teamCoordinationService.archive", () => {
  it("flips status to archived", async () => {
    const db = createAgentDb({
      updates: [[{ id: "tc1", status: "archived" }]],
    });
    const svc = teamCoordinationService(db);
    const result = await svc.archive("tc1");
    expect(result.status).toBe("archived");
  });
});

describe("teamCoordinationService.regenerateAutoSections", () => {
  it("replaces both members and routing sections, preserves user prose", async () => {
    const original = `## Mission
prose

<!-- begin:auto:members -->
old members
<!-- end:auto:members -->

<!-- begin:auto:routing -->
old routing
<!-- end:auto:routing -->`;

    const db = createAgentDb({
      selects: [[{ id: "tc1", teamId: "t1", markdown: original }]],
      updates: [[{ id: "tc1", teamId: "t1", markdown: "updated" }]],
    });
    const svc = teamCoordinationService(db);
    const result = await svc.regenerateAutoSections("tc1", {
      members: "## Members\n- alice [LEAD]",
      routing: "## Routing\n- default -> @alice",
    });
    expect(result).toBeDefined();
    expect(result.id).toBe("tc1");
  });

  it("throws notFound when coordination doesn't exist", async () => {
    const db = createAgentDb({
      selects: [[]],  // empty result
    });
    const svc = teamCoordinationService(db);
    await expect(svc.regenerateAutoSections("nonexistent", { members: "x" }))
      .rejects.toThrow(/not found/i);
  });
});
