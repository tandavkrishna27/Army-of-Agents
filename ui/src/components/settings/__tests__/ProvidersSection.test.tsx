/**
 * Settings -> Providers tab.
 *
 * Fixtures are built from the REAL `PROVIDER_CATALOG` via `getProviderById`,
 * never a hand-written `{ id, label }` cast — a previous task shipped a bug
 * precisely because its fixture erased `descriptor.credential`, which is the
 * field every login/key affordance reads.
 *
 * Only `providersApi` is mocked. The pure helpers (`keyInputState`,
 * `deriveCardStatus`, `loginUnavailableFrom`, …) stay REAL, because the card
 * imports them from the same module and stubbing them would make these tests
 * assert against a fake card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ADAPTER_PROBE_RETRY_AFTER_SECONDS,
  PROVIDER_READINESS_STALE_MS,
  getProviderById,
} from "@armyofagents/shared";
import { ApiError } from "@/api/client";
import type {
  ProviderStatusRow,
  ScopedReadiness,
  ProbeResult,
  LoginStatusResult,
} from "@/api/providers";
import { SETTINGS_SECTIONS } from "../SettingsLayout";
import { VALID_SECTIONS } from "@/pages/SettingsPage";
import { ProvidersSection, LOGIN_POLL_INTERVAL_MS } from "../sections/ProvidersSection";

/* ── mocks ─────────────────────────────────────────────────────────────── */

const listMock = vi.fn();
const testMock = vi.fn();
const saveKeyMock = vi.fn();
const startLoginMock = vi.fn();
const loginStatusMock = vi.fn();
const cancelLoginMock = vi.fn();

vi.mock("@/api/providers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/providers")>();
  return {
    ...actual,
    providersApi: {
      list: (...a: unknown[]) => listMock(...a),
      test: (...a: unknown[]) => testMock(...a),
      saveKey: (...a: unknown[]) => saveKeyMock(...a),
      startLogin: (...a: unknown[]) => startLoginMock(...a),
      loginStatus: (...a: unknown[]) => loginStatusMock(...a),
      cancelLogin: (...a: unknown[]) => cancelLoginMock(...a),
    },
  };
});

const COMPANY_ID = "company-1";
const useCompanyMock = vi.fn(() => ({ selectedCompanyId: COMPANY_ID as string | null }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => useCompanyMock(),
}));

/* ── fixtures ──────────────────────────────────────────────────────────── */

function descriptor(id: string) {
  const d = getProviderById(id);
  if (!d) throw new Error(`fixture error: no catalog entry for "${id}"`);
  return d;
}

const FRESH = new Date(Date.now() - 1000).toISOString();
const STALE = new Date(Date.now() - PROVIDER_READINESS_STALE_MS - 60_000).toISOString();

function scope(over: Partial<ScopedReadiness> = {}): ScopedReadiness {
  return {
    scopeType: "company_default",
    scopeId: null,
    outcome: "verified",
    testedAt: FRESH,
    checks: [],
    ...over,
  };
}

function agentScope(name: string): ScopedReadiness {
  return {
    scopeType: "agent",
    scopeId: name,
    agentName: name,
    outcome: "verified",
    testedAt: FRESH,
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

/**
 * A card only offers Sign in when it is NOT already verified — the card
 * deliberately refuses to tell a founder to fix something that works. So every
 * login test needs a row in a state where sign-in is the remedy.
 */
function needsAuthRow(id: string): ProviderStatusRow {
  return row(id, { companyDefault: scope({ outcome: "needs_auth" }) });
}

const PROBE_OK: ProbeResult = {
  outcome: "verified",
  checks: [],
  testedAt: new Date().toISOString(),
};

function loginStatus(over: Partial<LoginStatusResult> = {}): LoginStatusResult {
  return { status: "pending", loginUrl: "https://example.test/login", readiness: null, ...over };
}

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProvidersSection />
    </QueryClientProvider>,
  );
}

/** Wait for the first cached render. */
async function renderAndSettle(rows: ProviderStatusRow[]) {
  listMock.mockResolvedValue({ providers: rows });
  const utils = renderSection();
  await screen.findAllByTestId("provider-list-item");
  return utils;
}

