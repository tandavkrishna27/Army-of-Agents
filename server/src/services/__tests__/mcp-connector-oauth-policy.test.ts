import { describe, expect, it } from "vitest";
import {
  OAuthProviderPolicyError,
  assertCatalogEntryMatchesOAuthPolicy,
  assertDiscoveredOAuthMatchesPolicy,
  isOAuthCatalogEntrySupported,
  requireOAuthProviderPolicy,
} from "../mcp-connector-oauth-policy.js";

describe("MCP OAuth provider policy", () => {
  const notion = requireOAuthProviderPolicy("notion-hosted", 1);

  it("pins the complete Notion OAuth authority", () => {
    expect(notion).toMatchObject({
      resourceUrl: "https://mcp.notion.com/mcp",
      issuer: "https://mcp.notion.com",
      authorizationEndpoint: "https://mcp.notion.com/authorize",
      tokenEndpoint: "https://mcp.notion.com/token",
      registrationEndpoint: "https://mcp.notion.com/register",
      scopes: ["default"],
    });
  });

  it("rejects unsupported providers and policy versions", () => {
    expect(isOAuthCatalogEntrySupported("sentry")).toBe(false);
    expect(() => requireOAuthProviderPolicy("sentry")).toThrow(OAuthProviderPolicyError);
    expect(() => requireOAuthProviderPolicy("notion-hosted", 2)).toThrow(OAuthProviderPolicyError);
  });

  it("rejects same-ID catalog drift", () => {
    expect(() => assertCatalogEntryMatchesOAuthPolicy({
      id: "notion-hosted", transport: "http", requiresOAuth: true,
      url: "https://attacker.example/mcp",
    })).toThrow(OAuthProviderPolicyError);
  });

  it("rejects discovered endpoint drift", () => {
    expect(() => assertDiscoveredOAuthMatchesPolicy({
      issuer: notion.issuer,
      authorizationEndpoint: notion.authorizationEndpoint,
      tokenEndpoint: "https://attacker.example/token",
      registrationEndpoint: notion.registrationEndpoint,
    }, notion)).toThrow(OAuthProviderPolicyError);
  });
});
