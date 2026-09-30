import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import {
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  getProviderById,
  PROBE_OUTCOMES,
  type ProbeOutcome,
} from "@armyofagents/shared";
import { ApiError } from "../../../api/client";
import type { ProviderStatusRow, ScopedReadiness } from "../../../api/providers";
import {
  ProviderReadinessCard,
  outcomeLabel,
  outcomeTone,
  installHintFor,
  providerActionErrorCopy,
  detectPlatform,
  DEFAULT_INSTALL_PLATFORM,
} from "../ProviderReadinessCard";

/**
 * Fixtures are built from the REAL `PROVIDER_CATALOG` via `getProviderById`,
 * never from a hand-written `{ id, label }` cast. A previous task's cast erased
 * `credential` entirely, which hid a real bug for a full review cycle: every
 * assertion about key inputs and login affordances reads `descriptor.credential`,
 * so a fixture that omits it tests nothing.
 */
function descriptor(id: string) {
  const d = getProviderById(id);
  if (!d) throw new Error(`fixture error: no catalog entry for "${id}"`);
  return d;
}

function scope(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return {
    scopeType: "company_default",
    scopeId: null,
    outcome: "unknown",
    testedAt: null,
    checks: [],
    ...over,
  };
}

function agentScope(name: string, outcome: ProbeOutcome, id = name): ScopedReadiness {
  return {
    scopeType: "agent",
    scopeId: id,
    agentName: name,
    outcome,
    testedAt: "2026-07-20T10:00:00.000Z",
    checks: [],
  };
}

function row(id: string, over: Partial<ProviderStatusRow> = {}): ProviderStatusRow {
  const d = descriptor(id);
  return {
    descriptor: d,
    companyDefault: scope(),
    agents: [],
    existingKey: {
      configured: false,
      source: null,
      secretName: d.credential.apiKey?.secretName ?? null,
      envVar: d.credential.apiKey?.envVar ?? null,
    },
    ...over,
  };
}

const noop = () => {};
const noopSave = async () => {};

function renderCard(r: ProviderStatusRow, props: Record<string, unknown> = {}) {
  return render(
    <ProviderReadinessCard row={r} onTest={noop} onSaveKey={noopSave} {...props} />,
  );
}

const badge = () => screen.getByTestId("provider-status-badge");

/* ── status badge: exhaustive over all six outcomes ────────────────────── */

describe("ProviderReadinessCard — status badge", () => {
  const CANONICAL: Record<ProbeOutcome, string> = {
    verified: "Ready",
    needs_auth: "Needs sign-in",
    not_installed: "Not installed",
    failed: "Check failed",
    unknown: "Not verified",
    unverifiable: "Can't verify (custom command)",
  };

  it("covers every outcome in PROBE_OUTCOMES (no outcome may be untested)", () => {
    expect([...PROBE_OUTCOMES].sort()).toEqual(Object.keys(CANONICAL).sort());
  });

  for (const [outcome, label] of Object.entries(CANONICAL) as [ProbeOutcome, string][]) {
    it(`renders "${label}" for ${outcome}`, () => {
      renderCard(row("anthropic", { companyDefault: scope({ outcome }) }));
      expect(screen.getByText("Claude")).toBeTruthy();
      expect(badge().textContent).toBe(label);
      expect(outcomeLabel(outcome)).toBe(label);
    });
  }

  /*
    These assert the RENDERED class, and deliberately do NOT call `outcomeTone`
    first: a unit assertion placed above a render assertion short-circuits the
    test, so a tone regression would be caught only by the pure function while
    the actual badge went unchecked. The check is also POSITIVE (it must carry
    the muted/neutral treatment), not merely "not red" — an amber `warn` class
    contains neither "red" nor "destructive", so a neutral→warn mutation would
    survive a negative-only assertion.
  */
  it("unverifiable renders the NEUTRAL badge treatment — nothing is broken", () => {
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "unverifiable" }) }));
    expect(badge().className).toMatch(/text-muted-foreground/);
    expect(badge().className).not.toMatch(/red|destructive|amber|green/);
  });

  it("unknown renders the NEUTRAL badge treatment too — 'not verified yet' is not a failure", () => {
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "unknown" }) }));
    expect(badge().className).toMatch(/text-muted-foreground/);
    expect(badge().className).not.toMatch(/red|destructive|amber|green/);
  });

  it("failed renders the error treatment and needs_auth the warning one (rendered, not just derived)", () => {
    const { unmount } = renderCard(row("anthropic", { companyDefault: scope({ outcome: "failed" }) }));
    expect(badge().className).toMatch(/red/);
    unmount();
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "needs_auth" }) }));
    expect(badge().className).toMatch(/amber/);
  });

  it("outcomeTone maps every outcome (pure function, asserted separately)", () => {
    expect(outcomeTone("unverifiable")).toBe("neutral");
    expect(outcomeTone("unknown")).toBe("neutral");
  });

  it("failed / needs_auth / not_installed do carry a warning or error tone", () => {
    expect(outcomeTone("failed")).toBe("error");
    expect(outcomeTone("needs_auth")).toBe("warn");
    expect(outcomeTone("not_installed")).toBe("warn");
    expect(outcomeTone("verified")).toBe("ready");
  });

  it("renders 'checked …' only when testedAt is set", () => {
    const { unmount } = renderCard(row("anthropic", { companyDefault: scope({ outcome: "verified" }) }));
    expect(screen.queryByTestId("provider-checked-at")).toBeNull();
    unmount();

    renderCard(
      row("anthropic", {
        companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
      }),
    );
    expect(screen.getByTestId("provider-checked-at").textContent).toMatch(/checked/i);
  });
});

