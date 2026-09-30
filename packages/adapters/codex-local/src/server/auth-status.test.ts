import { describe, expect, it } from "vitest";
import { parseCodexAuthStatus, CODEX_AUTH_STATUS_ARGS } from "./auth-status.js";

describe("parseCodexAuthStatus", () => {
  it("parses 'Not logged in' as signed out", () => {
    expect(parseCodexAuthStatus("Not logged in")).toEqual({ loggedIn: false, account: null });
  });

  it("is case-insensitive for the not-logged-in phrase", () => {
    expect(parseCodexAuthStatus("not logged in")).toEqual({ loggedIn: false, account: null });
    expect(parseCodexAuthStatus("NOT LOGGED IN")).toEqual({ loggedIn: false, account: null });
  });

  it("parses 'Logged in using <method>' with the method as the account", () => {
    expect(parseCodexAuthStatus("Logged in using ChatGPT")).toEqual({
      loggedIn: true,
      account: "ChatGPT",
    });
  });

  it("parses 'Logged in using an API key'", () => {
    expect(parseCodexAuthStatus("Logged in using an API key")).toEqual({
      loggedIn: true,
      account: "an API key",
    });
  });

  it("is case-insensitive for the logged-in-using phrase", () => {
    expect(parseCodexAuthStatus("logged in using chatgpt")).toEqual({
      loggedIn: true,
      account: "chatgpt",
    });
  });

  it("strips trailing punctuation and whitespace from the method", () => {
    expect(parseCodexAuthStatus("Logged in using ChatGPT.\n")).toEqual({
      loggedIn: true,
      account: "ChatGPT",
    });
  });

  it("parses a bare 'Logged in' line with no method as logged in, no account", () => {
    expect(parseCodexAuthStatus("Logged in")).toEqual({ loggedIn: true, account: null });
  });

  it("checks not-logged-in BEFORE logged-in, since the former contains the latter as a substring", () => {
    // "Not logged in" contains "logged in" — must not be misread as loggedIn: true.
    expect(parseCodexAuthStatus("Not logged in")).toEqual({ loggedIn: false, account: null });
  });

  it("returns signed-out for empty output", () => {
    expect(parseCodexAuthStatus("")).toEqual({ loggedIn: false, account: null });
  });

  it("returns signed-out for whitespace-only output", () => {
    expect(parseCodexAuthStatus("   \n\t  ")).toEqual({ loggedIn: false, account: null });
  });

  it("returns signed-out for null input, without throwing", () => {
    expect(parseCodexAuthStatus(null as unknown as string)).toEqual({ loggedIn: false, account: null });
  });

  it("returns signed-out for undefined input, without throwing", () => {
    expect(parseCodexAuthStatus(undefined)).toEqual({ loggedIn: false, account: null });
  });

  it("returns signed-out for unrecognised/error output", () => {
    expect(parseCodexAuthStatus("error: unknown command 'login'")).toEqual({
      loggedIn: false,
      account: null,
    });
  });

  it("only reads the first non-empty line, ignoring trailing noise", () => {
    expect(parseCodexAuthStatus("Logged in using ChatGPT\nSomething else entirely")).toEqual({
      loggedIn: true,
      account: "ChatGPT",
    });
  });

  it("skips a leading warning banner to find the real status line", () => {
    // A banner before the actual status (e.g. a deprecation warning) must not
    // shadow the real status — a revoked user must not see "not signed in
    // yet" just because line 1 wasn't the status line.
    expect(parseCodexAuthStatus("warning: config deprecated\nLogged in using ChatGPT")).toEqual({
      loggedIn: true,
      account: "ChatGPT",
    });
  });

  it("finds the status line after multiple lines of noise", () => {
    expect(
      parseCodexAuthStatus(
        "warning: config deprecated\nnote: using default profile\nsome extra CLI banner line\nNot logged in",
      ),
    ).toEqual({ loggedIn: false, account: null });
  });

  it("returns a fresh object on every call, not a shared reference", () => {
    const a = parseCodexAuthStatus("Not logged in");
    const b = parseCodexAuthStatus("Not logged in");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    (a as { loggedIn: boolean }).loggedIn = true;
    expect(b.loggedIn).toBe(false);
  });

  it("exposes the status args used to spawn the probe", () => {
    expect(CODEX_AUTH_STATUS_ARGS).toEqual(["login", "status"]);
  });
});
