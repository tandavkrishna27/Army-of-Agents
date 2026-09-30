import { describe, expect, it } from "vitest";
import {
  stripConnectorRunBearers,
  CONNECTOR_STRIPPED_RUN_BEARER_KEYS,
} from "../server-utils.js";

// WS1 — the run-scoped bearers (AOA_API_KEY, its PAPERCLIP_ wire alias,
// AOA_RUNTIME_HOOK_TOKEN) must never reach a stdio connector child, which
// inherits the vendor CLI's full env. The helper deletes them from the overlay
// by KEY and by VALUE, but only when connectors are present.
describe("stripConnectorRunBearers", () => {
  it("no-op without connectors — the overlay is byte-identical", () => {
    const env = { AOA_API_KEY: "run-token", AOA_RUN_ID: "r1", PATH: "/bin" };
    stripConnectorRunBearers(env, { connectorsPresent: false, secretValues: ["run-token"] });
    expect(env).toEqual({ AOA_API_KEY: "run-token", AOA_RUN_ID: "r1", PATH: "/bin" });
  });

  it("strips every run bearer by key when connectors are present", () => {
    const env: Record<string, string> = {
      AOA_API_KEY: "run-token",
      PAPERCLIP_API_KEY: "wire-alias",
      AOA_RUNTIME_HOOK_TOKEN: "hook-token",
      AOA_RUN_ID: "r1",
      MAX_THINKING_TOKENS: "3000",
      "AOA_MCP_NOTION_TOKEN": "sk-notion", // the connector's OWN token — must survive
      PATH: "/bin",
    };
    stripConnectorRunBearers(env, { connectorsPresent: true, secretValues: ["run-token", "hook-token"] });
    expect(env).toEqual({
      AOA_RUN_ID: "r1",
      MAX_THINKING_TOKENS: "3000",
      AOA_MCP_NOTION_TOKEN: "sk-notion",
      PATH: "/bin",
    });
  });

  it("strips a bearer VALUE hiding under an arbitrarily-named configured key (Codex finding)", () => {
    const env: Record<string, string> = { SNEAKY_ALIAS: "run-token", PATH: "/bin" };
    stripConnectorRunBearers(env, { connectorsPresent: true, secretValues: ["run-token"] });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("folds bearer keys per the platform's env-key case semantics (win32 case-insensitive, POSIX case-sensitive)", () => {
    // `foldEnvKey` folds case ONLY on win32, because Windows env keys are
    // case-INSENSITIVE (`aoa_api_key` IS `AOA_API_KEY`) while POSIX keys are
    // case-SENSITIVE (`aoa_api_key` is a genuinely DIFFERENT var — not the
    // bearer, so it must NOT be stripped by key). Value-based stripping remains
    // the platform-independent backstop for a real bearer hiding under any key.
    const env: Record<string, string> = { aoa_api_key: "run-token", PATH: "/bin" };
    stripConnectorRunBearers(env, { connectorsPresent: true });
    if (process.platform === "win32") {
      expect(env).toEqual({ PATH: "/bin" });
    } else {
      expect(env).toEqual({ aoa_api_key: "run-token", PATH: "/bin" });
    }
  });

  it("value-stripping catches a bearer under a lowercase key on EVERY platform (the real defense)", () => {
    // The security-load-bearing path: even where key-folding does not apply
    // (POSIX), the actual bearer VALUE is removed regardless of its key name.
    const env: Record<string, string> = { aoa_api_key: "run-token", PATH: "/bin" };
    stripConnectorRunBearers(env, { connectorsPresent: true, secretValues: ["run-token"] });
    expect(env).toEqual({ PATH: "/bin" });
  });

  it("leaves the overlay alone when secretValues is omitted and no bearer keys match", () => {
    const env: Record<string, string> = { AOA_RUN_ID: "r1", PATH: "/bin" };
    stripConnectorRunBearers(env, { connectorsPresent: true });
    expect(env).toEqual({ AOA_RUN_ID: "r1", PATH: "/bin" });
  });

  it("exposes the canonical bearer key list", () => {
    expect(CONNECTOR_STRIPPED_RUN_BEARER_KEYS).toEqual([
      "AOA_API_KEY",
      "PAPERCLIP_API_KEY",
      "AOA_RUNTIME_HOOK_TOKEN",
    ]);
  });
});
