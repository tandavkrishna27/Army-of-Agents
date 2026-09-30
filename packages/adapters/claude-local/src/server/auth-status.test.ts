import { describe, it, expect } from "vitest";
import { parseClaudeAuthStatus } from "./auth-status.js";

describe("parseClaudeAuthStatus", () => {
  it("reads a logged-in account", () => {
    const out = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "ada@example.com",
      subscriptionType: "max",
    });
    expect(parseClaudeAuthStatus(out)).toEqual({ loggedIn: true, account: "ada@example.com" });
  });

  it("reads a logged-in account with no email", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true }))).toEqual({
      loggedIn: true,
      account: null,
    });
  });

  it("reads a logged-out state", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({
      loggedIn: false,
      account: null,
    });
  });

  // An older CLI without `auth status` prints usage text or an error. We must
  // degrade to "assume signed out" rather than throw inside the probe.
  it("treats unparseable output as not-logged-in instead of throwing", () => {
    expect(parseClaudeAuthStatus("error: unknown command 'auth'")).toEqual({
      loggedIn: false,
      account: null,
    });
  });

  it("treats empty output as not-logged-in", () => {
    expect(parseClaudeAuthStatus("")).toEqual({ loggedIn: false, account: null });
  });

  it("tolerates surrounding log noise around the JSON", () => {
    const out = 'warning: config\n{"loggedIn":true,"email":"ada@example.com"}\n';
    expect(parseClaudeAuthStatus(out)).toEqual({ loggedIn: true, account: "ada@example.com" });
  });

  it("does not throw on null or undefined input", () => {
    expect(parseClaudeAuthStatus(null as unknown as string)).toEqual({ loggedIn: false, account: null });
    expect(parseClaudeAuthStatus(undefined as unknown as string)).toEqual({ loggedIn: false, account: null });
  });

  it("parses when a brace-bearing warning follows the JSON", () => {
    const out = '{"loggedIn":true,"email":"ada@example.com"}\nwarn: check {config}';
    expect(parseClaudeAuthStatus(out)).toEqual({ loggedIn: true, account: "ada@example.com" });
  });

  it("parses the real multi-line pretty-printed CLI payload", () => {
    const out = [
      "{",
      '  "loggedIn": true,',
      '  "authMethod": "claude.ai",',
      '  "apiProvider": "firstParty",',
      '  "email": "ada@example.com",',
      '  "subscriptionType": "max"',
      "}",
    ].join("\n");
    expect(parseClaudeAuthStatus(out)).toEqual({ loggedIn: true, account: "ada@example.com" });
  });
});
