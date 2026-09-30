import { describe, it, expect, vi } from "vitest";
import type { AdapterEnvironmentCheck } from "@armyofagents/shared";
import {
  isStale,
  selectInUseProviders,
  redactChecks,
  recordReadiness,
  readReadiness,
  readReadinessForScope,
  READINESS_STALE_MS,
} from "../services/providers/readiness.js";

/* ─── Pure helpers ─────────────────────────────────────────────────────── */

describe("readiness staleness", () => {
  it("is stale when older than the threshold", () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    expect(isStale(old, 5 * 60_000)).toBe(true);
  });
  it("is fresh inside the threshold", () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(isStale(recent, 5 * 60_000)).toBe(false);
  });
  it("treats a missing timestamp as stale", () => {
    expect(isStale(null, 5 * 60_000)).toBe(true);
  });
  it("treats an unparseable timestamp as stale", () => {
    expect(isStale("not-a-date", 5 * 60_000)).toBe(true);
  });
  it("accepts a Date as well as an ISO string", () => {
    expect(isStale(new Date(), READINESS_STALE_MS)).toBe(false);
  });
  // A future timestamp (clock skew, restored backup) would otherwise pin a
  // provider "fresh" forever, since `now - t` stays negative.
  it("treats a FUTURE timestamp as stale, not permanently fresh", () => {
    const future = new Date(Date.now() + 10 * 365 * 24 * 3600_000).toISOString();
    expect(isStale(future, 5 * 60_000)).toBe(true);
  });
  it("pins the at-threshold boundary as fresh (exclusive comparison)", () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(isStale(new Date(now - 5 * 60_000).toISOString(), 5 * 60_000)).toBe(false);
      expect(isStale(new Date(now - 5 * 60_000 - 1).toISOString(), 5 * 60_000)).toBe(true);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });
});

describe("in-use provider selection", () => {
  it("includes Commander's adapter and every live agent adapter", () => {
    const ids = selectInUseProviders({
      commanderAdapterType: "claude_local",
      agentAdapterTypes: ["codex_local", "codex_local", "gemini_local"],
    });
    expect(ids.sort()).toEqual(["anthropic", "google", "openai"]);
  });
  it("ignores adapters with no catalog entry", () => {
    const ids = selectInUseProviders({
      commanderAdapterType: "claude_local",
      agentAdapterTypes: ["process", "http"],
    });
    expect(ids).toEqual(["anthropic"]);
  });
  it("returns nothing when there is no Commander adapter and no agents", () => {
    expect(
      selectInUseProviders({ commanderAdapterType: null, agentAdapterTypes: [] }),
    ).toEqual([]);
  });
});

/* ─── Redaction ────────────────────────────────────────────────────────── */

const SECRETY_CHECKS: AdapterEnvironmentCheck[] = [
  {
    code: "claude_local_auth_required",
    level: "error",
    message: "auth failed for sk-ant-abcdefghijklmnop1234567890",
    detail: "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop1234567890",
    hint: "rotate ghp_abcdefghijklmnopqrstuvwxyz012345",
  },
];

describe("redactChecks", () => {
  it("redacts credential material out of message, detail and hint", () => {
    const [c] = redactChecks(SECRETY_CHECKS);
    expect(c.message).not.toContain("sk-ant-");
    expect(c.hint).not.toContain("ghp_");
    expect((c as { detail?: string }).detail).not.toContain("sk-ant-");
    // Non-secret structure survives.
    expect(c.code).toBe("claude_local_auth_required");
    expect(c.level).toBe("error");
  });

  it("leaves innocuous text intact", () => {
    const [c] = redactChecks([
      { code: "x_hello_probe_passed", level: "info", message: "hello ok" },
    ]);
    expect(c.message).toBe("hello ok");
  });
});

/* ─── Write path ───────────────────────────────────────────────────────── */

