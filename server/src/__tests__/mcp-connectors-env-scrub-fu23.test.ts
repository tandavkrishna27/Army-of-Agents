/**
 * FU-23 — the connector-capable CLI spawn must not hand AoA's ambient secrets to
 * the third-party stdio MCP children the CLI spawns, WHILE the first-party `aoa`
 * bridge keeps everything it needs to run (DB + in-process secret decryption).
 *
 * This suite pins BOTH failure directions at the building-block level that
 * `cli-mode.ts`'s Commander spawn composes:
 *   - the connector-facing CLI env  = mergeConnectorEnv(buildScrubbedCliEnv(), connectorEnv)
 *   - the bridge's own env          = buildMcpBridgeSpec(params).env
 *
 * ABLATION:
 *   - swap `buildScrubbedCliEnv()` back to raw `process.env` in cli-mode → the
 *     "no AoA secret reaches the connector env" assertions below go RED.
 *   - drop the DATABASE_URL / secrets-provider re-injection from
 *     buildMcpBridgeSpec → the "bridge keeps its minimal env" assertions go RED.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScrubbedCliEnv } from "../services/cli-spawn-safety.js";
import { mergeConnectorEnv } from "../services/mcp-connectors-env.js";
import { buildMcpBridgeSpec } from "../services/internal-agent/cli-mode.js";

// Every AoA-owned secret a third-party stdio connector child must NEVER see.
const SECRET_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://user:pw@localhost:5432/aoa",
  DIRECT_DATABASE_URL: "postgres://user:pw@localhost:5432/aoa",
  REDIS_URL: "redis://localhost:6379",
  OPENAI_API_KEY: "sk-embeddings-should-not-leak",
  GITHUB_PAT: "ghp_should_not_leak",
  BETTER_AUTH_SECRET: "auth-signing-should-not-leak",
  AOA_AGENT_JWT_SECRET: "jwt-should-not-leak",
  AOA_SECRETS_MASTER_KEY: "raw-master-key-should-not-leak",
  AOA_SECRETS_MASTER_KEY_FILE: "/etc/aoa/secrets/master.key",
  AOA_SECRETS_PROVIDER: "local_encrypted",
  AOA_SECRETS_STRICT_MODE: "true",
};

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(SECRET_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  // A stable non-secret PATH so npx-based stdio connectors can still resolve.
  saved.PATH = process.env.PATH;
  if (!process.env.PATH) process.env.PATH = "/usr/bin";
});

afterEach(() => {
  for (const k of Object.keys(SECRET_ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (saved.PATH !== undefined) process.env.PATH = saved.PATH;
});

const bridgeParams = {
  companyId: "c",
  userId: "u",
  userRole: "founder",
  enabledCapabilities: ["memory_management"],
  bridgeEntrypoint: "/b.js",
} as const;

describe("FU-23 — connector-facing CLI env is scrubbed of AoA secrets", () => {
  // This is the exact expression cli-mode.ts uses for the connector case.
  const connectorEnv = { AOA_MCP_NOTION_TOKEN: "connector-own-token" };
  const cliEnv = () => mergeConnectorEnv(buildScrubbedCliEnv(), connectorEnv);

  it("keeps the connector's OWN token (needed for ${VAR} expansion)", () => {
    expect(cliEnv().AOA_MCP_NOTION_TOKEN).toBe("connector-own-token");
  });

  it("keeps PATH so npx-based stdio connectors still resolve", () => {
    expect(cliEnv().PATH).toBeTruthy();
  });

  it.each(Object.keys(SECRET_ENV))(
    "does NOT leak AoA secret %s into the connector-facing CLI env",
    (key) => {
      expect(cliEnv()[key]).toBeUndefined();
    },
  );

  it("a connector token can never redirect PATH (base wins)", () => {
    const hijack = mergeConnectorEnv(buildScrubbedCliEnv(), { PATH: "/evil" });
    expect(hijack.PATH).not.toBe("/evil");
  });
});

describe("FU-23 — the aoa bridge keeps its minimal first-party env", () => {
  it("re-supplies DATABASE_URL on the bridge's OWN spec env", () => {
    expect(buildMcpBridgeSpec(bridgeParams).env.DATABASE_URL).toBe(SECRET_ENV.DATABASE_URL);
  });

  it("re-supplies the secrets-provider CONFIG so in-process decryption works", () => {
    const env = buildMcpBridgeSpec(bridgeParams).env;
    expect(env.AOA_SECRETS_PROVIDER).toBe("local_encrypted");
    expect(env.AOA_SECRETS_STRICT_MODE).toBe("true");
    // The master-key FILE PATH (a pointer, not the key value) — the key itself
    // stays in its 0600 file, read off disk by the bridge process.
    expect(env.AOA_SECRETS_MASTER_KEY_FILE).toBe(SECRET_ENV.AOA_SECRETS_MASTER_KEY_FILE);
  });

  it("does NOT write secret VALUES (raw master key / embeddings key) onto the bridge spec env", () => {
    const env = buildMcpBridgeSpec(bridgeParams).env;
    // These would land in the on-disk MCP config file — deliberately excluded.
    expect(env.AOA_SECRETS_MASTER_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(env.AOA_AGENT_JWT_SECRET).toBeUndefined();
  });
});

describe("FU-23 — the split: bridge gets its env, connectors get scrubbed", () => {
  it("DATABASE_URL + secrets-provider config reach the bridge but NOT the connector env", () => {
    const cliEnv = mergeConnectorEnv(buildScrubbedCliEnv(), { AOA_MCP_X_TOKEN: "t" });
    const bridgeEnv = buildMcpBridgeSpec(bridgeParams).env;
    for (const key of ["DATABASE_URL", "AOA_SECRETS_MASTER_KEY_FILE", "AOA_SECRETS_PROVIDER"]) {
      expect(bridgeEnv[key]).toBeTruthy(); // first-party bridge: has it
      expect(cliEnv[key]).toBeUndefined(); // third-party connector child: does not
    }
  });
});
