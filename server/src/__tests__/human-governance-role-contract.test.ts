import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function routeSource(name: string): string {
  return readFileSync(new URL(`../routes/${name}`, import.meta.url), "utf8");
}

function handlerBlock(source: string, route: string, method?: string): string {
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = method
    ? new RegExp(`router\\.${method}\\(\\s*"${escapedRoute}"`).exec(source)?.index ?? -1
    : source.indexOf(`"${route}"`);
  expect(start, `missing ${method ? `${method.toUpperCase()} ` : ""}route ${route}`).toBeGreaterThan(-1);
  const next = source.indexOf("\n  router.", start + route.length + 2);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("human governance role contracts", () => {
  it.each([
    "briefs.ts",
    "file-import.ts",
    "internal-agent.ts",
    "memory-assets.ts",
    "memory-assets-upload.ts",
    "memory-feedback.ts",
    "memory-folders.ts",
    "memory-lifecycle.ts",
    "suggestions.ts",
    "team-imports.ts",
    "teams.ts",
    "workflow-templates.ts",
  ])("uses the non-agent role gate in %s", (file) => {
    const source = routeSource(file);
    expect(source).not.toMatch(/\bawait assertRole\s*\(/);
    expect(source).toContain("assertHumanRole");
  });

  it.each([
    "/companies/:companyId/discussions/inbox",
    "/companies/:companyId/discussions/:discussionId/reprocess",
    "/companies/:companyId/discussions/:discussionId/approve",
    "/companies/:companyId/discussions/link",
    "/companies/:companyId/discussions/:discussionId/share-token",
    "/companies/:companyId/discussions/:discussionId/promote-to-goal",
    "/companies/:companyId/discussions/:discussionId/assign",
    "/companies/:companyId/discussions/:discussionId/crew/pause",
    "/companies/:companyId/discussions/:discussionId/crew/resume",
    "/companies/:companyId/discussions/:discussionId/proposals/:proposalEntryId/approve",
  ])("keeps %s board-only", (route) => {
    expect(handlerBlock(routeSource("discussions.ts"), route)).toContain("assertHumanRole");
  });

  it.each([
    ["post", "/companies/:companyId/agents/:id/triggers"],
    ["patch", "/companies/:companyId/agents/:id/triggers/:triggerId"],
  ])("keeps %s %s board-only", (method, route) => {
    expect(handlerBlock(routeSource("agents.ts"), route, method)).toContain("assertHumanRole");
  });

  it.each([
    ["post", "/companies/:companyId/discussions"],
    ["patch", "/companies/:companyId/discussions/:discussionId"],
  ])("keeps %s %s human-governed", (method, route) => {
    expect(handlerBlock(routeSource("discussions.ts"), route, method)).toContain("assertHumanRole");
  });

  it("keeps every goal mutation human-governed", () => {
    const source = routeSource("goals.ts");
    expect(source).not.toMatch(/\bawait assertRole\s*\(/);
    expect(source.match(/await assertHumanRole\s*\(/g)).toHaveLength(4);
  });

  it.each([
    ["patch", "/settings"],
    ["post", "/updates/:id/dismiss"],
    ["post", "/updates/:id/apply"],
    ["post", "/updates/:id/merge"],
  ])("keeps marketplace governance mutation %s %s founder-only", (method, route) => {
    const block = handlerBlock(routeSource("marketplace-company.ts"), route, method);
    expect(block).toContain("assertBoard(req)");
    expect(block).toContain('assertRole(db, req, companyId, "founder")');
  });
});
