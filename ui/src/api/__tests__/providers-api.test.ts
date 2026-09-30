import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", async () => {
  const actual = await vi.importActual<typeof import("../client")>("../client");
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn() },
  };
});

import {
  ADAPTER_PROBE_BUSY_ERROR as SHARED_BUSY_ERROR,
  ADAPTER_PROBE_RETRY_AFTER_SECONDS as SHARED_RETRY_AFTER,
  PROBE_OUTCOMES as SHARED_PROBE_OUTCOMES,
  PROVIDER_CATALOG,
  getProviderById,
  type ProviderDescriptor,
  type ProviderId,
} from "@armyofagents/shared";
import { api, ApiError } from "../client";
import {
  ADAPTER_PROBE_BUSY_ERROR,
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  PROBE_OUTCOMES,
  deriveCardStatus,
  keyInputState,
  loginUnavailableFrom,
  providersApi,
  readinessForScope,
  type ProviderStatusRow,
  type ScopedReadiness,
} from "../providers";

/* ── fixtures ──────────────────────────────────────────────────────────── */

/**
 * Fixtures are built from REAL `PROVIDER_CATALOG` entries, never from a
 * hand-stubbed `{ id, label } as ProviderDescriptor` cast.
 *
 * A cast erases `credential` — including `credentialOwnerId` — so any helper
 * that reads it would be exercised against a descriptor shape the server never
 * sends, and the test would agree with itself by construction. That is exactly
 * how the credential-borrowing bug (a second key input on Pi / Cursor Cloud)
 * survived the first pass.
 */
function descriptorFor(id: ProviderId): ProviderDescriptor {
  const descriptor = getProviderById(id);
  if (!descriptor) throw new Error(`no catalog entry for ${id}`);
  return descriptor;
}

function scoped(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return {
    scopeType: "company_default",
    scopeId: null,
    outcome: "verified",
    testedAt: "2026-07-20T00:00:00.000Z",
    checks: [],
    ...over,
  };
}

function agentScope(agentId: string, outcome: ScopedReadiness["outcome"]): ScopedReadiness {
  return scoped({ scopeType: "agent", scopeId: agentId, agentName: `agent-${agentId}`, outcome });
}

/**
 * `providerId` selects the real catalog descriptor. `existingKey.envVar`
 * defaults to whatever that provider's own spec declares — mirroring the
 * server, which resolves it through `getCredentialOwner` and therefore reports
 * a NON-null envVar even for a borrower.
 */
function row(
  over: Partial<ProviderStatusRow> & { providerId?: ProviderId } = {},
): ProviderStatusRow {
  const { providerId = "openai", ...rest } = over;
  const descriptor = descriptorFor(providerId);
  return {
    descriptor,
    companyDefault: scoped(),
    agents: [],
    existingKey: {
      configured: false,
      source: null,
      secretName: null,
      envVar: descriptor.credential.apiKey?.envVar ?? null,
    },
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ── 1. contract drift ─────────────────────────────────────────────────── */

describe("ProbeOutcome contract drift", () => {
  it("re-exports the shared PROBE_OUTCOMES array rather than retyping it", () => {
    // Identity, not just equality: a local literal would be a different array.
    expect(PROBE_OUTCOMES).toBe(SHARED_PROBE_OUTCOMES);
  });

  it("carries exactly the six server outcomes, in order", () => {
    expect([...PROBE_OUTCOMES]).toEqual([...SHARED_PROBE_OUTCOMES]);
    expect(PROBE_OUTCOMES).toHaveLength(6);
    expect([...PROBE_OUTCOMES]).toEqual([
      "verified",
      "needs_auth",
      "not_installed",
      "failed",
      "unknown",
      "unverifiable",
    ]);
  });
});

/* ── 2. list ───────────────────────────────────────────────────────────── */

describe("providersApi.list", () => {
  it("GETs the company-scoped providers route", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ providers: [] });
    await providersApi.list("company-1");
    expect(api.get).toHaveBeenCalledWith("/companies/company-1/providers");
  });

  it("preserves BOTH scopes and existingKey without flattening", async () => {
    const payload = {
      providers: [
        row({
          agents: [agentScope("a1", "needs_auth")],
          existingKey: {
            configured: true,
            source: "external" as const,
            secretName: "llm:anthropic",
            envVar: "ANTHROPIC_API_KEY",
          },
        }),
      ],
    };
    vi.mocked(api.get).mockResolvedValueOnce(payload);

    const res = await providersApi.list("company-1");
    expect(res.providers[0].companyDefault.outcome).toBe("verified");
    expect(res.providers[0].agents).toHaveLength(1);
    expect(res.providers[0].agents[0].outcome).toBe("needs_auth");
    expect(res.providers[0].existingKey).toEqual({
      configured: true,
      source: "external",
      secretName: "llm:anthropic",
      envVar: "ANTHROPIC_API_KEY",
    });
  });
});

