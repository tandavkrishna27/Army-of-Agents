import { describe, expect, it, vi } from "vitest";

/**
 * Phase 1 Phase E batch 3 (T24): contract tests for the new intent/phase/
 * participant filters on the global search service.
 *
 * The existing `search.test.ts` mocks `drizzle-orm` and `@armyofagents/db` to
 * skip the ESM cycle issue (see project `docs/STANDARDS.md`). We reuse the
 * same approach here but tighten the mocks so we can spy on which SQL fragments
 * the service builds — that's how we verify a filter was actually translated
 * into a WHERE clause.
 */

const sqlCallStack: Array<{ strings: TemplateStringsArray | unknown; values: unknown[] }> = [];

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => {
      sqlCallStack.push({ strings, values });
      return { strings, values };
    }),
    {
      join: vi.fn((values: unknown[]) => values),
    },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  userRoles: {
    role: "role",
    projectId: "project_id",
    companyId: "company_id",
    userId: "user_id",
  },
}));

import { searchService } from "../services/search.js";

function makeDb(executeRows: unknown[][]) {
  let executeIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
    execute: async () => ({ rows: executeRows[executeIndex++] ?? [] }),
  } as any;
}

function clearStack() {
  sqlCallStack.length = 0;
}

function stackText(): string {
  // Reconstruct an approximation of the SQL by concatenating the static parts
  // of each tagged template + JSON-encoded values. Good enough to grep for
  // distinctive fragments (intent / phase / thread_participants).
  return sqlCallStack
    .map((call) => {
      const strs = Array.isArray(call.strings) ? call.strings.join("|") : "";
      return `${strs} :: ${JSON.stringify(call.values)}`;
    })
    .join("\n");
}

const emptyExecuteFixtures = () => [[], [], [], [], [], [], []];

describe("searchService thread filters", () => {
  it("does not emit any thread-source SQL when no thread filter is set", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "design",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    // Sanity: brief query used the legacy briefs+debriefs source.
    expect(text).toContain("from briefs b");
    expect(text).toContain("inner join debriefs d");
    // And no intent/phase/participant predicates leaked into the SQL.
    expect(text).not.toMatch(/d\.intent @>/);
    expect(text).not.toMatch(/d\.phase =/);
    expect(text).not.toMatch(/thread_participants/);
  });

  it("emits the intent @> predicate when intent is provided", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "design",
      intent: "research",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    expect(text).toContain("from discussions d");
    expect(text).toMatch(/d\.intent @>/);
    // Value bound to the SQL parameter is the JSON array literal as a string
    // ('["research"]'). Our stackText() re-serializes call values with
    // JSON.stringify, which double-quotes that string — so we look for the
    // raw `research` token instead of the bracketed form.
    expect(text).toContain("research");
  });

  it("emits the phase = predicate when phase is provided", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "roadmap",
      phase: "scope",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    expect(text).toContain("from discussions d");
    expect(text).toMatch(/d\.phase =/);
    expect(text).toContain('"scope"');
  });

  it("emits the EXISTS thread_participants predicate for participant=agent:<id>", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "alignment",
      participant: "agent:abc-123",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    expect(text).toContain("from discussions d");
    expect(text).toMatch(/thread_participants/);
    expect(text).toContain('"agent"');
    expect(text).toContain('"abc-123"');
  });

  it("emits the EXISTS predicate for participant=user:<id> with principalType=user", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "alignment",
      participant: "user:human-9",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    expect(text).toContain("thread_participants");
    expect(text).toContain('"user"');
    expect(text).toContain('"human-9"');
  });

  it("combines intent + phase + participant as AND clauses on the discussions source", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "alignment",
      intent: "decision",
      phase: "assign",
      participant: "agent:zz",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    // Single discussions-based brief query; brief+debriefs source is bypassed.
    expect(text).toContain("from discussions d");
    expect(text).not.toContain("from briefs b");
    // All three predicates present.
    expect(text).toMatch(/d\.intent @>/);
    expect(text).toMatch(/d\.phase =/);
    expect(text).toMatch(/thread_participants/);
  });

  it("ignores a malformed participant value (no colon)", async () => {
    clearStack();
    const svc = searchService(makeDb(emptyExecuteFixtures()));
    await svc.search("company-1", {
      query: "alignment",
      participant: "not-a-valid-participant",
      actor: { type: "board", source: "local_implicit", userId: "founder-1" },
    });
    const text = stackText();
    // Falls back to the briefs source because no thread filter took effect.
    expect(text).toContain("from briefs b");
    expect(text).not.toContain("thread_participants");
  });
});
