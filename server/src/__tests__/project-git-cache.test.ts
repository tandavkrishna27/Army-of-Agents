import { describe, it, expect, beforeEach } from "vitest";
import {
  graphCache,
  enrichCache,
  projectGitCacheKey,
  invalidateProjectGitCache,
} from "../services/project-git-cache";

describe("invalidateProjectGitCache", () => {
  beforeEach(() => { graphCache.clear(); enrichCache.clear(); });

  it("clears both graph and enrich entries for the project key", () => {
    const key = projectGitCacheKey("c1", "p1");
    graphCache.set(key, { data: { ok: true } as never, expiresAt: Date.now() + 9999 });
    enrichCache.set(key, { data: { ok: true } as never, expiresAt: Date.now() + 9999 });
    invalidateProjectGitCache("c1", "p1");
    expect(graphCache.has(key)).toBe(false);
    expect(enrichCache.has(key)).toBe(false);
  });

  it("does not touch other projects' entries", () => {
    const keep = projectGitCacheKey("c1", "p2");
    graphCache.set(keep, { data: 1 as never, expiresAt: Date.now() + 9999 });
    invalidateProjectGitCache("c1", "p1");
    expect(graphCache.has(keep)).toBe(true);
  });
});
