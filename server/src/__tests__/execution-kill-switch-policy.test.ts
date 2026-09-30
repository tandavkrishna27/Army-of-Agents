/**
 * REL-004 Lane C (D4/I2/I4) — reading the kill-switch policy on the aoa_app pool.
 *
 * The property under test is the one that decides whether a kill switch is a safety device or
 * a hazard: **a failed read is not an absent document.**
 *
 * "No policy has ever been set" is the steady state of every fresh install and must not stop
 * work. "I could not load the policy" is precisely the situation a kill switch exists for. If
 * the reader collapses the second into the first — `catch { return undefined }` — then a
 * database blip silently re-permits a killed provider, and nothing in the system notices.
 *
 * The two are kept apart by a sentinel that is deliberately NOT a plain object, so
 * `evaluateKillSwitches` refuses it through its single unreadable path rather than through a
 * second hand-written verdict at the call site.
 */

import { describe, expect, it, vi } from "vitest";

import {
  KILL_SWITCH_POLICY_UNREADABLE,
  createKillSwitchPolicyReader,
} from "../services/execution-kill-switch-policy.js";
import { evaluateKillSwitches } from "../services/execution-kill-switches.js";

vi.mock("../middleware/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const KNOWN = ["desktop", "dedicated_worker", "e2b", "local_host", "pooled_gvisor"];

/** A minimal drizzle-shaped stub: `.select().from().where().limit()`. */
function dbReturning(rows: unknown[] | (() => never)) {
  const where = vi.fn(() => ({
    limit: async () => (typeof rows === "function" ? rows() : rows),
  }));
  const stub = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })), where } as never;
  return stub as never & { where: typeof where };
}

describe("REL-004 Lane C/I2 — an absent document permits", () => {
  it("maps a MISSING singleton row to an absent document", async () => {
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([]) });
    expect(await reader.read()).toBeUndefined();
  });

  it("maps a NULL column to an absent document", async () => {
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([{ killSwitches: null }]) });
    expect(await reader.read()).toBeUndefined();
  });

  it("feeds through to a PERMIT verdict — a fresh install is not a stopped fleet", async () => {
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([]) });
    expect(evaluateKillSwitches({
      document: await reader.read(), provider: "e2b", template: undefined, knownProviders: KNOWN,
    })).toEqual({ killed: false });
  });
});

describe("REL-004 Lane C — the stored document is returned verbatim", () => {
  it("returns the jsonb value untouched", async () => {
    const document = { schema: 1, switches: [{ dimension: "provider", value: "e2b", reason: "x" }] };
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([{ killSwitches: document }]) });
    expect(await reader.read()).toEqual(document);
  });

  it("does not repair a document it cannot understand — that is the evaluator's job", async () => {
    // A `{}` (the shape a column DEFAULT would have produced) must reach the evaluator as `{}`
    // and be REFUSED there, not silently normalized here into an absent document.
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([{ killSwitches: {} }]) });
    const document = await reader.read();
    expect(document).toEqual({});
    expect(evaluateKillSwitches({
      document, provider: "e2b", template: undefined, knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: null, value: null, reason: "policy_unreadable" });
  });

  it("reads the DEFAULT singleton row, not merely the first row it finds", async () => {
    const db = dbReturning([{ killSwitches: null }]);
    await createKillSwitchPolicyReader({ appDb: db }).read();
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(db.where.mock.calls[0]![0]).toBeDefined();
  });
});

describe("REL-004 Lane C/I4 — a failed read is NOT an absent document", () => {
  it("maps a read failure to the unreadable sentinel", async () => {
    const reader = createKillSwitchPolicyReader({
      appDb: dbReturning(() => { throw new Error("connection reset"); }),
    });
    // Identity, not merely "some falsy thing": a mutant returning `{}` would still produce a
    // policy_unreadable verdict below, so only the identity assertion pins the sentinel.
    expect(await reader.read()).toBe(KILL_SWITCH_POLICY_UNREADABLE);
  });

  it("never rejects — a leasing path must get a value, not an exception", async () => {
    const reader = createKillSwitchPolicyReader({
      appDb: dbReturning(() => { throw new Error("connection reset"); }),
    });
    await expect(reader.read()).resolves.toBeDefined();
  });

  it("the sentinel is refused by the ONE unreadable path in the decision function", async () => {
    expect(evaluateKillSwitches({
      document: KILL_SWITCH_POLICY_UNREADABLE,
      provider: "e2b",
      template: undefined,
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: null, value: null, reason: "policy_unreadable" });
  });

  it("the sentinel is not a plain object, so it can never be read as a document", () => {
    // This is the structural reason the sentinel works. If it were ever changed to an object,
    // `isPlainObject` would accept it and the schema check would decide the verdict instead.
    expect(typeof KILL_SWITCH_POLICY_UNREADABLE).toBe("symbol");
  });
});
