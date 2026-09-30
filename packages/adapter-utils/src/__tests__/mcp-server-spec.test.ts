import { describe, expect, it } from "vitest";
import {
  isHttpServerSpec,
  isStdioServerSpec,
  aoaSecretPlaceholderVars,
  containsAoaSecretPlaceholder,
  mergeExternalMcpServers,
  reservedMcpServerNameCollisions,
  RESERVED_MCP_SERVER_NAMES,
  stdioSpecCarriesSecretPlaceholder,
  stripReservedMcpServerNames,
  type McpServerSpec,
} from "../mcp-server-spec.js";

const httpSpec = (url: string): McpServerSpec => ({ kind: "http", url, headers: {} });

describe("McpServerSpec", () => {
  it("narrows a stdio spec", () => {
    const spec: McpServerSpec = {
      kind: "stdio",
      command: "npx",
      args: ["@playwright/mcp@0.0.75"],
      env: {},
    };
    expect(isStdioServerSpec(spec)).toBe(true);
    expect(isHttpServerSpec(spec)).toBe(false);
  });

  it("narrows an http spec with headers", () => {
    const spec: McpServerSpec = {
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    };
    expect(isHttpServerSpec(spec)).toBe(true);
    expect(isStdioServerSpec(spec)).toBe(false);
  });

  it("narrows an http spec that also carries authTokenEnvVar", () => {
    const spec: McpServerSpec = {
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
      authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
    };
    expect(isHttpServerSpec(spec)).toBe(true);
    expect(isStdioServerSpec(spec)).toBe(false);
  });

  it("narrows an http spec without authTokenEnvVar the same as with it (optional field)", () => {
    const withVar: McpServerSpec = {
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: {},
      authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
    };
    const withoutVar: McpServerSpec = {
      kind: "http",
      url: "https://mcp.notion.com/mcp",
      headers: {},
    };
    expect(isHttpServerSpec(withVar)).toBe(isHttpServerSpec(withoutVar));
    expect((withoutVar as { authTokenEnvVar?: string }).authTokenEnvVar).toBeUndefined();
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "http", 42, true]) {
      expect(isStdioServerSpec(value)).toBe(false);
      expect(isHttpServerSpec(value)).toBe(false);
    }
  });

  it("rejects an object with the right kind but a missing required field", () => {
    expect(isStdioServerSpec({ kind: "stdio" })).toBe(false);
    expect(isHttpServerSpec({ kind: "http" })).toBe(false);
  });

  it("rejects an object with the right kind but a wrong-typed required field", () => {
    expect(isStdioServerSpec({ kind: "stdio", command: 123 })).toBe(false);
    expect(isHttpServerSpec({ kind: "http", url: 123 })).toBe(false);
  });

  it("rejects an unrelated object", () => {
    expect(isStdioServerSpec({ foo: "bar" })).toBe(false);
    expect(isHttpServerSpec({ foo: "bar" })).toBe(false);
  });
});

// These two helpers are consumed by the server AND by three Plan 2 adapter
// writers, so they are covered directly here rather than only through
// buildMcpConfig in the server package.

describe("stripReservedMcpServerNames", () => {
  it("drops every reserved name", () => {
    const out = stripReservedMcpServerNames(
      Object.fromEntries(
        RESERVED_MCP_SERVER_NAMES.map((name) => [name, httpSpec("https://evil.example.com/mcp")]),
      ),
    );
    expect(Object.keys(out)).toEqual([]);
  });

  it("preserves non-reserved connectors untouched", () => {
    const notion = httpSpec("https://mcp.notion.com/mcp");
    const out = stripReservedMcpServerNames({ notion, aoa: httpSpec("https://evil.example.com") });
    expect(Object.keys(out)).toEqual(["notion"]);
    expect(out.notion).toBe(notion);
  });

  it("handles empty input", () => {
    expect(Object.keys(stripReservedMcpServerNames({}))).toEqual([]);
  });

  it("returns a null-prototype object", () => {
    expect(Object.getPrototypeOf(stripReservedMcpServerNames({}))).toBeNull();
  });
});

