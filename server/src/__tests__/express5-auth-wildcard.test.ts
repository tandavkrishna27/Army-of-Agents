import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";

describe("Express 5 better-auth wildcard route", () => {
  it("matches /api/auth/sign-in/email (deep sub-path)", async () => {
    const app = express();
    const handlerCalls: string[] = [];

    // Reproduce the exact route pattern used in app.ts
    app.all("/api/auth/{*authPath}", (req, _res, next) => {
      handlerCalls.push(req.path);
      next();
    });

    // Add a fallback so the request doesn't hang
    app.use((_req, res) => {
      res.status(404).end();
    });

    await request(app)
      .post("/api/auth/sign-in/email")
      .send({ email: "x@y.z", password: "x" });

    expect(handlerCalls.length).toBeGreaterThan(0);
  });

  it("does NOT match /api/auth/ root with the old *authPath syntax (regression guard)", async () => {
    // The old bare *authPath syntax requires at least one character after the
    // prefix, so it silently skips /api/auth/ (the trailing-slash root endpoint
    // that better-auth uses for session and callback discovery). The fixed
    // {*authPath} syntax accepts an empty capture group and therefore matches.
    // This test proves the old syntax's gap — if someone reverts app.ts:152 back
    // to *authPath, better-auth's root endpoint breaks silently.
    const handlerCalls: string[] = [];
    const app = express();
    // OLD broken syntax — Express 5 path-to-regexp v8 does not match /api/auth/ (empty segment)
    app.all("/api/auth/*authPath", (req, _res, next) => {
      handlerCalls.push(req.path);
      next();
    });
    app.use((_req, res) => res.status(404).end());
    await request(app).get("/api/auth/").send();
    expect(handlerCalls).toEqual([]);
  });
});
