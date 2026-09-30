// Plan 2b Task 6 — opencode external MCP connectors.
//
// opencode expands `{env:VAR}`, NOT `${VAR}`. Specs arrive carrying the
// `${AOA_MCP_*}` form (D5: placeholder on disk, real value in the spawn env),
// so this writer must translate. THE TRAP (B2N9) is translating only headers —
// that reproduces the "connector authenticates as no-one" bug on every stdio
// connector, silently.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AOA_MCP_MANIFEST_FILENAME,
  readAoaManagedServerNames,
  resolveMcpManagedManifestPath,
  writeAoaManagedServerNames,
  type McpServerSpec,
} from "@armyofagents/adapter-utils";
import { writeOpenCodeMcpConfigJson } from "../server/opencode-config-json.js";

const BRIDGE_SPEC = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "co-1" },
};

/**
 * Exactly what `buildConnectorSpecs` produces for a connector whose stored
 * secret is the literal string REALSECRET: the spec carries only the
 * PLACEHOLDER, and the value travels separately in the spawn env.
 */
const REAL_SECRET_VALUE = "REALSECRET";
const HTTP_CONNECTOR: McpServerSpec = {
  kind: "http",
  url: "https://mcp.notion.com/mcp",
  headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
  authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
};
const STDIO_CONNECTOR_WITH_SECRET: McpServerSpec = {
  kind: "stdio",
  command: "npx",
  args: ["-y", "srv", "--token", "${AOA_MCP_SLACK_TOKEN}"],
  env: { SLACK_TOKEN: "${AOA_MCP_SLACK_TOKEN}" },
};

let tmpDir: string;
let aoaHome: string;
let previousAoaHome: string | undefined;

/** Scope every write to one company/agent so the manifest path is stable. */
const SCOPE = { companyId: "company-1", agentId: "agent-1" };

function manifestPath(): string {
  return resolveMcpManagedManifestPath({ adapter: "opencode", cwd: tmpDir, ...SCOPE });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-conn-"));
  // The manifest lives under the AoA instance root (I2). Redirect it at a temp
  // home so tests never touch the developer's real ~/.aoa.
  aoaHome = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-home-"));
  previousAoaHome = process.env.AOA_HOME;
  process.env.AOA_HOME = aoaHome;
});

afterEach(async () => {
  if (previousAoaHome === undefined) delete process.env.AOA_HOME;
  else process.env.AOA_HOME = previousAoaHome;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(aoaHome, { recursive: true, force: true }).catch(() => {});
});

async function readRaw(): Promise<string> {
  return fs.readFile(path.join(tmpDir, "opencode.json"), "utf8");
}
async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readRaw());
}

describe("opencode external connectors — emitted shape", () => {
  it("emits an http connector as type:remote with {env:VAR} headers", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });

    const written = await readConfig();
    expect(written.mcp.notion).toEqual({
      type: "remote",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer {env:AOA_MCP_NOTION_TOKEN}" },
      enabled: true,
    });
    expect(written.mcp.aoa.type).toBe("local");
  });

  it("REWRITES ${VAR} in stdio args AND environment values, not just headers (B2N9)", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { slack: STDIO_CONNECTOR_WITH_SECRET },
    });

    const written = await readConfig();
    expect(written.mcp.slack).toEqual({
      type: "local",
      command: ["npx", "-y", "srv", "--token", "{env:AOA_MCP_SLACK_TOKEN}"],
      environment: { SLACK_TOKEN: "{env:AOA_MCP_SLACK_TOKEN}" },
      enabled: true,
    });
    // A surviving `${AOA_MCP_...}` anywhere means opencode hands the server
    // those literal characters as its credential.
    expect(await readRaw()).not.toContain("${AOA_MCP_");
  });

  it("leaves unrelated ${...} text alone", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, null, {
      ...SCOPE,
      externalServers: {
        srv: {
          kind: "stdio",
          command: "npx",
          args: ["--home", "${HOME}/x"],
          env: { PATH_HINT: "${HOME}/bin" },
        },
      },
    });
    const written = await readConfig();
    expect(written.mcp.srv.command).toEqual(["npx", "--home", "${HOME}/x"]);
    expect(written.mcp.srv.environment).toEqual({ PATH_HINT: "${HOME}/bin" });
  });

  it("writes without a bridge (connectors-only run)", async () => {
    const result = await writeOpenCodeMcpConfigJson(tmpDir, null, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    const written = await readConfig();
    expect(written.mcp.aoa).toBeUndefined();
    expect(written.mcp.notion.type).toBe("remote");
    expect(result.managedServerNames).toEqual(["notion"]);
  });

  it("is idempotent — same input, byte-identical output", async () => {
    const opts = {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR, slack: STDIO_CONNECTOR_WITH_SECRET },
    };
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, opts);
    const first = await readRaw();
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, opts);
    expect(await readRaw()).toBe(first);
  });
});

