import { describe, it, expect } from "vitest";
import { createLoginUrlDetector, isLoopbackUrl } from "./login-url-detector.js";

describe("createLoginUrlDetector (Plan 3 T3)", () => {
  it("extracts a verification URL printed on a single line", () => {
    const d = createLoginUrlDetector();
    expect(d.push("Visit https://claude.ai/oauth/authorize?code=abc123 to continue\n")).toBe(
      "https://claude.ai/oauth/authorize?code=abc123",
    );
  });

  it("waits for the URL to complete when split across chunks (no premature match)", () => {
    const d = createLoginUrlDetector();
    // First chunk ends mid-URL — must NOT return a truncated URL.
    expect(d.push("Open https://chatgpt.com/device?user_c")).toBeNull();
    // The rest + a terminator arrives — now the full URL is returned.
    expect(d.push("ode=WXYZ-1234\nWaiting for you to sign in…")).toBe(
      "https://chatgpt.com/device?user_code=WXYZ-1234",
    );
  });

  it("returns null when the URL has no trailing terminator yet (still streaming)", () => {
    const d = createLoginUrlDetector();
    expect(d.push("https://claude.ai/oauth?x=1")).toBeNull(); // could still be growing
    expect(d.push("\n")).toBe("https://claude.ai/oauth?x=1");
  });

  it("returns null for output with no URL", () => {
    const d = createLoginUrlDetector();
    expect(d.push("Checking credentials…\nDone\n")).toBeNull();
  });

  it("is idempotent once found (subsequent pushes keep returning the same URL)", () => {
    const d = createLoginUrlDetector();
    expect(d.push("go to https://claude.ai/oauth?a=b \n")).toBe("https://claude.ai/oauth?a=b");
    expect(d.push("more logs\n")).toBe("https://claude.ai/oauth?a=b");
    expect(d.url).toBe("https://claude.ai/oauth?a=b");
  });

  it("does not let later log noise overwrite the login URL", () => {
    const d = createLoginUrlDetector();
    expect(d.push("Sign in at https://claude.ai/oauth?first=1\n")).toBe("https://claude.ai/oauth?first=1");
    expect(d.push("callback hit https://example.com/other?x=2\n")).toBe("https://claude.ai/oauth?first=1");
  });

  it("skips the loopback callback URL and returns the real auth URL (codex flow)", () => {
    const d = createLoginUrlDetector();
    // codex prints its local callback server FIRST, then the real auth URL.
    const first = d.push("Starting local login server on http://localhost:1455.\n");
    expect(first).toBeNull(); // loopback is not a verification URL
    const real = d.push(
      "If your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?client_id=abc&state=xyz\n",
    );
    expect(real).toBe("https://auth.openai.com/oauth/authorize?client_id=abc&state=xyz");
  });

  it("ignores 127.0.0.1 / [::1] loopback hosts too", () => {
    const d = createLoginUrlDetector();
    expect(d.push("server on http://127.0.0.1:8080/cb and http://[::1]:9/x\n")).toBeNull();
    expect(d.push("auth: https://auth.openai.com/go\n")).toBe("https://auth.openai.com/go");
  });

  it("trims trailing sentence punctuation from the matched URL", () => {
    const d = createLoginUrlDetector();
    expect(d.push("Go to https://claude.ai/oauth?a=b.\n")).toBe("https://claude.ai/oauth?a=b");
  });

  it("strips ANSI controls around a Codex device URL, including a split escape sequence", () => {
    const afterEsc = createLoginUrlDetector();
    expect(afterEsc.push("Open \u001b[4mhttps://auth.openai.com/codex/dev\u001b")).toBeNull();
    expect(afterEsc.push("[0mice")).toBeNull();
    expect(afterEsc.push("\u001b[0m in your browser.\n")).toBe(
      "https://auth.openai.com/codex/device",
    );

    const afterCsi = createLoginUrlDetector();
    expect(afterCsi.push("Open https://auth.openai.com/codex/dev\u001b[")).toBeNull();
    expect(afterCsi.push("0mice\n")).toBe("https://auth.openai.com/codex/device");
  });
});

describe("isLoopbackUrl", () => {
  it.each([
    ["http://localhost:1455/cb", "localhost"],
    ["http://sub.localhost:3000/x", ".localhost TLD"],
    ["http://127.0.0.1:8080/cb", "127.0.0.1"],
    ["http://127.9.9.9:1/x", "whole 127/8 block"],
    ["http://[::1]:9/x", "IPv6 [::1]"],
    ["http://0.0.0.0:80/x", "0.0.0.0"],
    ["http://[::ffff:127.0.0.1]:1/x", "IPv4-mapped IPv6 loopback"],
  ])("treats %s as loopback (%s)", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    ["https://claude.ai/oauth/authorize?code=abc123", "real claude.ai URL"],
    ["https://auth.openai.com/oauth/authorize?client_id=abc", "real auth.openai.com URL"],
  ])("does not treat %s as loopback (%s)", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it("returns false (not filtered) for an unparseable URL instead of throwing", () => {
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
