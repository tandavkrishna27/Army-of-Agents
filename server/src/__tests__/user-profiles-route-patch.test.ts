import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userProfileRoutes } from "../routes/user-profiles.js";

const profileMocks = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("../services/user-profiles.js", () => ({
  getUserProfile: profileMocks.get,
  upsertUserProfile: profileMocks.upsert,
}));

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.actor = { type: "board", userId: "u1" };
    next();
  });
  app.use("/api", userProfileRoutes(db));
  return app;
}

describe("PATCH /api/user-profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileMocks.upsert.mockResolvedValue({
      userId: "u1",
      displayName: "Ada Lovelace",
      avatarUrl: null,
      title: "Founder",
      bio: "Existing bio",
      socialLinks: [],
    });
  });

  it("preserves omission so a display-name patch cannot clear unrelated fields", async () => {
    const db = {};
    const res = await request(createApp(db))
      .patch("/api/user-profile")
      .send({ displayName: "Ada Lovelace" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(profileMocks.upsert).toHaveBeenCalledWith(db, "u1", {
      displayName: "Ada Lovelace",
    });
  });

  it("forwards timezone to the upsert", async () => {
    const db = {};
    const res = await request(createApp(db))
      .patch("/api/user-profile")
      .send({ displayName: "Ada Lovelace", timezone: "Asia/Kolkata" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(profileMocks.upsert).toHaveBeenCalledWith(db, "u1",
      expect.objectContaining({ timezone: "Asia/Kolkata" }));
  });

  it("Codex P2: rejects a malformed social link with 400 instead of storing it", async () => {
    // Was: Array.isArray-only → the malformed link was stored, then silently
    // dropped by materializeCompanyProfileFromGlobal. Now the route must 400.
    const res = await request(createApp({}))
      .patch("/api/user-profile")
      .send({ socialLinks: [{ type: "website", label: null, url: "https://not a url" }] });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(profileMocks.upsert).not.toHaveBeenCalled();
  });

  it("forwards valid social links to the upsert (200)", async () => {
    const db = {};
    const res = await request(createApp(db))
      .patch("/api/user-profile")
      .send({ socialLinks: [{ type: "website", label: null, url: "https://ada.dev" }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(profileMocks.upsert).toHaveBeenCalledWith(db, "u1",
      expect.objectContaining({
        socialLinks: [{ type: "website", label: null, url: "https://ada.dev" }],
      }));
  });
});
