import express from "express";
import request from "supertest";
import { describe, it, expect } from "vitest";
import { transcriptionRoutes } from "../routes/transcription.js";
import { errorHandler } from "../middleware/index.js";

describe("POST /companies/:companyId/transcribe (501 stub)", () => {
  it("returns 501 with a documented body explaining the deprecation", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "u1",
        source: "session",
        companyIds: ["c1"],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use(transcriptionRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post("/companies/c1/transcribe")
      .attach("audio", Buffer.from("fake"), "test.mp3");

    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      error: "transcription_not_available",
      message: expect.stringContaining("Internal Agent"),
    });
  });

  it("returns 403 (not 501) for unauthenticated callers — limiter still gates", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = { type: "none" };
      next();
    });
    app.use(transcriptionRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app).post("/companies/c1/transcribe");

    expect(res.status).toBe(401);
  });
});
