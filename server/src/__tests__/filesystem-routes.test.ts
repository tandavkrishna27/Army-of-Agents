import os from "node:os";
import path from "node:path";

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { filesystemRoutes } from "../routes/filesystem.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", filesystemRoutes());
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
const localImplicit = { ...nonAdminBoard, source: "local_implicit" };
const instanceAdmin = { ...nonAdminBoard, operator: true, isInstanceAdmin: true };

describe("filesystem routes — instance admin gate", () => {
  it("403 browse for non-admin board user", async () => {
    const res = await request(makeApp(nonAdminBoard)).get("/api/filesystem/browse?path=/tmp");
    expect(res.status).toBe(403);
  });
  it("403 mkdir for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard))
      .post("/api/filesystem/mkdir").send({ path: "/tmp/x" });
    expect(res.status).toBe(403);
  });
  it("403 reveal for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard))
      .post("/api/filesystem/reveal").send({ path: "/tmp" });
    expect(res.status).toBe(403);
  });
  it("403 drives for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard)).get("/api/filesystem/drives");
    expect(res.status).toBe(403);
  });
  it("403 home for non-admin", async () => {
    const res = await request(makeApp(nonAdminBoard)).get("/api/filesystem/home");
    expect(res.status).toBe(403);
  });
  it("not 403 for local_implicit (regression guard)", async () => {
    const res = await request(makeApp(localImplicit)).get("/api/filesystem/browse?path=/tmp");
    // May be 200 or 400 (path validation) or 500 (FS error in test env), but NEVER 403
    expect(res.status).not.toBe(403);
  });
  it("400 reveal for path outside home dir (instance admin)", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: "/etc/passwd" });
    // Should be rejected with 400 (outside home) — never 200 or actually-spawn xdg-open
    expect(res.status).toBe(400);
  });
  it("400 reveal for sibling-prefix path that bypasses startsWith (instance admin)", async () => {
    const homeDir = os.homedir();
    // Construct a sibling: if homeDir is /Users/alice, target is /Users/alice-evil-sibling.
    // The old `target.startsWith(homeDir)` check would have returned true here,
    // letting the sibling bypass the gate. With path.relative the result is
    // "../alice-evil-sibling" which correctly starts with ".." → outside.
    const siblingPath = path.join(
      path.dirname(homeDir),
      path.basename(homeDir) + "-evil-sibling",
    );
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: siblingPath });
    expect(res.status).toBe(400);
  });
  it("not 400 reveal for home dir itself (instance admin)", async () => {
    const homeDir = os.homedir();
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: homeDir });
    // Could be 200 (success), 404 (rare CI), or 500 (spawn error in CI), but
    // never 400 — the boundary check must not lock the user out of $HOME.
    expect(res.status).not.toBe(400);
  });
});
