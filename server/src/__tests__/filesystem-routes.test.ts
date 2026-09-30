import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { filesystemRoutes } from "../routes/filesystem.js";
import { errorHandler } from "../middleware/error-handler.js";

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: processMock.spawn };
});
class FakeChild extends EventEmitter {
  unref = vi.fn();
}
let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  // Contain the red regression; assertions require the route's own handler too.
  child.on("error", () => {});
  processMock.spawn.mockReset();
  processMock.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});

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
    expect(processMock.spawn).not.toHaveBeenCalled();
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
    expect(processMock.spawn).not.toHaveBeenCalled();
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
    expect(processMock.spawn).not.toHaveBeenCalled();
  });
  it("acknowledges successful opener launch for the home directory", async () => {
    const homeDir = os.homedir();
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: homeDir });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(processMock.spawn).toHaveBeenCalledWith(
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open",
      [homeDir],
      { detached: true, stdio: "ignore" },
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("reports asynchronous opener launch failure", async () => {
    processMock.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("error", new Error("fixture missing opener")));
      return child;
    });
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: os.homedir() });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Unable to launch the file manager" });
    expect(processMock.spawn).toHaveBeenCalledTimes(1);
    expect(child.unref).not.toHaveBeenCalled();
    expect(child.listenerCount("error")).toBeGreaterThan(1);
  });

  it("reports a synchronous opener launch failure", async () => {
    processMock.spawn.mockImplementation(() => { throw new Error("fixture spawn failure"); });
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: os.homedir() });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Unable to launch the file manager" });
  });

  it("keeps an error handler after successful launch", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: os.homedir() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("error")).toBeGreaterThan(1);
    expect(() => {
      child.emit("error", new Error("fixture late error"));
      child.emit("error", new Error("fixture second late error"));
    }).not.toThrow();
  });

  it("rejects a missing reveal path without spawning", async () => {
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({});
    expect(res.status).toBe(400);
    expect(processMock.spawn).not.toHaveBeenCalled();
  });

  it("returns 404 for an absent in-home path without spawning", async () => {
    const missingPath = path.join(os.homedir(), `aoa-reveal-missing-${randomUUID()}`);
    const res = await request(makeApp(instanceAdmin))
      .post("/api/filesystem/reveal").send({ path: missingPath });
    expect(res.status).toBe(404);
    expect(processMock.spawn).not.toHaveBeenCalled();
  });
});