/* ── 3. no scope fallback ──────────────────────────────────────────────── */

describe("readinessForScope — the false-green guard", () => {
  it("returns the company_default row for the company scope", () => {
    const r = row();
    expect(readinessForScope(r, { scopeType: "company_default" })).toBe(r.companyDefault);
  });

  it("returns the agent's OWN row for a known agent", () => {
    const mine = agentScope("a1", "failed");
    const r = row({ agents: [mine] });
    expect(readinessForScope(r, { scopeType: "agent", agentId: "a1" })).toBe(mine);
  });

  it("returns undefined — NEVER companyDefault — for an unprobed agent", () => {
    const r = row({ companyDefault: scoped({ outcome: "verified" }), agents: [] });
    const got = readinessForScope(r, { scopeType: "agent", agentId: "ghost" });
    expect(got).toBeUndefined();
    expect(got).not.toBe(r.companyDefault);
  });
});

/* ── 4. test (scoped probe) ────────────────────────────────────────────── */

describe("providersApi.test", () => {
  it("defaults to the company_default scope", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ outcome: "verified", checks: [], testedAt: "t" });
    await providersApi.test("company-1", "anthropic");
    expect(api.post).toHaveBeenCalledWith(
      "/companies/company-1/providers/anthropic/test?scope=company_default",
      {},
    );
  });

  it("sends scope=agent with the agentId", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ outcome: "failed", checks: [], testedAt: "t" });
    await providersApi.test("company-1", "anthropic", { scopeType: "agent", agentId: "a 1/x" });
    const url = vi.mocked(api.post).mock.calls[0][0];
    expect(url).toContain("scope=agent");
    expect(url).toContain("agentId=a+1%2Fx");
  });

  it("refuses an agent probe with no agentId instead of probing the company default", async () => {
    await expect(
      // Cast models a caller that lost the discriminated-union guarantee.
      providersApi.test("company-1", "anthropic", {
        scopeType: "agent",
      } as unknown as { scopeType: "agent"; agentId: string }),
    ).rejects.toThrow(/agentId/i);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("never emits a literal 'undefined' agentId", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ outcome: "verified", checks: [], testedAt: "t" });
    await providersApi.test("company-1", "anthropic", { scopeType: "agent", agentId: "a1" });
    expect(vi.mocked(api.post).mock.calls[0][0]).not.toContain("undefined");
  });

  it("returns the probe result shape the server sends (no scopeType/scopeId)", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      outcome: "unverifiable",
      checks: [{ code: "custom_command", level: "warn", message: "skipped" }],
      testedAt: "2026-07-20T00:00:00.000Z",
    });
    const res = await providersApi.test("company-1", "anthropic");
    expect(res.outcome).toBe("unverifiable");
    expect(res.testedAt).toBe("2026-07-20T00:00:00.000Z");
    expect(res.checks[0].code).toBe("custom_command");
  });
});

/* ── 5. saveKey ────────────────────────────────────────────────────────── */

describe("providersApi.saveKey", () => {
  it("POSTs the value and surfaces the credential-group result", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      ok: true,
      secretId: "s1",
      reprobed: ["cursor"],
      invalidated: ["cursor_cloud"],
    });
    const res = await providersApi.saveKey("company-1", "cursor", "sk-live");
    expect(api.post).toHaveBeenCalledWith("/companies/company-1/providers/cursor/key", {
      value: "sk-live",
    });
    expect(res.reprobed).toEqual(["cursor"]);
    expect(res.invalidated).toEqual(["cursor_cloud"]);
    // Invariant 3: a group member lands in exactly one of the two arrays.
    expect(res.reprobed.filter((p) => res.invalidated.includes(p))).toEqual([]);
  });
});

/* ── 6. login ──────────────────────────────────────────────────────────── */

