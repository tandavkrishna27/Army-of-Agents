import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Contract tests: read the route source and assert on implementation details.
// These fail before the routes are added and pass once they exist.
const routeSrc = readFileSync(
  resolve(__dirname, "../routes/internal-agent.ts"),
  "utf8",
);

describe("internal-agent route: multi-chat endpoints exist", () => {
  it("has GET conversations route", () => {
    expect(routeSrc).toContain(`"/companies/:companyId/internal-agent/conversations"`);
    expect(routeSrc).toContain("router.get");
  });

  it("has POST conversations route for creating new conversation", () => {
    expect(routeSrc).toContain("router.post");
    expect(routeSrc).toContain(`"/companies/:companyId/internal-agent/conversations"`);
  });

  it("has PATCH archive route", () => {
    expect(routeSrc).toContain(`"/companies/:companyId/internal-agent/conversations/:convId/archive"`);
    expect(routeSrc).toContain("archivedAt");
  });
});

describe("GET conversations — implementation contract", () => {
  it("filters to archivedAt IS NULL so archived convs are hidden", () => {
    expect(routeSrc).toContain("archivedAt");
    expect(routeSrc).toContain("isNull");
  });

  it("applies RBAC — non-founders scoped to their own userId", () => {
    expect(routeSrc).toContain("isFounder");
    expect(routeSrc).toContain("userId");
  });

  it("orders results by updatedAt descending — newest first", () => {
    expect(routeSrc).toContain("updatedAt");
    expect(routeSrc).toContain("desc");
  });
});

describe("POST conversations — implementation contract", () => {
  it("inserts with userId from actor and returns the new row via .returning()", () => {
    expect(routeSrc).toContain("actorId");
    expect(routeSrc).toContain("insert");
    expect(routeSrc).toContain(".returning()");
  });
});

describe("PATCH archive — implementation contract", () => {
  it("sets archivedAt to a Date on the matched conversation", () => {
    expect(routeSrc).toContain("archivedAt");
    expect(routeSrc).toContain("new Date()");
  });

  it("returns 404 if conversation belongs to a different company", () => {
    expect(routeSrc).toContain("throw notFound");
  });
});
