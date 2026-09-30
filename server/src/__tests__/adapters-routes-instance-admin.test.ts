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
const savedEnv: Record<string, string | undefined> = {};

// What this file proves is an AUTHZ property: who the `/adapters/install` gate
// lets through. It does not prove that npm can install anything. But the route
// runs `execNpm(["install", ...])` inline, so a naive test awaits a REAL
// registry install before it can read the status code — and `execNpm`'s own
// budget is 120_000 ms while vitest's `testTimeout` is 30_000 ms. That inverted
// budget made a required check's verdict depend on npm-registry latency: the
// FIRST (cold-cache) install in a job could cross 30 s and red the gate, while
// the second, cache-warm, install in the same file passed (observed on run
// 33799234615: "3 tests | 1 failed"). See finding E3-F035.
//
// Fix: pin npm to OFFLINE mode against an empty cache for the duration of these
// tests. `npm install --no-save x` then fails immediately with ENOTCACHED —
// no network, no installed tree, no EBUSY-on-cleanup on Windows — and the route
// still returns a non-403 status, which is the whole of what is asserted.
// Do NOT "fix" a timeout here by raising testTimeout: that hides latency, it
// does not remove the dependency on something outside the repo.
function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-adapter-routes-instance-"));
  setEnv("AOA_HOME", tmpHome);
  setEnv("npm_config_offline", "true");
  setEnv("npm_config_cache", path.join(tmpHome, "npm-cache"));
  setEnv("npm_config_fund", "false");
  setEnv("npm_config_audit", "false");
  setEnv("npm_config_update_notifier", "false");
  __resetAdapterPluginStoreCaches();
});

afterEach(async () => {
  for (const key of Object.keys(savedEnv)) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    delete savedEnv[key];
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

  it("not 403 install as instance admin", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/adapters/install")
      .send({ packageName: "x" });
    expect(res.status).not.toBe(403);
  });

  it("not 403 install as local_implicit (regression guard)", async () => {
    const res = await request(makeApp(localImplicit))
      .post("/api/adapters/install")
      .send({ packageName: "x" });
    expect(res.status).not.toBe(403);
  });
});