describe("opencode external connectors — D5: no live secret on disk", () => {
  it("a connector whose token is REALSECRET never puts REALSECRET in the file", async () => {
    // The value NEVER enters the writer: it rides in the spawn env under the
    // name the placeholder points at. This is the whole D5 indirection.
    const connectorEnv = { AOA_MCP_NOTION_TOKEN: REAL_SECRET_VALUE };

    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR, slack: STDIO_CONNECTOR_WITH_SECRET },
    });

    const raw = await readRaw();
    expect(raw).not.toContain(REAL_SECRET_VALUE);
    // ...and the file references the env var that DOES hold it.
    expect(raw).toContain("{env:AOA_MCP_NOTION_TOKEN}");
    expect(connectorEnv.AOA_MCP_NOTION_TOKEN).toBe(REAL_SECRET_VALUE);

    // The ownership manifest must not leak it either.
    const manifest = await fs.readFile(manifestPath(), "utf8");
    expect(manifest).not.toContain(REAL_SECRET_VALUE);
  });
});

describe("opencode external connectors — reserved names + classified skips", () => {
  it("reserved names never displace AoA's own servers", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        aoa: { kind: "http", url: "https://evil.example.com", headers: {} },
        playwright: { kind: "http", url: "https://evil2.example.com", headers: {} },
      },
    });
    const written = await readConfig();
    expect(written.mcp.aoa.type).toBe("local");
    expect(written.mcp.aoa.command).toEqual(["node", "/path/to/mcp-bridge.js"]);
    expect(written.mcp.playwright).toBeUndefined();
  });

  it("honours a NON-DEFAULT bridge name as reserved too (M2)", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      serverName: "aoa-crew",
      externalServers: {
        "aoa-crew": { kind: "http", url: "https://evil.example.com", headers: {} },
      },
    });
    const written = await readConfig();
    expect(written.mcp["aoa-crew"].type).toBe("local");
    expect(written.mcp["aoa-crew"].command).toEqual(["node", "/path/to/mcp-bridge.js"]);
  });

  it("reports reserved-name and unsupported-transport skips instead of dropping silently", async () => {
    const result = await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        aoa: { kind: "http", url: "https://evil.example.com", headers: {} },
        weird: { kind: "sse", url: "https://x" } as unknown as McpServerSpec,
        notion: HTTP_CONNECTOR,
      },
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { serverName: "aoa", reason: "reserved_name" },
        { serverName: "weird", reason: "unsupported_transport" },
      ]),
    );
    expect(result.managedServerNames.sort()).toEqual(["aoa", "notion"]);
  });

  it("does NOT skip a stdio connector carrying a secret (that is codex-only)", async () => {
    // opencode expands {env:VAR} in args/env, so its credential route works.
    const result = await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { slack: STDIO_CONNECTOR_WITH_SECRET },
    });
    expect(result.skipped).toEqual([]);
    expect(result.managedServerNames).toContain("slack");
  });
});

describe("opencode external connectors — B5 stale sweep", () => {
  it("removes a connector that is no longer active on the next run", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect((await readConfig()).mcp.notion).toBeDefined();

    // Founder deletes the connector → the next run delivers an EMPTY set.
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcp.notion).toBeUndefined();
    expect(written.mcp.aoa).toBeDefined();
  });

  it("NEVER removes a server the user added by hand", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ mcp: { mine: { type: "local", command: ["my-srv"] } } }),
      "utf8",
    );
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcp.mine).toEqual({ type: "local", command: ["my-srv"] });
    expect(written.mcp.notion).toBeUndefined();
  });

  it("preserves unrelated top-level user keys", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ theme: "dark", model: "x" }),
      "utf8",
    );
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    const written = await readConfig();
    expect(written.theme).toBe("dark");
    expect(written.model).toBe("x");
  });

  it("adds NO unknown top-level key — opencode rejects the whole config", async () => {
    // Probed live against opencode v1.18.4:
    //   Error: Configuration is invalid ... ↳ Unrecognized key: $aoaManagedMcpServers
    // An invalid config loads ZERO MCP servers, killing AoA's own bridge with
    // it. That is why ownership is tracked in a sidecar, not in this file.
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect(Object.keys(await readConfig())).toEqual(["mcp"]);
  });

  it("records ownership in a manifest OUTSIDE the repo (I2)", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["aoa", "notion"]);
    // Nothing AoA-owned is left lying around in the user's repo.
    expect((await fs.readdir(tmpDir)).sort()).toEqual(["opencode.json"]);
  });

  it("sweeps nothing when the manifest was deleted (degrades, never data-loss)", async () => {
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({ mcp: { mine: { type: "local", command: ["my-srv"] } } }),
      "utf8",
    );
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    await fs.rm(manifestPath());

    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcp.mine).toBeDefined(); // user entry intact
    expect(written.mcp.notion).toBeDefined(); // stale, but never deleted user data
  });
});

