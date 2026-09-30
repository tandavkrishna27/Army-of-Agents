import { describe, it, expect, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  agents: makeTableProxy("agents"),
}));

import { classifyCommanderProbe, cliToolToAdapterType } from "../services/commander-verify.js";
import type { AdapterEnvironmentTestResult } from "@armyofagents/shared";

describe("cliToolToAdapterType", () => {
  it("maps commander cliTools to adapter types", () => {
    expect(cliToolToAdapterType("claude_cli")).toBe("claude_local");
    expect(cliToolToAdapterType("codex")).toBe("codex_local");
    expect(cliToolToAdapterType("opencode")).toBe("opencode_local");
  });
  it("defaults to claude_local (Commander default)", () => {
    expect(cliToolToAdapterType(null)).toBe("claude_local");
    expect(cliToolToAdapterType(undefined)).toBe("claude_local");
    expect(cliToolToAdapterType("weird")).toBe("claude_local");
  });
});

const R = (
  checks: { code: string; level: "info" | "warn" | "error"; message?: string; detail?: string }[],
  status: "pass" | "warn" | "fail",
): AdapterEnvironmentTestResult => ({
  adapterType: "claude_local",
  status,
  checks: checks.map((c) => ({ ...c, message: c.message ?? c.code })),
  testedAt: "",
});

describe("classifyCommanderProbe", () => {
  it("verified on pass", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_hello_probe_passed", level: "info" }], "pass")).outcome).toBe(
      "verified",
    );
  });
  it("needs_auth when login required", () => {
    expect(
      classifyCommanderProbe(R([{ code: "claude_hello_probe_auth_required", level: "warn" }], "fail")).outcome,
    ).toBe("needs_auth");
  });
  it("not_installed when command unresolvable", () => {
    expect(
      classifyCommanderProbe(R([{ code: "claude_command_unresolvable", level: "error" }], "fail")).outcome,
    ).toBe("not_installed");
  });
  it("failed on other hard errors", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_hello_probe_failed", level: "error" }], "fail")).outcome).toBe(
      "failed",
    );
  });
  it("treats a cosmetic warn (no auth/install signal) as verified — not hard-blocked", () => {
    expect(classifyCommanderProbe(R([{ code: "claude_version_mismatch", level: "warn" }], "warn")).outcome).toBe(
      "verified",
    );
  });

  it("needs_auth on claude_hello_probe_auth_expired (revoked/expired session — recoverable)", () => {
    expect(
      classifyCommanderProbe(
        R(
          [
            {
              code: "claude_hello_probe_auth_expired",
              level: "warn",
              message: "Signed in as ada@example.com, but that session has expired or been revoked.",
            },
          ],
          "fail",
        ),
      ).outcome,
    ).toBe("needs_auth");
  });

  it("needs_auth on codex_hello_probe_auth_expired (symmetric with claude)", () => {
    expect(
      classifyCommanderProbe(
        R(
          [
            {
              code: "codex_hello_probe_auth_expired",
              level: "warn",
              message: "Your Codex sign-in has expired or been revoked.",
            },
          ],
          "fail",
        ),
      ).outcome,
    ).toBe("needs_auth");
  });

  it("needs_auth on claude_hello_probe_auth_required (unchanged behaviour)", () => {
    expect(
      classifyCommanderProbe(
        R([{ code: "claude_hello_probe_auth_required", level: "warn", message: "Not signed in yet." }], "fail"),
      ).outcome,
    ).toBe("needs_auth");
  });

  it("needs_auth via text fallback when an unknown future code carries a 401 in detail", () => {
    expect(
      classifyCommanderProbe(
        R(
          [
            {
              code: "some_new_adapter_probe_failed",
              level: "error",
              message: "Probe failed.",
              detail: "Request failed with status 401: authentication_error",
            },
          ],
          "fail",
        ),
      ).outcome,
    ).toBe("needs_auth");
  });

  it("stays failed on a genuine non-auth failure", () => {
    expect(
      classifyCommanderProbe(
        R([{ code: "claude_hello_probe_failed", level: "error", message: "API Error: 500" }], "fail"),
      ).outcome,
    ).toBe("failed");
  });

  it("stays failed on a rate limit — must not over-match as auth", () => {
    expect(
      classifyCommanderProbe(
        R(
          [
            {
              code: "claude_hello_probe_failed",
              level: "error",
              message: "429 rate limit exceeded",
              detail: "429 rate limit exceeded, please retry later",
            },
          ],
          "fail",
        ),
      ).outcome,
    ).toBe("failed");
  });
});