/* ── 409 error copy (login slot vs key-save conflict) ──────────────────── */

describe("providerActionErrorCopy — 409 disambiguation", () => {
  it("shows the server's login-slot message verbatim for a login 409", () => {
    const err = new ApiError("Another sign-in for Claude is already in progress on this machine.", 409, null);
    expect(providerActionErrorCopy(err)).toBe(
      "Another sign-in for Claude is already in progress on this machine.",
    );
  });

  it("preserves the key-save message for a NON-login 409 (never the login remedy)", () => {
    const err = new ApiError("This provider key was just saved by another request.", 409, null);
    expect(providerActionErrorCopy(err)).toBe("This provider key was just saved by another request.");
    expect(providerActionErrorCopy(err)).not.toMatch(/signing in|sign-in/i);
  });

  it("falls back to a friendly line when the 409 body is a bare 'Conflict'", () => {
    const err = new ApiError("Conflict", 409, null);
    expect(providerActionErrorCopy(err)).toMatch(/busy with another request/i);
    expect(providerActionErrorCopy(err)).not.toMatch(/\bconflict\b|\b409\b/i);
  });
});

/* ── the false-green gate ──────────────────────────────────────────────── */

describe("ProviderReadinessCard — canClaimReady gate", () => {
  it("a verified company default with a FAILING agent does NOT render a plain 'Ready'", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
        agents: [agentScope("Scout", "needs_auth")],
      }),
    );
    // The exact string "Ready" alone would be the false-green this feature exists
    // to remove: the tab would read green while Scout's own binding 401s.
    expect(badge().textContent).not.toBe("Ready");
    expect(badge().textContent).toMatch(/agent/i);
  });

  it("a verified company default with an UNVERIFIABLE agent also does not claim bare Ready", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
        agents: [agentScope("Custom", "unverifiable")],
      }),
    );
    expect(badge().textContent).not.toBe("Ready");
  });

  it("a verified company default with all agents verified DOES claim Ready", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
        agents: [agentScope("Scout", "verified")],
      }),
    );
    expect(badge().textContent).toBe("Ready");
  });
});

/* ── failing vs unverifiable agents are DIFFERENT lists ────────────────── */

