import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

/**
 * U13.6 — proves Commander history-compaction (`summarizeViaCli`) routes
 * through the shared ephemeral-sandbox seam (U13.1, `runOneShotCliInSandbox`)
 * on `cloud_auth`, authenticated with the COMPANY's own resolved provider key
 * (U13.0) — never the shared host's operator login — and that the desktop
 * spawn path is completely unchanged.
 *
 * Strategy mirrors extraction-cli-sandbox-env.test.ts (U13.2): mock
 * `../services/one-shot-provider-credential.js` and
 * `../services/one-shot-sandbox-cli.js` so these tests assert ROUTING (what
 * cli-summarizer.ts calls, with what args) without exercising the real
 * acquire/execute/release machinery — that machinery (including the S2
 * env-allowlist build that excludes CLAUDE_CODE_OAUTH_TOKEN and includes
 * only the company's own key) is covered by one-shot-sandbox-cli.test.ts.
 * The "env free of operator creds" invariant is proven here by showing the
 * cloud path NEVER reaches `node:child_process` spawn (the only place an
 * operator credential could leak in) — the sandbox's env is built entirely
 * inside the mocked runOneShotCliInSandbox from the resolved company
 * credential (companyId asserted below).
 */

const mockRunOneShotCliInSandbox = vi.fn();
vi.mock("../services/one-shot-sandbox-cli.js", () => ({
  runOneShotCliInSandbox: (...a: unknown[]) => mockRunOneShotCliInSandbox(...a),
}));

const mockResolveCompanyProviderCredential = vi.fn();
vi.mock("../services/one-shot-provider-credential.js", () => ({
  resolveCompanyProviderCredential: (...a: unknown[]) => mockResolveCompanyProviderCredential(...a),
}));

const spawnCalls: Array<{ bin: string; args: string[] }> = [];
vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    spawnCalls.push({ bin, args });
    return {
      stdin: { write() {}, end() {} },
      stdout: {
        on(ev: string, cb: any) {
          if (ev === "data") cb(Buffer.from("DESKTOP SUMMARY"));
        },
      },
      stderr: { on() {} },
      on(ev: string, cb: any) {
        if (ev === "close") cb(0);
      },
    };
  }),
}));

import { summarizeViaCli } from "../services/internal-agent/cli-summarizer.js";

const FAKE_CREDENTIAL = {
  envName: "ANTHROPIC_API_KEY",
  value: "sk-co-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};
const fakeDb = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  spawnCalls.length = 0;
  mockResolveCompanyProviderCredential.mockResolvedValue(FAKE_CREDENTIAL);
  mockRunOneShotCliInSandbox.mockResolvedValue({
    stdout: "SANDBOX SUMMARY",
    stderr: "",
    exitCode: 0,
    durationMs: 5,
  });
});

afterEach(() => setDeploymentMode("local_trusted"));

describe("summarizeViaCli — sandbox routing (U13.6)", () => {
  it("cloud + resolved company credential: returns the sandbox stdout summary, routes through runOneShotCliInSandbox with source:'compaction', never spawns a local CLI", async () => {
    setDeploymentMode("cloud_auth");

    const out = await summarizeViaCli({
      cliTool: "claude",
      cheapModel: null,
      transcript: "user: hi\nassistant: yo",
      db: fakeDb,
      companyId: "company-1",
    });

    expect(out).toBe("SANDBOX SUMMARY");

    expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
    const [input] = mockRunOneShotCliInSandbox.mock.calls[0];
    expect(input.db).toBe(fakeDb);
    expect(input.companyId).toBe("company-1");
    expect(input.cliTool).toBe("claude");
    expect(input.source).toBe("compaction");
    expect(input.command).toBe("claude");
    expect(input.stdinContent).toContain("user: hi\nassistant: yo");
    expect(input.stdinContent).toContain("Summarize this conversation");

    // The company's own resolved model-provider credential was consulted
    // (for --model threading) with the right company + cliTool — the ENV
    // itself is built inside runOneShotCliInSandbox from this same
    // resolution (S2/S3), never from the host process env.
    expect(mockResolveCompanyProviderCredential).toHaveBeenCalledWith(fakeDb, "company-1", {
      cliTool: "claude",
    });

    // NEVER the desktop local spawn — no operator credential
    // (CLAUDE_CODE_OAUTH_TOKEN, host-ambient ANTHROPIC_API_KEY) can leak in;
    // the sandbox env is exclusively the company's own key.
    expect(spawnCalls).toHaveLength(0);
  });

  it("codex on cloud: builds a codex exec argv with the resolved model, still via the sandbox", async () => {
    setDeploymentMode("cloud_auth");

    await summarizeViaCli({
      cliTool: "codex",
      transcript: "t",
      db: fakeDb,
      companyId: "company-1",
    });

    const [input] = mockRunOneShotCliInSandbox.mock.calls[0];
    expect(input.command).toBe("codex");
    expect(input.args).toEqual(
      expect.arrayContaining(["exec", "--model", FAKE_CREDENTIAL.model]),
    );
  });

  it("on sandbox failure, propagates the throw (caller treats it as skip-this-turn)", async () => {
    setDeploymentMode("cloud_auth");
    mockRunOneShotCliInSandbox.mockRejectedValueOnce(new Error("sandbox boom"));

    await expect(
      summarizeViaCli({ cliTool: "claude", transcript: "hi", db: fakeDb, companyId: "company-1" }),
    ).rejects.toThrow("sandbox boom");
  });

  it("desktop (tenantIsolationEnforced=false): still spawns locally, never calls the sandbox helper", async () => {
    setDeploymentMode("local_trusted");

    const out = await summarizeViaCli({
      cliTool: "claude",
      transcript: "hi",
    });

    expect(out).toBe("DESKTOP SUMMARY");
    expect(mockRunOneShotCliInSandbox).not.toHaveBeenCalled();
    expect(mockResolveCompanyProviderCredential).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].bin).toBe("claude");
  });
});
