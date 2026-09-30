/**
 * cockpitScope TDD tests — Phase 3b.
 *
 * These are PURE unit tests of the cockpit scoping logic (no DB, no mocks).
 * They cover the three role archetypes and the security-critical reviewFilterFor
 * predicate. Multi-human scoping is NOT exercisable in the local_trusted e2e
 * harness (single-founder actor); these tests are the security gate.
 */

import { describe, it, expect } from "vitest";
import {
  reviewFilterFor,
  type CockpitScope,
} from "../services/cockpit-scope.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

const founder: CockpitScope = {
  userId: "u1",
  role: "founder",
  isFounder: true,
  leadDepartmentIds: [],
};

const lead: CockpitScope = {
  userId: "u2",
  role: "team_lead",
  isFounder: false,
  leadDepartmentIds: ["dep-a"],
};

const member: CockpitScope = {
  userId: "u3",
  role: "team_member",
  isFounder: false,
  leadDepartmentIds: [],
};

// ── reviewFilterFor ───────────────────────────────────────────────────────────

describe("cockpitScope reviewFilterFor", () => {
  it("founder → no department/assignee restriction (empty object)", () => {
    expect(reviewFilterFor(founder)).toEqual({});
  });

  it("team_lead with departments → restricted to their departments", () => {
    expect(reviewFilterFor(lead)).toEqual({ projectIds: ["dep-a"] });
  });

  it("team_member → restricted to their own assigned reviews", () => {
    expect(reviewFilterFor(member)).toEqual({ assigneeUserId: "u3" });
  });

  it("team_lead with no departments (edge case) → falls back to assigneeUserId", () => {
    const leadNoDepts: CockpitScope = {
      userId: "u4",
      role: "team_lead",
      isFounder: false,
      leadDepartmentIds: [],
    };
    // A team_lead with zero departments behaves like a member (no dept to scope on).
    expect(reviewFilterFor(leadNoDepts)).toEqual({ assigneeUserId: "u4" });
  });

  it("team_lead with multiple departments → projectIds includes all dept ids", () => {
    const multiLead: CockpitScope = {
      userId: "u5",
      role: "team_lead",
      isFounder: false,
      leadDepartmentIds: ["dep-x", "dep-y"],
    };
    expect(reviewFilterFor(multiLead)).toEqual({ projectIds: ["dep-x", "dep-y"] });
  });
});

// ── Security gate ─────────────────────────────────────────────────────────────

describe("cockpitScope security invariants", () => {
  it("a member's review filter ALWAYS carries assigneeUserId (no cross-dept leak)", () => {
    const filter = reviewFilterFor(member);
    // Must have assigneeUserId and it must match the member's userId.
    expect(filter).toHaveProperty("assigneeUserId", member.userId);
    // Must NOT have projectIds (that would be a lead-level scope).
    expect(filter).not.toHaveProperty("projectIds");
  });

  it("a founder's review filter has NO assigneeUserId and NO projectIds", () => {
    const filter = reviewFilterFor(founder);
    expect(filter).not.toHaveProperty("assigneeUserId");
    expect(filter).not.toHaveProperty("projectIds");
  });
});