describe("ProviderReadinessCard — agent breakdown", () => {
  const mixed = row("anthropic", {
    companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
    agents: [agentScope("Scout", "needs_auth"), agentScope("Custom", "unverifiable")],
  });

  it("lists unverifiable agents SEPARATELY from failing agents", () => {
    renderCard(mixed);
    const failing = screen.getByTestId("provider-failing-agents");
    const unverifiable = screen.getByTestId("provider-unverifiable-agents");
    expect(within(failing).getByText(/Scout/)).toBeTruthy();
    expect(within(failing).queryByText(/Custom/)).toBeNull();
    expect(within(unverifiable).getByText(/Custom/)).toBeTruthy();
    expect(within(unverifiable).queryByText(/Scout/)).toBeNull();
  });

  it("labels the unverifiable list with neutral 'can't be checked' copy", () => {
    renderCard(mixed);
    expect(screen.getByTestId("provider-unverifiable-agents").textContent).toMatch(
      /can't be checked \(custom command\)/i,
    );
  });

  it("NEVER calls an unprobed agent 'waived' — a waiver is a recorded human decision", () => {
    const { container } = renderCard(mixed);
    expect(container.textContent ?? "").not.toMatch(/waive/i);
  });

  it("renders no agent list at all when there are no agents", () => {
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "verified" }) }));
    expect(screen.queryByTestId("provider-failing-agents")).toBeNull();
    expect(screen.queryByTestId("provider-unverifiable-agents")).toBeNull();
    expect(screen.queryByTestId("provider-unchecked-agents")).toBeNull();
  });

  /*
    THE FRESH-COMPANY STATE. Live driving a brand-new company found this card
    announcing "Ready, 9 agents failing" over "These agents can't run on this
    provider" for nine agents that had simply never been probed. Every agent of
    a new company starts `unknown` with a null testedAt, so this is the FIRST
    thing a founder ever sees on this tab — and it was a false red.
  */
  describe("never-probed agents (the default state of a fresh company)", () => {
    const fresh = row("anthropic", {
      companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
      agents: [
        { ...agentScope("Navigator", "unknown"), testedAt: null },
        { ...agentScope("Planner", "unknown"), testedAt: null },
      ],
    });

    it("does NOT call never-probed agents failing", () => {
      renderCard(fresh);
      expect(badge().textContent).not.toMatch(/failing/i);
      expect(screen.queryByTestId("provider-failing-agents")).toBeNull();
    });

    it("does NOT claim never-probed agents can't run", () => {
      const { container } = renderCard(fresh);
      expect(container.textContent ?? "").not.toMatch(/can't run on this provider/i);
    });

    it("lists them under a NOT-CHECKED heading, in a neutral block", () => {
      renderCard(fresh);
      const block = screen.getByTestId("provider-unchecked-agents");
      expect(block.textContent).toMatch(/not checked yet/i);
      expect(within(block).getByText(/Navigator/)).toBeTruthy();
      expect(within(block).getByText(/Planner/)).toBeTruthy();
      expect(block.className).toMatch(/text-muted-foreground/);
      expect(block.className).not.toMatch(/red|destructive|amber/);
    });

    it("shows a working provider as READY (green) with the caveat in the label", () => {
      // The company key is verified and nothing is failing, so the dot reads
      // green; the label still carries "N not checked yet" so it is never a bare
      // "Ready". A failing agent (tested elsewhere) still forces amber, so this
      // green never hides a broken agent.
      renderCard(fresh);
      expect(badge().textContent).toMatch(/2 agents not checked yet/);
      expect(badge().className).toMatch(/green/);
      expect(badge().className).not.toMatch(/red|destructive|amber/);
    });

    it("keeps unknown separate from a genuinely failing agent on the same card", () => {
      renderCard(
        row("anthropic", {
          companyDefault: scope({ outcome: "verified" }),
          agents: [agentScope("Scout", "needs_auth"), agentScope("Navigator", "unknown")],
        }),
      );
      const failing = screen.getByTestId("provider-failing-agents");
      expect(within(failing).getByText(/Scout/)).toBeTruthy();
      expect(within(failing).queryByText(/Navigator/)).toBeNull();
      expect(
        within(screen.getByTestId("provider-unchecked-agents")).getByText(/Navigator/),
      ).toBeTruthy();
      // Failure dominates the pill; the unchecked one is listed, not counted.
      expect(badge().textContent).toMatch(/1 agent failing/);
    });
  });
});

/* ── key input: borrowers get a LINK, never a second input ─────────────── */

