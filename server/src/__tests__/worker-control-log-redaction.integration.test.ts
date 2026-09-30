import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";

const capturedLogDir = await mkdtemp(join(tmpdir(), "aoa-worker-control-logs-"));
process.env.AOA_LOG_DIR = capturedLogDir;
const { httpLogger, logger } = await import("../middleware/logger.js");
const { errorHandler } = await import("../middleware/error-handler.js");

async function capturedLogs(): Promise<string> {
  await new Promise<void>((resolve) => logger.flush(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return readFile(join(capturedLogDir, "server.log"), "utf8");
}

afterAll(async () => {
  try { await rm(capturedLogDir, { recursive: true, force: true }); } catch { /* transport can own the file until exit */ }
});

describe("JOB-002 worker-control production log transport", () => {
  it("omits every credential and semantic/error payload on success and every denial class", async () => {
    const app = express();
    app.use(httpLogger);
    app.use(express.json());
    const respondForOutcome: express.RequestHandler = (req, res, next) => {
      switch (req.header("x-test-outcome")) {
        case "success": res.status(200).json({ outcome: "enrolled" }); return;
        case "malformed": res.status(400).json({ error: "malformed" }); return;
        case "unauthorized": res.status(401).json({ error: "unauthorized" }); return;
        case "revoked": res.status(401).json({ error: "revoked" }); return;
        default: {
          const internal = new Error("SQL_INTERNAL_MESSAGE_MARKER INSERT INTO workers ($1)", {
            cause: new Error("SQL_INTERNAL_CAUSE_MARKER query parameters"),
          });
          next(internal);
        }
      }
    };
    app.post("/api/worker-control/enroll", respondForOutcome);
    app.post("/api/execution-targets/heartbeat", respondForOutcome);
    app.use(errorHandler);

    const headers = {
      "aoa-enrollment-code": "aoa_enr_RAW_CODE_MARKER.RAW_SECRET_MARKER",
      "aoa-device-proof-version": "1",
      "aoa-device-public-key": "RAW_PUBLIC_KEY_MARKER",
      "aoa-device-signature": "RAW_SIGNATURE_MARKER",
      "aoa-device-proof-id": "RAW_PROOF_ID_MARKER",
      "aoa-device-issued-at": "2026-08-10T00:00:00.000Z",
    };
    for (const outcome of ["success", "malformed", "unauthorized", "revoked", "internal"] as const) {
      await request(app)
        .post(`/api/worker-control/enroll?SQL_QUERY_MARKER=${outcome}`)
        .set(headers)
        .set("x-test-outcome", outcome)
        .send({ semanticInput: `SEMANTIC_BODY_MARKER_${outcome}` });
    }
    for (const outcome of ["success", "malformed", "unauthorized", "revoked", "internal"] as const) {
      await request(app)
        .post(`/api/execution-targets/heartbeat?HEARTBEAT_QUERY_MARKER=${outcome}`)
        .set("authorization", "Bearer RAW_WORKER_SESSION_MARKER")
        .set(headers)
        .set("x-test-outcome", outcome)
        .send({ capabilities: `HEARTBEAT_SEMANTIC_BODY_MARKER_${outcome}` });
    }

    const logs = await capturedLogs();
    expect(logs).toContain("POST /api/worker-control/enroll");
    expect(logs).toContain("POST /api/execution-targets/heartbeat");
    for (const secret of [
      "RAW_CODE_MARKER",
      "RAW_SECRET_MARKER",
      "RAW_PUBLIC_KEY_MARKER",
      "RAW_SIGNATURE_MARKER",
      "RAW_PROOF_ID_MARKER",
      "RAW_WORKER_SESSION_MARKER",
      "SEMANTIC_BODY_MARKER",
      "HEARTBEAT_SEMANTIC_BODY_MARKER",
      "SQL_QUERY_MARKER",
      "HEARTBEAT_QUERY_MARKER",
      "SQL_INTERNAL_MESSAGE_MARKER",
      "SQL_INTERNAL_CAUSE_MARKER",
      "INSERT INTO workers",
      "query parameters",
    ]) expect(logs, secret).not.toContain(secret);
  });
});
