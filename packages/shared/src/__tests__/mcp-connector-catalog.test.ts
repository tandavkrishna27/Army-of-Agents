import { describe, it, expect } from "vitest";
import {
  McpConnectorCatalogEntrySchema,
  parseMcpConnectorCatalog,
} from "../mcp-connector-catalog.js";

describe("McpConnectorCatalogEntrySchema", () => {
  const httpEntry = {
    id: "notion",
    displayName: "Notion",
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    headerTemplateKeys: ["Authorization"],
    requiresSecret: true,
    trust: { tier: "verified" },
  };

  it("accepts a verified http entry", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse(httpEntry);
    expect(r.success).toBe(true);
  });

  it("defaults trust tier to community when absent (fail-closed)", () => {
    const { trust: _t, ...noTrust } = httpEntry;
    const r = McpConnectorCatalogEntrySchema.parse(noTrust);
    expect(r.trust.tier).toBe("community");
  });

  it("rejects a serverName outside /^[a-z0-9-]+$/", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      serverName: "Bad_Name",
    });
    expect(r.success).toBe(false);
  });

  it("strips an unknown value-bearing headerTemplate field so a smuggled secret cannot survive", () => {
    // FU-22: the entry schema is `.strip()` (forward-compat), so an unknown field
    // no longer FAILS the entry — but the secret-smuggling property must survive.
    // `headerTemplate` (VALUES) is not a field this schema knows; it is stripped,
    // so the pasted credential never reaches `entryToCreateInput` or a downstream
    // header-map writer.
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      headerTemplate: { Authorization: "Bearer sk-live-real" },
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).not.toHaveProperty("headerTemplate");
    expect(JSON.stringify(r.success && r.data)).not.toContain("sk-live-real");
  });

  it("tolerates a purely additive optional field, stripping it (FU-22 / Decision #96)", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      iconUrl: "https://cdn/x.png",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data).not.toHaveProperty("iconUrl");
  });

  it.each(["aoa", "playwright"])(
    "drops a reserved-name entry %j from the shelf (Codex P2 shelf hygiene)",
    (serverName) => {
      const file = {
        schemaVersion: "1.0.0",
        entries: [httpEntry, { ...httpEntry, id: "reserved", serverName }],
      };
      const result = parseMcpConnectorCatalog(file);
      expect(result.entries.map((e) => e.id)).toEqual(["notion"]);
      expect(result.dropped).toEqual(["reserved"]);
      expect(result.malformed).toBe(false);
    }
  );

  it("drops an unparseable entry but keeps the good ones (forward compatible)", () => {
    const file = {
      schemaVersion: "1.0.0",
      entries: [httpEntry, { id: "broken", transport: "carrier-pigeon" }],
    };
    const result = parseMcpConnectorCatalog(file);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("notion");
    expect(result.dropped).toEqual(["broken"]);
  });

  it("rejects a headerTemplateKeys entry smuggling a `Name: value` pair", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      headerTemplateKeys: ["Authorization: Bearer sk-live-actualsecret12345"],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an envTemplateKeys entry smuggling a bare secret value", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      transport: "stdio",
      command: "npx",
      url: undefined,
      envTemplateKeys: ["sk-live-actualsecret12345"],
    });
    expect(r.success).toBe(false);
  });

  it("accepts legitimate header and env template key names", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      headerTemplateKeys: ["Authorization", "X-Api-Key"],
      envTemplateKeys: ["NOTION_TOKEN", "_PRIVATE"],
    });
    expect(r.success).toBe(true);
  });

  it("accepts requiresOAuth:true as a valid entry (shown-but-not-installable)", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      requiresOAuth: true,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.requiresOAuth).toBe(true);
  });

  it("defaults requiresOAuth to false when absent", () => {
    const r = McpConnectorCatalogEntrySchema.parse(httpEntry);
    expect(r.requiresOAuth).toBe(false);
  });

  it("keeps requiresOAuth alongside unknown-field tolerance (.strip() intact)", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      requiresOAuth: true,
      iconUrl: "https://cdn/x.png",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.requiresOAuth).toBe(true);
    expect(r.success && r.data).not.toHaveProperty("iconUrl");
  });

  it("rejects an http entry that also carries a command (symmetric transport exclusion)", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      command: "npx",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a stdio entry that also carries a url (symmetric transport exclusion)", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      ...httpEntry,
      transport: "stdio",
      command: "npx",
      // url is still the http one inherited from httpEntry — this is the point of the test
    });
    expect(r.success).toBe(false);
  });
});

