/**
 * Shared drizzle-orm + @armyofagents/db mock helpers for server tests.
 *
 * Why this exists: importing real schema or real drizzle-orm into Vitest
 * triggers an ESM circular-dependency warning that resolves into runtime
 * `undefined` values. Tests work around this by Proxy-ing every accessed
 * column to a fresh Symbol and stubbing operators as plain strings. This
 * file extracts that pattern so every test gets the same shape.
 *
 * Usage in a test file:
 *
 *   vi.mock("@armyofagents/db", async () => ({
 *     memoryItems: makeTableProxy("memory_items"),
 *     issues: makeTableProxy("issues"),
 *   }));
 *   vi.mock("drizzle-orm", () => drizzleOperatorStubs());
 */

export function makeTableProxy(name: string): Record<string, unknown> {
  const cols: Record<string, symbol> = {};
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "_") return { name };
      if (prop === "$inferSelect" || prop === "$inferInsert") return {};
      if (typeof prop === "string") {
        if (!cols[prop]) cols[prop] = Symbol(prop);
        return cols[prop];
      }
      return undefined;
    },
  });
}

type OperatorStubs = {
  and: (...args: unknown[]) => string;
  or: (...args: unknown[]) => string;
  eq: (...args: unknown[]) => string;
  ne: (...args: unknown[]) => string;
  isNull: (...args: unknown[]) => string;
  isNotNull: (...args: unknown[]) => string;
  inArray: (...args: unknown[]) => string;
  notInArray: (...args: unknown[]) => string;
  gt: (...args: unknown[]) => string;
  gte: (...args: unknown[]) => string;
  lt: (...args: unknown[]) => string;
  lte: (...args: unknown[]) => string;
  like: (...args: unknown[]) => string;
  ilike: (...args: unknown[]) => string;
  desc: (...args: unknown[]) => string;
  asc: (...args: unknown[]) => string;
  count: (...args: unknown[]) => string;
  sql: unknown;
};

/** Sentinel object returned by the sql proxy when used as a tagged template or called. */
const SQL_SENTINEL = {
  as: (_alias: string) => SQL_SENTINEL,
  join: () => SQL_SENTINEL,
  raw: (_s: string) => SQL_SENTINEL,
  sql: "sql",
  toString: () => "sql",
};

export function drizzleOperatorStubs(): OperatorStubs {
  // The sql proxy needs to handle four call patterns:
  //   1. sql`template string`     — tagged template (apply trap)
  //   2. sql`template`.as("name") — chained .as() on tagged template result
  //   3. sql.join(arr, sep)       — static method call
  //   4. sql.raw(str)             — static method call
  // All return SQL_SENTINEL or a function that returns SQL_SENTINEL so
  // callers can chain further without errors.
  const sqlProxy: unknown = new Proxy(
    Object.assign(
      function sqlFn(..._args: unknown[]) {
        return SQL_SENTINEL;
      },
      {
        join: (..._args: unknown[]) => SQL_SENTINEL,
        raw: (_s: string) => SQL_SENTINEL,
      },
    ),
    {
      get(target: Record<string, unknown>, prop: string | symbol) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        // Any other property access (e.g. Symbol.toPrimitive) returns a no-op
        return () => SQL_SENTINEL;
      },
      apply(_target: unknown, _thisArg: unknown, _args: unknown[]) {
        return SQL_SENTINEL;
      },
    },
  );
  return {
    and: () => "and",
    or: () => "or",
    eq: () => "eq",
    ne: () => "ne",
    isNull: () => "isNull",
    isNotNull: () => "isNotNull",
    inArray: () => "inArray",
    notInArray: () => "notInArray",
    gt: () => "gt",
    gte: () => "gte",
    lt: () => "lt",
    lte: () => "lte",
    like: () => "like",
    ilike: () => "ilike",
    desc: () => "desc",
    asc: () => "asc",
    count: () => "count",
    sql: sqlProxy,
  };
}

// NOTE: a generic `createSequenceDb`/`createExtendedSequenceDb` helper was
// previously exported from this file but had zero consumers — every test that
// needs sequence-DB scaffolding declares its own local function tuned to its
// service-under-test (e.g. `setCalls` tracking in embedding-retry-persistence,
// `captured.insertValues` in memory-suggestions, scoped `tx` in routines-
// service). The exports were deleted as part of the residual-cleanup review;
// see commit history. If a future test wants a shared sequence-DB pattern,
// extract one only after multiple call-sites converge on a real shape.

/**
 * Vitest mock factory for the db-capabilities module. Use it like:
 *
 *   vi.mock("../services/db-capabilities.js", () => mockDbCapabilities());
 *   // or to test the no-vector path:
 *   vi.mock("../services/db-capabilities.js", () => mockDbCapabilities({ hasVectorSupport: false }));
 *
 * `getDbCapabilities()` returns `{ hasVectorSupport: false }` by default in
 * production until `probeDbCapabilities()` runs against a live DB. Tests that
 * exercise embedding/semantic-search paths must override this.
 */
export function mockDbCapabilities(overrides: { hasVectorSupport?: boolean } = {}) {
  const caps = { hasVectorSupport: true, ...overrides };
  return {
    getDbCapabilities: () => caps,
    setDbCapabilities: () => {},
    probeDbCapabilities: () => Promise.resolve(caps),
  };
}