function createInsertSpyDb() {
  const values = vi.fn(() => ({
    onConflictDoUpdate: vi.fn(() => ({
      returning: vi.fn(async () => [{ id: "row-1" }]),
    })),
  }));
  const db = { insert: vi.fn(() => ({ values })) };
  return { db: db as never, values, insert: db.insert };
}

describe("recordReadiness — persisted payload", () => {
  const base = {
    companyId: "11111111-1111-4111-8111-111111111111",
    providerId: "anthropic" as const,
    outcome: "needs_auth" as const,
    testedByUserId: null,
  };

  it("REDACTS checks before they reach the database", async () => {
    const { db, values } = createInsertSpyDb();
    await recordReadiness(db, {
      ...base,
      scope: { type: "company_default" },
      checks: SECRETY_CHECKS,
    });

    expect(values).toHaveBeenCalledTimes(1);
    const persisted = JSON.stringify(values.mock.calls[0]![0]);
    // The cache ROW itself must be clean — not merely the HTTP response.
    expect(persisted).not.toContain("sk-ant-abcdefghijklmnop1234567890");
    expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(persisted).toContain("REDACTED");
  });

  it("does not mutate the caller's checks array", async () => {
    const { db } = createInsertSpyDb();
    const input: AdapterEnvironmentCheck[] = [
      { ...SECRETY_CHECKS[0]! },
    ];
    await recordReadiness(db, {
      ...base,
      scope: { type: "company_default" },
      checks: input,
    });
    expect(input[0]!.message).toContain("sk-ant-");
  });

  it("writes a company_default row with a null scopeId", async () => {
    const { db, values } = createInsertSpyDb();
    await recordReadiness(db, {
      ...base,
      scope: { type: "company_default" },
      checks: [],
    });
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.scopeType).toBe("company_default");
    expect(row.scopeId).toBeNull();
  });

  it("writes an agent-scoped row carrying the agent id", async () => {
    const { db, values } = createInsertSpyDb();
    await recordReadiness(db, {
      ...base,
      scope: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
      checks: [],
    });
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.scopeType).toBe("agent");
    expect(row.scopeId).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("recordReadiness — validation", () => {
  const base = {
    companyId: "11111111-1111-4111-8111-111111111111",
    providerId: "anthropic" as const,
    scope: { type: "company_default" } as const,
    checks: [],
    testedByUserId: null,
  };

  // The drizzle `enum` on a text column is a TYPESCRIPT-only constraint: it
  // emits no DB CHECK, so Postgres would happily persist "ready". This service
  // is the only thing standing between a typo and a permanently wrong cache.
  it("rejects an outcome outside PROBE_OUTCOMES", async () => {
    const { db, insert } = createInsertSpyDb();
    await expect(
      recordReadiness(db, { ...base, outcome: "ready" as never }),
    ).rejects.toThrow(/outcome/i);
    expect(insert).not.toHaveBeenCalled();
  });

  it("accepts every declared outcome", async () => {
    for (const outcome of [
      "verified",
      "needs_auth",
      "not_installed",
      "failed",
      "unknown",
      "unverifiable",
    ] as const) {
      const { db } = createInsertSpyDb();
      await expect(
        recordReadiness(db, { ...base, outcome }),
      ).resolves.toBeDefined();
    }
  });

  it("rejects a providerId with no catalog entry", async () => {
    const { db, insert } = createInsertSpyDb();
    await expect(
      recordReadiness(db, {
        ...base,
        outcome: "verified",
        providerId: "claude_local" as never,
      }),
    ).rejects.toThrow(/provider/i);
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects an agent scope with no agent id (the DB CHECK shape)", async () => {
    const { db, insert } = createInsertSpyDb();
    await expect(
      recordReadiness(db, {
        ...base,
        outcome: "verified",
        scope: { type: "agent", agentId: "" } as never,
      }),
    ).rejects.toThrow(/scope/i);
    expect(insert).not.toHaveBeenCalled();
  });
});

/* ─── Read path ────────────────────────────────────────────────────────── */

/**
 * Render a drizzle predicate as readable SQL-ish text so tests can assert WHICH
 * column is filtered, not merely that `where()` was called.
 *
 * Asserting the call count alone is worthless here: a mutation filtering on
 * `providerId` instead of `companyId` — a cross-tenant read — passes a
 * `toHaveBeenCalledTimes(1)` check untouched.
 */
function flattenPredicate(node: any): string {
  if (!node) return "";
  if (Array.isArray(node.queryChunks)) return node.queryChunks.map(flattenPredicate).join("");
  if (Array.isArray(node.value) && node.value.every((v: any) => typeof v === "string")) {
    return node.value.join("");
  }
  if (typeof node.name === "string" && node.table) return node.name;
  if ("value" in node) return JSON.stringify(node.value);
  return "";
}

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const AGENT_A = "22222222-2222-4222-8222-222222222222";

describe("readReadiness", () => {
  it("filters on COMPANY_ID — the tenant boundary", async () => {
    const rows = [{ id: "a", providerId: "anthropic" }];
    const where = vi.fn(async () => rows);
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) } as never;

    await expect(readReadiness(db, COMPANY_A)).resolves.toEqual(rows);

    const predicate = flattenPredicate(where.mock.calls[0]![0]);
    expect(predicate).toContain("company_id");
    expect(predicate).toContain(COMPANY_A);
    // Cross-tenant guard: a read must never be keyed on provider alone.
    expect(predicate).toMatch(/company_id\s*=/);
  });
});

