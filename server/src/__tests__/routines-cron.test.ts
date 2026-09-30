import { describe, expect, it } from "vitest";
import { parseCron, validateCron, nextCronTick, nextCronTickFromExpression } from "../services/cron.js";

describe("parseCron", () => {
  it("parses a wildcard expression correctly", () => {
    const parsed = parseCron("* * * * *");
    expect(parsed.minutes).toHaveLength(60);
    expect(parsed.hours).toHaveLength(24);
    expect(parsed.daysOfMonth).toHaveLength(31);
    expect(parsed.months).toHaveLength(12);
    expect(parsed.daysOfWeek).toHaveLength(7);
  });

  it("parses exact values", () => {
    const parsed = parseCron("30 10 15 6 3");
    expect(parsed.minutes).toEqual([30]);
    expect(parsed.hours).toEqual([10]);
    expect(parsed.daysOfMonth).toEqual([15]);
    expect(parsed.months).toEqual([6]);
    expect(parsed.daysOfWeek).toEqual([3]);
  });

  it("parses range fields", () => {
    const parsed = parseCron("0 9-17 * * 1-5");
    expect(parsed.minutes).toEqual([0]);
    expect(parsed.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(parsed.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses step fields", () => {
    const parsed = parseCron("*/15 * * * *");
    expect(parsed.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses comma-separated lists", () => {
    const parsed = parseCron("0 0,12 * * *");
    expect(parsed.hours).toEqual([0, 12]);
  });

  it("parses range with step", () => {
    const parsed = parseCron("0 8-18/2 * * *");
    expect(parsed.hours).toEqual([8, 10, 12, 14, 16, 18]);
  });

  it("throws on wrong field count", () => {
    expect(() => parseCron("* * * *")).toThrow();
    expect(() => parseCron("* * * * * *")).toThrow();
  });

  it("throws on out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 24 * * *")).toThrow();
    expect(() => parseCron("* * 0 * *")).toThrow();
    expect(() => parseCron("* * * 13 *")).toThrow();
    expect(() => parseCron("* * * * 7")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseCron("")).toThrow();
  });
});

describe("validateCron", () => {
  it("returns true for valid expressions", () => {
    expect(validateCron("* * * * *")).toBeNull();
    expect(validateCron("0 10 * * 1-5")).toBeNull();
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("0 0 1 * *")).toBeNull();
  });

  it("returns an error string for invalid expressions", () => {
    expect(typeof validateCron("")).toBe("string");
    expect(typeof validateCron("not a cron")).toBe("string");
    expect(typeof validateCron("60 * * * *")).toBe("string");
    expect(typeof validateCron("* * * *")).toBe("string");
  });
});

describe("nextCronTick", () => {
  it("returns the next minute on * * * * *", () => {
    const after = new Date("2026-03-31T10:05:00.000Z");
    const parsed = parseCron("* * * * *");
    const next = nextCronTick(parsed, after);
    expect(next).toEqual(new Date("2026-03-31T10:06:00.000Z"));
  });

  it("returns the next daily run at 10:00 UTC", () => {
    const after = new Date("2026-03-31T08:00:00.000Z");
    const parsed = parseCron("0 10 * * *");
    const next = nextCronTick(parsed, after);
    expect(next).toEqual(new Date("2026-03-31T10:00:00.000Z"));
  });

  it("rolls over to the next day when today's slot has passed", () => {
    const after = new Date("2026-03-31T11:00:00.000Z");
    const parsed = parseCron("0 10 * * *");
    const next = nextCronTick(parsed, after);
    expect(next).toEqual(new Date("2026-04-01T10:00:00.000Z"));
  });

  it("finds next weekday slot correctly (skips Saturday)", () => {
    // 2026-04-04 is a Saturday
    const after = new Date("2026-04-04T10:01:00.000Z");
    const parsed = parseCron("0 10 * * 1-5");
    const next = nextCronTick(parsed, after);
    // Next weekday is Monday 2026-04-06
    expect(next).toEqual(new Date("2026-04-06T10:00:00.000Z"));
  });

  it("returns null for an expression that never fires (invalid month/dom combo)", () => {
    // Feb 31 — never fires
    const after = new Date("2026-01-01T00:00:00.000Z");
    const parsed = parseCron("0 10 31 2 *");
    const next = nextCronTick(parsed, after);
    expect(next).toBeNull();
  });

  it("handles every-hour step correctly", () => {
    const after = new Date("2026-03-31T10:05:00.000Z");
    const parsed = parseCron("0 * * * *");
    const next = nextCronTick(parsed, after);
    expect(next).toEqual(new Date("2026-03-31T11:00:00.000Z"));
  });
});

describe("nextCronTickFromExpression", () => {
  it("is a convenience wrapper around parseCron + nextCronTick", () => {
    const after = new Date("2026-03-31T08:00:00.000Z");
    const next = nextCronTickFromExpression("0 10 * * *", after);
    expect(next).toEqual(new Date("2026-03-31T10:00:00.000Z"));
  });

  it("throws on an invalid expression", () => {
    expect(() => nextCronTickFromExpression("not valid", new Date())).toThrow();
  });
});
