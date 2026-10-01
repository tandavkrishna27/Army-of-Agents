import { describe, expect, it } from "vitest";
import { isLocalTrustedProfile, profileDisplayName, profileFirstName } from "../auth-identity";

describe("auth identity presentation", () => {
  it("labels the synthetic local identity explicitly", () => {
    const profile = { id: "local-board", displayName: "Local Board", email: null };
    expect(isLocalTrustedProfile(profile)).toBe(true);
    expect(profileDisplayName(profile)).toBe("Local development");
    expect(profileFirstName(profile)).toBe("Local development");
  });

  it("preserves the real user's display name", () => {
    const profile = { id: "user-1", displayName: "Ada Lovelace", email: "ada@example.com" };
    expect(isLocalTrustedProfile(profile)).toBe(false);
    expect(profileDisplayName(profile)).toBe("Ada Lovelace");
    expect(profileFirstName(profile)).toBe("Ada");
  });

  it("falls back safely when a real profile is incomplete", () => {
    expect(profileDisplayName({ id: "user-1", displayName: "", email: "ada@example.com" })).toBe("ada@example.com");
    expect(profileDisplayName(undefined)).toBe("Account");
  });
});
