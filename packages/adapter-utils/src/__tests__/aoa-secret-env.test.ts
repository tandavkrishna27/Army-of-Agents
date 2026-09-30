import { describe, expect, it } from "vitest";
import {
  isAoaAmbientSecretEnvKey,
  aoaAmbientSecretEnvKeys,
} from "../aoa-secret-env.js";

describe("isAoaAmbientSecretEnvKey", () => {
  it.each([
    "DATABASE_URL",
    "DIRECT_DATABASE_URL",
    "REDIS_URL",
    "GITHUB_PAT",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "BETTER_AUTH_SECRET",
    "AOA_SECRETS_MASTER_KEY",
    "AOA_AGENT_JWT_SECRET",
    "AOA_ANYTHING",
    "NPM_TOKEN",
    "SENTRY_AUTH_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "SOME_PASSWORD",
    "SESSION_COOKIE",
  ])("flags %s as an AoA ambient secret", (key) => {
    expect(isAoaAmbientSecretEnvKey(key)).toBe(true);
  });

  it.each(["PATH", "HOME", "TMPDIR", "APPDATA", "SystemRoot", "PATHEXT", "LANG", "TERM"])(
    "keeps benign env %s",
    (key) => {
      expect(isAoaAmbientSecretEnvKey(key)).toBe(false);
    },
  );

  it("honours keep (vendor auth the CLI itself needs)", () => {
    expect(isAoaAmbientSecretEnvKey("OPENAI_API_KEY")).toBe(true);
    expect(isAoaAmbientSecretEnvKey("OPENAI_API_KEY", { keep: ["OPENAI_API_KEY"] })).toBe(false);
  });

  it("does NOT flag a connector's own token by name shape (it is overlay-set, not ambient)", () => {
    // The key itself matches AOA_* + token; isolation from the strip relies on
    // it being an OVERLAY key (mergeChildEnv exemption / opencode keep), which the
    // callers pass — this test only pins that the raw predicate treats it as a
    // secret unless kept, so callers MUST keep it.
    expect(isAoaAmbientSecretEnvKey("AOA_MCP_NOTION_TOKEN")).toBe(true);
    expect(
      isAoaAmbientSecretEnvKey("AOA_MCP_NOTION_TOKEN", { keep: ["AOA_MCP_NOTION_TOKEN"] }),
    ).toBe(false);
  });
});

describe("aoaAmbientSecretEnvKeys", () => {
  it("returns only the secret keys present in the given parent env", () => {
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      DATABASE_URL: "postgres://x",
      OPENAI_API_KEY: "sk-x",
      AOA_SECRETS_MASTER_KEY: "raw",
      AOA_RUN_ID: "run-1",
    };
    const keys = aoaAmbientSecretEnvKeys(parent);
    expect(keys.sort()).toEqual(
      ["AOA_RUN_ID", "AOA_SECRETS_MASTER_KEY", "DATABASE_URL", "OPENAI_API_KEY"].sort(),
    );
    expect(keys).not.toContain("PATH");
    expect(keys).not.toContain("HOME");
  });

  it("excludes kept keys (e.g. an overlay's own AOA_* + connector token)", () => {
    const parent: NodeJS.ProcessEnv = {
      DATABASE_URL: "postgres://x",
      AOA_RUN_ID: "run-1",
      AOA_MCP_NOTION_TOKEN: "connector-token",
    };
    const keys = aoaAmbientSecretEnvKeys(parent, {
      keep: ["AOA_RUN_ID", "AOA_MCP_NOTION_TOKEN"],
    });
    expect(keys).toEqual(["DATABASE_URL"]);
  });

  it("skips undefined values", () => {
    const parent: NodeJS.ProcessEnv = { DATABASE_URL: undefined, PATH: "/usr/bin" };
    expect(aoaAmbientSecretEnvKeys(parent)).toEqual([]);
  });
});
