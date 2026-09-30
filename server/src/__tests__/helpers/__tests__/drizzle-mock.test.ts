import { describe, it, expect } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "../drizzle-mock.js";

describe("makeTableProxy", () => {
  it("returns a stable symbol per column accessed", () => {
    const t = makeTableProxy("users");
    expect(t.id).toBe(t.id);
    expect(t.email).toBe(t.email);
    expect(t.id).not.toBe(t.email);
  });

  it("exposes the table name on the underscore key (drizzle convention)", () => {
    const t = makeTableProxy("users");
    expect((t as unknown as { _: { name: string } })._.name).toBe("users");
  });

  it("returns an empty object for $inferSelect / $inferInsert", () => {
    const t = makeTableProxy("users");
    expect((t as unknown as { $inferSelect: object }).$inferSelect).toEqual({});
    expect((t as unknown as { $inferInsert: object }).$inferInsert).toEqual({});
  });
});

describe("drizzleOperatorStubs", () => {
  it("returns string sentinels for and/eq/isNull/inArray/desc/asc", () => {
    const ops = drizzleOperatorStubs();
    expect(ops.and()).toBe("and");
    expect(ops.eq()).toBe("eq");
    expect(ops.isNull()).toBe("isNull");
    expect(ops.inArray()).toBe("inArray");
    expect(ops.desc()).toBe("desc");
    expect(ops.asc()).toBe("asc");
  });

  it("returns a string sentinel for count", () => {
    const ops = drizzleOperatorStubs();
    expect(ops.count()).toBe("count");
  });

  it("sql call-form and tagged-template form both return a non-crashing sentinel", () => {
    const ops = drizzleOperatorStubs();
    const sqlFn = ops.sql as unknown as (...args: unknown[]) => { as: (...args: unknown[]) => unknown };
    // Call form
    const callResult = sqlFn();
    expect(callResult).toBeDefined();
    // Tagged template form
    const tagResult = (ops.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => { as: (...args: unknown[]) => unknown })`SELECT 1`;
    expect(tagResult).toBeDefined();
  });

  it("sql result supports .as() chaining without throwing", () => {
    const ops = drizzleOperatorStubs();
    const sqlFn = ops.sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => { as: (alias: string) => unknown };
    const result = sqlFn`some expression`.as("myAlias");
    expect(result).toBeDefined();
  });

  it("sql.join() does not throw", () => {
    const ops = drizzleOperatorStubs();
    const sqlWithJoin = ops.sql as unknown as { join: (...args: unknown[]) => unknown };
    const result = sqlWithJoin.join(["a", "b", "c"], ", ");
    expect(result).toBeDefined();
  });

  it("sql.raw() does not throw", () => {
    const ops = drizzleOperatorStubs();
    const sqlWithRaw = ops.sql as unknown as { raw: (s: string) => unknown };
    const result = sqlWithRaw.raw("SELECT 1");
    expect(result).toBeDefined();
  });
});

describe("mockDbCapabilities", () => {
  it("defaults to hasVectorSupport: true", () => {
    const { getDbCapabilities } = mockDbCapabilities();
    expect(getDbCapabilities().hasVectorSupport).toBe(true);
  });

  it("respects overrides", () => {
    const { getDbCapabilities } = mockDbCapabilities({ hasVectorSupport: false });
    expect(getDbCapabilities().hasVectorSupport).toBe(false);
  });

  it("provides probeDbCapabilities and setDbCapabilities stubs", () => {
    const m = mockDbCapabilities();
    expect(typeof m.probeDbCapabilities).toBe("function");
    expect(typeof m.setDbCapabilities).toBe("function");
  });
});
