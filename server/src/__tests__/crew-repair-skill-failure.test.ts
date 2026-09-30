import { describe, expect, it } from "vitest";
import { classifyCrewSkillFailure } from "../services/crew-repair.js";
import { MarketplaceResourceFetchError } from "../services/marketplace-install/fetch-resource.js";

describe("crew repair skill failure classification", () => {
  it.each([
    {
      cause: Object.assign(new Error("secret path permission denied"), {
        code: "EACCES",
        syscall: "write",
      }),
      code: "filesystem-permission-denied",
      context: { filesystemOperation: "write" },
    },
    {
      cause: Object.assign(new Error("SKILL.md missing"), {
        code: "ENOENT",
      }),
      code: "bundle-missing",
      context: {},
    },
    {
      cause: Object.assign(new Error("HTTP 429"), { status: 429 }),
      code: "resource-temporarily-unavailable",
      context: { httpStatus: 429 },
    },
    {
      cause: Object.assign(new Error("request aborted"), {
        name: "AbortError",
      }),
      code: "resource-temporarily-unavailable",
      context: {},
    },
    {
      cause: new MarketplaceResourceFetchError(
        "Failed to fetch skill content",
        "transport_error",
        undefined,
        {
          cause: Object.assign(new Error("upstream secret timed out"), {
            name: "TimeoutError",
          }),
        },
      ),
      code: "resource-temporarily-unavailable",
      context: {},
    },
    {
      cause: new MarketplaceResourceFetchError(
        "Failed to fetch skill content",
        "transport_error",
        undefined,
        {
          cause: Object.assign(new Error("upstream secret aborted"), {
            name: "AbortError",
          }),
        },
      ),
      code: "resource-temporarily-unavailable",
      context: {},
    },
    {
      cause: new MarketplaceResourceFetchError(
        "Failed to fetch skill content",
        "transport_error",
        undefined,
        { cause: new Error("upstream secret socket closed") },
      ),
      code: "resource-fetch-failed",
      context: {},
    },
    {
      cause: Object.assign(new Error("HTTP 404"), { status: 404 }),
      code: "resource-fetch-failed",
      context: { httpStatus: 404 },
    },
    {
      cause: new SyntaxError("invalid catalog resource"),
      code: "resource-invalid",
      context: {},
    },
    {
      cause: new Error("unclassified internal token secret-value"),
      code: "bundle-materialization-failed",
      context: {},
    },
  ])("maps internal failures to $code without exposing cause text", ({
    cause,
    code,
    context,
  }) => {
    const result = classifyCrewSkillFailure(
      "skill:aoa-curated/example",
      cause,
    );

    expect(result).toMatchObject({
      code,
      catalogItemId: "skill:aoa-curated/example",
      ...context,
    });
    if (code === "resource-temporarily-unavailable") {
      expect(result.notBefore).toEqual(expect.any(String));
    }
    expect(JSON.stringify(result)).not.toContain(cause.message);
    expect(result).not.toHaveProperty("cause");
  });

  it("drops invalid HTTP status metadata and caps an untrusted catalog id", () => {
    const result = classifyCrewSkillFailure(
      `skill:${"x".repeat(200)}`,
      Object.assign(new Error("HTTP 999"), { status: 999 }),
    );

    expect(result).toMatchObject({
      code: "bundle-materialization-failed",
      catalogItemId: "unknown",
    });
    expect(result).not.toHaveProperty("httpStatus");
  });
});
