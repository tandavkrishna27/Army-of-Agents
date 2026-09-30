/**
 * T2.5 (D23) — the protected-agent identity predicate.
 *
 * Pure module, no db and no drizzle imports, so this suite needs no mocks.
 * Every row shape below is one that actually exists in production:
 *   - `aoa-curated/standard-crew/<slug>@legacy` — written by
 *     `backfillCrewTemplateOrigin` (its `sql` template is the only writer).
 *   - `agent:aoa-curated/aoa-<slug>` — a `catalogItem.id`, written by
 *     `createMarketplaceAgent`.
 *   - `null` — every crew role absent from `CREW_NAMES` (Steward, Chronicler),
 *     permanently.
 */
import { describe, it, expect } from "vitest";
import {
  protectedAgentRefusal,
  protectedAgentRole,
  protectedAgentsIn,
  PROTECTED_AGENT_ROLES,
} from "../services/protected-agents.js";

describe("protectedAgentRole", () => {
  it("protects Commander carrying the backfilled @legacy origin", () => {
    expect(
      protectedAgentRole({
        name: "Commander",
        templateOrigin: "aoa-curated/standard-crew/commander@legacy",
      })?.slug,
    ).toBe("commander");
  });

  it("protects Commander when templateOrigin is still NULL (pre-backfill boot)", () => {
    expect(protectedAgentRole({ name: "Commander", templateOrigin: null })?.slug).toBe(
      "commander",
    );
  });

  // THE case a set keyed only on templateOrigin silently fails to protect.
  // Steward is absent from `CREW_NAMES`, so the backfill never stamps it and
  // its origin stays NULL forever.
  it("protects Steward with a NULL templateOrigin (it has no origin and never will)", () => {
    expect(protectedAgentRole({ name: "Steward", templateOrigin: null })?.slug).toBe("steward");
  });

  it("protects Steward once T2.4 publishes it under a marketplace origin", () => {
    expect(
      protectedAgentRole({ name: "Steward", templateOrigin: "agent:aoa-curated/aoa-steward" })
        ?.slug,
    ).toBe("steward");
  });

  it("protects a RENAMED Commander through its origin slug", () => {
    // `PATCH /agents/:id` renames without touching templateOrigin.
    expect(
      protectedAgentRole({
        name: "Ops Lead",
        templateOrigin: "aoa-curated/standard-crew/commander@legacy",
      })?.slug,
    ).toBe("commander");
  });

  // ── discriminators: the guard must NOT be blanket ────────────────────────

  it("does NOT protect a published crew agent (Scout)", () => {
    expect(
      protectedAgentRole({ name: "Scout", templateOrigin: "agent:aoa-curated/aoa-scout" }),
    ).toBeNull();
  });

  it("does NOT protect a NULL-origin crew agent that is not in the set (Chronicler)", () => {
    // Chronicler shares Steward's NULL origin exactly. If it were protected the
    // predicate would be keying on "origin is NULL", not on identity.
    expect(protectedAgentRole({ name: "Chronicler", templateOrigin: null })).toBeNull();
  });

  it("does NOT protect an ordinary org agent", () => {
    expect(
      protectedAgentRole({
        name: "Senior Engineer",
        templateOrigin: "agent:aoa-curated/senior-engineer",
      }),
    ).toBeNull();
  });

  it("does NOT protect a legacy origin naming a retired, unprotected role", () => {
    expect(
      protectedAgentRole({
        name: "Dispatcher",
        templateOrigin: "aoa-curated/standard-crew/dispatcher@legacy",
      }),
    ).toBeNull();
  });

  it("treats the name case- and spacing-insensitively", () => {
    expect(protectedAgentRole({ name: "  steward  ", templateOrigin: null })?.slug).toBe(
      "steward",
    );
  });

  it("tolerates a missing templateOrigin field entirely", () => {
    expect(protectedAgentRole({ name: "Commander" })?.slug).toBe("commander");
  });
});

describe("protectedAgentsIn", () => {
  it("returns only the protected rows, preserving the caller's row object", () => {
    const rows = [
      { id: "a-scout", name: "Scout", templateOrigin: "agent:aoa-curated/aoa-scout" },
      { id: "a-steward", name: "Steward", templateOrigin: null },
      { id: "a-chron", name: "Chronicler", templateOrigin: null },
      {
        id: "a-cmd",
        name: "Commander",
        templateOrigin: "aoa-curated/standard-crew/commander@legacy",
      },
    ];

    const found = protectedAgentsIn(rows);

    expect(found.map((f) => f.agent.id)).toEqual(["a-steward", "a-cmd"]);
    expect(found.map((f) => f.role.slug)).toEqual(["steward", "commander"]);
  });

  it("returns an empty list when nothing is protected", () => {
    expect(
      protectedAgentsIn([
        { id: "a-1", name: "Scout", templateOrigin: "agent:aoa-curated/aoa-scout" },
        { id: "a-2", name: "Engineer", templateOrigin: "agent:aoa-curated/aoa-engineer" },
      ]),
    ).toEqual([]);
  });
});

describe("protectedAgentRefusal", () => {
  const commander = PROTECTED_AGENT_ROLES.find((r) => r.slug === "commander")!;
  const steward = PROTECTED_AGENT_ROLES.find((r) => r.slug === "steward")!;

  it("uses the caller's verb and ends with an actionable next step", () => {
    const msg = protectedAgentRefusal([{ name: "Commander", role: commander }], {
      operation: "Deleting this agent",
      remedy: "Pause it from the agent page if you want it to stop working.",
    });

    expect(msg).toMatch(/^Deleting this agent would remove a protected AoA agent: Commander/);
    expect(msg).toMatch(/Pause it from the agent page/);
    // The bug this parameterisation fixed: every message used to end
    // "…cannot be uninstalled", a non-sequitur after "Deleting this agent".
    expect(msg).not.toMatch(/cannot be uninstalled/);
  });

  it("pluralises and names every blocked agent", () => {
    const msg = protectedAgentRefusal(
      [
        { name: "Commander", role: commander },
        { name: "Steward", role: steward },
      ],
      { operation: "Doing the thing", remedy: "Try something else." },
    );

    expect(msg).toMatch(/protected AoA agents:/);
    expect(msg).toMatch(/Commander/);
    expect(msg).toMatch(/Steward/);
  });
});

describe("PROTECTED_AGENT_ROLES", () => {
  it("is exactly Commander + Steward", () => {
    expect(PROTECTED_AGENT_ROLES.map((r) => r.slug).sort()).toEqual(["commander", "steward"]);
  });

  it("gives every role a human-readable reason for the refusal copy", () => {
    for (const role of PROTECTED_AGENT_ROLES) {
      expect(role.why.length).toBeGreaterThan(0);
    }
  });
});
