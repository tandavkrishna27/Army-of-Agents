import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";

// signInstallState / verifyInstallState are pure crypto helpers with no DB dependency.
// We set the secret env var before importing so the module picks it up.
const TEST_SECRET = "test-secret";

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = TEST_SECRET;
});

afterAll(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

// Dynamic import so the module initialises after env is set.
const { signInstallState, verifyInstallState } = await import("../services/github-app.js");

describe("signInstallState / verifyInstallState", () => {
  it("round-trips: sign → verify returns the original companyId, with returnTo null when absent", () => {
    const token = signInstallState("company-abc");
    const result = verifyInstallState(token);
    expect(result).toEqual({ companyId: "company-abc", returnTo: null });
  });

  it("round-trips an allowlisted returnTo target through the signed state", () => {
    const token = signInstallState("company-abc", { returnTo: "integrations" });
    const result = verifyInstallState(token);
    expect(result).toEqual({ companyId: "company-abc", returnTo: "integrations" });
  });

  it("returns null for a tampered payload (flipped char in payload segment)", () => {
    const token = signInstallState("company-xyz");
    const dot = token.indexOf(".");
    const tampered = token.slice(0, dot) + (token[dot + 1] === "A" ? "B" : "A") + token.slice(dot + 2);
    expect(verifyInstallState(tampered)).toBeNull();
  });

  it("returns null for a tampered signature (flipped char in sig segment)", () => {
    const token = signInstallState("company-xyz");
    const lastDot = token.lastIndexOf(".");
    const payload = token.slice(0, lastDot);
    const sig = token.slice(lastDot + 1);
    const tamperedSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyInstallState(`${payload}.${tamperedSig}`)).toBeNull();
  });

  it("returns null for an expired token (issued 11 minutes ago)", () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    const token = signInstallState("company-expired", { now: elevenMinutesAgo });
    expect(verifyInstallState(token)).toBeNull();
  });

  it("returns null for a garbage string", () => {
    expect(verifyInstallState("xxx")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(verifyInstallState("")).toBeNull();
  });

  it("returns null for a token with no dot separator", () => {
    expect(verifyInstallState("nodothere")).toBeNull();
  });

  it("drops an off-allowlist returnTo key even though the signature is valid (defense in depth)", () => {
    // Simulate a validly-signed state whose `r` key isn't (or is no longer) in
    // ONBOARDING_RETURN_PATHS — e.g. a stale token signed before an allowlist
    // entry was removed, or any signer bug. verifyInstallState must not trust
    // the embedded key blindly; it re-checks against the allowlist itself.
    const payload = Buffer.from(
      JSON.stringify({ c: "company-abc", e: Date.now() + 60_000, r: "evil-unallowlisted-path" }),
      "utf8",
    ).toString("base64url");
    const sig = createHmac("sha256", TEST_SECRET).update(payload).digest("base64url");
    const forgedButSignedToken = `${payload}.${sig}`;

    const result = verifyInstallState(forgedButSignedToken);
    expect(result).toEqual({ companyId: "company-abc", returnTo: null });
  });
});
