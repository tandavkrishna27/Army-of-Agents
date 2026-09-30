import { describe, it, expect } from "vitest";
import { computeAdvance, advanceState, ensureProgress, type ProgressRow } from "../services/onboarding.js";
import { FOUNDER_PHASE1_STATES } from "@armyofagents/shared";

const ORDER = FOUNDER_PHASE1_STATES;

describe("computeAdvance (Stage B / B3 + revC RC1)", () => {
  it("advances to the immediate next state", () => {
    const d = computeAdvance(ORDER, "AUTHENTICATED", ["AUTHENTICATED"], "PROFILE_SET");
    expect(d).toEqual({
      kind: "advance",
      newCurrent: "PROFILE_SET",
      newCompleted: ["AUTHENTICATED", "PROFILE_SET"],
    });
  });

  it("is a no-op when the requested state is already completed (idempotent)", () => {
    expect(
      computeAdvance(ORDER, "PROFILE_SET", ["AUTHENTICATED", "PROFILE_SET"], "PROFILE_SET"),
    ).toEqual({ kind: "noop" });
  });

  it("is a no-op when the requested state is behind current (never regress)", () => {
    expect(
      computeAdvance(ORDER, "ENVIRONMENT_READY", ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED", "ENVIRONMENT_READY"], "PROFILE_SET"),
    ).toEqual({ kind: "noop" });
  });

  it("rejects an out-of-order skip (prior deps unmet)", () => {
    const d = computeAdvance(ORDER, "AUTHENTICATED", ["AUTHENTICATED"], "DEPARTMENT_CREATED");
    expect(d.kind).toBe("illegal");
  });

  it("rejects an unknown state for the journey", () => {
    const d = computeAdvance(ORDER, "AUTHENTICATED", ["AUTHENTICATED"], "JOIN_REQUESTED");
    expect(d.kind).toBe("illegal");
  });

  it("WS0c: a legacy in-flight row at DEPARTMENT_CREATED (curIdx -1, removed from the sequence) can still legally advance to SETUP_COMPLETE once the spine is complete", () => {
    // DEPARTMENT_CREATED is no longer in FOUNDER_PHASE1_STATES, so
    // order.indexOf(current) === -1. This must NOT be treated as "illegal" or
    // "regress" — priorSatisfied holds because completedStates already
    // includes everything through COMMANDER_VERIFIED, and
    // Math.max(-1, reqIdx) correctly picks SETUP_COMPLETE (design §8).
    const d = computeAdvance(
      ORDER,
      "DEPARTMENT_CREATED",
      [
        "AUTHENTICATED",
        "PROFILE_SET",
        "COMPANY_CREATED",
        "ENVIRONMENT_READY",
        "COMMANDER_SELECTED",
        "COMMANDER_VERIFIED",
      ],
      "SETUP_COMPLETE",
    );
    expect(d).toEqual({
      kind: "advance",
      newCurrent: "SETUP_COMPLETE",
      newCompleted: [
        "AUTHENTICATED",
        "PROFILE_SET",
        "COMPANY_CREATED",
        "ENVIRONMENT_READY",
        "COMMANDER_SELECTED",
        "COMMANDER_VERIFIED",
        "SETUP_COMPLETE",
      ],
    });
  });

  it("advances legally from COMMANDER_VERIFIED straight to SETUP_COMPLETE (the new terminal-step gate)", () => {
    const completed: typeof ORDER = [
      "AUTHENTICATED",
      "PROFILE_SET",
      "COMPANY_CREATED",
      "ENVIRONMENT_READY",
      "COMMANDER_SELECTED",
      "COMMANDER_VERIFIED",
    ];
    const d = computeAdvance(ORDER, "COMMANDER_VERIFIED", completed, "SETUP_COMPLETE");
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") {
      expect(d.newCurrent).toBe("SETUP_COMPLETE");
    }
  });
});

// Stateful fake db modelling a single progress row + optimistic version.
function fakeDb(opts: { start?: Partial<ProgressRow>; alwaysConflict?: boolean } = {}) {
  let row: ProgressRow | null = opts.start
    ? {
        id: "r1",
        userId: "u1",
        companyId: null,
        journey: "founder",
        currentState: "AUTHENTICATED",
        completedStates: ["AUTHENTICATED"],
        version: 0,
        ...opts.start,
      }
    : null;
  let bumpOnce = false;
  const db: any = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [{ ...row }] : []) }) }) }),
    insert: () => ({
      values: (v: any) => ({
        onConflictDoNothing: async () => {
          if (!row) row = { id: "r1", completedStates: [], version: 0, ...v, companyId: v.companyId ?? null };
        },
      }),
    }),
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            if (opts.alwaysConflict) return [];
            if (bumpOnce) {
              bumpOnce = false;
              row = { ...row!, version: row!.version + 1 }; // concurrent writer won
              return [];
            }
            if (row!.version !== patch.version - 1) return [];
            row = { ...row!, ...patch };
            return [{ ...row }];
          },
        }),
      }),
    }),
    _row: () => row,
    _triggerConflictOnce: () => {
      bumpOnce = true;
    },
  };
  return db;
}

