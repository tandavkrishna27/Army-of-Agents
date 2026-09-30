import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { assertBoard } from "../routes/authz.js";

function reqWithActor(actor: unknown): Request {
  return { actor } as unknown as Request;
}

function statusOfThrow(fn: () => void): number | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { status?: number }).status;
  }
  throw new Error("expected the call to throw, but it did not");
}

describe("assertBoard — 401 for unauthenticated, 403 for authenticated non-board (R9a)", () => {
  it("throws 401 (unauthorized) when there is no authenticated actor (type 'none')", () => {
    expect(statusOfThrow(() => assertBoard(reqWithActor({ type: "none" })))).toBe(401);
  });

  it("throws 403 (forbidden) for an authenticated non-board actor (agent)", () => {
    expect(statusOfThrow(() => assertBoard(reqWithActor({ type: "agent", companyId: "c1" })))).toBe(403);
  });

  it("throws 403 (forbidden) for an authenticated non-board actor (mcp)", () => {
    expect(statusOfThrow(() => assertBoard(reqWithActor({ type: "mcp", companyId: "c1" })))).toBe(403);
  });

  it("passes for a board actor", () => {
    expect(() => assertBoard(reqWithActor({ type: "board" }))).not.toThrow();
  });
});