describe("ProviderReadinessCard — key input state", () => {
  it("shows an 'Add' key input for a provider that owns its credential (Claude)", () => {
    renderCard(row("anthropic"));
    const input = screen.getByTestId("provider-key-input") as HTMLInputElement;
    expect(input.placeholder).toBe("sk-ant-…");
    expect(input.type).toBe("password");
  });

  it("shows a REPLACE affordance when a key already exists", () => {
    renderCard(
      row("anthropic", {
        existingKey: {
          configured: true,
          source: "provider",
          secretName: "provider:anthropic",
          envVar: "ANTHROPIC_API_KEY",
        },
      }),
    );
    expect(screen.getByTestId("provider-key-section").textContent).toMatch(/replace/i);
  });

  it("Pi BORROWS Claude's credential → link to Claude's card, and NO key input", () => {
    // provider:anthropic is where a stored key overrides Claude's subscription
    // auth. A second input on Pi's card would silently repoint Claude.
    renderCard(row("pi"));
    expect(screen.queryByTestId("provider-key-input")).toBeNull();
    expect(screen.getByTestId("provider-key-owned-elsewhere").textContent).toMatch(
      /managed on the claude card/i,
    );
  });

  it("Cursor Cloud BORROWS Cursor's credential → link, no input", () => {
    renderCard(row("cursor_cloud"));
    expect(screen.queryByTestId("provider-key-input")).toBeNull();
    expect(screen.getByTestId("provider-key-owned-elsewhere").textContent).toMatch(
      /managed on the cursor card/i,
    );
  });

  it("OpenCode takes no key at all → no key section", () => {
    renderCard(row("opencode"));
    expect(screen.queryByTestId("provider-key-input")).toBeNull();
    expect(screen.queryByTestId("provider-key-section")).toBeNull();
  });

  it("calls onSaveKey with the typed value", async () => {
    const onSaveKey = vi.fn(async () => {});
    renderCard(row("anthropic"), { onSaveKey });
    fireEvent.change(screen.getByTestId("provider-key-input"), { target: { value: "sk-ant-xyz" } });
    fireEvent.click(screen.getByTestId("provider-key-save"));
    expect(onSaveKey).toHaveBeenCalledWith("sk-ant-xyz");
  });

  it("labels the key's scope as per-company (D5)", () => {
    renderCard(row("anthropic"));
    expect(screen.getByTestId("provider-key-section").textContent).toMatch(
      /applies to this company only/i,
    );
  });
});

/* ── login affordance ──────────────────────────────────────────────────── */

describe("ProviderReadinessCard — login affordance", () => {
  it("Codex self-completes → renders a Sign in button and calls onStartLogin", () => {
    expect(descriptor("openai").credential.selfCompletingLogin).toBe(true);
    const onStartLogin = vi.fn();
    renderCard(row("openai", { companyDefault: scope({ outcome: "needs_auth" }) }), {
      onStartLogin,
    });
    fireEvent.click(screen.getByTestId("provider-signin"));
    expect(onStartLogin).toHaveBeenCalled();
  });

  it("Claude does NOT self-complete → NO Sign in button, manual command shown instead", () => {
    // `claude auth login` blocks on a paste-code stdin prompt; an in-app button
    // there is a dead button (the server also 400s — defence in depth).
    expect(descriptor("anthropic").credential.selfCompletingLogin).toBe(false);
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "needs_auth" }) }), {
      onStartLogin: vi.fn(),
    });
    expect(screen.queryByTestId("provider-signin")).toBeNull();
    expect(screen.getByTestId("provider-manual-login").textContent).toContain("claude auth login");
  });

  it("describes the sign-in SCOPE as host-shared without claiming you are signed in", () => {
    renderCard(row("openai", { companyDefault: scope({ outcome: "needs_auth" }) }), {
      onStartLogin: vi.fn(),
    });
    const text = screen.getByTestId("provider-login-section").textContent ?? "";
    expect(text).toMatch(/applies to this whole machine/i);
    expect(text).toMatch(/every company on this host/i);
    // The bug this replaces: a present-tense claim of being signed in, rendered
    // under a badge that says you are not, next to a button asking you to sign in.
    expect(text).not.toMatch(/signed in on this machine/i);
  });

  it("omits the Sign in button when no onStartLogin handler is supplied", () => {
    renderCard(row("openai", { companyDefault: scope({ outcome: "needs_auth" }) }));
    expect(screen.queryByTestId("provider-signin")).toBeNull();
  });
});

/* ── install hint ──────────────────────────────────────────────────────── */

