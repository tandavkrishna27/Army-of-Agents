import { describe, it, expect } from "vitest";
import { detectAuthFailure, isAuthFailure } from "./auth-failure-detector.js";

// The exact 401 observed on a live instance with a revoked Claude token.
const REVOKED_401 =
  'Failed to authenticate. API Error: 401 {"type":"error","error":' +
  '{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}';

describe("detectAuthFailure — expired/revoked credentials", () => {
  it("classifies the observed revoked-token 401 as expired", () => {
    expect(detectAuthFailure(REVOKED_401).kind).toBe("expired");
  });

  it("classifies an expired OAuth token as expired", () => {
    expect(detectAuthFailure("OAuth token expired, please re-authenticate").kind).toBe("expired");
  });

  it("classifies a bare 401 as expired", () => {
    expect(detectAuthFailure("API Error: 401").kind).toBe("expired");
  });

  it("classifies 403 as expired", () => {
    expect(detectAuthFailure("API Error: 403 Forbidden").kind).toBe("expired");
  });
});

describe("detectAuthFailure — never signed in", () => {
  it("classifies claude's not-logged-in message as signed_out", () => {
    expect(detectAuthFailure("You are not logged in. Please run `claude login`.").kind).toBe(
      "signed_out",
    );
  });

  it("classifies codex's login prompt as signed_out", () => {
    expect(detectAuthFailure("Not logged in. Please run `codex login`.").kind).toBe("signed_out");
  });

  it("classifies a generic login-required message as signed_out", () => {
    expect(detectAuthFailure("login required").kind).toBe("signed_out");
  });
});

describe("detectAuthFailure — bad key", () => {
  it("classifies an invalid API key as invalid_key", () => {
    expect(detectAuthFailure("Invalid API key provided").kind).toBe("invalid_key");
  });

  it("classifies a missing OPENAI_API_KEY as invalid_key", () => {
    expect(detectAuthFailure("OPENAI_API_KEY is missing").kind).toBe("invalid_key");
  });
});

// False positives send the founder to a sign-in screen that cannot help them,
// so non-auth failures MUST stay `none`.
describe("detectAuthFailure — must NOT over-match", () => {
  it("ignores rate limits", () => {
    expect(detectAuthFailure("API Error: 429 rate limit exceeded").kind).toBe("none");
  });

  it("ignores max-turns exhaustion", () => {
    expect(detectAuthFailure("Run stopped: maximum turns reached").kind).toBe("none");
  });

  it("ignores a 500", () => {
    expect(detectAuthFailure("API Error: 500 internal server error").kind).toBe("none");
  });

  it("ignores prose that merely discusses authorization", () => {
    expect(detectAuthFailure("Add an authorization header to the request handler.").kind).toBe(
      "none",
    );
  });

  it("returns none for empty input", () => {
    expect(detectAuthFailure("").kind).toBe("none");
  });

  it("does not treat a token count as a 5xx status", () => {
    expect(detectAuthFailure("Used 512 tokens.").kind).toBe("none");
  });
});

describe("detectAuthFailure — load-bearing precedence and noise-stripping", () => {
  it("prefers invalid_key over signed_out when both match", () =>
    expect(detectAuthFailure("Not logged in: invalid API key.").kind).toBe("invalid_key"));

  it("prefers signed_out over expired when both match", () =>
    expect(detectAuthFailure("Not logged in (401 unauthorized).").kind).toBe("signed_out"));

  it("keeps a real auth signal that co-occurs with a rate limit", () =>
    expect(detectAuthFailure("429 rate limited; then API Error: 401 authentication_error").kind).toBe(
      "expired",
    ));

  it("still detects sign-in need when the message also says timed out", () =>
    expect(detectAuthFailure("Login timed out. Please run `claude login`.").kind).toBe(
      "signed_out",
    ));

  it("still detects an invalid key when the message also says timed out", () =>
    expect(detectAuthFailure("Request timed out. Invalid API key provided.").kind).toBe(
      "invalid_key",
    ));

  it("still detects sign-out when the message also carries a 5xx", () =>
    expect(detectAuthFailure("API Error: 500. Also: not logged in.").kind).toBe("signed_out"));
});

// The loginUrl comes from the shared verification-URL extractor, which skips
// loopback callbacks. `codex login` prints its LOCAL callback before the real
// auth page, so a naive "first URL" match hands the founder a dead localhost
// link. Pinned here because the detector is what feeds the sign-in affordance.
describe("detectAuthFailure — loginUrl skips loopback callbacks", () => {
  it("returns the real auth URL, not the local callback codex prints first", () => {
    const out =
      "Starting local server at http://localhost:1455. " +
      "Open https://auth.openai.com/oauth?x=1 to continue. Not logged in.";
    expect(detectAuthFailure(out).loginUrl).toBe("https://auth.openai.com/oauth?x=1");
  });
});

describe("isAuthFailure", () => {
  it("is false only for none", () => {
    expect(isAuthFailure("none")).toBe(false);
    expect(isAuthFailure("signed_out")).toBe(true);
    expect(isAuthFailure("expired")).toBe(true);
    expect(isAuthFailure("invalid_key")).toBe(true);
  });
});

describe("detectAuthFailure — login URL", () => {
  it("extracts a verification URL when present", () => {
    const r = detectAuthFailure("Please log in at https://claude.ai/device/ABC-123 to continue");
    expect(r.kind).toBe("signed_out");
    expect(r.loginUrl).toBe("https://claude.ai/device/ABC-123");
  });

  it("strips ANSI controls from one-shot verification URLs", () => {
    const r = detectAuthFailure(
      "Not logged in. Open \u001b[4mhttps://auth.openai.com/codex/device\u001b[0m to continue.",
    );
    expect(r.kind).toBe("signed_out");
    expect(r.loginUrl).toBe("https://auth.openai.com/codex/device");
  });

  it("returns null loginUrl when absent", () => {
    expect(detectAuthFailure("not logged in").loginUrl).toBeNull();
  });
});
