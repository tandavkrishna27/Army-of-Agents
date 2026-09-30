import { describe, expect, it } from "vitest";
import { detectClaudeLoginRequired } from "./parse.js";

describe("detectClaudeLoginRequired", () => {
  describe("expired credentials (regression)", () => {
    const REVOKED_401 =
      'Failed to authenticate. API Error: 401 {"type":"error","error":' +
      '{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}';

    it("treats a revoked token as requiring login", () => {
      const r = detectClaudeLoginRequired({ parsed: null, stdout: REVOKED_401, stderr: "", exitCode: 1 });
      expect(r.requiresLogin).toBe(true);
    });

    it("reports kind=expired for a revoked token, not signed_out", () => {
      const r = detectClaudeLoginRequired({ parsed: null, stdout: REVOKED_401, stderr: "", exitCode: 1 });
      expect(r.kind).toBe("expired");
    });

    it("still reports kind=signed_out when never signed in", () => {
      const r = detectClaudeLoginRequired({
        parsed: null,
        stdout: "You are not logged in. Please run `claude login`.",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(true);
      expect(r.kind).toBe("signed_out");
    });

    it("does not flag a rate limit as a login problem", () => {
      const r = detectClaudeLoginRequired({
        parsed: null,
        stdout: "API Error: 429 rate limit exceeded",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(false);
      expect(r.kind).toBe("none");
    });
  });

  describe("input contract (transcript must not classify)", () => {
    it("ignores agent prose about expiry on a SUCCESSFUL run", () => {
      const r = detectClaudeLoginRequired({
        parsed: { result: "I fixed the bug where the cache entry expired too early." },
        stdout: "I fixed the bug where the cache entry expired too early.",
        stderr: "",
        exitCode: 0,
      });
      expect(r.requiresLogin).toBe(false);
      expect(r.kind).toBe("none");
    });

    it("ignores agent prose about 401 handling on a SUCCESSFUL run", () => {
      const r = detectClaudeLoginRequired({
        parsed: { result: "Added a handler returning 401 for missing sessions." },
        stdout: "Added a handler returning 401 for missing sessions.",
        stderr: "",
        exitCode: 0,
      });
      expect(r.requiresLogin).toBe(false);
    });

    it("never classifies from parsed.result even when the process failed", () => {
      const r = detectClaudeLoginRequired({
        parsed: { result: "I described how tokens get revoked in the docs." },
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(false);
    });

    // The real failure mode this feature exists to catch: the 401 arrives on
    // STDOUT of a failed process, not stderr.
    it("still detects the revoked-token 401 that arrives on stdout of a failed run", () => {
      const r = detectClaudeLoginRequired({
        parsed: null,
        stdout:
          'Failed to authenticate. API Error: 401 {"type":"error","error":' +
          '{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}',
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(true);
      expect(r.kind).toBe("expired");
    });

    // extractClaudeErrorMessages() reads `parsed.errors` — an array of
    // strings, or objects with a `message`/`error`/`code` field. It does NOT
    // read a top-level `parsed.error` object, so the fixture below uses the
    // shape the function actually consumes.
    it("detects auth errors from the parsed CLI error fields", () => {
      const r = detectClaudeLoginRequired({
        parsed: { errors: [{ message: "401 authentication_error" }] },
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(true);
    });

    it("still detects auth errors on stderr regardless of exit code", () => {
      const r = detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "You are not logged in. Please run `claude login`.",
        exitCode: 0,
      });
      expect(r.requiresLogin).toBe(true);
      expect(r.kind).toBe("signed_out");
    });

    it("preserves legacy behaviour when exitCode is not supplied", () => {
      const r = detectClaudeLoginRequired({
        parsed: null,
        stdout: "API Error: 401 authentication_error",
        stderr: "",
      });
      expect(r.requiresLogin).toBe(true);
    });

    // codex prints its local loopback callback (http://localhost:1455) before
    // the real auth URL; the shared detector's loginUrl skips loopback hosts.
    // Confirm a loopback-only failure never yields a bogus localhost link.
    it("does not surface a loopback-only URL as the login URL", () => {
      const r = detectClaudeLoginRequired({
        parsed: null,
        stdout: "Failed to authenticate. API Error: 401 unauthorized. See http://localhost:1455 for details.",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(true);
      expect(r.loginUrl).toBeNull();
    });
  });

  describe("structured api_error_status field", () => {
    // Field evidence: `subtype` is misleadingly "success" even on an auth
    // failure; `is_error`+`api_error_status` are the real signal.
    it("classifies as expired from api_error_status:401 even though subtype says success", () => {
      const r = detectClaudeLoginRequired({
        parsed: { type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Failed to authenticate." },
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(true);
      expect(r.kind).toBe("expired");
    });

    it("classifies as expired from api_error_status:403", () => {
      const r = detectClaudeLoginRequired({
        parsed: { api_error_status: 403 },
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
      expect(r.kind).toBe("expired");
    });

    it("overrides a text-detected signed_out kind when the structured field says 401", () => {
      const r = detectClaudeLoginRequired({
        parsed: { api_error_status: 401 },
        stdout: "You are not logged in. Please run `claude login`.",
        stderr: "",
        exitCode: 1,
      });
      expect(r.kind).toBe("expired");
    });

    it("ignores a non-auth api_error_status like 500", () => {
      const r = detectClaudeLoginRequired({
        parsed: { api_error_status: 500 },
        stdout: "internal server error",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(false);
      expect(r.kind).toBe("none");
    });

    it("ignores a null api_error_status (the success shape) without throwing", () => {
      const r = detectClaudeLoginRequired({
        parsed: { api_error_status: null },
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      expect(r.requiresLogin).toBe(false);
    });

    // Regression: a successful (exit 0) run must never be reclassified as an
    // auth failure just because it carries a stale/leftover api_error_status
    // field. The structured-field override is only trustworthy on a run that
    // actually failed — on exit 0 it must be ignored exactly like the text
    // detector already is.
    it("does not classify a successful run as expired even with a stale api_error_status:401", () => {
      const r = detectClaudeLoginRequired({
        parsed: { api_error_status: 401, result: "hello" },
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
      expect(r.requiresLogin).toBe(false);
      expect(r.kind).toBe("none");
    });

    it("still reports expired from api_error_status:401 on a FAILED run", () => {
      const r = detectClaudeLoginRequired({
        parsed: { api_error_status: 401, result: "Failed to authenticate." },
        stdout: "",
        stderr: "",
        exitCode: 1,
      });
      expect(r.requiresLogin).toBe(true);
      expect(r.kind).toBe("expired");
    });
  });
});