describe("advanceState (Stage B / B3 + revC RC1)", () => {
  it("advances forward and bumps version", async () => {
    const db = fakeDb({ start: {} });
    const r = await advanceState(db, { userId: "u1", companyId: null, journey: "founder", requestedState: "PROFILE_SET" });
    expect(r.status).toBe("ok");
    expect(db._row().currentState).toBe("PROFILE_SET");
    expect(db._row().version).toBe(1);
    expect(db._row().completedStates).toContain("PROFILE_SET");
  });

  it("idempotent replay is a no-op success (no version bump)", async () => {
    const db = fakeDb({ start: { currentState: "PROFILE_SET", completedStates: ["AUTHENTICATED", "PROFILE_SET"], version: 1 } });
    const r = await advanceState(db, { userId: "u1", companyId: null, journey: "founder", requestedState: "PROFILE_SET" });
    expect(r.status).toBe("ok");
    expect(db._row().version).toBe(1);
  });

  it("rejects an illegal skip", async () => {
    const db = fakeDb({ start: {} });
    const r = await advanceState(db, { userId: "u1", companyId: null, journey: "founder", requestedState: "AGENT_ASSIGNED" });
    expect(r.status).toBe("illegal");
  });

  it("uses the persisted row journey instead of a conflicting caller journey", async () => {
    const db = fakeDb({
      start: {
        journey: "invited",
        currentState: "PROFILE_SET",
        completedStates: ["AUTHENTICATED", "PROFILE_SET"],
      },
    });
    const r = await advanceState(db, {
      userId: "u1",
      companyId: null,
      journey: "founder",
      requestedState: "ORGANIZATION_CREATED",
    });
    expect(r).toEqual({
      status: "illegal",
      reason: "state COMPANY_CREATED not in journey",
    });
    expect(db._row().currentState).toBe("PROFILE_SET");
  });

  it("accepts the legacy organization state alias but persists the canonical company state", async () => {
    const db = fakeDb({
      start: {
        journey: "founder",
        currentState: "PROFILE_SET",
        completedStates: ["AUTHENTICATED", "PROFILE_SET"],
      },
    });
    const r = await advanceState(db, {
      userId: "u1",
      companyId: null,
      journey: "founder",
      requestedState: "ORGANIZATION_CREATED",
    });

    expect(r.status).toBe("ok");
    expect(db._row().currentState).toBe("COMPANY_CREATED");
    expect(db._row().completedStates).toContain("COMPANY_CREATED");
    expect(db._row().completedStates).not.toContain("ORGANIZATION_CREATED");
  });

  it("retries after one optimistic conflict, then succeeds", async () => {
    const db = fakeDb({ start: {} });
    db._triggerConflictOnce();
    const r = await advanceState(db, { userId: "u1", companyId: null, journey: "founder", requestedState: "PROFILE_SET" });
    expect(r.status).toBe("ok");
    expect(db._row().currentState).toBe("PROFILE_SET");
  });

  it("returns conflict after exhausting retries", async () => {
    const db = fakeDb({ start: {}, alwaysConflict: true });
    const r = await advanceState(db, { userId: "u1", companyId: null, journey: "founder", requestedState: "PROFILE_SET" });
    expect(r.status).toBe("conflict");
  });
});

describe("ensureProgress org-layer seeding (Stage C)", () => {
  it("seeds an org-layer row from the user-layer completed states", async () => {
    const selectResults: unknown[][] = [
      [], // org-layer lookup: none yet
      [
        {
          id: "u-row",
          userId: "u1",
          companyId: null,
          journey: "founder",
          currentState: "PROFILE_SET",
          completedStates: ["AUTHENTICATED", "PROFILE_SET"],
          version: 3,
        },
      ], // user-layer row
    ];
    let i = 0;
    let inserted: any = null;
    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => selectResults[i++] ?? [] }) }) }),
      insert: () => ({
        values: (v: any) => ({
          onConflictDoNothing: async () => {
            inserted = v;
            selectResults.push([{ id: "org-row", ...v }]); // org-layer re-read returns the seeded row
          },
        }),
      }),
    };
    const row = await ensureProgress(db, { userId: "u1", companyId: "org1", journey: "founder" });
    expect(inserted.completedStates).toEqual(["AUTHENTICATED", "PROFILE_SET"]);
    expect(inserted.currentState).toBe("PROFILE_SET");
    expect(row.companyId).toBe("org1");
  });
});
