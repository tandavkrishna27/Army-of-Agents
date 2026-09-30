import express from "express";
import request from "supertest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adapterRoutes } from "../routes/adapters.js";
import { errorHandler } from "../middleware/error-handler.js";
import { __resetAdapterPluginStoreCaches } from "../services/adapter-plugin-store.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", adapterRoutes());
  app.use(errorHandler);
  return app;
}

const nonAdminBoard = {
  type: "board",
  source: "session",
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
// Phase 3 repointed instance-wide admin gates from `isInstanceAdmin` to the
// `operator` plane (canManageInstanceSettings reads `operator`; isInstanceAdmin is
// clamped in cloud_auth). Adapter install is instance-wide infra, so it is
// operator-gated — a real instance admin carries `operator: true`.
const instanceAdmin = { ...nonAdminBoard, isInstanceAdmin: true, operator: true };
const localImplicit = { ...nonAdminBoard, source: "local_implicit" };

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-adapter-routes-instance-"));
  originalHome = process.env.AOA_HOME;
  process.env.AOA_HOME = tmpHome;
  __resetAdapterPluginStoreCaches();
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.AOA_HOME;
  } else {
    process.env.AOA_HOME = originalHome;
  }
  __resetAdapterPluginStoreCaches();
  await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("adapter routes — instance admin gate", () => {
  it("403 install as non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard))
      .post("/api/adapters/install")
      .send({ packageName: "x" });
    expect(res.status).toBe(403);
  });

  // npm install locks the tmp dir on Windows (EBUSY on cleanup) — skip, authz logic is platform-independent
  it.skipIf(process.platform === "win32")("not 403 install as instance admin", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/adapters/install")
      .send({ packageName: "x" });
    expect(res.status).not.toBe(403);
  });

  it.skipIf(process.platform === "win32")("not 403 install as local_implicit (regression guard)", async () => {
    const res = await request(makeApp(localImplicit))
      .post("/api/adapters/install")
      .send({ packageName: "x" });
    expect(res.status).not.toBe(403);
  });
});
