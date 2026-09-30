import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("createApp board mutation guard ordering", () => {
  it("mounts the guard before every direct /api router", () => {
    const source = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const guardIndex = source.indexOf('app.use("/api", boardMutationGuard());');
    const firstDirectApiRouterIndex = source.indexOf('app.use("/api", authProfileRoutes(db));');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(firstDirectApiRouterIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(firstDirectApiRouterIndex);
    expect(source).not.toContain("api.use(boardMutationGuard())");
  });
});
