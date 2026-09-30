import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { HttpError } from "../errors.js";
import { ZodError, z } from "zod";

function buildApp(throwFn: () => never) {
  const app = express();
  app.get("/boom", (_req, _res, next) => {
    try {
      throwFn();
    } catch (err) {
      next(err);
    }
  });
  app.use(errorHandler);
  return app;
}

describe("errorHandler", () => {
  it("returns HttpError.status as-is", async () => {
    const app = buildApp(() => {
      throw new HttpError(404, "not found");
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not found");
  });

  it("returns 400 with Zod validation details for ZodError", async () => {
    const app = buildApp(() => {
      z.object({ x: z.string() }).parse({});
      throw new Error("unreachable");
    });
    try {
      const res = await request(app).get("/boom");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Validation error");
    } catch (err) {
      if (err instanceof ZodError) throw err;
      throw err;
    }
  });

  it("honors err.status on body-parser-style errors (e.g. PayloadTooLargeError)", async () => {
    const app = buildApp(() => {
      const e: any = new Error("request entity too large");
      e.status = 413;
      e.statusCode = 413;
      e.expose = true;
      e.type = "entity.too.large";
      throw e;
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("request entity too large");
  });

  it("honors statusCode when status is absent", async () => {
    const app = buildApp(() => {
      const e: any = new Error("unauthorized");
      e.statusCode = 401;
      e.expose = true;
      throw e;
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("hides message when expose is not true", async () => {
    const app = buildApp(() => {
      const e: any = new Error("internal detail leak");
      e.status = 502;
      e.expose = false;
      throw e;
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Request error");
    expect(res.body.error).not.toContain("internal detail leak");
  });

  it("ignores out-of-range numeric status", async () => {
    const app = buildApp(() => {
      const e: any = new Error("weird");
      e.status = 200;
      throw e;
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });

  it("falls through to 500 for unknown errors", async () => {
    const app = buildApp(() => {
      throw new Error("kaboom");
    });
    const res = await request(app).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});
