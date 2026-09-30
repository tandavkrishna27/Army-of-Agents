import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { getUserProfile, upsertUserProfile } from "../services/user-profiles.js";
import { userProfileRoutes } from "../routes/user-profiles.js";

function fakeDb() {
  let saved: Record<string, unknown> | null = null;
  const authUpdates: Array<Record<string, unknown>> = [];
  let db: any;
  db = {
    authUpdates,
    transactionCalls: 0,
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      db.transactionCalls += 1;
      return await fn(db);
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          saved = saved ? { ...saved, ...set } : { ...v };
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (saved ? [saved] : []) }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { authUpdates.push(values); },
      }),
    }),
  } as any;
  return db;
}

describe("user profile service (Stage C / C1)", () => {
  it("upserts and returns the global profile", async () => {
    const db = fakeDb();
    const p = await upsertUserProfile(db, "u1", {
      displayName: "Ada",
      socialLinks: [{ type: "github", label: null, url: "https://github.com/ada" }],
    });
    expect(p.userId).toBe("u1");
    expect(p.displayName).toBe("Ada");
    expect(p.socialLinks[0].url).toContain("github");
  });

  it("keeps the existing app identity fields in sync with onboarding profile writes", async () => {
    const db = fakeDb();
    await upsertUserProfile(db, "u1", {
      displayName: "Ada",
      avatarUrl: "https://example.com/ada.png",
    });

    expect(db.authUpdates).toEqual([
      expect.objectContaining({
        displayName: "Ada",
        avatarUrl: "https://example.com/ada.png",
      }),
    ]);
    expect(db.transactionCalls).toBe(1);
  });

  it("getUserProfile returns null when none exists", async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as any;
    expect(await getUserProfile(db, "u1")).toBeNull();
  });

  it("preserves omitted fields on update while applying explicit clears", async () => {
    const db = fakeDb();
    await upsertUserProfile(db, "u1", {
      displayName: "Ada",
      avatarUrl: "https://example.com/ada.png",
      title: "Founder",
      bio: "Builds analytical engines",
      timezone: "Asia/Kolkata",
      socialLinks: [{ type: "github", label: null, url: "https://github.com/ada" }],
    });

    const updated = await upsertUserProfile(db, "u1", {
      displayName: "Ada Lovelace",
      avatarUrl: null,
    });

    expect(updated).toMatchObject({
      displayName: "Ada Lovelace",
      avatarUrl: null,
      title: "Founder",
      bio: "Builds analytical engines",
      timezone: "Asia/Kolkata",
    });
    expect(updated.socialLinks).toEqual([
      { type: "github", label: null, url: "https://github.com/ada" },
    ]);

    const cleared = await upsertUserProfile(db, "u1", {
      timezone: null,
    });
    expect(cleared.timezone).toBeNull();
  });
});

describe("user profile route (Stage C / C1)", () => {
  it("GET /user-profile → 401 without a board actor", async () => {
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "none" };
      next();
    });
    app.use("/api", userProfileRoutes({} as any));
    const res = await request(app).get("/api/user-profile");
    expect(res.status).toBe(401);
  });
});
