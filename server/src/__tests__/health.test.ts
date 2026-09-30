import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@armyofagents/db", () => {
  const makeTable = () =>
    new Proxy({}, { get: (_target, prop) => (prop === "$inferSelect" || prop === "$inferInsert" ? {} : Symbol(String(prop))) });
  return { instanceUserRoles: makeTable() };
});

vi.mock("drizzle-orm", () => ({
  count: (..._args: unknown[]) => "count",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

import { healthRoutes } from "../routes/health.js";

describe("GET /health", () => {
  const app = express();
  app.use("/health", healthRoutes());

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
