/**
 * Unit tests for `backfillFirstRunCompleted` (WS0b). Real `@armyofagents/db`
 * + `drizzle-orm` imported together (as `backfill-template-origin.ts` does)
 * trigger an ESM require-cycle crash in this environment's Node version — see
 * server/src/__tests__/helpers/drizzle-mock.ts. Mock both at module level and
 * capture the operator call args directly so the WHERE clause's "BOTH
 * representations" requirement is verified semantically, not just by call
 * shape.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTableProxy } from "./helpers/drizzle-mock.js";

const { andMock, orMock, eqMock, isNullMock, sqlMock } = vi.hoisted(() => ({
  andMock: vi.fn((...args: unknown[]) => ({ __op: "and", args })),
  orMock: vi.fn((...args: unknown[]) => ({ __op: "or", args })),
  eqMock: vi.fn((...args: unknown[]) => ({ __op: "eq", args })),
  isNullMock: vi.fn((...args: unknown[]) => ({ __op: "isNull", args })),
  sqlMock: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ __op: "sql", strings, values })),
}));

vi.mock("@armyofagents/db", () => ({
  onboardingProgress: makeTableProxy("onboarding_progress"),
}));

vi.mock("drizzle-orm", () => ({
  and: andMock,
  or: orMock,
  eq: eqMock,
  isNull: isNullMock,
  sql: sqlMock,
}));

function makeBackfillDb() {
  const whereProxy = { execute: vi.fn().mockResolvedValue(undefined) };
  const setProxy = { where: vi.fn().mockReturnValue(whereProxy) };
  const updateProxy = { set: vi.fn().mockReturnValue(setProxy) };
  const db = { update: vi.fn().mockReturnValue(updateProxy) };
  return { db, updateProxy, setProxy, whereProxy };
}

describe("backfillFirstRunCompleted (WS0b)", () => {
  it("calls db.update(onboardingProgress).set().where() exactly once", async () => {
    const { db, updateProxy, setProxy } = makeBackfillDb();

    const { backfillFirstRunCompleted } = await import("../migrations/backfill-first-run-completed.js");

    await backfillFirstRunCompleted(db as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateProxy.set).toHaveBeenCalledTimes(1);
    expect(setProxy.where).toHaveBeenCalledTimes(1);
  });

  it("SET payload stamps firstRunCompletedAt and updatedAt with Date instances", async () => {
    const { db, updateProxy } = makeBackfillDb();

    const { backfillFirstRunCompleted } = await import("../migrations/backfill-first-run-completed.js");

    await backfillFirstRunCompleted(db as any);

    const setArg = updateProxy.set.mock.calls[0][0] as {
      firstRunCompletedAt: unknown;
      updatedAt: unknown;
    };

    expect(setArg.firstRunCompletedAt).toBeInstanceOf(Date);
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it("resolves without throwing when db resolves undefined", async () => {
    const { db } = makeBackfillDb();

    const { backfillFirstRunCompleted } = await import("../migrations/backfill-first-run-completed.js");

    await expect(backfillFirstRunCompleted(db as any)).resolves.toBeUndefined();
  });

  it("WHERE clause gates on firstRunCompletedAt IS NULL AND completedStates containing BOTH AGENT_ASSIGNED and SETUP_COMPLETE (QA-BUG-4: legacy-only, not new-flow spine)", async () => {
    andMock.mockClear();
    orMock.mockClear();
    eqMock.mockClear();
    isNullMock.mockClear();
    sqlMock.mockClear();
    const { db } = makeBackfillDb();

    const { backfillFirstRunCompleted } = await import("../migrations/backfill-first-run-completed.js");

    await backfillFirstRunCompleted(db as any);

    // isNull(firstRunCompletedAt) — the "not already stamped" gate.
    expect(isNullMock).toHaveBeenCalledTimes(1);

    // The legacy-completion signal is a single containment check on completedStates:
    // it must include BOTH AGENT_ASSIGNED (only the old 8-step flow produced it)
    // AND SETUP_COMPLETE. New-flow founders reach SETUP_COMPLETE WITHOUT
    // AGENT_ASSIGNED, so they must NOT match. No eq()/or() any more.
    expect(sqlMock).toHaveBeenCalledTimes(1);
    const sqlValues = sqlMock.mock.calls[0].slice(1) as unknown[];
    const jsonArg = sqlValues.find((v) => typeof v === "string" && v.includes("AGENT_ASSIGNED")) as string | undefined;
    expect(jsonArg).toBeDefined();
    expect(jsonArg).toContain("AGENT_ASSIGNED");
    expect(jsonArg).toContain("SETUP_COMPLETE");

    // No OR / no eq — the old two-representation SETUP_COMPLETE-only match is gone.
    expect(orMock).not.toHaveBeenCalled();
    expect(eqMock).not.toHaveBeenCalled();

    // and(isNullResult, sqlResult) is the final WHERE predicate.
    expect(andMock).toHaveBeenCalledTimes(1);
    const andArgs = andMock.mock.calls[0];
    expect(andArgs).toContainEqual(isNullMock.mock.results[0].value);
    expect(andArgs).toContainEqual(sqlMock.mock.results[0].value);
  });
});