describe("providersApi login", () => {
  it("starts a login", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ challengeId: "c1", loginUrl: "https://x" });
    await providersApi.startLogin("company-1", "openai");
    expect(api.post).toHaveBeenCalledWith("/companies/company-1/providers/openai/login/start", {});
  });

  it("polls status and carries the post-login readiness re-probe", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      status: "completed",
      loginUrl: null,
      readiness: scoped({ outcome: "verified" }),
    });
    const res = await providersApi.loginStatus("company-1", "openai", "c1");
    expect(api.get).toHaveBeenCalledWith("/companies/company-1/providers/openai/login/c1");
    expect(res.status).toBe("completed");
    expect(res.readiness?.outcome).toBe("verified");
  });

  it("tolerates a null readiness on a pending poll", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      status: "pending",
      loginUrl: "https://x",
      readiness: null,
    });
    const res = await providersApi.loginStatus("company-1", "openai", "c1");
    expect(res.readiness).toBeNull();
  });

  it("cancels a login", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true });
    await providersApi.cancelLogin("company-1", "openai", "c1");
    expect(api.post).toHaveBeenCalledWith(
      "/companies/company-1/providers/openai/login/c1/cancel",
      {},
    );
  });
});

/* ── 7. the 400 login-unavailable body ─────────────────────────────────── */

describe("loginUnavailableFrom", () => {
  it("narrows a 400 that carries canLogin:false + manualCommand", () => {
    const err = new ApiError("Claude sign-in must be completed in a terminal.", 400, {
      error: "Claude sign-in must be completed in a terminal.",
      canLogin: false,
      manualCommand: "claude /login",
    });
    const info = loginUnavailableFrom(err);
    expect(info).not.toBeNull();
    expect(info?.canLogin).toBe(false);
    expect(info?.manualCommand).toBe("claude /login");
    expect(info?.error).toContain("terminal");
  });

  it("handles a 400 with no manualCommand (provider documents no login at all)", () => {
    const err = new ApiError("no in-app sign-in", 400, {
      error: "no in-app sign-in",
      canLogin: false,
    });
    expect(loginUnavailableFrom(err)?.manualCommand).toBeUndefined();
    expect(loginUnavailableFrom(err)?.canLogin).toBe(false);
  });

  it("returns null for the 409 slot conflict and other statuses", () => {
    expect(loginUnavailableFrom(new ApiError("busy", 409, { error: "busy" }))).toBeNull();
    expect(loginUnavailableFrom(new ApiError("boom", 502, { error: "boom" }))).toBeNull();
  });

  it("returns null for a 400 that is not the canLogin shape, and for non-ApiErrors", () => {
    expect(loginUnavailableFrom(new ApiError("bad", 400, { error: "bad" }))).toBeNull();
    expect(loginUnavailableFrom(new Error("network"))).toBeNull();
    expect(loginUnavailableFrom(null)).toBeNull();
  });
});

/* ── 8. key input state (reads existingKey) ────────────────────────────── */

describe("keyInputState", () => {
  it("hides the input for a provider with no key binding at all", () => {
    // OpenCode brokers its own per-provider credentials — no key input exists.
    expect(keyInputState(row({ providerId: "opencode" })).kind).toBe("hidden");
  });

  it("offers add when no key is configured", () => {
    expect(keyInputState(row({ providerId: "openai" })).kind).toBe("add");
  });

  it("offers replace when a key already exists under ANY known binding", () => {
    expect(
      keyInputState(
        row({
          providerId: "anthropic",
          existingKey: {
            configured: true,
            source: "external",
            secretName: "Commander anthropic API key",
            envVar: "ANTHROPIC_API_KEY",
          },
        }),
      ).kind,
    ).toBe("replace");
  });

  /**
   * The catalog forbids a second input for a borrower: two inputs writing one
   * secret means saving either silently overwrites the other.
   */
  describe("credential-borrowing providers never get their own input", () => {
    it("Cursor Cloud points at Cursor", () => {
      const state = keyInputState(row({ providerId: "cursor_cloud" }));
      expect(state).toEqual({ kind: "owned_elsewhere", ownerId: "cursor" });
    });

    it("Pi points at Claude — pasting an xAI key here would repoint claude_local", () => {
      const state = keyInputState(row({ providerId: "pi" }));
      expect(state).toEqual({ kind: "owned_elsewhere", ownerId: "anthropic" });
    });

    it("is not vacuous: both borrowers DO declare their own non-null envVar", () => {
      // This is why keying off `existingKey.envVar` alone rendered an input.
      for (const id of ["cursor_cloud", "pi"] as const) {
        const descriptor = descriptorFor(id);
        expect(descriptor.credential.credentialOwnerId).toBeTruthy();
        expect(descriptor.credential.apiKey?.envVar).toBeTruthy();
      }
    });

    it("covers every borrower in the catalog, not just the two known today", () => {
      const borrowers = PROVIDER_CATALOG.filter((p) => p.credential.credentialOwnerId);
      expect(borrowers.length).toBeGreaterThan(0);
      for (const descriptor of borrowers) {
        expect(keyInputState(row({ providerId: descriptor.id })).kind).toBe("owned_elsewhere");
      }
    });
  });
});

