import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * U13.7 — proves `probeReadinessInSandbox` routes the adapter hello-probe
 * through the shared ephemeral-sandbox seam (U13.1, `runOneShotCliInSandbox`)
 * authenticated with the COMPANY's own resolved provider credential (U13.0),
 * and maps the sandboxed run's outcome onto the adapter `EnvironmentTestResult`
 * shape the three probe routes already consume (`{status, checks, testedAt}`).
 *
 * Strategy mirrors cli-summarizer-sandbox.test.ts (U13.6): mock
 * `../services/one-shot-provider-credential.js` and
 * `../services/one-shot-sandbox-cli.js` (keeping the REAL `OneShotSandboxError`
 * class via importOriginal, so instanceof checks hold across the mock
 * boundary) so these tests assert ROUTING + MAPPING without exercising the
 * real acquire/execute/release machinery (covered by one-shot-sandbox-cli.test.ts)
 * or the real credential resolver (covered by one-shot-provider-credential.test.ts).
 */

const mockRunOneShotCliInSandbox = vi.fn();
const mockResolveCompanyProviderCredential = vi.fn();

vi.mock("../services/one-shot-sandbox-cli.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/one-shot-sandbox-cli.js")>();
  return {
    ...actual,
    runOneShotCliInSandbox: (...a: unknown[]) => mockRunOneShotCliInSandbox(...a),
  };
});

vi.mock("../services/one-shot-provider-credential.js", () => ({
  resolveCompanyProviderCredential: (...a: unknown[]) => mockResolveCompanyProviderCredential(...a),
}));

import {
  probeReadinessInSandbox,
  cliToolForSandboxReadinessProbe,
} from "../services/sandbox-readiness-probe.js";
import { OneShotSandboxError } from "../services/one-shot-sandbox-cli.js";
import { ProviderUnavailableError } from "../services/provider-resolution.js";

const FAKE_CREDENTIAL = {
  envName: "ANTHROPIC_API_KEY",
  value: "sk-co-secret",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};
const fakeDb = {} as never;
const COMPANY_ID = "company-1";

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCompanyProviderCredential.mockResolvedValue(FAKE_CREDENTIAL);
  mockRunOneShotCliInSandbox.mockResolvedValue({
    stdout: "hello",
    stderr: "",
    exitCode: 0,
    durationMs: 5,
  });
});