describe("parseMcpConnectorCatalog — envelope handling (never throws)", () => {
  const notObjectInputs: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "not a catalog"],
  ];

  it.each(notObjectInputs)(
    "treats %s input as malformed, never throws",
    (_label, input) => {
      expect(() => parseMcpConnectorCatalog(input)).not.toThrow();
      expect(parseMcpConnectorCatalog(input)).toEqual({
        entries: [],
        dropped: [],
        malformed: true,
      });
    }
  );

  it("treats a missing `entries` field as malformed", () => {
    expect(() => parseMcpConnectorCatalog({})).not.toThrow();
    expect(parseMcpConnectorCatalog({})).toEqual({
      entries: [],
      dropped: [],
      malformed: true,
    });
  });

  it("treats a non-array `entries` field as malformed", () => {
    const input = { entries: "not-an-array" };
    expect(() => parseMcpConnectorCatalog(input)).not.toThrow();
    expect(parseMcpConnectorCatalog(input)).toEqual({
      entries: [],
      dropped: [],
      malformed: true,
    });
  });

  it("treats a legitimately empty `entries` array as NOT malformed", () => {
    const input = { entries: [] };
    expect(() => parseMcpConnectorCatalog(input)).not.toThrow();
    expect(parseMcpConnectorCatalog(input)).toEqual({
      entries: [],
      dropped: [],
      malformed: false,
    });
  });

  it("drops a non-object entry as <unidentified>, never throws, and is not malformed", () => {
    const input = { entries: [42] };
    expect(() => parseMcpConnectorCatalog(input)).not.toThrow();
    expect(parseMcpConnectorCatalog(input)).toEqual({
      entries: [],
      dropped: ["<unidentified>"],
      malformed: false,
    });
  });

  it("drops an entry whose id is not a string as <unidentified>", () => {
    const input = { entries: [{ id: 123, transport: "carrier-pigeon" }] };
    expect(() => parseMcpConnectorCatalog(input)).not.toThrow();
    const result = parseMcpConnectorCatalog(input);
    expect(result.dropped).toEqual(["<unidentified>"]);
    expect(result.malformed).toBe(false);
  });
});

describe("parseMcpConnectorCatalog — Finding 5: value-bearing alias rejection", () => {
  const httpEntry = {
    id: "notion",
    displayName: "Notion",
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    headerTemplateKeys: ["Authorization"],
    requiresSecret: true,
    trust: { tier: "verified" },
  };

  it("DROPS an entry carrying a value-bearing `headerTemplate` alias (not retained)", () => {
    const input = {
      entries: [
        {
          ...httpEntry,
          headerTemplate: { Authorization: "Bearer sk-live-real" },
        },
      ],
    };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries).toHaveLength(0);
    expect(result.dropped).toEqual(["notion"]);
    expect(result.malformed).toBe(false);
    // secret value never reaches the returned data
    expect(JSON.stringify(result.entries)).not.toContain("sk-live-real");
  });

  it("DROPS an entry carrying a value-bearing `envTemplate` alias", () => {
    const input = {
      entries: [
        {
          ...httpEntry,
          transport: "stdio",
          command: "npx",
          url: undefined,
          envTemplate: { NOTION_TOKEN: "sk-live-real" },
        },
      ],
    };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries).toHaveLength(0);
    expect(result.dropped).toEqual(["notion"]);
  });

  it("KEEPS an entry with a benign additive field (iconUrl), stripping the field (FU-22)", () => {
    const input = { entries: [{ ...httpEntry, iconUrl: "https://cdn/x.png" }] };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe("notion");
    expect(result.entries[0]).not.toHaveProperty("iconUrl");
    expect(result.dropped).toEqual([]);
  });

  it("drops the dangerous alias entry but keeps a sibling additive entry in the same file", () => {
    const input = {
      entries: [
        { ...httpEntry, id: "good", iconUrl: "https://cdn/x.png" },
        {
          ...httpEntry,
          id: "bad",
          headerTemplate: { Authorization: "Bearer sk-live-real" },
        },
      ],
    };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries.map((e) => e.id)).toEqual(["good"]);
    expect(result.dropped).toEqual(["bad"]);
  });
});