/** Click a provider in the left rail and wait for its detail card. */
async function select(providerId: string) {
  const target = screen
    .getAllByTestId("provider-list-item")
    .find((el) => el.getAttribute("data-provider") === providerId);
  if (!target) throw new Error(`no list item for ${providerId}`);
  fireEvent.click(target);
  await screen.findByTestId("provider-card");
}

beforeEach(() => {
  vi.clearAllMocks();
  useCompanyMock.mockReturnValue({ selectedCompanyId: COMPANY_ID });
  testMock.mockResolvedValue(PROBE_OK);
  saveKeyMock.mockResolvedValue({ ok: true, secretId: "s1", reprobed: [], invalidated: [] });
  cancelLoginMock.mockResolvedValue({ ok: true });
  // jsdom implements neither.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ── tab registration ──────────────────────────────────────────────────── */

describe("Settings -> Providers registration", () => {
  it("registers a Providers entry in the Operations group", () => {
    const ops = SETTINGS_SECTIONS.find((g) => g.group === "Operations");
    expect(ops).toBeTruthy();
    expect(ops?.items.map((i) => i.id)).toContain("providers");
  });

  it("accepts every registered section id as a ?tab= value", () => {
    // A section rendered in the nav but missing from VALID_SECTIONS silently
    // falls back to General — a dead nav item with no type error to catch it.
    for (const group of SETTINGS_SECTIONS) {
      for (const item of group.items) {
        expect(VALID_SECTIONS).toContain(item.id);
      }
    }
  });
});

/* ── cached-first rendering (D3) ───────────────────────────────────────── */

describe("ProvidersSection cached rendering", () => {
  it("renders one list item per provider and shows the selected provider's card", async () => {
    await renderAndSettle([row("anthropic"), row("openai"), row("opencode")]);
    expect(screen.getAllByTestId("provider-list-item")).toHaveLength(3);
    // Exactly one detail card is shown (the default selection), never eight.
    expect(screen.getAllByTestId("provider-card")).toHaveLength(1);
    // Labels are in the rail.
    const rail = screen.getByTestId("provider-list");
    expect(rail.textContent).toMatch(/Claude/);
    expect(rail.textContent).toMatch(/Codex/);
  });

  it("clears the key draft when switching providers (no cross-provider credential leak)", async () => {
    // Paste a key for one provider, switch to another BEFORE saving. The card is
    // keyed by provider id, so it remounts and the draft is gone — Save can never
    // send the first provider's key to the second one.
    await renderAndSettle([row("anthropic"), row("openai")]);
    await select("anthropic");
    fireEvent.change(screen.getByTestId("provider-key-input"), {
      target: { value: "sk-ant-should-not-leak" },
    });
    expect((screen.getByTestId("provider-key-input") as HTMLInputElement).value).toBe(
      "sk-ant-should-not-leak",
    );
    await select("openai");
    expect((screen.getByTestId("provider-key-input") as HTMLInputElement).value).toBe("");
  });

  it("refetches the list even when a Test FAILS (stale Ready must not persist)", async () => {
    // A probe that fails during config resolution still records a fresh `failed`
    // row server-side, so the card must refetch on the failure path too.
    await renderAndSettle([row("anthropic")]);
    await select("anthropic");
    const before = listMock.mock.calls.length;
    testMock.mockRejectedValueOnce(new Error("resolution failed"));
    fireEvent.click(screen.getByTestId("provider-test"));
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(before));
  });

  it("does NOT probe on load — every probe spawns a real CLI", async () => {
    await renderAndSettle([
      row("anthropic", { companyDefault: scope({ testedAt: STALE }) }),
      row("openai"),
      row("opencode", { companyDefault: scope({ testedAt: null, outcome: "unknown" }) }),
    ]);
    // Flush any effect-scheduled work before asserting the negative.
    await act(async () => {
      await Promise.resolve();
    });
    expect(testMock).not.toHaveBeenCalled();
  });

  it("auto-refreshes only providers that are BOTH in use and stale", async () => {
    await renderAndSettle([
      // in use + stale -> refresh
      row("anthropic", {
        companyDefault: scope({ testedAt: STALE }),
        agents: [agentScope("Scout")],
      }),
      // in use + fresh -> leave alone
      row("openai", { companyDefault: scope({ testedAt: FRESH }), agents: [agentScope("Ada")] }),
      // stale but nobody uses it -> leave alone
      row("google", { companyDefault: scope({ testedAt: STALE }) }),
    ]);

    await waitFor(() => expect(testMock).toHaveBeenCalledTimes(1));
    expect(testMock.mock.calls[0]?.[1]).toBe("anthropic");
    // And it never grows: the refreshed set must not re-fire on the refetch its
    // own invalidation triggers.
    await act(async () => {
      await Promise.resolve();
    });
    expect(testMock).toHaveBeenCalledTimes(1);
  });

  /*
    THE FRESH-COMPANY FIRST LOAD, end to end through the page.

    Reproduces what live driving actually produced: a new company whose crew
    agents are seeded but never probed, so `GET /providers` returns a verified
    company default alongside N agents at `unknown` / `testedAt: null`. The tab
    announced "Ready, 9 agents failing" over "These agents can't run on this
    provider" — nine agents declared broken on the strength of not having looked.

    Every unit-level card fixture supplied a PROBED outcome, so nothing caught it.
  */
  it("does not announce never-probed agents as failing on a fresh company", async () => {
    const neverProbed = (name: string): ScopedReadiness => ({
      scopeType: "agent",
      scopeId: name,
      agentName: name,
      outcome: "unknown",
      testedAt: null,
      checks: [],
    });
    await renderAndSettle([
      row("anthropic", {
        companyDefault: scope({ outcome: "verified", testedAt: FRESH }),
        agents: [neverProbed("Navigator"), neverProbed("Planner"), neverProbed("Memory Keeper")],
      }),
    ]);

    expect(screen.getByTestId("provider-status-badge").textContent).not.toMatch(/failing/i);
    expect(screen.queryByTestId("provider-failing-agents")).toBeNull();
    expect(screen.getByTestId("providers-section").textContent ?? "").not.toMatch(
      /can't run on this provider/i,
    );

    const block = screen.getByTestId("provider-unchecked-agents");
    expect(block.textContent).toMatch(/not checked yet/i);
    expect(block.textContent).toMatch(/Navigator/);
    expect(block.className).not.toMatch(/red|destructive|amber/);
  });

  it("shows a relative 'checked … ago' from testedAt", async () => {
    await renderAndSettle([
      row("anthropic", {
        companyDefault: scope({ testedAt: new Date(Date.now() - 3 * 60_000).toISOString() }),
      }),
    ]);
    expect(screen.getByTestId("provider-checked-at").textContent).toMatch(/checked 3m ago/i);
  });

  it("defaults the detail pane to the first IN-USE provider, not merely the first row", async () => {
    // openai is first in the list but idle; anthropic is later but in use.
    await renderAndSettle([
      row("openai"),
      row("anthropic", { agents: [agentScope("Scout")] }),
    ]);
    // The detail card is anthropic's (the in-use one), and its rail item is marked.
    const anthropicItem = screen
      .getAllByTestId("provider-list-item")
      .find((el) => el.getAttribute("data-provider") === "anthropic");
    expect(anthropicItem?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("provider-detail").getAttribute("data-provider")).toBe("anthropic");
  });
});

/* ── Test / Test all ───────────────────────────────────────────────────── */

describe("ProvidersSection probing", () => {
  it("probes the company default scope when a card's Test is pressed", async () => {
    await renderAndSettle([row("anthropic")]);
    fireEvent.click(screen.getByTestId("provider-test"));
    await waitFor(() => expect(testMock).toHaveBeenCalledTimes(1));
    expect(testMock).toHaveBeenCalledWith(COMPANY_ID, "anthropic");
  });

  it("runs 'Test all' SEQUENTIALLY — the server holds one probe slot", async () => {
    await renderAndSettle([row("anthropic"), row("openai"), row("google")]);

    let resolveFirst: (v: ProbeResult) => void = () => {};
    testMock.mockImplementationOnce(
      () =>
        new Promise<ProbeResult>((res) => {
          resolveFirst = res;
        }),
    );

    fireEvent.click(screen.getByTestId("providers-test-all"));
    await waitFor(() => expect(testMock).toHaveBeenCalledTimes(1));

    // The second probe must not have started while the first is in flight.
    await act(async () => {
      await Promise.resolve();
    });
    expect(testMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst(PROBE_OK);
      await Promise.resolve();
    });
    await waitFor(() => expect(testMock).toHaveBeenCalledTimes(3));
    expect(testMock.mock.calls.map((c) => c[1])).toEqual(["anthropic", "openai", "google"]);
  });

  it("renders the shared 429 back-off copy, not a raw error", async () => {
    await renderAndSettle([row("anthropic")]);
    testMock.mockRejectedValueOnce(new ApiError("Too Many Requests", 429, null));
    fireEvent.click(screen.getByTestId("provider-test"));
    const err = await screen.findByTestId("provider-error");
    expect(err.textContent).toMatch(
      new RegExp(`about ${ADAPTER_PROBE_RETRY_AFTER_SECONDS} seconds`, "i"),
    );
    expect(err.textContent).not.toMatch(/429/);
  });
});

