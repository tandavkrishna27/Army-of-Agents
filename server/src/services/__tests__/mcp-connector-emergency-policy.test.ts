import { describe, expect, it } from "vitest";
import {
  isMcpConnectorBlocked,
  readMcpConnectorEmergencyPolicy,
} from "../mcp-connector-emergency-policy.js";

describe("MCP connector emergency policy", () => {
  it("defaults to enabled with an empty denylist", () => {
    const policy = readMcpConnectorEmergencyPolicy({});
    expect(policy.enabled).toBe(true);
    expect([...policy.deniedServerNames]).toEqual([]);
    expect(isMcpConnectorBlocked("context7", policy)).toBe(false);
  });

  it.each(["0", "false", "off", "no", "typo"])(
    "fails closed for explicit enabled value %j",
    (value) => {
      const policy = readMcpConnectorEmergencyPolicy({
        AOA_MCP_CONNECTORS_ENABLED: value,
      });
      expect(policy.enabled).toBe(false);
      expect(isMcpConnectorBlocked("context7", policy)).toBe(true);
    },
  );

  it("normalizes valid denylist names and ignores invalid names", () => {
    const policy = readMcpConnectorEmergencyPolicy({
      AOA_MCP_CONNECTOR_DENYLIST:
        " Context7, github, Bad_Name, ../escape, context7 ",
    });
    expect([...policy.deniedServerNames]).toEqual(["context7", "github"]);
    expect(isMcpConnectorBlocked("context7", policy)).toBe(true);
    expect(isMcpConnectorBlocked("notion", policy)).toBe(false);
  });

  it("blocks the shipped OAuth connector server names from the operator runbook", () => {
    const policy = readMcpConnectorEmergencyPolicy({
      AOA_MCP_CONNECTOR_DENYLIST: "notion,sentry",
    });

    expect(isMcpConnectorBlocked("notion", policy)).toBe(true);
    expect(isMcpConnectorBlocked("sentry", policy)).toBe(true);
    // Catalog entry IDs are not runtime server names.
    expect(isMcpConnectorBlocked("notion-hosted", policy)).toBe(false);
  });
});
