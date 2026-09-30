/**
 * F2 — `crew-repair.ts`'s `INFRASTRUCTURE_*` sets and D23's
 * `PROTECTED_AGENT_ROLES` are identical today and **must stay separate
 * declarations**, because they are safe in OPPOSITE directions:
 *
 *   - growing `PROTECTED_AGENT_ROLES` adds refusals/retentions — the safe way
 *     for a destructive guard to be wrong;
 *   - growing `INFRASTRUCTURE_*` marks MORE leftover crew rows "accounted for",
 *     which REMOVES `unaccounted-crew-rows` refusals and lets repair install a
 *     second crew beside rows that own real work.
 *
 * Aliasing one to the other (which an earlier revision of this work did) turns
 * a one-line addition to the protected set into a silent semantic change in
 * crew repair. This test is the tripwire: adding a third protected role fails
 * here and forces a conscious decision in `crew-repair.ts`.
 *
 * **Do not "fix" a failure here by re-aliasing the constants.** Either add the
 * role to both, deliberately, or record why crew repair must not see it.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("op"),
  and: () => Symbol("op"),
  inArray: () => Symbol("op"),
  isNull: () => Symbol("op"),
  sql: Object.assign(() => Symbol("op"), { raw: () => Symbol("op") }),
}));
vi.mock("@armyofagents/db", () => {
  const table = () => new Proxy({}, { get: () => Symbol("col") });
  return {
    agents: table(),
    companySkills: table(),
    teams: table(),
    teamMembers: table(),
    marketplaceInstallOperations: table(),
  };
});

import {
  PROTECTED_AGENT_NAMES,
  PROTECTED_AGENT_SLUGS,
} from "../services/protected-agents.js";
import {
  INFRASTRUCTURE_LEGACY_SLUGS,
  INFRASTRUCTURE_NAMES,
} from "../services/crew-repair.js";

const sorted = (set: ReadonlySet<string>) => [...set].sort();

describe("protected set ↔ crew-repair infrastructure set parity", () => {
  it("holds the same role slugs", () => {
    expect(sorted(INFRASTRUCTURE_LEGACY_SLUGS)).toEqual(sorted(PROTECTED_AGENT_SLUGS));
  });

  it("holds the same display names", () => {
    expect(sorted(INFRASTRUCTURE_NAMES)).toEqual(sorted(PROTECTED_AGENT_NAMES));
  });

  it("keeps them as SEPARATE objects, not one aliased to the other", () => {
    // `ReadonlySet` is compile-time only — aliasing would share the very same
    // object, which is exactly the coupling this file exists to prevent.
    expect(INFRASTRUCTURE_LEGACY_SLUGS).not.toBe(PROTECTED_AGENT_SLUGS);
    expect(INFRASTRUCTURE_NAMES).not.toBe(PROTECTED_AGENT_NAMES);
  });
});
