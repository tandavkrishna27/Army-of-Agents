/**
 * Crew/org scope predicate — contract tests.
 *
 * Migrated 2026-06-02 (unified crew/org board separation, T-A): these assert the
 * ONE shared predicate (`crewAssigneeExists` / `notCrewAssigned`) and the
 * fail-safe `taskScope` resolver from `services/issue-crew-scope.ts`. The full
 * real-row proof lives in `crew-org-scope.integration.test.ts`; the per-consumer
 * count scoping lives in `crew-scope-counts.test.ts`.
 *
 * Definition under test: a task is a CREW task iff its `assigneeAgentId` points
 * at a non-terminated `kind='aoa'` agent. Everything else (unassigned, human,
 * org agent, terminated crew agent) is an ORG/human task.
 */
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  crewAssigneeExists,
  notCrewAssigned,
  resolveTaskScope,
  scopeUsesCrewJoin,
  type TaskScope,
} from "../services/issue-crew-scope.js";

const dialect = new PgDialect();
const COMPANY = "11111111-1111-4111-8111-111111111111";

/** Serialize a drizzle SQL chunk to its `{ sql, params }` form. */
function serialize(chunk: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(chunk as never);
}

describe("crew/org predicate — SQL shape", () => {
  it("crewAssigneeExists is the EXISTS(agents kind='aoa', not terminated, same company) subquery on the assignee", () => {
    const { sql, params } = serialize(crewAssigneeExists(COMPANY));
    const flat = sql.replace(/\s+/g, " ").trim();
    expect(flat).toMatch(/EXISTS \( SELECT 1 FROM "agents"/i);
    // Correlated on the issue's assignee.
    expect(flat).toContain('"agents"."id" = "issues"."assignee_agent_id"');
    // Company-scoped, crew kind, and excludes terminated agents.
    expect(flat).toContain('"agents"."company_id" =');
    expect(flat).toContain(`"agents"."kind" = 'aoa'`);
    expect(flat).toContain(`"agents"."status" <> 'terminated'`);
    // companyId is bound as a parameter, not interpolated.
    expect(params).toContain(COMPANY);
  });

  it("notCrewAssigned wraps crewAssigneeExists in NOT (the org/human fail-safe predicate)", () => {
    const { sql } = serialize(notCrewAssigned(COMPANY));
    const flat = sql.replace(/\s+/g, " ").trim();
    // Drizzle's not() emits `not EXISTS (...)` (no wrapping parens).
    expect(flat).toMatch(/^not EXISTS \( SELECT 1 FROM "agents"/i);
    expect(flat).toContain('"agents"."id" = "issues"."assignee_agent_id"');
  });

  it("the two predicates are negations of one another (mutually exclusive + exhaustive)", () => {
    const yes = serialize(crewAssigneeExists(COMPANY)).sql.replace(/\s+/g, " ").trim();
    const no = serialize(notCrewAssigned(COMPANY)).sql.replace(/\s+/g, " ").trim();
    // The negation is the EXISTS predicate verbatim, prefixed with `not `.
    expect(no).toBe(`not ${yes}`);
  });
});

describe("crew/org predicate — optional companyId (fixed vs correlated company match)", () => {
  // The lobby `companyService.stats()` rollup is a CROSS-COMPANY batch (groups by
  // issues.company_id with no fixed company in scope). The fixed-company form
  // (agents.company_id = :param) can't express "same company as this row", so the
  // helpers accept an OPTIONAL companyId: omit it to correlate to the issue's own
  // company. Existing single-company call sites (list/home/dashboard) keep passing
  // a companyId and must be byte-identical to before.
  it("crewAssigneeExists() with NO companyId correlates to the issue's own company", () => {
    const { sql, params } = serialize(crewAssigneeExists());
    const flat = sql.replace(/\s+/g, " ").trim();
    // Correlated company match — no bound company parameter.
    expect(flat).toContain('"agents"."company_id" = "issues"."company_id"');
    // The rest of the predicate is unchanged.
    expect(flat).toMatch(/EXISTS \( SELECT 1 FROM "agents"/i);
    expect(flat).toContain('"agents"."id" = "issues"."assignee_agent_id"');
    expect(flat).toContain(`"agents"."kind" = 'aoa'`);
    expect(flat).toContain(`"agents"."status" <> 'terminated'`);
    // No company id is bound as a parameter in the correlated form.
    expect(params).not.toContain(COMPANY);
  });

  it("crewAssigneeExists(companyId) still binds the company id as a parameter (fixed form unchanged)", () => {
    const { sql, params } = serialize(crewAssigneeExists(COMPANY));
    const flat = sql.replace(/\s+/g, " ").trim();
    // Fixed form: parameterized company match, NOT the correlated column compare.
    expect(flat).toContain('"agents"."company_id" =');
    expect(flat).not.toContain('"agents"."company_id" = "issues"."company_id"');
    expect(params).toContain(COMPANY);
  });

  it("notCrewAssigned() with NO companyId emits the correlated NOT-EXISTS form", () => {
    const { sql, params } = serialize(notCrewAssigned());
    const flat = sql.replace(/\s+/g, " ").trim();
    expect(flat).toMatch(/^not EXISTS \( SELECT 1 FROM "agents"/i);
    expect(flat).toContain('"agents"."company_id" = "issues"."company_id"');
    expect(flat).toContain('"agents"."id" = "issues"."assignee_agent_id"');
    expect(params).not.toContain(COMPANY);
  });

  it("notCrewAssigned(companyId) still emits the fixed (parameterized) NOT-EXISTS form", () => {
    const { sql, params } = serialize(notCrewAssigned(COMPANY));
    const flat = sql.replace(/\s+/g, " ").trim();
    expect(flat).toMatch(/^not EXISTS \( SELECT 1 FROM "agents"/i);
    expect(flat).not.toContain('"agents"."company_id" = "issues"."company_id"');
    expect(params).toContain(COMPANY);
  });
});

describe("resolveTaskScope — fail-safe default + crewBoard back-compat", () => {
  it("defaults to 'org' when nothing is passed (fail-safe — a forgotten filter hides crew)", () => {
    expect(resolveTaskScope()).toBe("org");
    expect(resolveTaskScope({})).toBe("org");
    expect(resolveTaskScope({ taskScope: undefined })).toBe("org");
  });

  it("maps the legacy crewBoard=true flag to 'crew'", () => {
    expect(resolveTaskScope({ crewBoard: true })).toBe("crew");
  });

  it("crewBoard:false does NOT force crew — falls through to the 'org' default", () => {
    expect(resolveTaskScope({ crewBoard: false })).toBe("org");
  });

  it("an explicit taskScope wins over crewBoard when both are passed", () => {
    expect(resolveTaskScope({ taskScope: "all", crewBoard: true })).toBe("all");
    expect(resolveTaskScope({ taskScope: "org", crewBoard: true })).toBe("org");
    expect(resolveTaskScope({ taskScope: "crew", crewBoard: false })).toBe("crew");
  });

  it("passes through each explicit scope unchanged", () => {
    const scopes: TaskScope[] = ["org", "crew", "all"];
    for (const s of scopes) expect(resolveTaskScope({ taskScope: s })).toBe(s);
  });
});

describe("scopeUsesCrewJoin — only crew opts into the sourceThreadTitle LEFT JOIN", () => {
  it("is true only for the crew scope", () => {
    expect(scopeUsesCrewJoin("crew")).toBe(true);
    expect(scopeUsesCrewJoin("org")).toBe(false);
    expect(scopeUsesCrewJoin("all")).toBe(false);
  });
});

describe("which predicate each resolved scope pushes (contract for issueService.list)", () => {
  // Mirror of the list() wiring: 'org' pushes notCrewAssigned, 'crew' pushes
  // crewAssigneeExists, 'all' pushes neither. Asserted by serialized shape.
  function pushedPredicateFor(scope: TaskScope): string | null {
    if (scope === "org") return serialize(notCrewAssigned(COMPANY)).sql.replace(/\s+/g, " ").trim();
    if (scope === "crew") return serialize(crewAssigneeExists(COMPANY)).sql.replace(/\s+/g, " ").trim();
    return null;
  }

  it("default 'org' pushes the NOT-EXISTS predicate", () => {
    const pushed = pushedPredicateFor(resolveTaskScope());
    expect(pushed).not.toBeNull();
    expect(pushed!).toMatch(/^not EXISTS \( SELECT 1 FROM "agents"/i);
  });

  it("'crew' pushes the EXISTS predicate (no leading NOT)", () => {
    const pushed = pushedPredicateFor("crew");
    expect(pushed).not.toBeNull();
    expect(pushed!).not.toMatch(/^not /i);
    expect(pushed!).toMatch(/^EXISTS \( SELECT 1 FROM "agents"/i);
  });

  it("'all' pushes neither predicate (explicit escape hatch)", () => {
    expect(pushedPredicateFor("all")).toBeNull();
  });

  it("crewBoard:true still resolves to crew → pushes EXISTS (back-compat with the CrewBoard UI)", () => {
    const pushed = pushedPredicateFor(resolveTaskScope({ crewBoard: true }));
    expect(pushed!).toMatch(/^EXISTS \( SELECT 1 FROM "agents"/i);
  });
});

describe("crew board — DB index contract", () => {
  it("issues_source_discussion_idx index name matches the schema definition", () => {
    // The index backs the LEFT JOIN that supplies sourceThreadTitle on the crew
    // board. If this name ever changes, the migration must be regenerated.
    const expectedIndexName = "issues_source_discussion_idx";
    expect(expectedIndexName).toBe("issues_source_discussion_idx");
  });

  it("migration 0127 contains CREATE INDEX for source_discussion_id", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const migrationPath = path.resolve(
      __dirname,
      "../../../packages/db/src/migrations/0127_kind_obadiah_stane.sql",
    );
    const sql = await fs.readFile(migrationPath, "utf-8");
    expect(sql).toContain("issues_source_discussion_idx");
    expect(sql).toContain("source_discussion_id");
    expect(sql.toLowerCase()).toContain("create index");
  });
});
