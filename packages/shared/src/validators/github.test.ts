import { describe, expect, it } from "vitest";
import { isGitHubRepoUrl } from "./github.js";

describe("isGitHubRepoUrl", () => {
  it("accepts a valid github.com owner/repo URL", () => {
    expect(isGitHubRepoUrl("https://github.com/acme/product")).toBe(true);
  });

  it("accepts www.github.com", () => {
    expect(isGitHubRepoUrl("https://www.github.com/acme/product")).toBe(true);
  });

  it("accepts a repo URL with a trailing .git", () => {
    expect(isGitHubRepoUrl("https://github.com/acme/product.git")).toBe(true);
  });

  it("accepts extra path segments beyond owner/repo", () => {
    expect(isGitHubRepoUrl("https://github.com/acme/product/tree/main")).toBe(true);
  });

  it("rejects a non-github host", () => {
    expect(isGitHubRepoUrl("https://gitlab.com/acme/product")).toBe(false);
  });

  it("rejects a github URL with fewer than 2 path segments", () => {
    expect(isGitHubRepoUrl("https://github.com/acme")).toBe(false);
    expect(isGitHubRepoUrl("https://github.com/")).toBe(false);
  });

  it("rejects garbage / unparseable input", () => {
    expect(isGitHubRepoUrl("not a url")).toBe(false);
    expect(isGitHubRepoUrl("")).toBe(false);
  });

  it("rejects a lookalike host containing github.com as a substring", () => {
    expect(isGitHubRepoUrl("https://github.com.evil.example/acme/product")).toBe(false);
    expect(isGitHubRepoUrl("https://notgithub.com/acme/product")).toBe(false);
  });
});
