import { beforeEach, describe, it, expect, vi } from "vitest";
import type { CatalogItem } from "@armyofagents/shared";

vi.mock("../services/outbound-url-guard.js", () => ({
  validateAndResolveFetchUrl: vi.fn(async (url: string) => ({
    parsedUrl: new URL(url),
    resolvedAddress: "93.184.216.34",
    hostHeader: new URL(url).host,
    tlsServername: new URL(url).hostname,
    useTls: true,
  })),
  executePinnedRequest: vi.fn(),
}));

import {
  loadSkillContent,
  MarketplaceResourceFetchError,
} from "../services/marketplace-install/fetch-resource.js";
import {
  executePinnedRequest,
  validateAndResolveFetchUrl,
} from "../services/outbound-url-guard.js";

const BASE_ITEM: CatalogItem = {
  id: "skill:aoa-curated/code-review",
  type: "skill",
  name: "Code Review",
  description: "Reviews code for issues",
  version: "1.0.0",
  source: { adapter: "aoa-curated", url: "https://example.com", locator: "content/skills/code-review", commitSha: "abc123" },
  resourceUrl: `https://raw.githubusercontent.com/example/skills/${"f".repeat(40)}/SKILL.md`,
  content: undefined,
  trust: { tier: "verified", source: "aoa-curated" },
  status: "active",
  addedAt: "2026-04-30T00:00:00Z",
  category: "engineering",
  tags: [],
};

describe("loadSkillContent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns inline content without making any HTTP request", async () => {
    vi.mocked(validateAndResolveFetchUrl).mockClear();
    vi.mocked(executePinnedRequest).mockClear();

    const item = { ...BASE_ITEM, content: { inline: "# Code Review\n\nCheck for bugs." } };
    const result = await loadSkillContent(item);

    expect(result).toBe("# Code Review\n\nCheck for bugs.");
    expect(executePinnedRequest).not.toHaveBeenCalled();
  });

  it("fetches from resourceUrl when no inline content present", async () => {
    const body = "# Web Search\n\nFetched from CDN.";
    vi.mocked(executePinnedRequest).mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      body,
    });

    const result = await loadSkillContent(BASE_ITEM);

    expect(result).toBe(body);
    expect(validateAndResolveFetchUrl).toHaveBeenCalledWith(
      BASE_ITEM.resourceUrl,
    );
    expect(executePinnedRequest).toHaveBeenCalled();
  });

  it("accepts a commit-pinned GitHub root-level resource", async () => {
    const resourceUrl =
      `https://github.com/example/skills/raw/${"f".repeat(40)}/SKILL.md`;
    vi.mocked(executePinnedRequest).mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      body: "# Root-level skill",
    });

    await expect(
      loadSkillContent({ ...BASE_ITEM, resourceUrl }),
    ).resolves.toBe("# Root-level skill");
    expect(validateAndResolveFetchUrl).toHaveBeenCalledWith(resourceUrl);
  });

  it("throws an error containing 'HTTP 404' when fetch returns non-ok", async () => {
    vi.mocked(executePinnedRequest).mockResolvedValueOnce({
      status: 404,
      statusText: "Not Found",
      headers: {},
      body: "",
    });

    await expect(loadSkillContent(BASE_ITEM)).rejects.toThrow("HTTP 404");
  });

  it("revalidates and follows an allowlisted relative redirect", async () => {
    vi.mocked(executePinnedRequest)
      .mockResolvedValueOnce({
        status: 302,
        statusText: "Found",
        headers: { location: "README.md" },
        body: "",
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        headers: {},
        body: "# Redirected skill",
      });

    await expect(loadSkillContent(BASE_ITEM)).resolves.toBe(
      "# Redirected skill",
    );
    expect(validateAndResolveFetchUrl).toHaveBeenNthCalledWith(
      2,
      new URL("README.md", BASE_ITEM.resourceUrl).toString(),
    );
    expect(executePinnedRequest).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe redirect before issuing another request", async () => {
    vi.mocked(executePinnedRequest).mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      headers: { location: "https://127.0.0.1/internal" },
      body: "",
    });

    await expect(loadSkillContent(BASE_ITEM)).rejects.toMatchObject({
      code: "unsafe_url",
    });
    expect(executePinnedRequest).toHaveBeenCalledTimes(1);
    expect(validateAndResolveFetchUrl).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a redirect omits Location", async () => {
    vi.mocked(executePinnedRequest).mockResolvedValueOnce({
      status: 302,
      statusText: "Found",
      headers: {},
      body: "",
    });

    await expect(loadSkillContent(BASE_ITEM)).rejects.toMatchObject({
      code: "http_error",
      status: 302,
    });
  });

  it("stops after the bounded redirect limit", async () => {
    vi.mocked(executePinnedRequest).mockResolvedValue({
      status: 302,
      statusText: "Found",
      headers: { location: "README.md" },
      body: "",
    });

    const error = await loadSkillContent(BASE_ITEM).catch((cause) => cause);
    expect(error).toBeInstanceOf(MarketplaceResourceFetchError);
    expect(error).toMatchObject({ code: "redirect_limit", status: 302 });
    expect(executePinnedRequest).toHaveBeenCalledTimes(6);
    expect(validateAndResolveFetchUrl).toHaveBeenCalledTimes(6);
  });

  it("rejects credentialed, private, and unpinned resource forms before DNS", async () => {
    for (const resourceUrl of [
      "https://user:secret@raw.githubusercontent.com/acme/repo/" +
        `${"f".repeat(40)}/SKILL.md`,
      "https://127.0.0.1/resource",
      "https://raw.githubusercontent.com/acme/repo/main/SKILL.md",
      `https://github.com/acme/repo/raw/${"f".repeat(40)}`,
      "https://github.com/acme/repo/raw/main/SKILL.md",
    ]) {
      await expect(
        loadSkillContent({ ...BASE_ITEM, resourceUrl }),
      ).rejects.toThrow(/credential-free HTTPS|allowlist/);
    }
  });

  it("throws when item has no inline content and no resourceUrl", async () => {
    const broken = { ...BASE_ITEM, resourceUrl: undefined };

    await expect(loadSkillContent(broken)).rejects.toThrow(/no resourceUrl/i);
  });
});
