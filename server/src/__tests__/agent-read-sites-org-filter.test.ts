// Fan-out guard: the user-facing agent-enumeration sites must filter
// kind='org' so platform (Commander-team) agents stay out of user surfaces.
// Source-presence assertion (Windows-runnable); the authoritative behavioural
// proof is agents-list-excludes-platform.integration.test.ts (Linux CI).
//
// Site classification was verified per-query (T1.4): only genuine user-facing
// ENUMERATIONS are filtered. by-id lookups (context-packaging, feedback-bundles,
// projects, issues:assignee, trust-scores, budgets, costs, heartbeat) are
// intentionally NOT filtered and are asserted absent below.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Resolve server source files relative to __dirname so this works whether
// vitest CWD is server/ or the monorepo root.
const serverSrc = (rel: string) =>
  resolve(__dirname, "..", rel.replace(/^src\//, ""));

const FILTERED = [
  "src/services/agents.ts",       // list(), orgForCompany(), getByUrlKey()
  "src/services/dashboard.ts",    // agent status counts
  "src/services/home.ts",         // agent count
  "src/services/companies.ts",    // per-company agent count
  "src/services/issues.ts",       // @mention resolution
];

// by-id / cost / budget / heartbeat-structural — MUST NOT carry a kind filter.
const NOT_FILTERED = [
  "src/services/context-packaging.ts",
  "src/services/feedback-bundles.ts",
  "src/services/trust-scores.ts",
];

describe("user-facing agent enumerations filter kind='org'", () => {
  for (const f of FILTERED) {
    it(`${f} references agents.kind`, () => {
      expect(readFileSync(serverSrc(f), "utf8").includes("agents.kind")).toBe(true);
    });
  }
});

describe("by-id agent lookups are intentionally NOT kind-filtered", () => {
  for (const f of NOT_FILTERED) {
    it(`${f} does not add a kind filter (by-id lookup)`, () => {
      expect(readFileSync(serverSrc(f), "utf8").includes("agents.kind")).toBe(false);
    });
  }
});