describe("mergeExternalMcpServers", () => {
  const passthrough = (spec: McpServerSpec) => spec;

  it("returns a null-prototype object", () => {
    expect(Object.getPrototypeOf(mergeExternalMcpServers({}, {}, passthrough))).toBeNull();
  });

  // NOTE: this case is carried by stripReservedMcpServerNames, not by the
  // hasOwnProperty precedence guard — `aoa` is filtered out of `external`
  // before the merge loop ever runs. See the non-reserved test below for the
  // one that actually exercises the guard.
  it("filters a RESERVED_MCP_SERVER_NAMES connector out before the merge loop", () => {
    const ours: McpServerSpec = { kind: "stdio", command: "node", args: [], env: {} };
    const out = mergeExternalMcpServers<McpServerSpec>(
      { aoa: ours },
      { aoa: httpSpec("https://evil.example.com/mcp") },
      passthrough,
    );
    expect(out.aoa).toBe(ours);
    expect(Object.keys(out)).toEqual(["aoa"]);
  });

  // The precedence guard's real job: `notion` is NOT reserved, so it survives
  // stripReservedMcpServerNames and reaches the loop, where hasOwnProperty must
  // stop it clobbering the caller-supplied entry of the same name. Identity
  // (toBe) is the assertion that matters — it proves the reserved value won
  // rather than being re-derived through toEntry.
  it("lets a caller-supplied entry win over a colliding NON-reserved connector", () => {
    const ours: McpServerSpec = { kind: "stdio", command: "node", args: [], env: {} };
    const out = mergeExternalMcpServers<McpServerSpec>(
      { notion: ours },
      { notion: httpSpec("https://evil.example.com/mcp") },
      passthrough,
    );
    expect(out.notion).toBe(ours);
    expect(Object.keys(out)).toEqual(["notion"]);
  });

  it("keeps a __proto__-named connector as an own key", () => {
    const out = mergeExternalMcpServers<McpServerSpec>(
      {},
      { ["__proto__"]: httpSpec("https://x.example.com/mcp") },
      passthrough,
    );
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    // The connector must not have become the map's prototype.
    expect((out as Record<string, unknown>).url).toBeUndefined();
  });

  it("applies toEntry to each external spec but never to reserved entries", () => {
    const reservedEntry = { tag: "reserved" };
    const out = mergeExternalMcpServers(
      { aoa: reservedEntry },
      { a: httpSpec("https://a.example.com"), b: httpSpec("https://b.example.com") },
      (spec) => ({ tag: isHttpServerSpec(spec) ? spec.url : "stdio" }),
    );
    expect(out.aoa).toBe(reservedEntry);
    expect(out.a).toEqual({ tag: "https://a.example.com" });
    expect(out.b).toEqual({ tag: "https://b.example.com" });
  });

  it("merges an empty connector set without disturbing reserved entries", () => {
    const out = mergeExternalMcpServers<McpServerSpec>(
      { aoa: httpSpec("https://loopback.example.com") },
      {},
      passthrough,
    );
    expect(Object.keys(out)).toEqual(["aoa"]);
  });
});

// ── Plan 2b Task 6 ──────────────────────────────────────────────────────────

describe("stripReservedMcpServerNames — caller's configured bridge name (M2)", () => {
  it("drops a connector colliding with the caller's non-default serverName", () => {
    // The bridge's table/key name is CONFIGURABLE. Filtering only the hardcoded
    // list left a hole: on codex (string concatenation, last-wins) the
    // connector's block would REPLACE AoA's own loopback bridge.
    const out = stripReservedMcpServerNames(
      { "aoa-crew": httpSpec("https://evil.example.com"), notion: httpSpec("https://n") },
      ["aoa-crew"],
    );
    expect(Object.keys(out)).toEqual(["notion"]);
  });

  it("still drops the hardcoded reserved names when extras are supplied", () => {
    const out = stripReservedMcpServerNames(
      { aoa: httpSpec("https://a"), playwright: httpSpec("https://b"), ok: httpSpec("https://c") },
      ["aoa-crew"],
    );
    expect(Object.keys(out)).toEqual(["ok"]);
  });

  it("is unchanged when no extras are supplied (back-compat)", () => {
    const out = stripReservedMcpServerNames({ aoa: httpSpec("https://a"), ok: httpSpec("https://c") });
    expect(Object.keys(out)).toEqual(["ok"]);
  });
});

describe("reservedMcpServerNameCollisions", () => {
  it("reports exactly the names strip would drop, so writers can classify them", () => {
    const servers = {
      aoa: httpSpec("https://a"),
      "aoa-crew": httpSpec("https://b"),
      notion: httpSpec("https://c"),
    };
    const collisions = reservedMcpServerNameCollisions(servers, ["aoa-crew"]);
    expect(collisions.sort()).toEqual(["aoa", "aoa-crew"]);
    expect(Object.keys(stripReservedMcpServerNames(servers, ["aoa-crew"]))).toEqual(["notion"]);
  });
});

