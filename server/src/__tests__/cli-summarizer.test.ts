import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

const spawnArgs: any[] = [];
// U13.6: cli-summarizer.ts now statically imports resolveCompanyProviderCredential
// / runOneShotCliInSandbox (for the cloud sandbox branch, unexercised by these
// desktop-only tests) — their transitive chain (provider-credential-bindings.ts
// -> cli-auth-topology.ts) reaches `execFile` on node:child_process. Keep the
// REAL module via importOriginal and only override `spawn` so that chain still
// resolves (mirrors extraction-cli-sandbox-env.test.ts's same pattern).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((bin: string, args: string[]) => {
      spawnArgs.push({ bin, args });
      return {
        stdin: { write() {}, end() {} },
        stdout: {
          on(ev: string, cb: any) {
            if (ev === "data") cb(Buffer.from("SUMMARY TEXT"));
          },
        },
        stderr: { on() {} },
        on(ev: string, cb: any) {
          if (ev === "close") cb(0);
        },
      };
    }),
  };
});

import { summarizeViaCli } from "../services/internal-agent/cli-summarizer.js";

describe("summarizeViaCli", () => {
  it("returns the model output and never attaches the MCP bridge", async () => {
    const out = await summarizeViaCli({
      cliTool: "claude_cli",
      cheapModel: "claude-haiku-4-5",
      transcript: "user: hi\nassistant: yo",
    });
    expect(out).toBe("SUMMARY TEXT");
    const a = spawnArgs[0].args.join(" ");
    expect(a).not.toContain("--mcp-config");
    expect(a).not.toContain("mcp");
  });
});

// U13.6: compaction no longer hard-refuses on cloud_auth (that guard is gone
// — see cli-summarizer-sandbox.test.ts for the full sandbox-routing coverage
// this superseded). What remains true on cloud without company context is a
// structural guard (mirrors extraction-cli.ts's equivalent): it still never
// falls through to the LOCAL operator-cred spawn below.
describe("summarizeViaCli — cloud_auth requires company context to route through the sandbox", () => {
  afterEach(() => setDeploymentMode("local_trusted"));
  it("throws a structural guard (missing db/companyId) without spawning a CLI locally", async () => {
    setDeploymentMode("cloud_auth");
    const before = spawnArgs.length;
    await expect(summarizeViaCli({ cliTool: "claude", transcript: "hello" }))
      .rejects.toThrow(/company context/i);
    expect(spawnArgs.length).toBe(before);
  });
});
