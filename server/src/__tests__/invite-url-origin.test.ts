import { describe, expect, it } from "vitest";
import {
  isTrustProxyEnabled,
  requestBaseUrl,
  resolveInviteBaseUrl,
} from "../routes/access-helpers.js";

/**
 * Build a minimal Express-like request. `trustProxy` (when provided) is what
 * `req.app.get("trust proxy")` returns — the same value app.ts installs via
 * `app.set("trust proxy", config.trustProxy)`.
 */
function makeReq(opts: {
  protocol?: string;
  host?: string;
  forwardedProto?: string;
  forwardedHost?: string;
  trustProxy?: unknown;
  hasApp?: boolean;
}) {
  const headers: Record<string, string | undefined> = {
    host: opts.host,
    "x-forwarded-proto": opts.forwardedProto,
    "x-forwarded-host": opts.forwardedHost,
  };
  const app =
    opts.hasApp === false
      ? undefined
      : {
          get(name: string) {
            return name === "trust proxy" ? opts.trustProxy : undefined;
          },
        };
  return {
    protocol: opts.protocol ?? "http",
    header(name: string) {
      return headers[name.toLowerCase()];
    },
    app,
  };
}

describe("isTrustProxyEnabled", () => {
  it("treats a real reverse proxy as enabled and everything else as off", () => {
    expect(isTrustProxyEnabled(true)).toBe(true);
    expect(isTrustProxyEnabled(false)).toBe(false);
    expect(isTrustProxyEnabled(1)).toBe(true);
    expect(isTrustProxyEnabled(2)).toBe(true);
    expect(isTrustProxyEnabled(0)).toBe(false); // trust 0 hops = disabled
    expect(isTrustProxyEnabled(["10.0.0.0/8"])).toBe(true);
    expect(isTrustProxyEnabled([])).toBe(false);
    expect(isTrustProxyEnabled(undefined)).toBe(false);
    expect(isTrustProxyEnabled(null)).toBe(false);
    expect(isTrustProxyEnabled("loopback")).toBe(true);
    expect(isTrustProxyEnabled("false")).toBe(false);
    expect(isTrustProxyEnabled("")).toBe(false);
  });
});

describe("requestBaseUrl", () => {
  it("does NOT honor a spoofed X-Forwarded-Host when trust proxy is off", () => {
    const req = makeReq({
      host: "app.internal:3100",
      forwardedProto: "https",
      forwardedHost: "evil.com",
      trustProxy: false,
    });
    const url = requestBaseUrl(req);
    expect(url).not.toContain("evil.com");
    // Falls back to the real connection Host header, not the spoofed one.
    expect(url).toBe("http://app.internal:3100");
  });

  it("defaults its trust-proxy source to req.app.get('trust proxy')", () => {
    // No opts: the untrusted app setting must gate the forwarded header.
    const spoofed = makeReq({
      host: "app.internal:3100",
      forwardedHost: "evil.com",
      trustProxy: false,
    });
    expect(requestBaseUrl(spoofed)).toBe("http://app.internal:3100");

    // Legit reverse proxy: app.get('trust proxy') is truthy → forwarded honored.
    const proxied = makeReq({
      host: "app.internal:3100",
      forwardedProto: "https",
      forwardedHost: "aoa.example.com",
      trustProxy: 1,
    });
    expect(requestBaseUrl(proxied)).toBe("https://aoa.example.com");
  });

  it("honors X-Forwarded-* when trust proxy is explicitly enabled", () => {
    const req = makeReq({
      host: "app.internal:3100",
      forwardedProto: "https",
      forwardedHost: "aoa.example.com",
    });
    expect(requestBaseUrl(req, { trustProxy: true })).toBe("https://aoa.example.com");
  });

  it("uses the Host header when trust proxy is on but no forwarded host is present", () => {
    const req = makeReq({ host: "app.internal:3100", protocol: "https" });
    expect(requestBaseUrl(req, { trustProxy: true })).toBe("https://app.internal:3100");
  });

  it("returns an empty string (→ relative) when there is no host at all", () => {
    const req = makeReq({ forwardedHost: "evil.com", trustProxy: false });
    expect(requestBaseUrl(req)).toBe("");
  });

  it("ignores a forwarded host even when req has no app object", () => {
    const req = makeReq({ host: "localhost:3100", forwardedHost: "evil.com", hasApp: false });
    expect(requestBaseUrl(req)).toBe("http://localhost:3100");
  });
});

describe("resolveInviteBaseUrl", () => {
  it("uses the configured public origin regardless of spoofed headers", () => {
    const req = makeReq({
      host: "app.internal:3100",
      forwardedProto: "https",
      forwardedHost: "evil.com",
      trustProxy: true, // even a trusted proxy must not override the config origin
    });
    const url = resolveInviteBaseUrl(req, { publicBaseUrl: "https://aoa.example.com" });
    expect(url).toBe("https://aoa.example.com");
    expect(url).not.toContain("evil.com");
  });

  it("normalizes the configured public URL to its origin (drops path/trailing slash)", () => {
    const req = makeReq({ host: "app.internal:3100" });
    expect(
      resolveInviteBaseUrl(req, { publicBaseUrl: "https://aoa.example.com/app/" }),
    ).toBe("https://aoa.example.com");
  });

  it("does NOT point at a spoofed X-Forwarded-Host when there is no config and trust proxy is off", () => {
    const req = makeReq({
      host: "app.internal:3100",
      forwardedHost: "evil.com",
      trustProxy: false,
    });
    const url = resolveInviteBaseUrl(req, { publicBaseUrl: null });
    expect(url).not.toContain("evil.com");
    expect(url).toBe("http://app.internal:3100");
  });

  it("falls back to a relative path (empty base) with no config and no host", () => {
    const req = makeReq({ forwardedHost: "evil.com", trustProxy: false });
    expect(resolveInviteBaseUrl(req, { publicBaseUrl: null })).toBe("");
  });

  it("honors a trusted reverse proxy when no public URL is configured", () => {
    const req = makeReq({
      host: "app.internal:3100",
      forwardedProto: "https",
      forwardedHost: "aoa.example.com",
      trustProxy: 1,
    });
    expect(resolveInviteBaseUrl(req, { publicBaseUrl: null })).toBe("https://aoa.example.com");
  });

  it("falls through to secure header derivation when the configured URL is malformed", () => {
    const req = makeReq({ host: "app.internal:3100", forwardedHost: "evil.com", trustProxy: false });
    const url = resolveInviteBaseUrl(req, { publicBaseUrl: "not a url" });
    expect(url).toBe("http://app.internal:3100");
    expect(url).not.toContain("evil.com");
  });
});
