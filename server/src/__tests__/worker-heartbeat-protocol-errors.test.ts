import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@armyofagents/db";
import { OPERATION_DESCRIPTORS, protocolErrorV1Schema } from "@armyofagents/worker-protocol";
import { executionTargetRoutes } from "../routes/execution-targets.js";
import { errorHandler } from "../middleware/error-handler.js";

function lookupFailingDb(): Db {
  return {
    select() {
      throw new Error("worker lookup SQL/query parameters must remain internal");
    },
  } as unknown as Db;
}

describe("JOB-002 proof-bound heartbeat early protocol errors", () => {
  it.each([
    { name: "missing bearer", authorization: undefined, status: 401, code: "unauthorized" },
    { name: "malformed bearer", authorization: "Basic not-a-bearer", status: 401, code: "unauthorized" },
    { name: "legacy lookup failure", authorization: "Bearer lookup-fails", status: 503, code: "internal_unavailable" },
  ])("returns frozen ProtocolErrorV1 for $name", async ({ authorization, status, code }) => {
    const db = lookupFailingDb();
    const app = express();
    app.use(express.json({ verify: (req, _res, bytes) => {
      (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(bytes);
    } }));
    app.use("/api", executionTargetRoutes({
      db,
      workerSession: {
        appDb: db,
        operatorDb: db,
        sessionSigningKey: "test-signing-key-at-least-32-bytes",
      },
    }));
    app.use(errorHandler);

    let pending = request(app).post("/api/execution-targets/heartbeat").send({ status: "active" });
    if (authorization) pending = pending.set("authorization", authorization);
    const response = await pending;

    expect(response.status).toBe(status);
    expect(protocolErrorV1Schema.safeParse(response.body)).toMatchObject({ success: true });
    expect(OPERATION_DESCRIPTORS.enrollment.errors).toContain(code);
    expect(response.body).toMatchObject({
      protocolVersion: 1,
      code,
      redaction: "secret",
      retryAfterMs: code === "internal_unavailable" ? 1_000 : null,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/SQL|query parameters|lookup-fails/i);
  });
});