describe("ProviderReadinessCard — install hint", () => {
  it("shows the OS-specific hint when not_installed", () => {
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "not_installed" }) }), {
      platform: "win",
    });
    expect(screen.getByTestId("provider-install-hint").textContent).toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
  });

  it("picks per-OS AND classifies command vs docs prose", () => {
    const hint = descriptor("cursor").installHint!;
    // Windows is PROSE pointing at docs, not something you can paste.
    expect(installHintFor(hint, "win")).toMatchObject({ kind: "docs" });
    expect(installHintFor(hint, "win")!.text).toMatch(/docs for Windows/i);
    expect(installHintFor(hint, "mac")).toMatchObject({ kind: "command" });
    expect(installHintFor(hint, "mac")!.text).toMatch(/cursor\.com\/install/);
    expect(installHintFor(hint, "linux")).toMatchObject({ kind: "command" });
  });

  it("renders a docs-prose hint as prose + link, NEVER as a pasteable command", () => {
    // The bug this replaces: `See the OpenCode docs for Windows install.` was
    // rendered in a <code> block under "Install it, then run the check again:".
    renderCard(row("opencode", { companyDefault: scope({ outcome: "not_installed" }) }), {
      platform: "win",
    });
    const block = screen.getByTestId("provider-install-hint");
    expect(screen.getByTestId("provider-install-docs").textContent).toMatch(/docs for Windows/i);
    expect(screen.queryByTestId("provider-install-command")).toBeNull();
    expect(block.textContent).not.toMatch(/run the check again/i);
    expect(within(block).getByRole("link").getAttribute("href")).toBe("https://opencode.ai/docs");
  });

  it("renders a runnable hint as a copyable command", () => {
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "not_installed" }) }), {
      platform: "mac",
    });
    expect(screen.getByTestId("provider-install-command").textContent).toContain(
      "npm install -g @anthropic-ai/claude-code",
    );
    expect(screen.queryByTestId("provider-install-docs")).toBeNull();
  });

  it("every Grok platform is docs prose (all three), so none renders as a command", () => {
    const hint = descriptor("grok").installHint!;
    for (const p of ["mac", "win", "linux"] as const) {
      expect(installHintFor(hint, p)).toMatchObject({ kind: "docs" });
    }
  });

  it("surfaces docsUrl when the hint points at docs", () => {
    renderCard(row("grok", { companyDefault: scope({ outcome: "not_installed" }) }), {
      platform: "linux",
    });
    const link = within(screen.getByTestId("provider-install-hint")).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://docs.x.ai");
  });

  it("renders no hint for a managed runtime that has none (Cursor Cloud)", () => {
    expect(descriptor("cursor_cloud").installHint).toBeUndefined();
    renderCard(row("cursor_cloud", { companyDefault: scope({ outcome: "not_installed" }) }));
    expect(screen.queryByTestId("provider-install-hint")).toBeNull();
    expect(installHintFor(undefined, "mac")).toBeNull();
  });

  it("hides the install hint when the provider is not reporting not_installed", () => {
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "verified" }) }), {
      platform: "mac",
    });
    expect(screen.queryByTestId("provider-install-hint")).toBeNull();
  });
});

/* ── test action + error copy ──────────────────────────────────────────── */

