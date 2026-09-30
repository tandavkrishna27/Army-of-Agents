import { describe, it, expect } from "vitest";
import {
  canAdvancePhase,
  resolveOwnerOnAction,
  canViewThread,
} from "../services/threads.js";

describe("canAdvancePhase", () => {
  it("allows forward by one step", () => {
    expect(canAdvancePhase("discuss", "scope")).toBe(true);
    expect(canAdvancePhase("scope", "assign")).toBe(true);
    expect(canAdvancePhase("assign", "done")).toBe(true);
  });
  it("allows backward jumps (override)", () => {
    expect(canAdvancePhase("done", "discuss")).toBe(true);
    expect(canAdvancePhase("assign", "scope")).toBe(true);
  });
  it("rejects forward skips and unknown phases", () => {
    expect(canAdvancePhase("discuss", "assign")).toBe(false);
    expect(canAdvancePhase("discuss", "bogus" as never)).toBe(false);
  });
});

describe("resolveOwnerOnAction (owned-by-action; agents never own)", () => {
  it("a human's first governance action claims an unclaimed thread", () => {
    expect(
      resolveOwnerOnAction({ ownerUserId: null }, { userId: "u1", isHuman: true }),
    ).toBe("u1");
  });
  it("leaves an already-owned thread unchanged", () => {
    expect(
      resolveOwnerOnAction({ ownerUserId: "u9" }, { userId: "u1", isHuman: true }),
    ).toBeNull();
  });
  it("never makes an agent the owner", () => {
    expect(
      resolveOwnerOnAction({ ownerUserId: null }, { userId: "a1", isHuman: false }),
    ).toBeNull();
  });
});

describe("canViewThread (hide private/unclaimed)", () => {
  const open = { ownerUserId: "u9", visibility: "company" as const };
  const priv = { ownerUserId: "u9", visibility: "private" as const };
  const unclaimed = { ownerUserId: null, visibility: "company" as const };

  it("founder sees everything", () => {
    expect(canViewThread(open, { role: "founder", hasScopeAccess: false, isParticipant: false })).toBe(true);
    expect(canViewThread(priv, { role: "founder", hasScopeAccess: false, isParticipant: false })).toBe(true);
    expect(canViewThread(unclaimed, { role: "founder", hasScopeAccess: false, isParticipant: false })).toBe(true);
  });
  it("open thread visible to anyone with scope access", () => {
    expect(canViewThread(open, { role: "team_member", hasScopeAccess: true, isParticipant: false })).toBe(true);
    expect(canViewThread(open, { role: "team_member", hasScopeAccess: false, isParticipant: false })).toBe(false);
  });
  it("private thread visible only to participants", () => {
    expect(canViewThread(priv, { role: "team_member", hasScopeAccess: true, isParticipant: false })).toBe(false);
    expect(canViewThread(priv, { role: "team_member", hasScopeAccess: false, isParticipant: true })).toBe(true);
  });
  it("unclaimed thread visible only to founder or a lead with scope access", () => {
    expect(canViewThread(unclaimed, { role: "team_lead", hasScopeAccess: true, isParticipant: false })).toBe(true);
    expect(canViewThread(unclaimed, { role: "team_member", hasScopeAccess: true, isParticipant: false })).toBe(false);
  });
});
