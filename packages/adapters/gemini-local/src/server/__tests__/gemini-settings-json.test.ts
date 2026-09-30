// T2.2 — gemini MCP config writer.
//
// Gemini CLI reads MCP servers from `.gemini/settings.json` in the workspace
// (and from `~/.gemini/settings.json` as a fallback; we use the workspace
// scope to avoid polluting the user's global config). Shape mirrors
// claude_desktop_config.json: `mcpServers.<name>.{command,args,env}`.
//
// Pre-T2.2 the gemini-local adapter ignored ctx.mcpBridge entirely; gemini
// crew agents spawned without MCP tools (same failure mode codex had
// pre-MX2 and opencode had pre-T2.1). T2.2 closes the parallel gap.
//
// Pinned contract (same shape as opencode-config-json.test.ts):
//  - Idempotent
//  - Preserves unrelated keys (theme, contextFileName, other MCP servers)
//  - Strips prior mcpServers.<serverName> before splicing
//  - Creates `.gemini/` dir + settings.json file as needed
//  - Overwrites on parse-fail (same teaching-mode policy as opencode T2.1)

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeGeminiMcpSettingsJson } from "../gemini-settings-json.js";

const BRIDGE_SPEC = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "co-1", AOA_SESSION_USER_ID: "aoa-subagent" },
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-gemini-cfg-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("writeGeminiMcpSettingsJson (T2.2)", () => {
  describe("happy path", () => {
    it("creates .gemini/settings.json with mcpServers.aoa block", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8"),
      );
      expect(written.mcpServers).toBeDefined();
      expect(written.mcpServers.aoa).toBeDefined();
      // Claude-shape (gemini's accepted format): command is a string, args is
      // a string[], env is a flat map. NOT opencode's "command as array".
      expect(written.mcpServers.aoa.command).toBe("node");
      expect(written.mcpServers.aoa.args).toEqual(["/path/to/mcp-bridge.js"]);
      expect(written.mcpServers.aoa.env).toEqual(BRIDGE_SPEC.env);
    });

    it("creates the .gemini directory if it doesn't exist", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);
      const stat = await fs.stat(path.join(tmpDir, ".gemini"));
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("re-running with the same spec produces byte-identical output", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);
      const first = await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8");
      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);
      const second = await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8");
      expect(second).toBe(first);
    });

    it("re-running with a new spec replaces the aoa block (no stale env carryover)", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);
      const updatedSpec = {
        command: "node",
        args: ["/different/bridge.js"],
        env: { AOA_SESSION_COMPANY_ID: "co-2" },
      };
      await writeGeminiMcpSettingsJson(tmpDir, updatedSpec);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8"),
      );
      expect(written.mcpServers.aoa.args).toEqual(["/different/bridge.js"]);
      expect(written.mcpServers.aoa.env).toEqual({ AOA_SESSION_COMPANY_ID: "co-2" });
      expect(written.mcpServers.aoa.env.AOA_SESSION_USER_ID).toBeUndefined();
    });
  });

  describe("preservation of unrelated config", () => {
    it("preserves top-level non-mcpServers keys (theme, contextFileName)", async () => {
      await fs.mkdir(path.join(tmpDir, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".gemini", "settings.json"),
        JSON.stringify({ theme: "dark", contextFileName: "GEMINI.md" }, null, 2),
      );

      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8"),
      );
      expect(written.theme).toBe("dark");
      expect(written.contextFileName).toBe("GEMINI.md");
      expect(written.mcpServers.aoa).toBeDefined();
    });

    it("preserves OTHER mcp servers under mcpServers", async () => {
      await fs.mkdir(path.join(tmpDir, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".gemini", "settings.json"),
        JSON.stringify(
          {
            mcpServers: {
              somethingelse: { command: "python", args: ["-m", "their_server"], env: {} },
            },
          },
          null,
          2,
        ),
      );

      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8"),
      );
      expect(written.mcpServers.somethingelse).toBeDefined();
      expect(written.mcpServers.somethingelse.command).toBe("python");
      expect(written.mcpServers.aoa).toBeDefined();
    });
  });

  describe("custom server name", () => {
    it("respects serverName arg when stripping + writing", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC, { serverName: "myorg" });
      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8"),
      );
      expect(written.mcpServers.myorg).toBeDefined();
      expect(written.mcpServers.aoa).toBeUndefined();
    });
  });

  describe("error tolerance", () => {
    it("treats existing-but-unreadable JSON as empty (don't crash on corrupt)", async () => {
      await fs.mkdir(path.join(tmpDir, ".gemini"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, ".gemini", "settings.json"),
        "{ this is { not valid JSON",
      );

      await writeGeminiMcpSettingsJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8"),
      );
      expect(written.mcpServers.aoa).toBeDefined();
      expect(written.theme).toBeUndefined();
    });
  });

  describe("concurrency (codex finding P1)", () => {
    it("10 parallel writes converge to ONE valid JSON file (no torn content, no temp leftovers)", async () => {
      // Same regression guard as opencode T2.1.1: under concurrent writes
      // the pre-fix read-modify-write could tear the file or clobber other
      // mcpServers.* entries. Atomic temp+rename guarantees an all-or-
      // nothing landing. See opencode-config-json.test.ts for the full
      // rationale — this is the same bug class.
      const N = 10;
      const writes = Array.from({ length: N }, (_, i) =>
        writeGeminiMcpSettingsJson(tmpDir, {
          ...BRIDGE_SPEC,
          env: { ...BRIDGE_SPEC.env, AOA_WRITER_INDEX: String(i) },
        }),
      );
      await Promise.all(writes);

      const text = await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8");
      const written = JSON.parse(text); // (a) valid JSON — parse must NOT throw
      // (b) The aoa block exists with the expected static fields.
      expect(written.mcpServers.aoa.command).toBe("node");
      expect(written.mcpServers.aoa.args).toEqual(["/path/to/mcp-bridge.js"]);
      // (c) The env is ONE variant verbatim — last-writer-wins, not a torn merge.
      const idxStr = written.mcpServers.aoa.env.AOA_WRITER_INDEX;
      expect(typeof idxStr).toBe("string");
      const idx = Number(idxStr);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(N);

      // (d) No temp files left behind in .gemini/.
      const remaining = await fs.readdir(path.join(tmpDir, ".gemini"));
      const tempFiles = remaining.filter((f) => f.startsWith("settings.json.tmp-"));
      expect(tempFiles).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // U4b (S7): the reserved `aoa` server itself, rendered as an `httpUrl` entry
  // for a brokered (E2B-sandboxed) run. Reuses the exact toGeminiEntry HTTP
  // path external connectors already use below — NOT a second hand-rolled
  // JSON HTTP emitter. Security invariant: NO `command`/`env` block, and
  // therefore no DATABASE_URL, for a brokered spec.
  // -------------------------------------------------------------------------
  describe("reserved aoa server as HTTP (U4b — brokered/E2B runs)", () => {
    it("renders mcpServers.aoa as httpUrl + synthesized Bearer header, with NO command/env and NO DATABASE_URL", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, {
        kind: "http",
        url: "https://cp.example/companies/co-1/mcp",
        headers: {},
        authTokenEnvVar: "AOA_API_KEY",
      });

      const raw = await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8");
      const written = JSON.parse(raw);

      expect(written.mcpServers.aoa.httpUrl).toBe("https://cp.example/companies/co-1/mcp");
      // gemini's native ${VAR} syntax, synthesized by withSynthesizedBearerHeader —
      // same mechanism external HTTP connectors use.
      expect(written.mcpServers.aoa.headers).toEqual({ Authorization: "Bearer ${AOA_API_KEY}" });
      expect(written.mcpServers.aoa.command).toBeUndefined();
      expect(written.mcpServers.aoa.env).toBeUndefined();

      // CRITICAL security invariant: a brokered run's config must never carry
      // the control-plane DB credential — that would ride into the VM.
      expect(raw).not.toContain("DATABASE_URL");
      expect(raw).not.toContain("postgres://");
    });

    it("a non-brokered (stdio) aoa spec still renders command/args/env with DATABASE_URL — byte-identical to today", async () => {
      await writeGeminiMcpSettingsJson(tmpDir, {
        command: "node",
        args: ["/bridge.js"],
        env: {
          AOA_SESSION_COMPANY_ID: "c",
          DATABASE_URL: "postgres://should-be-present:5432/db",
        },
      });

      const raw = await fs.readFile(path.join(tmpDir, ".gemini", "settings.json"), "utf8");
      const written = JSON.parse(raw);

      expect(written.mcpServers.aoa.command).toBe("node");
      expect(written.mcpServers.aoa.args).toEqual(["/bridge.js"]);
      expect(written.mcpServers.aoa.env.DATABASE_URL).toBe(
        "postgres://should-be-present:5432/db",
      );
      expect(written.mcpServers.aoa.httpUrl).toBeUndefined();
    });
  });
});
