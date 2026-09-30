/**
 * T2.9 (route half) — the service owns the gate; the route owns telling the
 * founder. These assert the founder-visible half:
 *   - `POST /skills/:id/install-update` answers 409 + `SKILL_CUSTOMIZED` and
 *     raises a hub item.
 *   - `POST /skills/import` reports refusals in the body and raises a hub item.
 *   - Neither fires on the success path (the discriminator — a route that
 *     notified unconditionally would otherwise pass).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@armyofagents/db", () => {
  const tableProxy = new Proxy({}, { get: () => Symbol("col") });
  return { companySkills: tableProxy, userRoles: tableProxy };
});
vi.mock("drizzle-orm", () => ({
  eq: () => Symbol("eq"),
  and: () => Symbol("and"),
  isNull: () => Symbol("isNull"),
  or: () => Symbol("or"),
  gt: () => Symbol("gt"),
}));
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn(),
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorType: "board", actorId: "u1", agentId: null, runId: null })),
}));

const installUpdateMock = vi.hoisted(() => vi.fn());
const importFromSourceMock = vi.hoisted(() => vi.fn());
const createLocalSkillMock = vi.hoisted(() => vi.fn());
const getByIdMock = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companySkillService: vi.fn(() => ({
    installUpdate: installUpdateMock,
    importFromSource: importFromSourceMock,
    createLocalSkill: createLocalSkillMock,
    getById: getByIdMock,
  })),
  agentService: vi.fn(() => ({ getById: vi.fn(), list: vi.fn() })),
  accessService: vi.fn(() => ({ canUser: vi.fn().mockResolvedValue(true), hasPermission: vi.fn() })),
  logActivity: vi.fn(),
}));

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("../services/marketplace-notifications.js", () => ({
  marketplaceNotifications: { skillUpdateRefusedCustomized: notifyMock },
}));
vi.mock("../middleware/logger.js", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { companySkillRoutes } from "../routes/company-skills.js";
import { errorHandler } from "../middleware/error-handler.js";
import { conflict } from "../errors.js";
import {
  SKILL_CUSTOMIZED_ERROR_CODE,
  SKILL_NAME_TAKEN_ERROR_CODE,
} from "@armyofagents/shared";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.actor = { type: "board", source: "local_implicit", userId: "u1" };
    next();
  });
  app.use("/", companySkillRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /skills — name-taken refusal", () => {
  it("answers 409 with the distinct top-level name-taken code", async () => {
    createLocalSkillMock.mockRejectedValue(
      conflict("Name already taken", {
        code: SKILL_NAME_TAKEN_ERROR_CODE,
        slug: "brainstorming",
        key: "company/c1/brainstorming",
      }),
    );

    const res = await request(buildApp())
      .post("/companies/c1/skills")
      .send({ name: "Brainstorming", slug: "brainstorming" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(SKILL_NAME_TAKEN_ERROR_CODE);
    expect(res.body.code).not.toBe(SKILL_CUSTOMIZED_ERROR_CODE);
    expect(res.body.details).toMatchObject({
      code: SKILL_NAME_TAKEN_ERROR_CODE,
      slug: "brainstorming",
    });
  });
});

describe("POST /skills/:skillId/install-update — customized refusal", () => {
  it("answers 409 SKILL_CUSTOMIZED and notifies the founder", async () => {
    installUpdateMock.mockRejectedValue(
      conflict('"Brainstorming" has local edits.', {
        code: SKILL_CUSTOMIZED_ERROR_CODE,
        skillId: "skill-1",
      }),
    );
    getByIdMock.mockResolvedValue({ id: "skill-1", name: "Brainstorming", companyId: "c1" });

    const res = await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(res.status).toBe(409);
    // F4 — top-level `code` matches the catalog path's shape so one client check
    // works on both; `details` carries the skill id.
    expect(res.body.code).toBe(SKILL_CUSTOMIZED_ERROR_CODE);
    expect(res.body.details).toMatchObject({ code: SKILL_CUSTOMIZED_ERROR_CODE, skillId: "skill-1" });
    expect(notifyMock).toHaveBeenCalledWith({}, "c1", "Brainstorming", "skill-1");
  });

  it("F5 — a failing name lookup still yields the 409, not a 500", async () => {
    installUpdateMock.mockRejectedValue(
      conflict("has local edits", { code: SKILL_CUSTOMIZED_ERROR_CODE, skillId: "skill-1" }),
    );
    getByIdMock.mockRejectedValue(new Error("db blip"));

    const res = await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(SKILL_CUSTOMIZED_ERROR_CODE);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("F6 — no durable hub item for a skill that no longer exists", async () => {
    installUpdateMock.mockRejectedValue(
      conflict("has local edits", { code: SKILL_CUSTOMIZED_ERROR_CODE, skillId: "skill-1" }),
    );
    getByIdMock.mockResolvedValue(null); // lost the delete race

    const res = await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(res.status).toBe(409);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not notify for a skill belonging to another company", async () => {
    installUpdateMock.mockRejectedValue(
      conflict("has local edits", { code: SKILL_CUSTOMIZED_ERROR_CODE, skillId: "skill-1" }),
    );
    getByIdMock.mockResolvedValue({ id: "skill-1", name: "Brainstorming", companyId: "other-co" });

    await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("does not notify on a successful install-update (discriminator)", async () => {
    installUpdateMock.mockResolvedValue({ id: "skill-1", slug: "brainstorming", sourceRef: "abc" });

    const res = await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(res.status).toBe(200);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("a notification failure does not turn the refusal into a 500", async () => {
    installUpdateMock.mockRejectedValue(
      conflict("has local edits", { code: SKILL_CUSTOMIZED_ERROR_CODE, skillId: "skill-1" }),
    );
    getByIdMock.mockResolvedValue({ id: "skill-1", name: "Brainstorming", companyId: "c1" });
    notifyMock.mockRejectedValue(new Error("hub down"));

    const res = await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(res.status).toBe(409);
  });

  it("passes through unrelated 409s without notifying", async () => {
    installUpdateMock.mockRejectedValue(conflict("something else"));

    const res = await request(buildApp()).post("/companies/c1/skills/skill-1/install-update");

    expect(res.status).toBe(409);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("POST /skills/import — customized refusal", () => {
  it("returns the refusal in the body and notifies once per refused skill", async () => {
    importFromSourceMock.mockResolvedValue({
      imported: [],
      warnings: ['Skipped "Brainstorming" — it has local edits...'],
      refusedCustomized: [
        { skillId: "skill-1", key: "acme/skills/brainstorming", slug: "brainstorming", name: "Brainstorming", reason: "customized" },
      ],
    });

    getByIdMock.mockResolvedValue({ id: "skill-1", name: "Brainstorming", companyId: "c1" });

    const res = await request(buildApp())
      .post("/companies/c1/skills/import")
      .send({ source: "https://github.com/acme/skills" });

    expect(res.status).toBe(201);
    expect(res.body.refusedCustomized).toHaveLength(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({}, "c1", "Brainstorming", "skill-1");
  });

  it("does not notify when nothing was refused (discriminator)", async () => {
    importFromSourceMock.mockResolvedValue({
      imported: [{ id: "skill-1", slug: "brainstorming" }],
      warnings: [],
      refusedCustomized: [],
    });

    const res = await request(buildApp())
      .post("/companies/c1/skills/import")
      .send({ source: "https://github.com/acme/skills" });

    expect(res.status).toBe(201);
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
