import { describe, it, expect } from "vitest";
import { redactSecretsInString } from "../redaction.js";
describe("redactSecretsInString", () => {
  it("strips an OpenAI/Anthropic-style key embedded in free text", () => {
    const out = redactSecretsInString("probe failed: key sk-ant-abc123DEF456ghi789 was rejected");
    expect(out).not.toContain("sk-ant-abc123DEF456ghi789");
    expect(out).toContain("***REDACTED***");
  });
  it("leaves ordinary text untouched", () => {
    expect(redactSecretsInString("Codex hello probe succeeded.")).toBe("Codex hello probe succeeded.");
  });
  it("redacts a whitespace-delimited JWT token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactSecretsInString(`token ${jwt} end`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("***REDACTED***");
  });
  // Codex P2: a JWT adjacent to punctuation (token=…, Authorization:…) is missed
  // by the whitespace-tokenized anchored pass — must be redacted in context.
  it("redacts a JWT embedded in punctuation (token=…, Authorization:…)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    for (const ctx of [`token=${jwt}`, `Authorization:${jwt}`, `(${jwt})`, `"${jwt}"`]) {
      const out = redactSecretsInString(`probe error: ${ctx} rejected`);
      expect(out).not.toContain(jwt);
      expect(out).toContain("***REDACTED***");
    }
  });
  it("does NOT over-redact a punctuation-adjacent dotted non-JWT (eyJ-anchored precision)", () => {
    // A generic in-context x.y.z matcher would redact `config=1.2.3`; the
    // eyJ anchor keeps non-JWT dotted values intact (and the token-wise pass
    // can't match it either — the `config=` prefix breaks the anchored regex).
    expect(redactSecretsInString("set config=1.2.3 then run")).toBe("set config=1.2.3 then run");
  });
  it("redacts an ENTIRE PEM private key block — header + base64 body + footer (Codex P2)", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn+abcd1234\n" +
      "EFGHijklMNOP+/qrstuvWXYZ0987654321==\n" +
      "-----END RSA PRIVATE KEY-----";
    const out = redactSecretsInString(`probe error: ${pem} (rejected)`);
    expect(out).not.toContain("MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn"); // body must be gone
    expect(out).not.toContain("EFGHijklMNOP+/qrstuvWXYZ0987654321");
    expect(out).not.toContain("-----END RSA PRIVATE KEY-----"); // footer must be gone
    expect(out).toContain("***REDACTED***");
  });
});
