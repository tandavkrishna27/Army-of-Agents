import { describe, expect, it } from "vitest";
import { buildConnectorEgressHosts, buildConnectorProcessEnv, mergeConnectorEnv } from "../mcp-connectors-env.js";

// mergeConnectorEnv is the PURE half — takes an already-scrubbed base so it can
// be unit-tested with synthetic input. Real scrubbing is buildScrubbedCliEnv,
// which reads process.env internally and is exercised by the thin wrapper.
describe("mergeConnectorEnv", () => {
  it("includes connector token vars", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, { AOA_MCP_NOTION_TOKEN: "secret-abc" });
    expect(env.AOA_MCP_NOTION_TOKEN).toBe("secret-abc");
  });

  it("preserves PATH from the scrubbed base so npx-based stdio connectors resolve", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, {});
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops undefined values from the scrubbed base", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin", EMPTY: undefined }, {});
    expect(env).not.toHaveProperty("EMPTY");
  });

  it("never lets a connector var overwrite PATH", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, { PATH: "/evil" });
    expect(env.PATH).toBe("/usr/bin");
  });

  it("builds a null-prototype result", () => {
    const env = mergeConnectorEnv({ PATH: "/usr/bin" }, {});
    expect(Object.getPrototypeOf(env)).toBe(null);
  });
});

describe("buildConnectorProcessEnv", () => {
  it("preserves real PATH (or Windows Path) from process.env so a spawned stdio connector can resolve npx/node", () => {
    const env = buildConnectorProcessEnv({});
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
    expect(pathKey).toBeDefined();
    expect(env[pathKey as string]).toBeTruthy();
  });

  it("does not leak AoA/infra secrets from process.env into the connector env", () => {
    const savedDbUrl = process.env.DATABASE_URL;
    const savedAoa = process.env.AOA_TEST_SECRET_PROBE;
    process.env.DATABASE_URL = "postgres://should-not-leak";
    process.env.AOA_TEST_SECRET_PROBE = "should-not-leak";
    try {
      const env = buildConnectorProcessEnv({});
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.AOA_TEST_SECRET_PROBE).toBeUndefined();
    } finally {
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedDbUrl;
      if (savedAoa === undefined) delete process.env.AOA_TEST_SECRET_PROBE;
      else process.env.AOA_TEST_SECRET_PROBE = savedAoa;
    }
  });
});

// U11: best-effort VM egress allowlist — bare hosts only, never a
// scheme/path/wildcard. NOT a security boundary (isTransportAllowed /
// isStdioCommandSafe still gate real delivery, independently); this only
// widens what the sandbox's network policy permits the process to reach.
describe("buildConnectorEgressHosts", () => {
  it("npm + http connector host, no host for stdio-only", () => {
    const hosts = buildConnectorEgressHosts([
      { transport: "http", url: "https://mcp.notion.com/mcp", serverName: "notion" } as any,
      { transport: "stdio", command: "npx", serverName: "local" } as any,
    ]);
    expect(hosts).toContain("mcp.notion.com");        // http connector host
    expect(hosts).toContain("registry.npmjs.org");    // stdio launcher needs npm
    // never a bare scheme/path, never a wildcard
    expect(hosts.every((h) => !h.includes("/") && h !== "*")).toBe(true);
  });

  it("adds PyPI hosts only when the stdio launcher is uvx (not npx)", () => {
    const npxOnly = buildConnectorEgressHosts([
      { transport: "stdio", command: "npx", serverName: "a" } as any,
    ]);
    expect(npxOnly).not.toContain("pypi.org");
    expect(npxOnly).not.toContain("files.pythonhosted.org");

    const uvx = buildConnectorEgressHosts([
      { transport: "stdio", command: "uvx", serverName: "b" } as any,
    ]);
    expect(uvx).toContain("registry.npmjs.org");
    expect(uvx).toContain("pypi.org");
    expect(uvx).toContain("files.pythonhosted.org");
  });

  it("dedupes repeated hosts across multiple connectors", () => {
    const hosts = buildConnectorEgressHosts([
      { transport: "http", url: "https://mcp.notion.com/mcp", serverName: "notion" } as any,
      { transport: "http", url: "https://mcp.notion.com/other", serverName: "notion-2" } as any,
    ]);
    expect(hosts.filter((h) => h === "mcp.notion.com")).toHaveLength(1);
  });

  it("skips a malformed http URL rather than throwing or guessing", () => {
    expect(() =>
      buildConnectorEgressHosts([{ transport: "http", url: "not a url", serverName: "bad" } as any]),
    ).not.toThrow();
    expect(buildConnectorEgressHosts([{ transport: "http", url: "not a url", serverName: "bad" } as any])).toEqual([]);
  });

  it("returns an empty array for no rows", () => {
    expect(buildConnectorEgressHosts([])).toEqual([]);
  });
});
