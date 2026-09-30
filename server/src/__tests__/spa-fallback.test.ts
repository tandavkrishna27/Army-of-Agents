import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SPA_FALLBACK_ROUTE, spaFallbackHandler } from "../services/spa-fallback.js";

// BUG-4 regression trigger: the ui dist lives under a DOT directory segment
// (real installs: ~/.aoa/wt/... worktrees, npx caches). `send`'s dotfile check
// runs on EVERY segment of a bare absolute sendFile path, so ".aoa-like" in
// the install path 404'd the SPA fallback with dotfiles:"ignore".
const MARKER = "SPA_FALLBACK_TEST_MARKER";
const INDEX_HTML = `<!doctype html><html><body>${MARKER}</body></html>`;
const REAL_ASSET_CONTENT = "// real hashed bundle\n";

let tmpRoot: string;
let distDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spa-fallback-"));
  // The dot segment is the point of the test — do not "clean it up".
  distDir = path.join(tmpRoot, ".aoa-like", "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), INDEX_HTML);
  fs.writeFileSync(path.join(distDir, "assets", "real-abc123.js"), REAL_ASSET_CONTENT);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Assemble the app exactly like app.ts static mode does:
 * /api router ending in a JSON 404 -> express.static(dist) -> SPA catch-all.
 */
function makeApp(spaHandler: express.RequestHandler, spaRoute: RegExp) {
  const app = express();
  const api = express.Router();
  api.use((req, res) => {
    res.status(404).json({ error: "Not found", path: req.originalUrl });
  });
  app.use("/api", api);
  app.use(express.static(distDir));
  app.get(spaRoute, spaHandler);
  return app;
}

describe("spaFallbackHandler under a dot-directory install", () => {
  function fixedApp() {
    return makeApp(spaFallbackHandler(distDir), SPA_FALLBACK_ROUTE);
  }

  it("serves index.html for a client-side route (/QAL/home)", async () => {
    const res = await request(fixedApp()).get("/QAL/home");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain(MARKER);
  });

  it("serves index.html for a nested deep link (/QAL/inbox/waiting)", async () => {
    const res = await request(fixedApp()).get("/QAL/inbox/waiting");
    expect(res.status).toBe(200);
    expect(res.text).toContain(MARKER);
  });

  it("serves index.html for /", async () => {
    const res = await request(fixedApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain(MARKER);
  });

  it("serves index.html for /apiary (no false positive on /api prefix)", async () => {
    const res = await request(fixedApp()).get("/apiary");
    expect(res.status).toBe(200);
    expect(res.text).toContain(MARKER);
  });

  it("404s unmatched /api routes with JSON, never the SPA (Issue #116)", async () => {
    const res = await request(fixedApp()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({ error: "Not found", path: "/api/nope" });
  });

  it("404s a missing hashed bundle loudly instead of serving index.html", async () => {
    const res = await request(fixedApp()).get("/assets/missing.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(MARKER);
  });

  it("still serves a real asset from the dist", async () => {
    const res = await request(fixedApp()).get("/assets/real-abc123.js");
    expect(res.status).toBe(200);
    expect(res.text).toBe(REAL_ASSET_CONTENT);
  });

  it("never serves the SPA for the exact path /assets", async () => {
    // express.static answers first with its directory redirect (301 -> /assets/);
    // the point is the fallback regex must not paper over it with index.html.
    const res = await request(fixedApp()).get("/assets");
    expect(res.status).not.toBe(200);
    expect(res.text).not.toContain(MARKER);
  });
});

describe("control: old inline handler reproduces BUG-4 under the same dist", () => {
  // The pre-fix app.ts handler: bare absolute sendFile, old /api-only regex.
  // Proves the temp-dir setup actually triggers send's dotfile 404 — if this
  // test ever starts seeing 200s, the regression trigger has silently vanished
  // and the suite above is no longer testing anything.
  function oldStyleApp() {
    return makeApp((_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    }, /^(?!\/api\/).*/);
  }

  it("old handler 404s a client-side route because of the dot segment", async () => {
    const res = await request(oldStyleApp()).get("/QAL/home");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(MARKER);
  });
});

describe("SPA_FALLBACK_ROUTE regex", () => {
  it("excludes /api/* and /assets/*", () => {
    expect(SPA_FALLBACK_ROUTE.test("/api/x")).toBe(false);
    expect(SPA_FALLBACK_ROUTE.test("/api/agents/123")).toBe(false);
    expect(SPA_FALLBACK_ROUTE.test("/assets/x.js")).toBe(false);
    expect(SPA_FALLBACK_ROUTE.test("/assets/deep/nested.css")).toBe(false);
  });

  it("excludes the exact paths /api and /assets (no trailing slash)", () => {
    // Codex P2: the naive /^(?!\/api\/).*/ form matched the slash-less exact
    // paths and served the SPA for them.
    expect(SPA_FALLBACK_ROUTE.test("/api")).toBe(false);
    expect(SPA_FALLBACK_ROUTE.test("/assets")).toBe(false);
  });

  it("matches SPA routes, /, and prefix look-alikes", () => {
    expect(SPA_FALLBACK_ROUTE.test("/QAL/home")).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test("/QAL/inbox/waiting")).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test("/")).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test("/apiary")).toBe(true);
    expect(SPA_FALLBACK_ROUTE.test("/assetsomething")).toBe(true);
  });
});