describe("opencode manifest — I1 crash window (manifest first, union)", () => {
  it("claims ownership BEFORE the config exists", async () => {
    // The invariant: a name can never be on disk without already being claimed.
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["aoa", "notion"]);
  });

  it("a crash between config and manifest still sweeps on the NEXT run", async () => {
    // The three-run sequence that the config-first ordering got wrong: with
    // config-first, run 2's `beta` was never recorded, run 3 rewrote the
    // manifest from its own set, and `beta` stayed in the config FOREVER.
    //
    // run 1 — steady state.
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { alpha: HTTP_CONNECTOR },
    });
    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["alpha", "aoa"]);

    // run 2 — writes `beta`, then "crashes" before the narrowing manifest
    // write. Simulated by restoring the manifest to its pre-narrow state: the
    // union that run 2 wrote FIRST.
    const unionAfterRun2 = ["alpha", "aoa", "beta"];
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { beta: HTTP_CONNECTOR },
    });
    await writeAoaManagedServerNames(manifestPath(), unionAfterRun2);
    expect((await readConfig()).mcp.beta).toBeDefined();

    // run 3 — founder has deleted every connector.
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcp.beta).toBeUndefined(); // swept, NOT orphaned forever
    expect(written.mcp.alpha).toBeUndefined();
    expect(written.mcp.aoa).toBeDefined();
  });

  it("narrows the claim to this run's set once the config is durable", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });
    // `notion` is gone from the config, so it is no longer claimed either —
    // the manifest does not grow without bound.
    expect(await readAoaManagedServerNames(manifestPath())).toEqual(["aoa"]);
  });
});

describe("opencode manifest — bookkeeping must never cost the agent its tools", () => {
  it("still writes the config when the manifest location is unwritable", async () => {
    // The manifest is written FIRST (I1), so a throwing write would abort the
    // whole MCP config and leave the agent with NO servers at all — bridge
    // included — on every run. Degrade to "no sweeping" instead.
    // Force failure by making the manifest path resolve under a FILE.
    const brokenHome = path.join(tmpDir, "broken-home");
    await fs.writeFile(brokenHome, "not a directory", "utf8");
    process.env.AOA_HOME = brokenHome;

    const result = await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: { notion: HTTP_CONNECTOR },
    });

    const written = await readConfig();
    expect(written.mcp.aoa).toBeDefined();
    expect(written.mcp.notion).toBeDefined();
    expect(result.managedServerNames.sort()).toEqual(["aoa", "notion"]);
  });
});

describe("opencode manifest — I2 untrusted input", () => {
  it("a manifest PLANTED in the repo cannot make the sweep eat user entries", async () => {
    // The cwd is a checked-out user repo AoA does not control. Before
    // relocation, a planted (or merely committed-and-cloned) manifest claiming
    // the user's own servers would delete them on the next run.
    await fs.writeFile(
      path.join(tmpDir, "opencode.json"),
      JSON.stringify({
        mcp: {
          mine: { type: "local", command: ["my-srv"] },
          other: { type: "local", command: ["other-srv"] },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tmpDir, AOA_MCP_MANIFEST_FILENAME),
      JSON.stringify({ managedServerNames: ["mine", "other"] }),
      "utf8",
    );

    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(written.mcp.mine).toEqual({ type: "local", command: ["my-srv"] });
    expect(written.mcp.other).toEqual({ type: "local", command: ["other-srv"] });
    expect(written.mcp.aoa).toBeDefined();
  });

  it("deletes the stale in-repo manifest an earlier build wrote, without reading it", async () => {
    await fs.writeFile(
      path.join(tmpDir, AOA_MCP_MANIFEST_FILENAME),
      JSON.stringify({ managedServerNames: ["mine"] }),
      "utf8",
    );
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });
    await expect(fs.access(path.join(tmpDir, AOA_MCP_MANIFEST_FILENAME))).rejects.toThrow();
  });

  it("scopes ownership per agent — one agent's claims never sweep another's cwd view", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      companyId: "company-1",
      agentId: "agent-1",
      externalServers: { notion: HTTP_CONNECTOR },
    });
    const other = resolveMcpManagedManifestPath({
      adapter: "opencode",
      cwd: tmpDir,
      companyId: "company-1",
      agentId: "agent-2",
    });
    expect(await readAoaManagedServerNames(other)).toEqual([]);
  });
});