describe("readReadinessForScope", () => {
  function createScopedReadDb(rows: unknown[]) {
    const limit = vi.fn(async () => rows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const db = { select: vi.fn(() => ({ from })) };
    return { db: db as never, where };
  }

  /**
   * Predicate-aware mock: serves a row ONLY for the company_default query.
   * A flat "always return []" mock cannot detect a fallback — the implementation
   * could quietly re-query for the default and the test would still see
   * undefined. This makes the fallback observable.
   */
  function createFallbackTrapDb(defaultRow: unknown) {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn((predicate: unknown) => ({
            limit: vi.fn(async () =>
              flattenPredicate(predicate).includes("scope_id is null") ? [defaultRow] : [],
            ),
          })),
        })),
      })),
    };
    return db as never;
  }

  it("keys a company_default read on scope_id IS NULL", async () => {
    const { db, where } = createScopedReadDb([{ id: "d" }]);
    await readReadinessForScope(db, COMPANY_A, "anthropic", { type: "company_default" });

    const p = flattenPredicate(where.mock.calls[0]![0]);
    expect(p).toContain("company_id");
    expect(p).toContain(COMPANY_A);
    expect(p).toContain("provider_id");
    expect(p).toContain("company_default");
    expect(p).toContain("scope_id is null");
  });

  it("keys an agent read on that agent's id", async () => {
    const { db, where } = createScopedReadDb([{ id: "a" }]);
    await readReadinessForScope(db, COMPANY_A, "anthropic", {
      type: "agent",
      agentId: AGENT_A,
    });

    const p = flattenPredicate(where.mock.calls[0]![0]);
    expect(p).toContain("scope_type");
    expect(p).toContain(JSON.stringify("agent"));
    expect(p).toContain(AGENT_A);
    expect(p).not.toContain("scope_id is null");
  });

  /**
   * THE invariant. An agent's own env binding wins over the company default, so
   * falling back would render "Ready" from the company key while that agent
   * 401s on its own revoked binding — the exact false-green this table exists
   * to prevent. Unprobed must be undefined, and undefined must render unknown.
   */
  it("returns undefined for an unprobed agent rather than the company default", async () => {
    // A verified company_default row EXISTS and is reachable — the trap db
    // serves it to any query keyed on `scope_id is null`. Falling back to it
    // is the failure mode; `undefined` is the contract.
    const db = createFallbackTrapDb({ id: "company-default-row", outcome: "verified" });
    const row = await readReadinessForScope(db, COMPANY_A, "anthropic", {
      type: "agent",
      agentId: AGENT_A,
    });
    expect(row).toBeUndefined();
  });
});
