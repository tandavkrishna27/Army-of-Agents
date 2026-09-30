import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { companyWorkspaceFsRoutes } from "../routes/company-workspace-fs.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { DeploymentMode } from "@armyofagents/shared";

function makeApp(actor: any, deploymentMode: DeploymentMode, companyWorkspaceBaseDir: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", companyWorkspaceFsRoutes({ deploymentMode, companyWorkspaceBaseDir }));
  app.use(errorHandler);
  return app;
}

const COMPANY_A = "company-A";
const COMPANY_B = "company-B";

function memberActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-1",
    companyIds: [companyId],
    isInstanceAdmin: false,
  };
}

function nonMemberActor(companyId: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-2",
    companyIds: [`not-${companyId}`],
    isInstanceAdmin: false,
  };
}

const localImplicitActor = {
  type: "board",
  source: "local_implicit",
  userId: "founder",
  companyIds: [],
  isInstanceAdmin: false,
};

let tmpBase: string;

beforeEach(async () => {
  tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-company-fs-routes-test-"));
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

describe("company workspace-fs routes — authz", () => {
  it("403 for a non-member (authenticated mode)", async () => {
    const app = makeApp(nonMemberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/home`);
    expect(res.status).toBe(403);
  });

  it("403 browse for a non-member (authenticated mode)", async () => {
    const app = makeApp(nonMemberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/workspace-fs/browse`,
    );
    expect(res.status).toBe(403);
  });

  it("403 mkdir for a non-member (authenticated mode)", async () => {
    const app = makeApp(nonMemberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/workspace-fs/mkdir`)
      .send({ path: path.join(tmpBase, COMPANY_A, "x") });
    expect(res.status).toBe(403);
  });

  it("401 for an unauthenticated actor", async () => {
    const app = makeApp({ type: "none" }, "authenticated", tmpBase);
    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/home`);
    expect(res.status).toBe(401);
  });
});

describe("company workspace-fs routes — local_trusted (unjailed)", () => {
  it("home returns the real home dir and is not jailed", async () => {
    const app = makeApp(localImplicitActor, "local_trusted", tmpBase);
    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/home`);
    expect(res.status).toBe(200);
    expect(res.body.homePath).toBe(os.homedir());
    expect(res.body.jailed).toBe(false);
  });

  it("drives are enumerated (not hidden)", async () => {
    const app = makeApp(localImplicitActor, "local_trusted", tmpBase);
    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/drives`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.drives)).toBe(true);
    expect(res.body.drives.length).toBeGreaterThan(0);
  });

  it("browses an existing repo dir anywhere on disk (outside the company base)", async () => {
    const existingRepoDir = path.join(tmpBase, "pre-existing-repo");
    await fs.mkdir(existingRepoDir, { recursive: true });
    const app = makeApp(localImplicitActor, "local_trusted", tmpBase);
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/workspace-fs/browse?path=${encodeURIComponent(existingRepoDir)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(existingRepoDir);
  });

  it("mkdir succeeds anywhere on disk (unjailed)", async () => {
    const target = path.join(tmpBase, "new-local-trusted-dir");
    const app = makeApp(localImplicitActor, "local_trusted", tmpBase);
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/workspace-fs/mkdir`)
      .send({ path: target });
    expect(res.status).toBe(200);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe("company workspace-fs routes — authenticated (jailed)", () => {
  it("home returns the per-company jail root and is jailed", async () => {
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/home`);
    expect(res.status).toBe(200);
    expect(res.body.homePath).toBe(path.join(tmpBase, COMPANY_A));
    expect(res.body.jailed).toBe(true);
  });

  it("drives are hidden/empty", async () => {
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/drives`);
    expect(res.status).toBe(200);
    expect(res.body.drives).toEqual([]);
  });

  it("browse defaults to the jail root and lists company-created dirs", async () => {
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    await request(app)
      .post(`/api/companies/${COMPANY_A}/workspace-fs/mkdir`)
      .send({ path: path.join(tmpBase, COMPANY_A, "project-1") });

    const res = await request(app).get(`/api/companies/${COMPANY_A}/workspace-fs/browse`);
    expect(res.status).toBe(200);
    expect(res.body.currentPath).toBe(path.join(tmpBase, COMPANY_A));
    expect(res.body.entries.some((e: any) => e.name === "project-1")).toBe(true);
  });

  it("mkdir inside the jail succeeds", async () => {
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const target = path.join(tmpBase, COMPANY_A, "nested", "dir");
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/workspace-fs/mkdir`)
      .send({ path: target });
    expect(res.status).toBe(200);
    const stat = await fs.stat(target);
    expect(stat.isDirectory()).toBe(true);
  });

  it("company A cannot browse into company B's jail via a manual path", async () => {
    // company B's jail happens to already exist (e.g. it browsed earlier).
    await fs.mkdir(path.join(tmpBase, COMPANY_B), { recursive: true });
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/workspace-fs/browse?path=${encodeURIComponent(path.join(tmpBase, COMPANY_B))}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects '..' traversal browse out of the jail", async () => {
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const escapePath = path.join(tmpBase, COMPANY_A, "..", "..");
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/workspace-fs/browse?path=${encodeURIComponent(escapePath)}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects an absolute path outside the jail", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-outside-"));
    try {
      const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
      const res = await request(app).get(
        `/api/companies/${COMPANY_A}/workspace-fs/browse?path=${encodeURIComponent(outside)}`,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked directory pointing outside the jail (browse)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-outside-link-"));
    try {
      const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
      await fs.mkdir(path.join(tmpBase, COMPANY_A), { recursive: true });
      const linkPath = path.join(tmpBase, COMPANY_A, "escape-link");
      await fs.symlink(outside, linkPath, "junction");

      const res = await request(app).get(
        `/api/companies/${COMPANY_A}/workspace-fs/browse?path=${encodeURIComponent(linkPath)}`,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a prefix-collision sibling company id (company-A vs company-A2)", async () => {
    // Company A's jail is <tmpBase>/company-A. A sibling company id
    // "company-A2" would collide under a naive startsWith() check.
    await fs.mkdir(path.join(tmpBase, "company-A2"), { recursive: true });
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/workspace-fs/browse?path=${encodeURIComponent(path.join(tmpBase, "company-A2"))}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects mkdir-through-symlink (intermediate dir escapes the jail)", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-outside-mkdir-"));
    try {
      const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
      await fs.mkdir(path.join(tmpBase, COMPANY_A), { recursive: true });
      const linkPath = path.join(tmpBase, COMPANY_A, "escape-link");
      await fs.symlink(outside, linkPath, "junction");

      const res = await request(app)
        .post(`/api/companies/${COMPANY_A}/workspace-fs/mkdir`)
        .send({ path: path.join(linkPath, "evil-new-dir") });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const escaped = await fs
        .stat(path.join(outside, "evil-new-dir"))
        .then(() => true)
        .catch(() => false);
      expect(escaped).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects mkdir '..' traversal out of the jail", async () => {
    const app = makeApp(memberActor(COMPANY_A), "authenticated", tmpBase);
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/workspace-fs/mkdir`)
      .send({ path: path.join(tmpBase, COMPANY_A, "..", "escape-mkdir") });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const escaped = await fs
      .stat(path.join(tmpBase, "escape-mkdir"))
      .then(() => true)
      .catch(() => false);
    expect(escaped).toBe(false);
  });
});