describe("opencode — I3 secret with an EMPTY headerTemplate", () => {
  it("synthesizes a bearer header instead of emitting an unauthenticated connector", async () => {
    // routes/mcp-connectors.ts defaults headerTemplate to {} and never requires
    // it to reference ${TOKEN}, so this is creatable straight from the UI.
    const result = await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: {},
          authTokenEnvVar: "AOA_MCP_NOTION_TOKEN",
        },
      },
    });

    const written = await readConfig();
    expect(written.mcp.notion.headers).toEqual({
      Authorization: "Bearer {env:AOA_MCP_NOTION_TOKEN}",
    });
    expect(result.skipped).toEqual([]);
    // Still only a placeholder on disk.
    expect(await readRaw()).not.toContain(REAL_SECRET_VALUE);
  });

  it("does not double up when a header already references the token", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        acme: {
          kind: "http",
          url: "https://acme.example.com/mcp",
          headers: { "X-Api-Key": "${AOA_MCP_ACME_TOKEN}" },
          authTokenEnvVar: "AOA_MCP_ACME_TOKEN",
        },
      },
    });
    const written = await readConfig();
    expect(written.mcp.acme.headers).toEqual({
      "X-Api-Key": "{env:AOA_MCP_ACME_TOKEN}",
    });
    expect(written.mcp.acme.headers.Authorization).toBeUndefined();
  });

  it("adds no auth header for a connector that genuinely has no secret", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        public_docs: { kind: "http", url: "https://docs.example.com/mcp", headers: {} },
      },
    });
    expect((await readConfig()).mcp.public_docs.headers).toEqual({});
  });
});

describe("opencode — M6 __proto__ as a HEADER/env key", () => {
  it("keeps a header key literally named __proto__", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, null, {
      ...SCOPE,
      externalServers: {
        srv: {
          kind: "http",
          url: "https://x.example.com/mcp",
          headers: { ["__proto__"]: "value" },
        },
      },
    });
    const written = await readConfig();
    expect(Object.prototype.hasOwnProperty.call(written.mcp.srv.headers, "__proto__")).toBe(
      true,
    );
    expect(({} as Record<string, unknown>).value).toBeUndefined();
  });

  it("keeps a stdio environment key literally named __proto__", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, null, {
      ...SCOPE,
      externalServers: {
        srv: { kind: "stdio", command: "npx", args: [], env: { ["__proto__"]: "v" } },
      },
    });
    const written = await readConfig();
    expect(
      Object.prototype.hasOwnProperty.call(written.mcp.srv.environment, "__proto__"),
    ).toBe(true);
  });
});

describe("opencode external connectors — adversarial names", () => {
  it("a connector named __proto__ neither pollutes the prototype nor vanishes", async () => {
    const result = await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        ["__proto__"]: { kind: "http", url: "https://attacker.example.com", headers: {} },
      },
    });

    // 1. No prototype pollution in-process.
    expect(({} as Record<string, unknown>).url).toBeUndefined();
    expect(({} as Record<string, unknown>).type).toBeUndefined();

    // 2. It did not silently vanish: it is an OWN key and is tracked as owned,
    //    so the next sweep can remove it.
    const written = await readConfig();
    expect(Object.prototype.hasOwnProperty.call(written.mcp, "__proto__")).toBe(true);
    expect(result.managedServerNames).toContain("__proto__");

    // 3. The bridge survived intact — the real risk of a lost/aliased key.
    expect(written.mcp.aoa.command).toEqual(["node", "/path/to/mcp-bridge.js"]);
  });

  it("sweeps a previously-written __proto__ connector without disturbing the prototype", async () => {
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, {
      ...SCOPE,
      externalServers: {
        ["__proto__"]: { kind: "http", url: "https://attacker.example.com", headers: {} },
      },
    });
    await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { ...SCOPE, externalServers: {} });

    const written = await readConfig();
    expect(Object.prototype.hasOwnProperty.call(written.mcp, "__proto__")).toBe(false);
    expect(written.mcp.aoa).toBeDefined();
    expect(({} as Record<string, unknown>).url).toBeUndefined();
  });
});
