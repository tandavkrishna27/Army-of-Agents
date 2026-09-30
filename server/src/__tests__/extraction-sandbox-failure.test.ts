import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

/**
 * U13.3 — finalizes the `sandbox_unavailable` CliErrorKind.
 *
 * Before this task, `extractViaCliSandbox` (extraction-cli.ts) collapsed EVERY
 * `OneShotSandboxError` other than `timeout` into `CliExtractionError.kind ===
 * "nonzero_exit"` (a deliberate temporary bucket — see U13.2's comment). This
 * proves the FINAL mapping: a `OneShotSandboxError("sandbox_unavailable")`
 * (no isolated sandbox could be acquired — missing provider key, no
 * environment resolved, a lease missing its provider, etc. — see
 * one-shot-sandbox-cli.ts) now classifies as its OWN
 * `CliExtractionError.kind === "sandbox_unavailable"`:
 *   - NOT "not_authed" — DiscussionDetail.extractionFailureMessage has a
 *     `multiTenant && kind === "not_authed"` override that shows the STALE
 *     pre-U13 "extraction isn't available on AoA Cloud yet" copy, which would
 *     be actively wrong now that cloud extraction exists.
 *   - NOT "nonzero_exit" (the U13.2-temporary bucket) — sandbox_unavailable
 *     is its own class now.
 * The classified failure message must point at provider-key/config
 * (Settings), and must NEVER contain "install" — there is no local CLI to
 * install on a sandboxed spawn (that copy is desktop-only, e.g.
 * "claude CLI not found on PATH. Install the Claude Code CLI...").
 *
 * Strategy: mock ONLY `one-shot-sandbox-cli.js` (the U13.1 seam) so
 * `extractViaCli`'s real `extractViaCliSandbox` branch runs for real, with
 * the sandbox helper itself faked to throw the injected error — same
 * boundary U13.2's extraction-cli-sandbox-env.test.ts uses.
 */

const mockRunOneShotCliInSandbox = vi.fn();
vi.mock("../services/one-shot-sandbox-cli.js", () => {
  // Defined INSIDE the (hoisted) factory — vi.mock factories may not close
  // over top-level bindings declared below the call (mirrors
  // extraction-cli-sandbox-env.test.ts's identical pattern).
  class FakeOneShotSandboxError extends Error {
    readonly kind: string;
    readonly exitCode: number | null;
    readonly stderr: string;
    constructor(message: string, kind: string, exitCode: number | null = null, stderr = "") {
      super(message);
      this.name = "OneShotSandboxError";
      this.kind = kind;
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  }
  return {
    runOneShotCliInSandbox: (...a: unknown[]) => mockRunOneShotCliInSandbox(...a),
    OneShotSandboxError: FakeOneShotSandboxError,
  };
});

import { extractViaCli, CliExtractionError } from "../services/extraction-cli.js";
import { OneShotSandboxError } from "../services/one-shot-sandbox-cli.js";

const FAKE_CREDENTIAL = {
  envName: "ANTHROPIC_API_KEY",
  value: "sk-co-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};
const FAKE_DB = {} as never;

afterEach(() => {
  setDeploymentMode("local_trusted");
  vi.clearAllMocks();
});

describe("extractViaCli — sandbox_unavailable classification (U13.3)", () => {
  it("claude: OneShotSandboxError('sandbox_unavailable') classifies as CliExtractionError kind sandbox_unavailable (not not_authed, not nonzero_exit)", async () => {
    setDeploymentMode("cloud_auth");
    mockRunOneShotCliInSandbox.mockRejectedValueOnce(
      new OneShotSandboxError(
        "No isolated sandbox environment is available for this company.",
        "sandbox_unavailable",
      ),
    );

    let caught: CliExtractionError | undefined;
    try {
      await extractViaCli("claude", "sys", "content", {
        credential: FAKE_CREDENTIAL,
        companyId: "company-1",
        db: FAKE_DB,
      });
    } catch (err) {
      caught = err as CliExtractionError;
    }

    expect(caught).toBeInstanceOf(CliExtractionError);
    expect(caught!.kind).toBe("sandbox_unavailable");
    expect(caught!.kind).not.toBe("not_authed");
    expect(caught!.kind).not.toBe("nonzero_exit");
  });

  it("classified failure copy points at provider-key/config (Settings) and never contains 'install'", async () => {
    setDeploymentMode("cloud_auth");
    mockRunOneShotCliInSandbox.mockRejectedValueOnce(
      new OneShotSandboxError("Sandbox lease is missing a provider.", "sandbox_unavailable"),
    );

    await expect(
      extractViaCli("claude", "sys", "content", {
        credential: FAKE_CREDENTIAL,
        companyId: "company-1",
        db: FAKE_DB,
      }),
    ).rejects.toMatchObject({
      name: "CliExtractionError",
      kind: "sandbox_unavailable",
      message: expect.stringMatching(/provider key|config|Settings/i),
    });

    // Re-run to inspect the message directly (rejects.toMatchObject above
    // consumed the mocked rejection).
    mockRunOneShotCliInSandbox.mockRejectedValueOnce(
      new OneShotSandboxError("Sandbox lease is missing a provider.", "sandbox_unavailable"),
    );
    let message = "";
    try {
      await extractViaCli("claude", "sys", "content", {
        credential: FAKE_CREDENTIAL,
        companyId: "company-1",
        db: FAKE_DB,
      });
    } catch (err) {
      message = (err as CliExtractionError).message;
    }
    expect(message.toLowerCase()).not.toContain("install");
  });

  it("codex: same sandbox_unavailable classification and cloud copy (no 'install')", async () => {
    setDeploymentMode("cloud_auth");
    mockRunOneShotCliInSandbox.mockRejectedValueOnce(
      new OneShotSandboxError("Failed to acquire an execution sandbox: boom", "sandbox_unavailable"),
    );

    let caught: CliExtractionError | undefined;
    try {
      await extractViaCli("codex", "sys", "content", {
        credential: { ...FAKE_CREDENTIAL, envName: "OPENAI_API_KEY", provider: "openai" },
        companyId: "company-1",
        db: FAKE_DB,
      });
    } catch (err) {
      caught = err as CliExtractionError;
    }

    expect(caught).toBeInstanceOf(CliExtractionError);
    expect(caught!.kind).toBe("sandbox_unavailable");
    expect(caught!.message.toLowerCase()).not.toContain("install");
    expect(caught!.message).toMatch(/provider key|config|Settings/i);
  });

  it("timeout/nonzero_exit kinds are unaffected — still map to their own kinds, not sandbox_unavailable", async () => {
    setDeploymentMode("cloud_auth");
    mockRunOneShotCliInSandbox.mockRejectedValueOnce(
      new OneShotSandboxError("One-shot CLI timed out inside the sandbox.", "timeout"),
    );
    await expect(
      extractViaCli("claude", "sys", "content", {
        credential: FAKE_CREDENTIAL,
        companyId: "company-1",
        db: FAKE_DB,
      }),
    ).rejects.toMatchObject({ kind: "timeout" });

    mockRunOneShotCliInSandbox.mockRejectedValueOnce(
      new OneShotSandboxError("One-shot CLI exited with code 1.", "nonzero_exit", 1, "boom"),
    );
    await expect(
      extractViaCli("claude", "sys", "content", {
        credential: FAKE_CREDENTIAL,
        companyId: "company-1",
        db: FAKE_DB,
      }),
    ).rejects.toMatchObject({ kind: "nonzero_exit" });
  });
});