describe("ProviderReadinessCard — actions and errors", () => {
  it("calls onTest when Test is pressed", () => {
    const onTest = vi.fn();
    renderCard(row("anthropic"), { onTest });
    fireEvent.click(screen.getByTestId("provider-test"));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  it("disables the actions while busy", () => {
    renderCard(row("anthropic"), { busy: true });
    expect((screen.getByTestId("provider-test") as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a 429 using the SHARED retry constant, never a hardcoded 30", async () => {
    const { ADAPTER_PROBE_RETRY_AFTER_SECONDS, ADAPTER_PROBE_BUSY_ERROR } = await import(
      "@armyofagents/shared"
    );
    const copy = providerActionErrorCopy(new ApiError("busy", 429, {}));
    expect(copy).toContain(ADAPTER_PROBE_BUSY_ERROR);
    expect(copy).toContain(String(ADAPTER_PROBE_RETRY_AFTER_SECONDS));
    renderCard(row("anthropic"), { error: new ApiError("busy", 429, {}) });
    expect(screen.getByTestId("provider-error").textContent).toContain(ADAPTER_PROBE_BUSY_ERROR);
  });

  it("renders a bare 409 as readable copy, never a raw error", () => {
    renderCard(row("openai"), { error: new ApiError("Conflict", 409, {}) });
    const text = screen.getByTestId("provider-error").textContent ?? "";
    // A bare "Conflict" body has no actionable message, so we show a friendly
    // generic line — never the raw status/word.
    expect(text).toMatch(/busy with another request/i);
    expect(text).not.toMatch(/\b409\b|Conflict/);
  });

  it("renders a descriptive 409 (key-save conflict) verbatim, not the login remedy", () => {
    renderCard(row("openai"), {
      error: new ApiError("This provider key was just saved by another request.", 409, {}),
    });
    const text = screen.getByTestId("provider-error").textContent ?? "";
    expect(text).toContain("This provider key was just saved by another request.");
    expect(text).not.toMatch(/signing in|sign-in/i);
  });

  /*
    The 400 body carries `canLogin: false` + `manualCommand`. It must be NARROWED
    via `loginUnavailableFrom`, not cast: the same 400 status is also used for
    ordinary validation failures, and a cast would print a manual command that
    isn't there. Nothing covered this path before.
  */
  it("renders a 400 'cannot self-complete' body with its manual command", () => {
    renderCard(row("anthropic"), {
      error: new ApiError("Bad Request", 400, {
        error: "This provider's login cannot complete in-app.",
        canLogin: false,
        manualCommand: "claude auth login",
      }),
    });
    const text = screen.getByTestId("provider-error").textContent ?? "";
    expect(text).toContain("This provider's login cannot complete in-app.");
    expect(text).toContain("claude auth login");
    expect(text).not.toMatch(/\b400\b|Bad Request/);
  });

  it("does NOT treat an unrelated 400 as a login-unavailable body", () => {
    // `canLogin` absent → loginUnavailableFrom returns null → fall through to the
    // plain message rather than inventing a manual command.
    const copy = providerActionErrorCopy(new ApiError("Key was rejected.", 400, { error: "nope" }));
    expect(copy).toBe("Key was rejected.");
  });

  it("passes a plain string error through unchanged", () => {
    renderCard(row("anthropic"), { error: "Could not save the key." });
    expect(screen.getByTestId("provider-error").textContent).toBe("Could not save the key.");
  });

  it("renders nothing for a null error", () => {
    renderCard(row("anthropic"), { error: null });
    expect(screen.queryByTestId("provider-error")).toBeNull();
    expect(providerActionErrorCopy(null)).toBeNull();
  });

  it("styles transient contention (429/409) as NOT destructive", () => {
    // Back-off and a held host slot are the system working under contention, not
    // breakage. Red here is the same cry-wolf failure as red `unverifiable`.
    const { unmount } = renderCard(row("anthropic"), { error: new ApiError("busy", 429, {}) });
    expect(screen.getByTestId("provider-error").className).not.toMatch(/destructive/);
    unmount();
    renderCard(row("openai"), { error: new ApiError("Conflict", 409, {}) });
    expect(screen.getByTestId("provider-error").className).not.toMatch(/destructive/);
  });

  it("styles a real failure as destructive", () => {
    renderCard(row("anthropic"), { error: new Error("Key was rejected.") });
    expect(screen.getByTestId("provider-error").className).toMatch(/destructive/);
  });

  it("marks the error as a live region so a screen reader hears it", () => {
    renderCard(row("anthropic"), { error: new Error("Key was rejected.") });
    expect(screen.getByTestId("provider-error").getAttribute("role")).toBe("alert");
  });

  it("marks the status badge as a live region — it swaps in place on Test", () => {
    renderCard(row("anthropic"));
    const b = badge();
    expect(b.getAttribute("role")).toBe("status");
    expect(b.getAttribute("aria-live")).toBe("polite");
  });
});

/* ── composite badges + per-action busy (the cry-wolf surfaces) ─────────── */

describe("ProviderReadinessCard — composite badge tones", () => {
  const withFailing = row("anthropic", {
    companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
    agents: [agentScope("Scout", "needs_auth")],
  });
  const withUnverifiable = row("anthropic", {
    companyDefault: scope({ outcome: "verified", testedAt: "2026-07-20T10:00:00.000Z" }),
    agents: [agentScope("Custom", "unverifiable")],
  });

  it("'Ready, N failing' carries the WARNING tone, never neutral", () => {
    renderCard(withFailing);
    expect(badge().textContent).toMatch(/1 agent failing/);
    expect(badge().className).toMatch(/amber/);
    expect(badge().className).not.toMatch(/text-muted-foreground/);
  });

  it("'Ready, N can't be checked' stays NEUTRAL — an unprobed custom command is not a fault", () => {
    renderCard(withUnverifiable);
    expect(badge().textContent).toMatch(/1 agent can't be checked/);
    expect(badge().className).toMatch(/text-muted-foreground/);
    expect(badge().className).not.toMatch(/red|destructive|amber/);
  });

  it("the unverifiable agent LIST block is neutral, not an error block", () => {
    renderCard(withUnverifiable);
    const block = screen.getByTestId("provider-unverifiable-agents");
    expect(block.className).toMatch(/text-muted-foreground/);
    expect(block.className).not.toMatch(/red|destructive|amber/);
  });

  it("the failing agent LIST block does carry a warning treatment", () => {
    renderCard(withFailing);
    expect(screen.getByTestId("provider-failing-agents").className).toMatch(/amber/);
  });

  it("failure dominates the badge when both kinds are present", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({ outcome: "verified" }),
        agents: [agentScope("Scout", "failed"), agentScope("Custom", "unverifiable")],
      }),
    );
    expect(badge().textContent).toMatch(/1 agent failing/);
    expect(badge().className).toMatch(/amber/);
    // ...but the unverifiable one is still fully listed, not hidden.
    expect(screen.getByTestId("provider-unverifiable-agents").textContent).toMatch(/Custom/);
  });

  it("unverifiable outranks merely-unchecked in the badge", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({ outcome: "verified" }),
        agents: [agentScope("Custom", "unverifiable"), agentScope("Navigator", "unknown")],
      }),
    );
    // A command we can NEVER probe is a durable property of the setup; "not
    // looked yet" is the weakest of the three and resolves on its own.
    expect(badge().textContent).toMatch(/1 agent can't be checked/);
    expect(badge().className).toMatch(/text-muted-foreground/);
    expect(screen.getByTestId("provider-unchecked-agents").textContent).toMatch(/Navigator/);
  });
});

