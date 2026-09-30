import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRateLimiter, signinLimiter } from "../middleware/rate-limit.js";

// ── Test helpers ──────────────────────────────────────────────────────────────
//
// Each test constructs a fresh limiter via `createRateLimiter(...)` so the
// in-memory bucket starts empty. We avoid module-level shared limiters here
// so cross-test ordering doesn't leak. The supertest agent talks to localhost,
// so `req.ip` defaults to ::ffff:127.0.0.1 (IPv4-mapped IPv6) or 127.0.0.1.
//
// To exercise multi-IP / multi-actor scenarios we override req.ip via a stub
// middleware that sets the property before the limiter sees the request.

interface BuildAppOpts {
  limiter: ReturnType<typeof createRateLimiter>;
  /** Optional: pre-limiter middleware to set req.ip / req.actor for the test. */
  preLimiter?: (req: Request, res: Response, next: NextFunction) => void;
}

function buildApp(opts: BuildAppOpts) {
  const app = express();
  app.set("trust proxy", false);
  if (opts.preLimiter) {
    app.use(opts.preLimiter);
  }
  app.use(opts.limiter);
  app.get("/probe", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

/**
 * supertest-agent helper that makes the named header look like a real upstream
 * IP. express-rate-limit reads `req.ip`, which is computed from the trust-proxy
 * setting. In our tests we set req.ip directly via a pre-limiter middleware
 * since trust-proxy=false ignores forwarded headers.
 */
function withIp(ip: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    Object.defineProperty(req, "ip", { value: ip, configurable: true });
    next();
  };
}

function withActor(actor: Express.Request["actor"], ip = "10.0.0.99") {
  return (req: Request, _res: Response, next: NextFunction) => {
    Object.defineProperty(req, "ip", { value: ip, configurable: true });
    req.actor = actor;
    next();
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createRateLimiter", () => {
  it("allows up to `max` requests then 429s the next one", async () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, keyBy: "ip" });
    const app = buildApp({ limiter, preLimiter: withIp("198.51.100.1") });

    const r1 = await request(app).get("/probe");
    expect(r1.status).toBe(200);
    const r2 = await request(app).get("/probe");
    expect(r2.status).toBe(200);

    const r3 = await request(app).get("/probe");
    expect(r3.status).toBe(429);
    expect(r3.body).toMatchObject({ error: "rate_limited" });
    expect(typeof r3.body.retryAfter).toBe("number");
    expect(r3.body.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("buckets different IPs into separate buckets", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2, keyBy: "ip" });

    // Two apps using the SAME limiter (which lives at module scope here in
    // closure form) but feeding different req.ip values. Because the limiter
    // shares its memory store, exhausting bucket A must NOT exhaust bucket B.
    const appA = buildApp({ limiter, preLimiter: withIp("203.0.113.10") });
    const appB = buildApp({ limiter, preLimiter: withIp("203.0.113.20") });

    // Burn IP A
    expect((await request(appA).get("/probe")).status).toBe(200);
    expect((await request(appA).get("/probe")).status).toBe(200);
    expect((await request(appA).get("/probe")).status).toBe(429);

    // IP B should still be fresh
    expect((await request(appB).get("/probe")).status).toBe(200);
    expect((await request(appB).get("/probe")).status).toBe(200);
    expect((await request(appB).get("/probe")).status).toBe(429);
  });

  it("buckets different actor.userId values separately when keyBy=actor", async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keyBy: "actor",
    });

    const appUser1 = buildApp({
      limiter,
      preLimiter: withActor({
        type: "board",
        userId: "user-alpha",
        source: "session",
      }),
    });
    const appUser2 = buildApp({
      limiter,
      preLimiter: withActor({
        type: "board",
        userId: "user-beta",
        source: "session",
      }),
    });

    expect((await request(appUser1).get("/probe")).status).toBe(200);
    expect((await request(appUser1).get("/probe")).status).toBe(429);

    // Different userId → different bucket
    expect((await request(appUser2).get("/probe")).status).toBe(200);
    expect((await request(appUser2).get("/probe")).status).toBe(429);
  });

  it("falls back to IP bucketing when keyBy=actor and actor.type is none", async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keyBy: "actor",
    });

    // Same IP, no actor → same fallback bucket. Second request must 429.
    const app = buildApp({
      limiter,
      preLimiter: withActor({ type: "none", source: "none" }, "192.0.2.50"),
    });

    expect((await request(app).get("/probe")).status).toBe(200);
    expect((await request(app).get("/probe")).status).toBe(429);

    // Different IP, still no actor → independent fallback bucket.
    const appOtherIp = buildApp({
      limiter,
      preLimiter: withActor({ type: "none", source: "none" }, "192.0.2.51"),
    });
    expect((await request(appOtherIp).get("/probe")).status).toBe(200);
    expect((await request(appOtherIp).get("/probe")).status).toBe(429);
  });

  // Regression: an actor-keyed limiter reached with NO `req.actor` at all (a
  // route mounted without actorMiddleware) must degrade to an IP bucket, never
  // 500 on `req.actor.type` of undefined. Before the guard this threw a
  // TypeError and crashed the request.
  it("falls back to IP bucketing when keyBy=actor and req.actor is absent", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, keyBy: "actor" });
    // Set req.ip but deliberately leave req.actor undefined.
    const app = buildApp({ limiter, preLimiter: withIp("192.0.2.77") });

    const r1 = await request(app).get("/probe");
    expect(r1.status).toBe(200); // did not 500
    const r2 = await request(app).get("/probe");
    expect(r2.status).toBe(429); // same IP bucket exhausted
  });

  it("emits draft-7 RateLimit-* standardized headers on responses", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5, keyBy: "ip" });
    const app = buildApp({ limiter, preLimiter: withIp("198.51.100.99") });

    const res = await request(app).get("/probe");
    expect(res.status).toBe(200);

    // Header names from RFC draft-7 (case-insensitive in supertest).
    // Lowercase keys via the response.headers object.
    const headers = res.headers as Record<string, string>;
    expect(headers).toHaveProperty("ratelimit-policy");
    expect(headers).toHaveProperty("ratelimit");

    // The legacy X-RateLimit-* headers must NOT be set.
    expect(headers).not.toHaveProperty("x-ratelimit-limit");
    expect(headers).not.toHaveProperty("x-ratelimit-remaining");
    expect(headers).not.toHaveProperty("x-ratelimit-reset");
  });
});