/* ── 10. probe back-off constants ──────────────────────────────────────── */

describe("adapter probe back-off constants", () => {
  it("re-exports the shared constants rather than hardcoding 30", () => {
    expect(ADAPTER_PROBE_RETRY_AFTER_SECONDS).toBe(SHARED_RETRY_AFTER);
    expect(ADAPTER_PROBE_BUSY_ERROR).toBe(SHARED_BUSY_ERROR);
    expect(typeof ADAPTER_PROBE_RETRY_AFTER_SECONDS).toBe("number");
  });
});

/* ── 9. card status derivation ─────────────────────────────────────────── */

describe("deriveCardStatus", () => {
  it("claims ready only when the company default is verified and no agent objects", () => {
    const s = deriveCardStatus(row());
    expect(s.outcome).toBe("verified");
    expect(s.canClaimReady).toBe(true);
    expect(s.failingAgents).toEqual([]);
    expect(s.unverifiableAgents).toEqual([]);
  });

  it("refuses ready when an in-use agent fails, even with a verified company default", () => {
    const bad = agentScope("a1", "needs_auth");
    const s = deriveCardStatus(row({ agents: [agentScope("a0", "verified"), bad] }));
    expect(s.canClaimReady).toBe(false);
    expect(s.failingAgents).toEqual([bad]);
  });

  it("treats unverifiable agents as UNCHECKED, not failures, but still blocks bare ready", () => {
    const u = agentScope("a1", "unverifiable");
    const s = deriveCardStatus(row({ agents: [u] }));
    expect(s.failingAgents).toEqual([]);
    expect(s.unverifiableAgents).toEqual([u]);
    expect(s.canClaimReady).toBe(false);
  });

  /*
    This test previously PINNED the bug: it asserted a never-probed agent counts
    as failing. Both halves of that are wrong in the same way — `unknown` means
    "we have not looked", and the card rendered it as "these agents can't run on
    this provider". Live driving a fresh company (all agents `unknown`, testedAt
    null) showed "Ready, 9 agents failing" as the founder's first ever view.

    The blocking half was right and is kept: ignorance still forbids a bare
    "Ready". Only the ACCUSATION is removed.
  */
  it("does NOT count an unknown agent as failing — never probed is not broken", () => {
    const s = deriveCardStatus(row({ agents: [agentScope("a1", "unknown")] }));
    expect(s.failingAgents).toHaveLength(0);
    expect(s.unverifiableAgents).toHaveLength(0);
    expect(s.uncheckedAgents).toHaveLength(1);
    // Ignorance still blocks the green claim.
    expect(s.canClaimReady).toBe(false);
  });

  it("keeps all three non-verified buckets disjoint", () => {
    const s = deriveCardStatus(
      row({
        agents: [
          agentScope("bad", "needs_auth"),
          agentScope("broken", "failed"),
          agentScope("custom", "unverifiable"),
          agentScope("new", "unknown"),
          agentScope("good", "verified"),
        ],
      }),
    );
    expect(s.failingAgents.map((a) => a.scopeId)).toEqual(["bad", "broken"]);
    expect(s.unverifiableAgents.map((a) => a.scopeId)).toEqual(["custom"]);
    expect(s.uncheckedAgents.map((a) => a.scopeId)).toEqual(["new"]);
  });

  it("refuses ready when the company default itself is not verified", () => {
    const s = deriveCardStatus(row({ companyDefault: scoped({ outcome: "not_installed" }) }));
    expect(s.outcome).toBe("not_installed");
    expect(s.canClaimReady).toBe(false);
  });
});