describe("parseMcpConnectorCatalog — Finding 7: duplicate id dedup (first-wins)", () => {
  const httpEntry = {
    id: "notion",
    displayName: "Notion",
    serverName: "notion",
    transport: "http",
    url: "https://mcp.notion.com/mcp",
    headerTemplateKeys: ["Authorization"],
    requiresSecret: true,
    trust: { tier: "verified" },
  };

  it("keeps the FIRST entry for an id and drops later collisions", () => {
    const input = {
      entries: [
        { ...httpEntry, displayName: "First" },
        // second card shares the id but a different (stdio) command — install-route
        // `entries.find(...)` would otherwise resolve the wrong one
        {
          ...httpEntry,
          displayName: "Second",
          transport: "stdio",
          command: "npx",
          url: undefined,
        },
      ],
    };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].displayName).toBe("First");
    expect(result.entries[0].transport).toBe("http");
    expect(result.dropped).toEqual(["notion"]);
    expect(result.malformed).toBe(false);
  });

  it("yields at most one entry per id even with three collisions", () => {
    const input = {
      entries: [
        { ...httpEntry },
        { ...httpEntry, displayName: "dup2" },
        { ...httpEntry, displayName: "dup3" },
      ],
    };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries).toHaveLength(1);
    expect(result.dropped).toEqual(["notion", "notion"]);
  });

  it("does not confuse distinct ids", () => {
    const input = {
      entries: [
        { ...httpEntry, id: "a", serverName: "a" },
        { ...httpEntry, id: "b", serverName: "b" },
      ],
    };
    const result = parseMcpConnectorCatalog(input);
    expect(result.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(result.dropped).toEqual([]);
  });

  it("drops a later entry that reuses an existing serverName", () => {
    const result = parseMcpConnectorCatalog({
      entries: [
        { ...httpEntry, id: "notion-primary" },
        { ...httpEntry, id: "notion-shadow", displayName: "Shadow" },
        {
          ...httpEntry,
          id: "linear",
          serverName: "linear",
          displayName: "Linear",
        },
      ],
    });

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "notion-primary",
      "linear",
    ]);
    expect(result.dropped).toEqual(["notion-shadow"]);
    expect(result.malformed).toBe(false);
  });
});

describe("oauth block", () => {
  it("accepts an entry with an oauth object of non-secret metadata", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "notion-hosted",
      serverName: "notion",
      displayName: "Notion (hosted)",
      transport: "http",
      url: "https://mcp.notion.com/mcp",
      requiresOAuth: true,
      oauth: { scopes: ["default"] },
    });
    expect(parsed.oauth?.scopes).toEqual(["default"]);
    expect(parsed.requiresOAuth).toBe(true);
  });

  it("defaults oauth scopes to [] and leaves oauth undefined when absent", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "linear",
      serverName: "linear",
      displayName: "Linear",
      transport: "http",
      url: "https://x/mcp",
    });
    expect(parsed.oauth).toBeUndefined();
  });

  it("strips unknown keys inside oauth (forward-compat)", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "x",
      serverName: "x",
      displayName: "X",
      transport: "http",
      url: "https://x/mcp",
      oauth: { scopes: [], somethingNew: 1 },
    });
    expect(
      (parsed.oauth as Record<string, unknown>).somethingNew
    ).toBeUndefined();
  });

  it("defaults oauth.scopes to [] when an oauth block omits scopes", () => {
    const parsed = McpConnectorCatalogEntrySchema.parse({
      id: "declared",
      serverName: "declared",
      displayName: "Declared",
      transport: "http",
      url: "https://x/mcp",
      oauth: {
        authorizationUrl: "https://as/authorize",
        tokenUrl: "https://as/token",
      },
    });
    expect(parsed.oauth?.scopes).toEqual([]);
  });

  it("rejects an OAuth entry declared with stdio transport", () => {
    const r = McpConnectorCatalogEntrySchema.safeParse({
      id: "bad",
      serverName: "bad",
      displayName: "Bad",
      transport: "stdio",
      command: "npx some-pkg@1.0.0",
      requiresOAuth: true,
    });
    expect(r.success).toBe(false);
  });
});
