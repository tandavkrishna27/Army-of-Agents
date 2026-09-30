import { describe, it, expect } from "vitest";
import { updateAgentSchema } from "../validators/agent.js";

describe("updateAgentSchema — expectedUpdatedAt (optimistic concurrency token)", () => {
  it("accepts an absent token (back-compat: last-write-wins path)", () => {
    const parsed = updateAgentSchema.parse({ title: "New title" });
    expect(parsed).not.toHaveProperty("expectedUpdatedAt");
  });

  it("accepts a valid ISO datetime token", () => {
    const iso = new Date("2026-06-25T12:00:00.000Z").toISOString();
    const parsed = updateAgentSchema.parse({ title: "x", expectedUpdatedAt: iso });
    expect(parsed.expectedUpdatedAt).toBe(iso);
  });

  it("rejects a non-datetime token", () => {
    const res = updateAgentSchema.safeParse({ expectedUpdatedAt: "not-a-date" });
    expect(res.success).toBe(false);
  });
});
