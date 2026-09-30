import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../services/db-errors.js";

describe("isUniqueViolation", () => {
  it("detects 23505 on err.code", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("detects 23505 on err.cause.code (drizzle-wrapped)", () => {
    const inner = Object.assign(new Error("dup"), { code: "23505" });
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("returns false for non-unique errors (e.g. 23503 FK violation)", () => {
    const err = Object.assign(new Error("fk"), { code: "23503" });
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("returns false for plain errors with no code", () => {
    expect(isUniqueViolation(new Error("plain"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("string")).toBe(false);
    expect(isUniqueViolation(42)).toBe(false);
  });

  it("matches a specific constraint name when provided", () => {
    const err = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "team_members_one_lead_uq",
    });
    expect(isUniqueViolation(err, "team_members_one_lead_uq")).toBe(true);
    expect(isUniqueViolation(err, "different_constraint")).toBe(false);
  });

  it("matches constraint on err.cause when provided (drizzle-wrapped)", () => {
    const inner = Object.assign(new Error("dup"), {
      code: "23505",
      constraint: "team_coordinations_one_published_uq",
    });
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner });
    expect(
      isUniqueViolation(wrapped, "team_coordinations_one_published_uq"),
    ).toBe(true);
  });

  it("falls back to true when constraint is undefined and code matches", () => {
    const err = Object.assign(new Error("dup"), { code: "23505" });
    expect(isUniqueViolation(err)).toBe(true);
    expect(isUniqueViolation(err, undefined)).toBe(true);
  });

  it("matches a specific constraint via `constraint_name` (postgres-js shape)", () => {
    // postgres-js emits `constraint_name`, NOT `constraint`. This is the REAL
    // production shape; without it the #197 action-gate convergence is dead code.
    const err = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "discussion_entries_source_action_uq",
    });
    expect(isUniqueViolation(err, "discussion_entries_source_action_uq")).toBe(true);
    expect(isUniqueViolation(err, "other_uq")).toBe(false);
  });

  it("matches `constraint_name` on err.cause (drizzle-wrapped postgres-js shape)", () => {
    const inner = Object.assign(new Error("dup"), {
      code: "23505",
      constraint_name: "artifacts_source_action_uq",
    });
    const wrapped = Object.assign(new Error("wrapped"), { cause: inner });
    expect(isUniqueViolation(wrapped, "artifacts_source_action_uq")).toBe(true);
  });
});
