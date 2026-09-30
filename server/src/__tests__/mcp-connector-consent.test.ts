import { describe, it, expect } from "vitest";
import {
  mintConsentToken,
  verifyConsentToken,
  CONSENT_TOKEN_TTL_MS,
} from "../services/mcp-connector-consent.js";

const SECRET = "test-signing-secret";
const cmd = { command: "npx", args: ["-y", "acme-db-tool"] };

/** Deliberately loose — these tests feed shapes the declared type forbids. */
type ConsentCommandLike = { command: string; args?: string[] };

describe("consent token", () => {
  it("round-trips for the exact command it was minted for", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000).ok).toBe(true);
  });

  it("REJECTS a token bound to a different command", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const evil = { command: "npx", args: ["-y", "evil-package"] };
    expect(verifyConsentToken(SECRET, "acme", evil, t, 1_000_000).ok).toBe(false);
  });

  it("rejects a token for a different connector id", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "other", cmd, t, 1_000_000).ok).toBe(false);
  });

  it("rejects an expired token", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000 + 16 * 60_000).ok).toBe(false);
  });

  it("rejects a forged token", () => {
    expect(verifyConsentToken(SECRET, "acme", cmd, "not.a.token", 1_000_000).ok).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const t = mintConsentToken("other-secret", "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adversarial cases — everything below models something an attacker controls:
// the catalog entry (id/command/args), the token bytes on the wire, or the
// clock they claim.
// ---------------------------------------------------------------------------

describe("consent token — adversarial", () => {
  it("binds arg ORDER: ['a','b'] does not validate a token minted for ['b','a']", () => {
    const ab = mintConsentToken(SECRET, "acme", { command: "npx", args: ["a", "b"] }, 1_000_000);
    const ba = mintConsentToken(SECRET, "acme", { command: "npx", args: ["b", "a"] }, 1_000_000);
    expect(ab).not.toBe(ba);
    expect(
      verifyConsentToken(SECRET, "acme", { command: "npx", args: ["b", "a"] }, ab, 1_000_000).ok,
    ).toBe(false);
    expect(
      verifyConsentToken(SECRET, "acme", { command: "npx", args: ["a", "b"] }, ba, 1_000_000).ok,
    ).toBe(false);
  });

  it("resists delimiter collision: ['a b'] and ['a','b'] mint different tokens", () => {
    // A naive `args.join(" ")` payload would make these two IDENTICAL, letting a
    // founder who approved one argv shape authorise a materially different one.
    const joined = mintConsentToken(SECRET, "acme", { command: "npx", args: ["a b"] }, 1_000_000);
    const split = mintConsentToken(SECRET, "acme", { command: "npx", args: ["a", "b"] }, 1_000_000);
    expect(joined).not.toBe(split);
    expect(
      verifyConsentToken(SECRET, "acme", { command: "npx", args: ["a", "b"] }, joined, 1_000_000).ok,
    ).toBe(false);
    expect(
      verifyConsentToken(SECRET, "acme", { command: "npx", args: ["a b"] }, split, 1_000_000).ok,
    ).toBe(false);
  });

  it("resists delimiter collision between entryId and command", () => {
    // Same class as above, one field up: a `${entryId}:${command}` payload would
    // collide these. JSON-array framing keeps them distinct.
    const a = mintConsentToken(SECRET, "acme:npx", { command: "tool", args: [] }, 1_000_000);
    const b = mintConsentToken(SECRET, "acme", { command: "npx:tool", args: [] }, 1_000_000);
    expect(a).not.toBe(b);
  });

  it("binds the command itself, not just the args", () => {
    const t = mintConsentToken(SECRET, "acme", { command: "npx", args: ["-y", "x"] }, 1_000_000);
    expect(
      verifyConsentToken(SECRET, "acme", { command: "bash", args: ["-y", "x"] }, t, 1_000_000).ok,
    ).toBe(false);
  });

  it("rejects a token whose expiry was raised while keeping the original mac", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const [exp, mac] = t.split(".");
    const tampered = `${Number(exp) + 10 * 365 * 24 * 60 * 60_000}.${mac}`;
    const res = verifyConsentToken(SECRET, "acme", cmd, tampered, 1_000_000);
    expect(res.ok).toBe(false);
    // Must fail on the SIGNATURE, not merely on the clock — proving the expiry
    // is inside the signed payload rather than an unauthenticated prefix.
    expect(res.reason).toBe("signature_mismatch");
  });

  it("rejects a token whose expiry was lowered while keeping the original mac", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const [exp, mac] = t.split(".");
    const tampered = `${Number(exp) - 1}.${mac}`;
    expect(verifyConsentToken(SECRET, "acme", cmd, tampered, 1_000_000).ok).toBe(false);
  });

  it("rejects a mac of the correct length but wrong content", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const [exp, mac] = t.split(".");
    expect(mac).toHaveLength(64);
    const flipped = (mac[0] === "a" ? "b" : "a") + mac.slice(1);
    expect(flipped).toHaveLength(64);
    const res = verifyConsentToken(SECRET, "acme", cmd, `${exp}.${flipped}`, 1_000_000);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("signature_mismatch");
  });

  it("rejects a mac that is not valid hex (never throws in timingSafeEqual)", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const exp = t.split(".")[0];
    for (const bad of ["z".repeat(64), "zz", "", "0x" + "a".repeat(62), "A".repeat(64)]) {
      const res = verifyConsentToken(SECRET, "acme", cmd, `${exp}.${bad}`, 1_000_000);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("malformed");
    }
  });

  it("rejects a mac that is the right hex alphabet but the wrong length", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const [exp, mac] = t.split(".");
    for (const bad of [mac.slice(0, 62), mac + "ab"]) {
      expect(verifyConsentToken(SECRET, "acme", cmd, `${exp}.${bad}`, 1_000_000).ok).toBe(false);
    }
  });

  it("rejects structurally broken tokens without throwing", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "1000000",
      ".abc",
      "1000000.",
      "notanumber.abc",
      "-1.abc",
      "1e9.abc",
      " 1000000.abc",
    ]) {
      expect(() => verifyConsentToken(SECRET, "acme", cmd, bad, 1_000_000)).not.toThrow();
      expect(verifyConsentToken(SECRET, "acme", cmd, bad, 1_000_000).ok).toBe(false);
    }
  });

  it("rejects a non-string token", () => {
    expect(verifyConsentToken(SECRET, "acme", cmd, undefined as unknown as string, 1_000_000).ok).toBe(
      false,
    );
    expect(verifyConsentToken(SECRET, "acme", cmd, 12345 as unknown as string, 1_000_000).ok).toBe(
      false,
    );
  });

  it("rejects an empty signing secret rather than minting an unprotected token", () => {
    expect(() => mintConsentToken("", "acme", cmd, 1_000_000)).toThrow();
    expect(verifyConsentToken("", "acme", cmd, "1.a", 1_000_000).ok).toBe(false);
  });

  it("is valid right up to the TTL boundary and invalid one millisecond later", () => {
    const t = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000 + CONSENT_TOKEN_TTL_MS).ok).toBe(true);
    const res = verifyConsentToken(SECRET, "acme", cmd, t, 1_000_000 + CONSENT_TOKEN_TTL_MS + 1);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("expired");
  });

  it("uses a 15-minute TTL", () => {
    expect(CONSENT_TOKEN_TTL_MS).toBe(15 * 60_000);
  });

  it("treats an absent args array as an empty one, and binds it", () => {
    const t = mintConsentToken(SECRET, "acme", { command: "npx" }, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", { command: "npx", args: [] }, t, 1_000_000).ok).toBe(
      true,
    );
    expect(verifyConsentToken(SECRET, "acme", { command: "npx", args: ["x"] }, t, 1_000_000).ok).toBe(
      false,
    );
  });

  it("closes the undefined/null arg collision — the one real cross-command hole", () => {
    // JSON.stringify serialises an IN-ARRAY `undefined` as `null`, so
    // ["a", undefined] and ["a", null] frame to byte-identical payloads. That
    // is a genuine "token minted for one command validates another". Both
    // violate the declared type, but this primitive is fed request bodies, so
    // it must fail closed rather than trust TypeScript.
    const sneaky = { command: "npx", args: ["a", undefined] } as unknown as {
      command: string;
      args: string[];
    };
    const nulled = { command: "npx", args: ["a", null] } as unknown as {
      command: string;
      args: string[];
    };

    expect(() => mintConsentToken(SECRET, "acme", sneaky, 1_000_000)).toThrow();
    expect(() => mintConsentToken(SECRET, "acme", nulled, 1_000_000)).toThrow();

    // And a well-formed token can never be redeemed against either shape.
    const good = mintConsentToken(SECRET, "acme", { command: "npx", args: ["a", "b"] }, 1_000_000);
    expect(verifyConsentToken(SECRET, "acme", sneaky, good, 1_000_000)).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(verifyConsentToken(SECRET, "acme", nulled, good, 1_000_000)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("fails closed on any non-string signed field", () => {
    const good = mintConsentToken(SECRET, "acme", cmd, 1_000_000);
    const bad: Array<[unknown, unknown]> = [
      [{ command: 42, args: [] }, "acme"],
      [{ command: "npx", args: "not-an-array" }, "acme"],
      [{ command: "npx", args: [{ toString: () => "-y" }] }, "acme"],
      [{ args: [] }, "acme"],
      [cmd, 42],
      [cmd, null],
    ];
    for (const [c, id] of bad) {
      expect(() =>
        mintConsentToken(SECRET, id as string, c as ConsentCommandLike, 1_000_000),
      ).toThrow();
      expect(
        verifyConsentToken(SECRET, id as string, c as ConsentCommandLike, good, 1_000_000).ok,
      ).toBe(false);
    }
  });

  it("does not treat a prefix of the args as a match", () => {
    const t = mintConsentToken(SECRET, "acme", { command: "npx", args: ["-y", "pkg"] }, 1_000_000);
    expect(
      verifyConsentToken(SECRET, "acme", { command: "npx", args: ["-y"] }, t, 1_000_000).ok,
    ).toBe(false);
    expect(
      verifyConsentToken(
        SECRET,
        "acme",
        { command: "npx", args: ["-y", "pkg", "--extra"] },
        t,
        1_000_000,
      ).ok,
    ).toBe(false);
  });
});
