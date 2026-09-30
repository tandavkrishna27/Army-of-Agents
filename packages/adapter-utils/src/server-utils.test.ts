import { describe, it, expect } from "vitest";
import { mergeChildEnv } from "./server-utils.js";

// mergeChildEnv reads process.platform at call time; stub it so both the
// case-insensitive (Windows) and case-sensitive (POSIX) branches are covered
// deterministically on any CI runner.
function withPlatform(platform: NodeJS.Platform, fn: () => void) {
  const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, "platform", orig);
  }
}

describe("mergeChildEnv — unsetEnvKeys escape hatch", () => {
  it("strips an inherited key the overlay did not set", () => {
    const out = mergeChildEnv({ OPENAI_API_KEY: "sk-server", PATH: "/usr/bin" }, {}, ["OPENAI_API_KEY"]);
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });
  it("keeps an overlay-set key (agent's own key wins)", () => {
    const out = mergeChildEnv({ OPENAI_API_KEY: "sk-server" }, { OPENAI_API_KEY: "sk-agent" }, ["OPENAI_API_KEY"]);
    expect(out.OPENAI_API_KEY).toBe("sk-agent");
  });
  it("an explicit empty overlay value suppresses the inherited key (overlay wins)", () => {
    const out = mergeChildEnv({ OPENAI_API_KEY: "sk-server" }, { OPENAI_API_KEY: "" }, ["OPENAI_API_KEY"]);
    expect(out.OPENAI_API_KEY).toBe("");
  });
  it("is a no-op without unsetEnvKeys (today's behavior)", () => {
    const out = mergeChildEnv({ OPENAI_API_KEY: "sk-server", PATH: "/b" }, { FOO: "bar" });
    expect(out.OPENAI_API_KEY).toBe("sk-server");
    expect(out.FOO).toBe("bar");
  });

  // Codex P2: Windows env var names are case-insensitive — a differently-cased
  // ambient key must still be stripped, else the codex child inherits the server
  // key despite unsetEnvKeys.
  it("strips a differently-cased inherited key on Windows (case-insensitive env)", () => {
    withPlatform("win32", () => {
      const out = mergeChildEnv({ OpenAI_API_KEY: "sk-server", PATH: "/b" }, {}, ["OPENAI_API_KEY"]);
      expect(out.OpenAI_API_KEY).toBeUndefined();
      expect(out.PATH).toBe("/b");
    });
  });
  it("keeps a differently-cased overlay key on Windows (agent's own key wins, case-insensitive)", () => {
    withPlatform("win32", () => {
      const out = mergeChildEnv({ OPENAI_API_KEY: "sk-server" }, { OpenAI_API_KEY: "sk-agent" }, ["OPENAI_API_KEY"]);
      // The overlay set the key (any casing) → not stripped; the ambient one is gone.
      expect(out.OpenAI_API_KEY).toBe("sk-agent");
      expect(out.OPENAI_API_KEY).toBeUndefined();
    });
  });
  it("does NOT strip a differently-cased var on POSIX (case-sensitive env — distinct var)", () => {
    withPlatform("linux", () => {
      const out = mergeChildEnv({ OpenAI_API_KEY: "sk-other", OPENAI_API_KEY: "sk-server" }, {}, ["OPENAI_API_KEY"]);
      expect(out.OPENAI_API_KEY).toBeUndefined(); // exact-cased strip
      expect(out.OpenAI_API_KEY).toBe("sk-other"); // legitimately distinct var preserved
    });
  });

  // ── unsetEnvPrefixes (D9 — crew ambient-config isolation) ─────────────────
  // An enumerated key list silently leaks any newly-introduced variable, so the
  // CLAUDE_*/ANTHROPIC_* host-config class is stripped by PREFIX. Same
  // "overlay wins" rule and same case-folding as unsetEnvKeys — additive, so
  // callers that pass no prefixes (codex) are byte-for-byte unaffected.
  it("strips every inherited key matching a prefix", () => {
    const out = mergeChildEnv(
      {
        CLAUDE_CONFIG_DIR: "/home/op/.claude",
        CLAUDE_CODE_USE_BEDROCK: "1",
        ANTHROPIC_API_KEY: "sk-ant-server",
        PATH: "/usr/bin",
      },
      {},
      undefined,
      ["CLAUDE_", "ANTHROPIC_"],
    );
    expect(out.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(out.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.PATH).toBe("/usr/bin");
  });

  it("keeps an overlay-set key matching a prefix (the pinned value wins)", () => {
    const out = mergeChildEnv(
      { CLAUDE_CONFIG_DIR: "/home/op/.claude", ANTHROPIC_API_KEY: "sk-ant-server" },
      { CLAUDE_CONFIG_DIR: "/tmp/run-42/.claude" },
      undefined,
      ["CLAUDE_", "ANTHROPIC_"],
    );
    expect(out.CLAUDE_CONFIG_DIR).toBe("/tmp/run-42/.claude");
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("strips a differently-cased prefixed key on Windows (case-insensitive env)", () => {
    withPlatform("win32", () => {
      const out = mergeChildEnv(
        { Claude_Config_Dir: "/home/op/.claude", anthropic_api_key: "sk-ant-server", PATH: "/b" },
        { CLAUDE_CONFIG_DIR: "/tmp/run-42/.claude" },
        undefined,
        ["CLAUDE_", "ANTHROPIC_"],
      );
      // Claude_Config_Dir and CLAUDE_CONFIG_DIR are the SAME variable on Windows:
      // the ambient casing must go, the overlay casing must stay.
      expect(out.Claude_Config_Dir).toBeUndefined();
      expect(out.CLAUDE_CONFIG_DIR).toBe("/tmp/run-42/.claude");
      expect(out.anthropic_api_key).toBeUndefined();
      expect(out.PATH).toBe("/b");
    });
  });

  it("does NOT strip a differently-cased prefixed var on POSIX (distinct var)", () => {
    withPlatform("linux", () => {
      const out = mergeChildEnv({ Claude_Config_Dir: "/home/op/.claude" }, {}, undefined, ["CLAUDE_"]);
      expect(out.Claude_Config_Dir).toBe("/home/op/.claude");
    });
  });

  // An empty prefix matches EVERY key, so a naive loop would wipe the child's
  // whole environment. Not reachable through today's sole caller (a frozen
  // const), but this is a public export in a shared package and the hazard is
  // asymmetric with its sibling: an empty entry in unsetEnvKeys deletes at most
  // a literal "" key.
  it("ignores an empty prefix instead of wiping the environment", () => {
    const out = mergeChildEnv({ PATH: "/usr/bin", HOME: "/home/op" }, { FOO: "bar" }, undefined, [""]);
    expect(out).toEqual({ PATH: "/usr/bin", HOME: "/home/op", FOO: "bar" });
  });

  it("is a no-op without unsetEnvPrefixes (regression guard for the codex caller)", () => {
    const parent = { CLAUDE_CONFIG_DIR: "/home/op/.claude", ANTHROPIC_API_KEY: "sk-ant", PATH: "/b" };
    const withoutPrefixes = mergeChildEnv(parent, { FOO: "bar" }, ["OPENAI_API_KEY"]);
    const explicitUndefined = mergeChildEnv(parent, { FOO: "bar" }, ["OPENAI_API_KEY"], undefined);
    const emptyPrefixes = mergeChildEnv(parent, { FOO: "bar" }, ["OPENAI_API_KEY"], []);
    expect(withoutPrefixes).toEqual({ ...parent, FOO: "bar" });
    expect(explicitUndefined).toEqual(withoutPrefixes);
    expect(emptyPrefixes).toEqual(withoutPrefixes);
  });
});
