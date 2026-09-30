import { describe, it, expect, vi, beforeEach } from "vitest";
import { destinationForJourney, getOnboardingProgress, advanceOnboarding, setFirstRunCompleted } from "../onboarding";
import type { PostAuthJourneyResult } from "@armyofagents/shared";

const base = (over: Partial<PostAuthJourneyResult>): PostAuthJourneyResult => ({
  journey: "founder",
  targetCompanyId: null,
  pendingInvitations: [],
  inviteToken: null,
  ...over,
});

describe("destinationForJourney (Stage A / A9)", () => {
  it("returning → lobby", () => {
    expect(destinationForJourney(base({ journey: "returning", targetCompanyId: "c1" }))).toBe("/");
  });

  it("founder → onboarding", () => {
    expect(destinationForJourney(base({ journey: "founder" }))).toBe("/onboarding");
  });

  it("invited → join flow with the target company", () => {
    expect(destinationForJourney(base({ journey: "invited", targetCompanyId: "c2" }))).toBe(
      "/onboarding/join?company=c2",
    );
  });
});

describe("onboarding progress client (Stage B / B7)", () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn();
  });

  it("getOnboardingProgress GETs with credentials + companyId", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ progress: { completedStates: ["AUTHENTICATED"] } }),
    });
    const p = await getOnboardingProgress("c1");
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("/api/onboarding/progress?companyId=c1");
    expect(init.credentials).toBe("include");
    expect(p).toEqual({ completedStates: ["AUTHENTICATED"] });
  });

  it("getOnboardingProgress returns null when no row", async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ progress: null }) });
    expect(await getOnboardingProgress(null)).toBeNull();
  });

  it("advanceOnboarding PATCHes the requested state", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ progress: { completedStates: ["AUTHENTICATED", "PROFILE_SET"] } }),
    });
    const p = await advanceOnboarding({ companyId: null, journey: "founder", requestedState: "PROFILE_SET" });
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("/api/onboarding/progress");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toMatchObject({ journey: "founder", requestedState: "PROFILE_SET" });
    expect(p?.completedStates).toContain("PROFILE_SET");
  });
});

describe("setFirstRunCompleted (Fix 2 — write the flag at onboarding completion)", () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn();
  });

  it("PATCHes the first-run endpoint with companyId + completed:true", async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ progress: { firstRunCompletedAt: "2026-07-18T00:00:00Z" } }),
    });
    await setFirstRunCompleted("c1");
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("/api/onboarding/first-run");
    expect(init.method).toBe("PATCH");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body)).toEqual({ companyId: "c1", completed: true });
  });

  // The function returns false rather than undefined on failure (453a92b55) so
  // callers can tell a confirmed write from an unconfirmed one and avoid
  // clearing resume state on the latter. It still must never throw.
  it("resolves false without throwing when the server responds with a non-OK status", async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 409 });
    await expect(setFirstRunCompleted("c1")).resolves.toBe(false);
  });

  it("resolves false without throwing when fetch itself rejects", async () => {
    (globalThis.fetch as any).mockRejectedValue(new Error("network down"));
    await expect(setFirstRunCompleted("c1")).resolves.toBe(false);
  });

  it("resolves true when the write is confirmed", async () => {
    (globalThis.fetch as any).mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(setFirstRunCompleted("c1")).resolves.toBe(true);
  });
});