describe("AoA secret placeholder detection (B2N9)", () => {
  it("detects the ${AOA_MCP_*} placeholder form", () => {
    expect(containsAoaSecretPlaceholder("Bearer ${AOA_MCP_NOTION_TOKEN}")).toBe(true);
  });

  it("leaves unrelated ${...} text alone", () => {
    // A writer that treated every ${...} as ours would mangle a user's own
    // literal text.
    expect(containsAoaSecretPlaceholder("${HOME}/bin")).toBe(false);
    expect(containsAoaSecretPlaceholder("no placeholders here")).toBe(false);
  });

  it("is not stateful across calls (the exported /g regex is shared)", () => {
    const value = "Bearer ${AOA_MCP_X_TOKEN}";
    expect(containsAoaSecretPlaceholder(value)).toBe(true);
    expect(containsAoaSecretPlaceholder(value)).toBe(true);
  });

  it("flags a stdio spec whose OWN secret placeholder is in args", () => {
    expect(
      stdioSpecCarriesSecretPlaceholder({
        kind: "stdio",
        command: "npx",
        args: ["srv", "--token", "${AOA_MCP_X_TOKEN}"],
        env: {},
        secretEnvVar: "AOA_MCP_X_TOKEN",
      }),
    ).toBe(true);
  });

  it("flags a stdio spec whose OWN secret placeholder is in env values", () => {
    expect(
      stdioSpecCarriesSecretPlaceholder({
        kind: "stdio",
        command: "npx",
        args: [],
        env: { API_KEY: "${AOA_MCP_X_TOKEN}" },
        secretEnvVar: "AOA_MCP_X_TOKEN",
      }),
    ).toBe(true);
  });

  it("does NOT flag a secretless stdio spec", () => {
    expect(
      stdioSpecCarriesSecretPlaceholder({
        kind: "stdio",
        command: "npx",
        args: ["srv", "--verbose"],
        env: { LOG: "debug" },
      }),
    ).toBe(false);
  });

  // M3 — the detector is gated on the connector ACTUALLY having a secret, not
  // on placeholder shape. A connector with no secret cannot have a credential
  // that fails to arrive, so reporting `secret_unreachable` for it is a lie.
  it("does NOT flag a SECRETLESS spec that merely mentions another connector's var", () => {
    expect(
      stdioSpecCarriesSecretPlaceholder({
        kind: "stdio",
        command: "npx",
        args: ["srv", "--token", "${AOA_MCP_OTHER_TOKEN}"],
        env: {},
      }),
    ).toBe(false);
  });

  it("does NOT flag a spec whose secret placeholder is absent from args/env", () => {
    // It has a secret, but nothing references it — there is no placeholder for
    // the CLI to fail to expand, so this connector is deliverable as-is.
    expect(
      stdioSpecCarriesSecretPlaceholder({
        kind: "stdio",
        command: "npx",
        args: ["srv"],
        env: { LOG: "debug" },
        secretEnvVar: "AOA_MCP_X_TOKEN",
      }),
    ).toBe(false);
  });

  it("ignores a DIFFERENT connector's placeholder when it has its own secret", () => {
    expect(
      stdioSpecCarriesSecretPlaceholder({
        kind: "stdio",
        command: "npx",
        args: ["srv", "--other", "${AOA_MCP_OTHER_TOKEN}"],
        env: {},
        secretEnvVar: "AOA_MCP_X_TOKEN",
      }),
    ).toBe(false);
  });
});

describe("aoaSecretPlaceholderVars", () => {
  it("returns every referenced var name, deduped and in order", () => {
    expect(aoaSecretPlaceholderVars("${AOA_MCP_A_TOKEN}/${AOA_MCP_B_TOKEN}/${AOA_MCP_A_TOKEN}"))
      .toEqual(["AOA_MCP_A_TOKEN", "AOA_MCP_B_TOKEN"]);
  });

  it("returns [] for text with no AoA placeholder", () => {
    expect(aoaSecretPlaceholderVars("Bearer ${HOME}")).toEqual([]);
  });

  it("is not stateful across calls", () => {
    const v = "Bearer ${AOA_MCP_X_TOKEN}";
    expect(aoaSecretPlaceholderVars(v)).toEqual(["AOA_MCP_X_TOKEN"]);
    expect(aoaSecretPlaceholderVars(v)).toEqual(["AOA_MCP_X_TOKEN"]);
  });
});
