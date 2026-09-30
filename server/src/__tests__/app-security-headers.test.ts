import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import helmet from "helmet";

describe("app security headers", () => {
  it("emits the helmet-light defaults", async () => {
    const app = express();
    app.use(helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
    }));
    app.get("/health", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
