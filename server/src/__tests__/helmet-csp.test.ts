import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import helmet from "helmet";
import { buildHelmetOptions } from "../services/helmet-options.js";

describe("buildHelmetOptions — production CSP shape", () => {
  it("emits a strict directive set for `authenticated` mode", () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: ["abcd1234"],
    });

    expect(opts.contentSecurityPolicy).not.toBe(false);
    if (opts.contentSecurityPolicy === false || !opts.contentSecurityPolicy) {
      throw new Error("expected CSP enabled in authenticated mode");
    }
    const directives = opts.contentSecurityPolicy.directives as Record<string, string[]>;

    // default-src locks everything to self by default
    expect(directives["default-src"]).toEqual(["'self'"]);

    // script-src includes self + each inline-script hash, no unsafe-inline / unsafe-eval
    expect(directives["script-src"]).toContain("'self'");
    expect(directives["script-src"]).toContain("'sha256-abcd1234'");
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["script-src"]).not.toContain("'unsafe-eval'");

    // style-src — Vite emits inline <style> via dynamic injection in prod, so
    // we accept 'unsafe-inline' for stylesheets only (we own the build).
    expect(directives["style-src"]).toContain("'self'");
    expect(directives["style-src"]).toContain("'unsafe-inline'");

    // img-src allows data:, blob:, https: for avatar generators / asset previews
    expect(directives["img-src"]).toEqual(
      expect.arrayContaining(["'self'", "data:", "blob:", "https:"]),
    );

    // font-src allows data: for inline fonts
    expect(directives["font-src"]).toEqual(expect.arrayContaining(["'self'", "data:"]));

    // connect-src is locked to 'self' only — UI never calls LLM APIs directly,
    // all LLM traffic goes through the AoA backend.
    expect(directives["connect-src"]).toEqual(["'self'"]);

    // Locked-down directives — these are the security wins the rest of the
    // config exists to support.
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'self'"]);
    expect(directives["form-action"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
  });

  it("emits CSP for `cloud_auth` mode (any non-local-trusted)", () => {
    const opts = buildHelmetOptions({
      deploymentMode: "cloud_auth",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    expect(opts.contentSecurityPolicy).not.toBe(false);
  });

  it("emits CSP for `local_trusted` mode when nodeEnv is `production` (built bundle)", () => {
    // local_trusted + production node env = served from a built UI bundle.
    // Strict CSP applies because the inline scripts are stable (Vite output).
    const opts = buildHelmetOptions({
      deploymentMode: "local_trusted",
      nodeEnv: "production",
      inlineScriptHashes: ["bootloader"],
    });
    expect(opts.contentSecurityPolicy).not.toBe(false);
  });

  it("skips CSP in `local_trusted` dev mode (Vite HMR)", () => {
    const opts = buildHelmetOptions({
      deploymentMode: "local_trusted",
      nodeEnv: "development",
      inlineScriptHashes: [],
    });
    // Vite HMR needs inline scripts + WebSocket + eval. Skipping CSP is the
    // pragmatic path; loopback is the trust boundary in dev.
    expect(opts.contentSecurityPolicy).toBe(false);
  });

  it("skips CSP for authenticated Vite middleware but keeps it for authenticated static UI", () => {
    const viteDev = buildHelmetOptions({
      deploymentMode: "authenticated",
      uiMode: "vite-dev",
      nodeEnv: "development",
      inlineScriptHashes: [],
    });
    const staticUi = buildHelmetOptions({
      deploymentMode: "authenticated",
      uiMode: "static",
      nodeEnv: "development",
      inlineScriptHashes: ["bootloader"],
    });

    expect(viteDev.contentSecurityPolicy).toBe(false);
    expect(staticUi.contentSecurityPolicy).not.toBe(false);
  });

  it("includes upgrade-insecure-requests in production CSP", () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    if (opts.contentSecurityPolicy === false || !opts.contentSecurityPolicy) {
      throw new Error("expected CSP enabled");
    }
    const directives = opts.contentSecurityPolicy.directives as Record<string, string[] | unknown>;
    expect(directives["upgrade-insecure-requests"]).toBeDefined();
  });

  it("uses same-origin-allow-popups for COOP and same-site for CORP", () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    expect(opts.crossOriginOpenerPolicy).toEqual({ policy: "same-origin-allow-popups" });
    expect(opts.crossOriginResourcePolicy).toEqual({ policy: "same-site" });
  });

  it("keeps Cross-Origin-Embedder-Policy disabled (would break external avatar loading)", () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    expect(opts.crossOriginEmbedderPolicy).toBe(false);
  });
});

describe("helmet wired with buildHelmetOptions — HTTP behavior", () => {
  function makeApp(opts: ReturnType<typeof buildHelmetOptions>) {
    const app = express();
    app.use(helmet(opts));
    app.get("/health", (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("emits Content-Security-Policy header in authenticated/production mode", async () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: ["abc123"],
    });
    const app = makeApp(opts);
    const res = await request(app).get("/health");

    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'sha256-abc123'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it("does NOT emit Content-Security-Policy in local_trusted dev mode", async () => {
    const opts = buildHelmetOptions({
      deploymentMode: "local_trusted",
      nodeEnv: "development",
      inlineScriptHashes: [],
    });
    const app = makeApp(opts);
    const res = await request(app).get("/health");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("preserves the helmet-light header set in BOTH modes (nosniff, frame-deny etc.)", async () => {
    const prod = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    const dev = buildHelmetOptions({
      deploymentMode: "local_trusted",
      nodeEnv: "development",
      inlineScriptHashes: [],
    });

    for (const opts of [prod, dev]) {
      const app = makeApp(opts);
      const res = await request(app).get("/health");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-powered-by"]).toBeUndefined();
      // Helmet's frame-ancestors lives in CSP for prod (nicer modern
      // shape); X-Frame-Options stays as a defense-in-depth header that
      // helmet emits by default regardless of CSP.
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    }
  });

  it("emits Cross-Origin-Opener-Policy: same-origin-allow-popups", async () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    const app = makeApp(opts);
    const res = await request(app).get("/health");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  });

  it("emits Cross-Origin-Resource-Policy: same-site", async () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    const app = makeApp(opts);
    const res = await request(app).get("/health");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-site");
  });

  it("does NOT emit Cross-Origin-Embedder-Policy", async () => {
    const opts = buildHelmetOptions({
      deploymentMode: "authenticated",
      nodeEnv: "production",
      inlineScriptHashes: [],
    });
    const app = makeApp(opts);
    const res = await request(app).get("/health");
    // COEP would break loading external avatars / images that lack the
    // CORP header. Intentionally off pending audit.
    expect(res.headers["cross-origin-embedder-policy"]).toBeUndefined();
  });
});