/* ── key save ──────────────────────────────────────────────────────────── */

describe("ProvidersSection key save", () => {
  it("saves a key and lets the card clear its own draft", async () => {
    await renderAndSettle([row("anthropic")]);
    const input = screen.getByTestId("provider-key-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-test" } });
    fireEvent.click(screen.getByTestId("provider-key-save"));
    await waitFor(() => expect(saveKeyMock).toHaveBeenCalledWith(COMPANY_ID, "anthropic", "sk-test"));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("rejects to the card so a failed save retains the draft", async () => {
    await renderAndSettle([row("anthropic")]);
    saveKeyMock.mockRejectedValueOnce(new Error("nope"));
    const input = screen.getByTestId("provider-key-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByTestId("provider-key-save"));
    await screen.findByTestId("provider-error");
    expect(input.value).toBe("sk-bad");
  });
});

/* ── borrower navigation ───────────────────────────────────────────────── */

describe("ProvidersSection credential borrowers", () => {
  it("selecting a borrower links to and selects the owner", async () => {
    // pi borrows provider:anthropic — two inputs on one secret means saving
    // either silently overwrites the other, so the borrower has no input of its
    // own; it points at the owner.
    await renderAndSettle([row("anthropic"), row("pi")]);
    await select("pi");
    const link = screen.getByTestId("provider-key-owner-link");
    expect(link.textContent).toMatch(/Claude/);
    fireEvent.click(link);
    // The owner is now selected: its list item is marked and its detail (a real
    // key section, not an owned-elsewhere pointer) is shown.
    await waitFor(() => {
      const anthropicItem = screen
        .getAllByTestId("provider-list-item")
        .find((el) => el.getAttribute("data-provider") === "anthropic");
      expect(anthropicItem?.getAttribute("aria-selected")).toBe("true");
    });
    expect(screen.getByTestId("provider-key-section")).toBeTruthy();
  });
});

/* ── login lifecycle ───────────────────────────────────────────────────── */

describe("ProvidersSection login lifecycle", () => {
  it("polls immediately, then on an interval, and stops on completed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderAndSettle([needsAuthRow("openai")]);
    startLoginMock.mockResolvedValue({
      challengeId: "c1",
      loginUrl: "https://example.test/l",
      mode: "device_code",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-20T00:05:00.000Z",
    });
    loginStatusMock.mockResolvedValue(loginStatus({ status: "pending" }));

    fireEvent.click(screen.getByTestId("provider-signin"));

    expect(await screen.findByLabelText("Codex device code")).toHaveTextContent("ABCD-EFGH");
    expect(screen.getByTestId("provider-login-expiry").textContent).toMatch(/^Expires /);

    // Poll ONCE immediately — not after a full interval of dead air.
    await waitFor(() => expect(loginStatusMock).toHaveBeenCalledTimes(1));
    expect(loginStatusMock).toHaveBeenCalledWith(COMPANY_ID, "openai", "c1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    });
    expect(loginStatusMock).toHaveBeenCalledTimes(2);

    // Completion: the server already re-probed and hands back the fresh row.
    loginStatusMock.mockResolvedValue(
      loginStatus({ status: "completed", readiness: scope() }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);
    });
    expect(loginStatusMock).toHaveBeenCalledTimes(3);

    // Terminal: polling MUST stop. Continued polling re-hits the status route
    // forever for a challenge that is already done.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 4);
    });
    expect(loginStatusMock).toHaveBeenCalledTimes(3);
    // The server re-probed for us (readiness non-null) — don't spawn a second CLI.
    expect(testMock).not.toHaveBeenCalled();
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(1));
  });

  it("stops polling and surfaces an error when the challenge 404s (reaped/lost)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderAndSettle([needsAuthRow("openai")]);
    startLoginMock.mockResolvedValue({ challengeId: "c-gone", loginUrl: "https://example.test/l" });
    // The challenge is gone — every status poll 404s. Without terminal handling
    // the card would spin "Waiting for sign-in…" forever.
    loginStatusMock.mockRejectedValue(new ApiError("Not found", 404, null));

    fireEvent.click(screen.getByTestId("provider-signin"));

    await waitFor(() => expect(loginStatusMock).toHaveBeenCalledTimes(1));
    // Terminal: no further polls fire after the 404.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS * 4);
    });
    expect(loginStatusMock).toHaveBeenCalledTimes(1);
    // And the card says the session is gone, rather than staying stuck waiting.
    await screen.findByText(/expired|start again/i);
  });

  it("re-probes itself only when the server's best-effort re-probe failed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderAndSettle([needsAuthRow("openai")]);
    startLoginMock.mockResolvedValue({ challengeId: "c2", loginUrl: "https://example.test/l" });
    loginStatusMock.mockResolvedValue(loginStatus({ status: "completed", readiness: null }));

    fireEvent.click(screen.getByTestId("provider-signin"));
    await waitFor(() => expect(testMock).toHaveBeenCalledWith(COMPANY_ID, "openai"));
  });

  it("cancels a still-pending challenge on unmount — the host slot is shared", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = await renderAndSettle([needsAuthRow("openai")]);
    startLoginMock.mockResolvedValue({ challengeId: "c3", loginUrl: "https://example.test/l" });
    loginStatusMock.mockResolvedValue(loginStatus({ status: "pending" }));

    fireEvent.click(screen.getByTestId("provider-signin"));
    await waitFor(() => expect(loginStatusMock).toHaveBeenCalled());

    unmount();
    expect(cancelLoginMock).toHaveBeenCalledWith(COMPANY_ID, "openai", "c3");
  });

  it("does not cancel anything on unmount when no challenge is pending", async () => {
    const { unmount } = await renderAndSettle([needsAuthRow("openai")]);
    unmount();
    expect(cancelLoginMock).not.toHaveBeenCalled();
  });

  it("renders readable copy for a bare 409 conflict, never a raw status", async () => {
    await renderAndSettle([needsAuthRow("openai")]);
    startLoginMock.mockRejectedValueOnce(new ApiError("Conflict", 409, null));
    fireEvent.click(screen.getByTestId("provider-signin"));
    const err = await screen.findByTestId("provider-error");
    // A bare "Conflict" has no actionable message → friendly generic line.
    expect(err.textContent).toMatch(/busy with another request/i);
    expect(err.textContent).not.toMatch(/409|Conflict/);
  });

  it("shows the server's descriptive 409 message verbatim (login slot in progress)", async () => {
    await renderAndSettle([needsAuthRow("openai")]);
    startLoginMock.mockRejectedValueOnce(
      new ApiError("Another sign-in for Codex is already in progress on this machine.", 409, null),
    );
    fireEvent.click(screen.getByTestId("provider-signin"));
    const err = await screen.findByTestId("provider-error");
    expect(err.textContent).toContain("Another sign-in for Codex is already in progress");
  });
});

/* ── company guard ─────────────────────────────────────────────────────── */

describe("ProvidersSection company guard", () => {
  it("does not fetch without a selected company", async () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: null });
    renderSection();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("provider-card")).toBeNull();
  });
});