describe("probeReadinessInSandbox (U13.7)", () => {
  it("resolved company key + sandboxed hello-probe exits 0 -> {status:'pass'}, routes through runOneShotCliInSandbox with source:'readiness'", async () => {
    const result = await probeReadinessInSandbox({
      db: fakeDb,
      companyId: COMPANY_ID,
      cliTool: "claude",
      adapterType: "claude_local",
    });

    expect(result.status).toBe("pass");
    expect(result.adapterType).toBe("claude_local");
    expect(result.checks[0].code).toBe("claude_hello_probe_passed");
    expect(result.checks[0].level).toBe("info");
    expect(typeof result.testedAt).toBe("string");

    expect(mockRunOneShotCliInSandbox).toHaveBeenCalledTimes(1);
    const [input] = mockRunOneShotCliInSandbox.mock.calls[0];
    expect(input.db).toBe(fakeDb);
    expect(input.companyId).toBe(COMPANY_ID);
    expect(input.cliTool).toBe("claude");
    expect(input.command).toBe("claude");
    expect(input.source).toBe("readiness");
    expect(input.stdinContent).toBe("Respond with hello.");

    // The env is built INSIDE runOneShotCliInSandbox from the resolved company
    // credential (S2/S3) — this call never builds/passes its own env, so the
    // sandbox env can only ever carry the company key, never an operator
    // credential (no CLAUDE_CODE_OAUTH_TOKEN / host ANTHROPIC_API_KEY reaches
    // this seam at all). Assert the credential resolution that feeds that env
    // build used the right company + cliTool.
    expect(mockResolveCompanyProviderCredential).toHaveBeenCalledWith(fakeDb, COMPANY_ID, {
      cliTool: "claude",
    });
    expect(input.env).toBeUndefined();
  });

  it("codex: builds a codex exec argv with the resolved model, still via the sandbox", async () => {
    mockResolveCompanyProviderCredential.mockResolvedValue({
      ...FAKE_CREDENTIAL,
      envName: "OPENAI_API_KEY",
      provider: "openai",
      model: "gpt-5.5",
    });

    const result = await probeReadinessInSandbox({
      db: fakeDb,
      companyId: COMPANY_ID,
      cliTool: "codex",
      adapterType: "codex_local",
    });

    expect(result.checks[0].code).toBe("codex_hello_probe_passed");
    const [input] = mockRunOneShotCliInSandbox.mock.calls[0];
    expect(input.command).toBe("codex");
    expect(input.args).toEqual(expect.arrayContaining(["exec", "--model", "gpt-5.5"]));
  });

  it("no company key configured (resolveCompanyProviderCredential throws ProviderUnavailableError) propagates UNCHANGED — never runs the sandbox", async () => {
    const thrown = new ProviderUnavailableError("anthropic", "no_assignment", null);
    mockResolveCompanyProviderCredential.mockRejectedValue(thrown);

    await expect(
      probeReadinessInSandbox({
        db: fakeDb,
        companyId: COMPANY_ID,
        cliTool: "claude",
        adapterType: "claude_local",
      }),
    ).rejects.toBe(thrown);

    expect(mockRunOneShotCliInSandbox).not.toHaveBeenCalled();
  });

  it("sandboxed hello-probe exits nonzero -> {status:'fail', checks:[{code:'*_hello_probe_failed'}]} — NOT the 'no key' shape", async () => {
    mockRunOneShotCliInSandbox.mockRejectedValue(
      new OneShotSandboxError("One-shot CLI exited with code 1.", "nonzero_exit", 1, "auth error"),
    );

    const result = await probeReadinessInSandbox({
      db: fakeDb,
      companyId: COMPANY_ID,
      cliTool: "claude",
      adapterType: "claude_local",
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe("claude_hello_probe_failed");
    expect(result.checks[0].code).not.toBe("readiness_unavailable_on_cloud");
    expect(result.checks[0].level).toBe("error");
  });

  it("sandboxed hello-probe times out -> {status:'fail', checks:[{code:'*_hello_probe_timed_out'}]}", async () => {
    mockRunOneShotCliInSandbox.mockRejectedValue(
      new OneShotSandboxError("One-shot CLI timed out inside the sandbox.", "timeout"),
    );

    const result = await probeReadinessInSandbox({
      db: fakeDb,
      companyId: COMPANY_ID,
      cliTool: "claude",
      adapterType: "claude_local",
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe("claude_hello_probe_timed_out");
  });

  it("sandbox itself unavailable -> {status:'fail', checks:[{code:'*_sandbox_unavailable'}]} — distinct from the 'no key' code", async () => {
    mockRunOneShotCliInSandbox.mockRejectedValue(
      new OneShotSandboxError("No isolated sandbox environment is available for this company.", "sandbox_unavailable"),
    );

    const result = await probeReadinessInSandbox({
      db: fakeDb,
      companyId: COMPANY_ID,
      cliTool: "claude",
      adapterType: "claude_local",
    });

    expect(result.status).toBe("fail");
    expect(result.checks[0].code).toBe("claude_sandbox_unavailable");
    expect(result.checks[0].code).not.toBe("readiness_unavailable_on_cloud");
  });
});

describe("cliToolForSandboxReadinessProbe (U13.7)", () => {
  it("maps claude_local -> claude, codex_local -> codex, everything else -> null", () => {
    expect(cliToolForSandboxReadinessProbe("claude_local")).toBe("claude");
    expect(cliToolForSandboxReadinessProbe("codex_local")).toBe("codex");
    expect(cliToolForSandboxReadinessProbe("gemini_local")).toBeNull();
    expect(cliToolForSandboxReadinessProbe("process")).toBeNull();
    expect(cliToolForSandboxReadinessProbe("opencode_local")).toBeNull();
  });
});
