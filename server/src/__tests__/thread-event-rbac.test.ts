import { describe, it, expect } from "vitest";
import { filterThreadEventRecipients } from "../services/live-events.js";

// Plan 7 Task 2: the pure fan-out filter reuses canViewThread (Plan 2) so a
// viewer never receives even a poke about a thread they can't see. Subscribers
// carry their RBAC inputs ({ role, hasScopeAccess, isParticipant }) plus an id.
describe("filterThreadEventRecipients (envelope RBAC)", () => {
  const priv = { ownerUserId: "u9", visibility: "private" as const };
  const subs = [
    { id: "s1", role: "team_member" as const, hasScopeAccess: true, isParticipant: false },
    { id: "s2", role: "team_member" as const, hasScopeAccess: true, isParticipant: true },
    { id: "s3", role: "founder" as const, hasScopeAccess: false, isParticipant: false },
  ];

  it("delivers a private thread event only to participants (+ founder)", () => {
    const out = filterThreadEventRecipients(priv, subs).map((s) => s.id);
    expect(out).toContain("s2"); // participant
    expect(out).toContain("s3"); // founder sees everything
    expect(out).not.toContain("s1"); // scope access but not a participant -> blocked
  });

  it("delivers a company-wide thread event to anyone with scope access or participation", () => {
    const open = { ownerUserId: "u9", visibility: "company" as const };
    const out = filterThreadEventRecipients(open, subs).map((s) => s.id);
    expect(out).toEqual(["s1", "s2", "s3"]);
  });

  it("delivers an unclaimed thread event to leads with scope, participants, and founder", () => {
    // Crew-posting fix (2026-07-16): participants may view unclaimed threads —
    // a summoned member/agent must see replies in a thread nobody has claimed
    // yet. canViewThread's unclaimed branch is (lead && scope) || participant,
    // and this fan-out filter mirrors it. Non-participant members stay blocked.
    const unclaimed = { ownerUserId: null, visibility: "company" as const };
    const leadSubs = [
      { id: "lead", role: "team_lead" as const, hasScopeAccess: true, isParticipant: false },
      { id: "member", role: "team_member" as const, hasScopeAccess: true, isParticipant: true },
      { id: "outsider", role: "team_member" as const, hasScopeAccess: true, isParticipant: false },
      { id: "founder", role: "founder" as const, hasScopeAccess: false, isParticipant: false },
    ];
    const out = filterThreadEventRecipients(unclaimed, leadSubs).map((s) => s.id);
    expect(out).toContain("lead");
    expect(out).toContain("founder");
    expect(out).toContain("member"); // participant — summoned into the thread
    expect(out).not.toContain("outsider"); // scope alone is not enough on unclaimed
  });

  it("returns an empty list when no subscriber qualifies", () => {
    const out = filterThreadEventRecipients(priv, [
      { id: "x", role: "team_member" as const, hasScopeAccess: true, isParticipant: false },
    ]);
    expect(out).toEqual([]);
  });
});