describe("trust proxy integration with rate limiter", () => {
  it("buckets per spoofed IP when trust proxy is true and X-Forwarded-For set", async () => {
    const app = express();
    app.set("trust proxy", true);
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.post("/test", signinLimiter, (_req, res) => res.status(200).json({ ok: true }));

    // signinLimiter is module-level and shares state across this process.
    // Use unique IPs per assertion so the test isn't sensitive to prior runs.
    const ipA = "198.51.100.81";
    const ipB = "198.51.100.82";

    const ipAResults: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await request(app).post("/test").set("X-Forwarded-For", ipA);
      ipAResults.push(r.status);
    }
    expect(ipAResults.filter((s) => s === 200).length).toBe(10);
    expect(ipAResults.filter((s) => s === 429).length).toBe(2);

    // Different XFF IP should still have its own (fresh) bucket.
    const r = await request(app).post("/test").set("X-Forwarded-For", ipB);
    expect(r.status).toBe(200);
  });

  it("ignores X-Forwarded-For when trust proxy is false (default)", async () => {
    const app = express();
    app.set("trust proxy", false);
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.get("/probe", (req, res) => res.json({ ip: req.ip }));

    const r = await request(app).get("/probe").set("X-Forwarded-For", "1.2.3.4");
    // With trust proxy false, req.ip is the loopback socket IP, not the XFF.
    expect(r.body.ip).not.toBe("1.2.3.4");
  });
});
