/**
 * Unit tests for `normalizeLegacyOnboardingState` (WS0c). Real
 * `@armyofagents/db` + `drizzle-orm` imported together trigger an ESM
 * require-cycle crash in this environment's Node version — see
 * server/src/__tests__/helpers/drizzle-mock.ts and
 * backfill-first-run-completed.test.ts, which this mirrors. Mock both at
 * module level and capture the operator call args directly so the WHERE
 * clause's "founder + legacy state + spine-complete" requirement is verified
 * semantically, not just by call shape.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

const { andMock, eqMock, inArrayMock, sqlMock } = vi.hoisted(() => ({
  andMock: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  eqMock: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  inArrayMock: vi.fn((...args: unknown[]) => ({ __op: "inArray", args })),
  sqlMock: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ __op: "sql", strings, values })),
}));

vi.mock("@armyofagents/db", () => ({
  onboardingProgress: makeTableProxy("onboarding_progress"),
}));

vi.mock("drizzle-orm", () => ({
  and: andMock,
  eq: eqMock,
  inArray: inArrayMock,
  sql: sqlMock,
}));

function makeBackfillDb() {
  const whereProxy = { execute: vi.fn().mockResolvedValue(undefined) };
  const setProxy = { where: vi.fn().mockReturnValue(whereProxy) };
  const updateProxy = { set: vi.fn().mockReturnValue(setProxy) };
  const db = { update: vi.fn().mockReturnValue(updateProxy) };
  return { db, updateProxy, setProxy, whereProxy };
}

describe("normalizeLegacyOnboardingState (WS0c)", () => {
  it("calls db.update(onboardingProgress).set().where() exactly once", async () => {
    const { db, updateProxy, setProxy } = makeBackfillDb();

    const { normalizeLegacyOnboardingState } = await import("../migrations/normalize-legacy-onboarding-state.js");

    await normalizeLegacyOnboardingState(db as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateProxy.set).toHaveBeenCalledTimes(1);
    expect(setProxy.where).toHaveBeenCalledTimes(1);
  });

  it("SET payload normalizes to COMMANDER_VERIFIED (never SETUP_COMPLETE) and stamps updatedAt", async () => {
    const { db, updateProxy } = makeBackfillDb();

    const { normalizeLegacyOnboardingState } = await import("../migrations/normalize-legacy-onboarding-state.js");

    await normalizeLegacyOnboardingState(db as any);

    const setArg = updateProxy.set.mock.calls[0][0] as {
      currentState: unknown;
      updatedAt: unknown;
      version: unknown;
    };

    // The whole point of this normalization (design §8, Codex P1) is landing
    // on COMMANDER_VERIFIED, not SETUP_COMPLETE — colliding with the WS0b
    // backfillFirstRunCompleted backfill would silently skip these founders
    // past the new Home first-run experience.
    expect(setArg.currentState).toBe("COMMANDER_VERIFIED");
    expect(setArg.currentState).not.toBe("SETUP_COMPLETE");
    expect(setArg.updatedAt).toBeInstanceOf(Date);
    // version bump goes through the sql`` mock (version + 1), not a raw number.
    expect(setArg.version).toEqual({ __op: "sql", strings: expect.anything(), values: expect.anything() });
  });

  it("resolves without throwing when db resolves undefined", async () => {
    const { db } = makeBackfillDb();

    const { normalizeLegacyOnboardingState } = await import("../migrations/normalize-legacy-onboarding-state.js");

    await expect(normalizeLegacyOnboardingState(db as any)).resolves.toBeUndefined();
  });

  it("WHERE clause is gated on journey='founder' AND currentState IN (DEPARTMENT_CREATED, AGENT_ASSIGNED) AND completedStates containing COMMANDER_VERIFIED", async () => {
    andMock.mockClear();
    eqMock.mockClear();
    inArrayMock.mockClear();
    sqlMock.mockClear();
    const { db } = makeBackfillDb();

    const { normalizeLegacyOnboardingState } = await import("../migrations/normalize-legacy-onboarding-state.js");

    await normalizeLegacyOnboardingState(db as any);

    // eq(journey, "founder") — only the founder journey ever carried these states.
    expect(eqMock).toHaveBeenCalledTimes(1);
    expect(eqMock.mock.calls[0][1]).toBe("founder");

    // inArray(currentState, [DEPARTMENT_CREATED, AGENT_ASSIGNED]) — the two
    // removed legacy states.
    expect(inArrayMock).toHaveBeenCalledTimes(1);
    expect(inArrayMock.mock.calls[0][1]).toEqual(["DEPARTMENT_CREATED", "AGENT_ASSIGNED"]);

    // sql`` is used twice: once for the version+1 bump in SET, once for the
    // completedStates jsonb-containment check in WHERE — the WHERE one is the
    // spine-complete gate and is the second call (SET is built before WHERE).
    expect(sqlMock).toHaveBeenCalledTimes(2);
    const whereGateCallIndex = sqlMock.mock.calls.findIndex((call) =>
      call.slice(1).some((v: unknown) => typeof v === "string" && v.includes("COMMANDER_VERIFIED")),
    );
    expect(whereGateCallIndex).toBeGreaterThanOrEqual(0);

    // and(eqResult, inArrayResult, sqlResult) combines all three predicates.
    expect(andMock).toHaveBeenCalledTimes(1);
    const andArgs = andMock.mock.calls[0];
    expect(andArgs).toContainEqual(eqMock.mock.results[0].value);
    expect(andArgs).toContainEqual(inArrayMock.mock.results[0].value);
    expect(andArgs).toContainEqual(sqlMock.mock.results[whereGateCallIndex].value);
  });
});
