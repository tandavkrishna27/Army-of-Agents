// T2.1 — opencode MCP config writer.
//
// Mirrors codex-config-toml.test.ts. Opencode discovers MCP servers from
// `opencode.json` (or `opencode.jsonc`) in the working directory (per the
// v1-completion plan's research) — we write the file there, splicing in the
// `mcp.aoa` block and preserving all other config. Pre-T2.1, opencode crew
// agents spawned without MCP tools (same failure mode codex had pre-MX2):
// the LLM ran 30s, exited without calling any tool, and the run was logged
// as "succeeded" while having done nothing.
//
// Contract:
//  - Idempotent: re-running with the same bridge spec produces byte-identical output.
//  - Preserves unrelated keys (mcp.othersrv, model, theme, anything user-defined).
//  - Strips a prior `mcp.aoa` (or matching serverName) before splicing the new one
//    so spec changes (new env, new command path) are picked up cleanly.
//  - Creates the file if it doesn't exist; creates the directory if it doesn't exist.
//  - Never throws on existing-file read errors (treat as empty config).

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeOpenCodeMcpConfigJson } from "../server/opencode-config-json.js";

const BRIDGE_SPEC = {
  command: "node",
  args: ["/path/to/mcp-bridge.js"],
  env: { AOA_SESSION_COMPANY_ID: "co-1", AOA_SESSION_USER_ID: "aoa-subagent" },
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-opencode-cfg-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("writeOpenCodeMcpConfigJson (T2.1)", () => {
  describe("happy path", () => {
    it("creates opencode.json with mcp.aoa block when file doesn't exist", async () => {
      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8"),
      );
      expect(written.mcp).toBeDefined();
      expect(written.mcp.aoa).toBeDefined();
      // Shape per opencode docs: command is an array (cmd + args together),
      // environment is the env map, type='local' for stdio transport.
      expect(written.mcp.aoa.type).toBe("local");
      expect(written.mcp.aoa.command).toEqual(["node", "/path/to/mcp-bridge.js"]);
      expect(written.mcp.aoa.environment).toEqual(BRIDGE_SPEC.env);
    });

    it("creates the directory if it doesn't exist", async () => {
      const nested = path.join(tmpDir, "deeply", "nested", "dir");
      await writeOpenCodeMcpConfigJson(nested, BRIDGE_SPEC);
      const stat = await fs.stat(path.join(nested, "opencode.json"));
      expect(stat.isFile()).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("re-running with the same spec produces byte-identical output", async () => {
      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);
      const first = await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8");
      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);
      const second = await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8");
      expect(second).toBe(first);
    });

    it("re-running with a NEW spec replaces the aoa block (no stale env carryover)", async () => {
      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);
      const updatedSpec = {
        command: "node",
        args: ["/different/path/mcp-bridge.js"],
        env: { AOA_SESSION_COMPANY_ID: "co-2" }, // changed company, dropped USER_ID
      };
      await writeOpenCodeMcpConfigJson(tmpDir, updatedSpec);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8"),
      );
      expect(written.mcp.aoa.command).toEqual(["node", "/different/path/mcp-bridge.js"]);
      expect(written.mcp.aoa.environment).toEqual({ AOA_SESSION_COMPANY_ID: "co-2" });
      // Confirm the OLD env keys are NOT carried over. This is the regression
      // guard: a naive shallow-merge would leave AOA_SESSION_USER_ID behind.
      expect(written.mcp.aoa.environment.AOA_SESSION_USER_ID).toBeUndefined();
    });
  });

  describe("preservation of unrelated config", () => {
    it("preserves top-level non-mcp keys (theme, model, etc.)", async () => {
      // Simulate a user with existing opencode.json that has unrelated settings.
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        JSON.stringify({ theme: "dark", model: "gpt-5", $schema: "https://opencode.ai/config.json" }, null, 2),
      );

      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8"),
      );
      expect(written.theme).toBe("dark");
      expect(written.model).toBe("gpt-5");
      expect(written.$schema).toBe("https://opencode.ai/config.json");
      // …and the aoa block is added alongside, not replacing top-level.
      expect(written.mcp.aoa).toBeDefined();
    });

    it("preserves OTHER mcp servers (mcp.somethingelse)", async () => {
      // User has another MCP server configured; we must not clobber it.
      await fs.writeFile(
        path.join(tmpDir, "opencode.json"),
        JSON.stringify(
          {
            mcp: {
              somethingelse: {
                type: "local",
                command: ["python", "-m", "their_server"],
                environment: { THEIR_KEY: "v" },
              },
            },
          },
          null,
          2,
        ),
      );

      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8"),
      );
      expect(written.mcp.somethingelse).toBeDefined();
      expect(written.mcp.somethingelse.command).toEqual(["python", "-m", "their_server"]);
      expect(written.mcp.aoa).toBeDefined();
    });
  });

  describe("custom server name", () => {
    it("respects the serverName argument when stripping + writing", async () => {
      // Same content under a non-default key — verifies the strip/write logic
      // doesn't assume the literal string "aoa".
      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC, { serverName: "myorg" });

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8"),
      );
      expect(written.mcp.myorg).toBeDefined();
      expect(written.mcp.myorg.command).toEqual(["node", "/path/to/mcp-bridge.js"]);
      expect(written.mcp.aoa).toBeUndefined();
    });
  });

  describe("error tolerance", () => {
    it("treats existing-but-unreadable JSON as empty (don't crash on a corrupt config)", async () => {
      // Opencode users sometimes edit opencode.json by hand. If they leave a
      // trailing comma or unbalanced brace, the file won't parse. T2.1 chooses
      // to overwrite-with-aoa-block in that case (preserving the corrupt
      // content would orphan our MCP wiring). This is a teaching-mode default;
      // can be changed to "throw" if user feedback prefers that.
      await fs.writeFile(path.join(tmpDir, "opencode.json"), "{ this is { not valid JSON");

      await writeOpenCodeMcpConfigJson(tmpDir, BRIDGE_SPEC);

      const written = JSON.parse(
        await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8"),
      );
      expect(written.mcp.aoa).toBeDefined();
      // The corrupt content is GONE — confirms the "overwrite on parse-fail"
      // policy. If we ever change this to throw, this assertion flips.
      expect(written.theme).toBeUndefined();
    });
  });

  describe("concurrency (codex finding P1)", () => {
    it("10 parallel writes converge to ONE valid JSON file with the aoa block (no torn content)", async () => {
      // Pre-T2.1.1 the writer did fs.readFile → mutate → fs.writeFile. Two
      // concurrent agent starts in the SAME cwd could either tear the file
      // (partial JSON byte interleaving) or clobber unrelated mcp.* entries
      // (the read happened before the other write landed). The atomic temp +
      // rename fix guarantees: every read sees a COMPLETE prior file, and
      // every write either fully lands or doesn't (no torn output).
      //
      // This test acts as a REGRESSION GUARD. Without atomic-rename it may
      // pass on a fast machine where writes happen to serialize at the OS
      // level; with atomic-rename it's 100% deterministic. If someone reverts
      // the fix, the test starts flaking and CI catches it within ~10 runs.
      const N = 10;
      const writes = Array.from({ length: N }, (_, i) =>
        writeOpenCodeMcpConfigJson(tmpDir, {
          ...BRIDGE_SPEC,
          env: { ...BRIDGE_SPEC.env, AOA_WRITER_INDEX: String(i) },
        }),
      );
      await Promise.all(writes);

      const text = await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8");
      // (a) Valid JSON — parse must NOT throw.
      const written = JSON.parse(text);
      // (b) The aoa block exists with the expected static fields.
      expect(written.mcp.aoa.type).toBe("local");
      expect(written.mcp.aoa.command).toEqual(["node", "/path/to/mcp-bridge.js"]);
      // (c) The env is ONE of the variants — i.e., one writer won cleanly,
      // not a torn merge. AOA_WRITER_INDEX must be the string of an integer
      // in [0, N-1], not undefined, not corrupted.
      const idxStr = written.mcp.aoa.environment.AOA_WRITER_INDEX;
      expect(typeof idxStr).toBe("string");
      const idx = Number(idxStr);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(N);

      // (d) No temp files left behind in tmpDir.
      const remaining = await fs.readdir(tmpDir);
      const tempFiles = remaining.filter((f) => f.startsWith("opencode.json.tmp-"));
      expect(tempFiles).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // U4b (S7): the reserved `aoa` server itself, rendered as a `type:"remote"`
  // (HTTP) entry for a brokered (E2B-sandboxed) run. Reuses the exact
  // toOpenCodeEntry HTTP path external connectors already use below — NOT a
  // second hand-rolled JSON HTTP emitter. Security invariant: NO
  // `environment` block, NO `command`, and therefore no DATABASE_URL for a
  // brokered spec.
  // -------------------------------------------------------------------------
  describe("reserved aoa server as HTTP (U4b — brokered/E2B runs)", () => {
    it("renders mcp.aoa as type:remote + url + synthesized Bearer header, with NO command/environment and NO DATABASE_URL", async () => {
      await writeOpenCodeMcpConfigJson(tmpDir, {
        kind: "http",
        url: "https://cp.example/companies/co-1/mcp",
        headers: {},
        authTokenEnvVar: "AOA_API_KEY",
      });

      const raw = await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8");
      const written = JSON.parse(raw);

      expect(written.mcp.aoa.type).toBe("remote");
      expect(written.mcp.aoa.url).toBe("https://cp.example/companies/co-1/mcp");
      // opencode's own interpolation syntax ({env:VAR}), synthesized by
      // withSynthesizedBearerHeader — same mechanism external HTTP connectors use.
      expect(written.mcp.aoa.headers).toEqual({ Authorization: "Bearer {env:AOA_API_KEY}" });
      expect(written.mcp.aoa.command).toBeUndefined();
      expect(written.mcp.aoa.environment).toBeUndefined();

      // CRITICAL security invariant: a brokered run's config must never carry
      // the control-plane DB credential — that would ride into the VM.
      expect(raw).not.toContain("DATABASE_URL");
      expect(raw).not.toContain("postgres://");
    });

    it("a non-brokered (stdio) aoa spec still renders type:local with command/environment and DATABASE_URL — byte-identical to today", async () => {
      await writeOpenCodeMcpConfigJson(tmpDir, {
        command: "node",
        args: ["/bridge.js"],
        env: {
          AOA_SESSION_COMPANY_ID: "c",
          DATABASE_URL: "postgres://should-be-present:5432/db",
        },
      });

      const raw = await fs.readFile(path.join(tmpDir, "opencode.json"), "utf8");
      const written = JSON.parse(raw);

      expect(written.mcp.aoa.type).toBe("local");
      expect(written.mcp.aoa.command).toEqual(["node", "/bridge.js"]);
      expect(written.mcp.aoa.environment.DATABASE_URL).toBe(
        "postgres://should-be-present:5432/db",
      );
      expect(written.mcp.aoa.url).toBeUndefined();
    });
  });
});