describe("ProviderReadinessCard — per-action busy", () => {
  it("busy disables Save key", () => {
    renderCard(row("anthropic"), { busy: true });
    fireEvent.change(screen.getByTestId("provider-key-input"), { target: { value: "sk-ant-x" } });
    expect((screen.getByTestId("provider-key-save") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("provider-key-input") as HTMLInputElement).disabled).toBe(true);
  });

  it("busy disables Sign in", () => {
    renderCard(row("openai", { companyDefault: scope({ outcome: "needs_auth" }) }), {
      busy: true,
      onStartLogin: vi.fn(),
    });
    expect((screen.getByTestId("provider-signin") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a Test in flight does NOT disable the key input (per-action, not global)", () => {
    renderCard(row("anthropic"), { busy: { test: true } });
    expect((screen.getByTestId("provider-test") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("provider-key-input") as HTMLInputElement).disabled).toBe(false);
  });
});

/* ── save lifecycle ────────────────────────────────────────────────────── */

describe("ProviderReadinessCard — save lifecycle", () => {
  it("clears the draft on success so the live secret does not linger", async () => {
    renderCard(row("anthropic"), { onSaveKey: async () => {} });
    const input = screen.getByTestId("provider-key-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-xyz" } });
    fireEvent.click(screen.getByTestId("provider-key-save"));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("surfaces a save rejection instead of dropping it as an unhandled rejection", async () => {
    renderCard(row("anthropic"), {
      onSaveKey: async () => {
        throw new Error("Key was rejected.");
      },
    });
    const input = screen.getByTestId("provider-key-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-ant-bad" } });
    fireEvent.click(screen.getByTestId("provider-key-save"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-error").textContent).toBe("Key was rejected."),
    );
    // Draft is retained on failure — retyping a rejected secret is pure friction.
    expect(input.value).toBe("sk-ant-bad");
  });

  it("renders a 429 save rejection with the shared retry copy", async () => {
    renderCard(row("anthropic"), {
      onSaveKey: async () => {
        throw new ApiError("busy", 429, {});
      },
    });
    fireEvent.change(screen.getByTestId("provider-key-input"), { target: { value: "sk-ant-x" } });
    fireEvent.click(screen.getByTestId("provider-key-save"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-error").textContent).toContain(
        String(ADAPTER_PROBE_RETRY_AFTER_SECONDS),
      ),
    );
  });
});

/* ── borrower navigation ───────────────────────────────────────────────── */

describe("ProviderReadinessCard — borrower link", () => {
  it("renders a REAL control that fires onOpenProvider with the owner id", () => {
    const onOpenProvider = vi.fn();
    renderCard(row("pi"), { onOpenProvider });
    fireEvent.click(screen.getByTestId("provider-key-owner-link"));
    expect(onOpenProvider).toHaveBeenCalledWith("anthropic");
  });

  it("Cursor Cloud's control points at cursor", () => {
    const onOpenProvider = vi.fn();
    renderCard(row("cursor_cloud"), { onOpenProvider });
    fireEvent.click(screen.getByTestId("provider-key-owner-link"));
    expect(onOpenProvider).toHaveBeenCalledWith("cursor");
  });

  it("renders no dead arrow when the surface cannot navigate", () => {
    renderCard(row("pi"));
    expect(screen.queryByTestId("provider-key-owner-link")).toBeNull();
    const text = screen.getByTestId("provider-key-owned-elsewhere").textContent ?? "";
    expect(text).toMatch(/managed on the claude card/i);
    // No "→" affordance promising a click that nothing handles.
    expect(text).not.toContain("→");
  });
});

/* ── remediation is never absent ───────────────────────────────────────── */

describe("ProviderReadinessCard — remediation always present", () => {
  it("needs_auth Codex with NO onStartLogin still offers the terminal command", () => {
    // The agent-config badge passes no handler. Previously this rendered a
    // "Needs sign-in" card with no login section at all — a dead end.
    renderCard(row("openai", { companyDefault: scope({ outcome: "needs_auth" }) }));
    expect(screen.queryByTestId("provider-signin")).toBeNull();
    expect(screen.getByTestId("provider-manual-login").textContent).toContain("codex login");
  });

  it("hides the login section entirely on a verified card", () => {
    // A green Claude card must not tell the founder to sign in and re-check.
    renderCard(row("anthropic", { companyDefault: scope({ outcome: "verified" }) }));
    expect(screen.queryByTestId("provider-login-section")).toBeNull();
  });

  it("shows and copies Codex device-login details while a challenge is pending", async () => {
    const onCancelLogin = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderCard(row("openai", { companyDefault: scope({ outcome: "needs_auth" }) }), {
      onStartLogin: vi.fn(),
      onCancelLogin,
      login: {
        status: "pending",
        loginUrl: "https://auth.openai.com/x",
        mode: "device_code",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-07-20T00:05:00.000Z",
      },
    });
    expect((screen.getByTestId("provider-signin") as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(screen.getByTestId("provider-login-progress")).getByRole("link").getAttribute("href"),
    ).toBe("https://auth.openai.com/x");
    expect(screen.getByLabelText("Codex device code").textContent).toBe("ABCD-EFGH");
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(screen.getByTestId("provider-login-expiry").textContent).toMatch(/^Expires /);
    fireEvent.click(screen.getByTestId("provider-login-cancel"));
    expect(onCancelLogin).toHaveBeenCalled();
  });
});

/* ── probe reasons ─────────────────────────────────────────────────────── */

describe("ProviderReadinessCard — checks", () => {
  it("renders the probe's reasons, not just the verdict", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({
          outcome: "failed",
          testedAt: "2026-07-20T10:00:00.000Z",
          checks: [
            { code: "cli_missing", level: "error", message: "claude not found on PATH" },
            { code: "ver", level: "info", message: "probe ran", hint: "try `claude --version`" },
          ],
        }),
      }),
    );
    const items = screen.getAllByTestId("provider-check");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("claude not found on PATH");
    expect(items[1].textContent).toContain("try `claude --version`");
  });

  it("styles check levels distinctly and exhaustively", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({
          outcome: "failed",
          checks: [
            { code: "a", level: "error", message: "boom" },
            { code: "b", level: "warn", message: "hmm" },
            { code: "c", level: "info", message: "fyi" },
          ],
        }),
      }),
    );
    const items = screen.getAllByTestId("provider-check");
    expect(items[0].innerHTML).toMatch(/red/);
    expect(items[1].innerHTML).toMatch(/amber/);
    expect(items[2].innerHTML).toMatch(/text-muted-foreground/);
  });

  it("suppresses per-check noise on a cleanly verified card", () => {
    renderCard(
      row("anthropic", {
        companyDefault: scope({
          outcome: "verified",
          checks: [{ code: "ok", level: "info", message: "all good" }],
        }),
      }),
    );
    expect(screen.queryByTestId("provider-checks")).toBeNull();
  });
});

/* ── robustness ────────────────────────────────────────────────────────── */

describe("ProviderReadinessCard — unrecognised outcome", () => {
  it("degrades an unknown stored verdict to neutral 'Not verified' instead of throwing", () => {
    // `outcome` is unvalidated at both ends: drizzle emits no CHECK constraint and
    // the route casts the stored string. One stale row must not white-screen the tab.
    const bogus = "banana" as ProbeOutcome;
    expect(() =>
      renderCard(row("anthropic", { companyDefault: scope({ outcome: bogus }) })),
    ).not.toThrow();
    expect(badge().textContent).toBe("Not verified");
    expect(badge().className).toMatch(/text-muted-foreground/);
  });
});

describe("ProviderReadinessCard — platform default", () => {
  it("falls back to the DECLARED default when navigator reports nothing (jsdom)", () => {
    // jsdom's navigator.platform is "", so tests omitting `platform` exercise this.
    expect(detectPlatform()).toBe(DEFAULT_INSTALL_PLATFORM);
    expect(DEFAULT_INSTALL_PLATFORM).toBe("linux");
  });
});
