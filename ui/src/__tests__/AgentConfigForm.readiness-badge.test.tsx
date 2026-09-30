/**
 * Agent-config readiness badge (Task 13).
 *
 * Driven through `AgentConfigForm` rather than against the badge in isolation,
 * because the wiring is half the contract: which company id, which agent id and
 * — the one that actually broke in review — which adapter type (the DRAFT value,
 * not the persisted one).
 *
 * The six-outcome table is not padding. `outcomeLabel` degrades an unrecognised
 * verdict to neutral copy instead of throwing, which is right for resilience and
 * exactly wrong for coverage: a badge that silently renders the fallback for a
 * real outcome looks fine on screen. Asserting label AND tone for all six is
 * what makes a blank or mis-toned badge a test failure.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProbeOutcome } from "@armyofagents/shared";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { TooltipProvider } from "../components/ui/tooltip";

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    adapterModels: vi.fn().mockResolvedValue([]),
    org: vi.fn().mockResolvedValue([]),
    testEnvironment: vi.fn(),
  },
}));

vi.mock("../api/secrets", () => ({
  secretsApi: { list: vi.fn().mockResolvedValue([]), create: vi.fn() },
}));

vi.mock("../api/environments", () => ({ useEnvironments: () => ({ data: [] }) }));

vi.mock("../api/assets", () => ({ assetsApi: { uploadImage: vi.fn() } }));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <textarea readOnly value={value} />,
}));

/**
 * Only the two network functions are stubbed. `readinessForScope` — the helper
 * carrying the NO-FALLBACK guarantee — is kept REAL via `importActual`. Stubbing
 * it would let the badge pass this suite while silently reading the company
 * default, which is the single bug the suite exists to catch.
 */
const { listMock, testMock } = vi.hoisted(() => ({ listMock: vi.fn(), testMock: vi.fn() }));
vi.mock("../api/providers", async () => {
  const actual = await vi.importActual<typeof import("../api/providers")>("../api/providers");
  return { ...actual, providersApi: { list: listMock, test: testMock } };
});

const baseAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Software Agent",
  title: "Engineer",
  role: "general",
  capabilities: ["software"],
  status: "active",
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300, wakeOnDemand: true } },
  reportsToAgentId: null,
  reportsToUserId: null,
  parentType: null,
  parentId: null,
  departmentId: null,
  defaultEnvironmentId: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** Minimal `ProviderStatusRow` for Claude. `agents` is supplied per test. */
function claudeRow(opts: {
  companyDefaultOutcome?: ProbeOutcome;
  agents?: Array<{ scopeId: string; outcome: ProbeOutcome }>;
}) {
  return {
    descriptor: {
      id: "anthropic",
      label: "Claude",
      adapterType: "claude_local",
      kind: "local_cli",
      credential: {
        apiKey: { envVar: "ANTHROPIC_API_KEY", secretName: "provider:anthropic" },
        selfCompletingLogin: false,
        manualLoginCommand: "claude auth login",
      },
      installHint: { mac: "x", win: "x", linux: "x" },
    },
    companyDefault: {
      scopeType: "company_default" as const,
      scopeId: null,
      outcome: opts.companyDefaultOutcome ?? "verified",
      testedAt: new Date().toISOString(),
      checks: [],
    },
    agents: (opts.agents ?? []).map((a) => ({
      scopeType: "agent" as const,
      scopeId: a.scopeId,
      agentName: "Software Agent",
      outcome: a.outcome,
      testedAt: new Date().toISOString(),
      checks: [],
    })),
    existingKey: {
      configured: false,
      source: null,
      secretName: "provider:anthropic",
      envVar: "ANTHROPIC_API_KEY",
    },
  };
}

function renderForm(agentPatch: Record<string, unknown> = {}, onSave = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter initialEntries={["/AC/team/aoa/agent-1"]}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AgentConfigForm
            mode="edit"
            agent={{ ...baseAgent, ...agentPatch } as never}
            onSave={onSave}
            adapterModels={[]}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onSave };
}

beforeEach(() => {
  listMock.mockReset();
  testMock.mockReset();
});

/* ── the six-outcome table ─────────────────────────────────────────────── */

const CASES: Array<{ outcome: ProbeOutcome; label: string; tone: string }> = [
  { outcome: "verified", label: "Ready", tone: "ready" },
  { outcome: "needs_auth", label: "Needs sign-in", tone: "warn" },
  { outcome: "not_installed", label: "Not installed", tone: "warn" },
  { outcome: "failed", label: "Check failed", tone: "error" },
  { outcome: "unknown", label: "Not verified", tone: "neutral" },
  { outcome: "unverifiable", label: "Can't verify (custom command)", tone: "neutral" },
];

describe("AgentConfigForm readiness badge — outcome table", () => {
  it.each(CASES)("renders $outcome as '$label' with the $tone tone", async ({
    outcome,
    label,
    tone,
  }) => {
    listMock.mockResolvedValue({
      providers: [
        claudeRow({
          // Deliberately the OPPOSITE of the agent's own verdict wherever they
          // can differ, so a badge reading the company default cannot
          // accidentally produce the expected label.
          companyDefaultOutcome: outcome === "verified" ? "failed" : "verified",
          agents: [{ scopeId: "agent-1", outcome }],
        }),
      ],
    });
    renderForm();

    const badge = await screen.findByTestId("agent-readiness-badge");
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveAttribute("data-tone", tone);
  });

  /**
   * P1-1. The reason the two-key lookup exists at all: an agent binding its own
   * revoked key must read "Needs sign-in" while the company key is fine.
   */
  it("shows the agent's own failing verdict even when the company default is verified", async () => {
    listMock.mockResolvedValue({
      providers: [
        claudeRow({
          companyDefaultOutcome: "verified",
          agents: [{ scopeId: "agent-1", outcome: "needs_auth" }],
        }),
      ],
    });
    renderForm();

    const badge = await screen.findByTestId("agent-readiness-badge");
    expect(badge).toHaveTextContent("Needs sign-in");
    expect(badge).not.toHaveTextContent("Ready");
    expect(badge).toHaveAttribute("data-tone", "warn");
  });

  /**
   * The unchecked state. A never-probed agent must NOT inherit the company
   * default's green, and must not be painted as broken either — it reads as the
   * neutral "Not verified" plus the sentence that says which kind of ignorance
   * this is.
   */
  it("renders a never-probed agent as neutral Not verified, not the company default", async () => {
    listMock.mockResolvedValue({
      providers: [claudeRow({ companyDefaultOutcome: "verified", agents: [] })],
    });
    renderForm();

    const badge = await screen.findByTestId("agent-readiness-badge");
    expect(badge).toHaveTextContent("Not verified");
    expect(badge).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByTestId("agent-readiness-never-checked")).toBeInTheDocument();
  });

  it("does not confuse another agent's scope for this one", async () => {
    listMock.mockResolvedValue({
      providers: [
        claudeRow({
          companyDefaultOutcome: "verified",
          agents: [{ scopeId: "agent-OTHER", outcome: "verified" }],
        }),
      ],
    });
    renderForm();

    const badge = await screen.findByTestId("agent-readiness-badge");
    expect(badge).toHaveTextContent("Not verified");
  });
});

describe("AgentConfigForm readiness badge — lookup and actions", () => {
  it("renders nothing for an adapter with no credentialed provider", async () => {
    listMock.mockResolvedValue({ providers: [claudeRow({ agents: [] })] });
    renderForm({ adapterType: "process" });

    await screen.findByText("Adapter type");
    expect(screen.queryByTestId("agent-readiness")).not.toBeInTheDocument();
    // …and it must not even FETCH: an uncredentialed adapter has no readiness.
    expect(listMock).not.toHaveBeenCalled();
  });

  it("renders nothing when the server returned no row for this provider", async () => {
    listMock.mockResolvedValue({ providers: [] });
    renderForm();

    await screen.findByText("Adapter type");
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(screen.queryByTestId("agent-readiness")).not.toBeInTheDocument();
  });

  /**
   * The badge must follow the DRAFT adapter type. The form lets the founder
   * switch adapters before saving, and a badge pinned to `agent.adapterType`
   * would report Claude's readiness for an agent about to run on Codex.
   */
  it("follows the draft adapter type after an unsaved adapter switch", async () => {
    listMock.mockResolvedValue({
      providers: [
        claudeRow({ agents: [{ scopeId: "agent-1", outcome: "verified" }] }),
        {
          ...claudeRow({ agents: [{ scopeId: "agent-1", outcome: "needs_auth" }] }),
          descriptor: {
            id: "openai",
            label: "Codex",
            adapterType: "codex_local",
            kind: "local_cli",
            credential: {
              apiKey: { envVar: "OPENAI_API_KEY", secretName: "provider:openai" },
              selfCompletingLogin: true,
              manualLoginCommand: "codex login",
            },
            installHint: { mac: "x", win: "x", linux: "x" },
          },
        },
      ],
    });
    renderForm();

    expect(await screen.findByTestId("agent-readiness-badge")).toHaveTextContent("Ready");

    await userEvent.click(await screen.findByRole("button", { name: /claude.*\(local\)/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /codex.*\(local\)/i }));

    await waitFor(() => {
      expect(screen.getByTestId("agent-readiness-badge")).toHaveTextContent("Needs sign-in");
    });
  });

  /**
   * The Test button is how an agent leaves the unchecked state — the Settings
   * tab never probes agent scopes (design D3). It must therefore ask for THIS
   * AGENT'S scope, not the company default.
   */
  it("probes the agent scope, not the company default", async () => {
    listMock.mockResolvedValue({
      providers: [claudeRow({ companyDefaultOutcome: "verified", agents: [] })],
    });
    testMock.mockResolvedValue({ outcome: "verified", checks: [], testedAt: "now" });
    renderForm();

    await screen.findByTestId("agent-readiness-badge");
    const panel = screen.getByTestId("agent-readiness");
    await userEvent.click(within(panel).getByRole("button", { name: "Test" }));

    await waitFor(() =>
      expect(testMock).toHaveBeenCalledWith("company-1", "anthropic", {
        scopeType: "agent",
        agentId: "agent-1",
      }),
    );
  });

  it("links to Settings -> Providers", async () => {
    listMock.mockResolvedValue({
      providers: [claudeRow({ agents: [{ scopeId: "agent-1", outcome: "verified" }] })],
    });
    renderForm();

    const link = await screen.findByRole("link", { name: /manage in settings/i });
    expect(link.getAttribute("href")).toContain("/settings?tab=providers");
  });
});

/* ── Step 2 regression: the per-agent credential override ──────────────── */

/**
 * The per-agent `adapterConfig.env` binding is explicitly protected behaviour:
 * it is the mechanism that makes an agent's readiness differ from the company
 * default in the first place. This asserts the badge's arrival changed neither
 * the fields nor the emitted patch shape.
 */
describe("AgentConfigForm per-agent env binding (regression)", () => {
  beforeEach(() => {
    listMock.mockResolvedValue({
      providers: [claudeRow({ agents: [{ scopeId: "agent-1", outcome: "verified" }] })],
    });
  });

  it("still renders the Model API key binding and the env var editor", async () => {
    renderForm();

    const field = await screen.findByText("Model API key");
    const container = field.closest("div")?.parentElement as HTMLElement;
    expect(within(container).getByText("ANTHROPIC_API_KEY")).toBeInTheDocument();
    expect(screen.getByText("Environment variables")).toBeInTheDocument();
  });

  it("still emits the same adapterConfig.env patch shape on save", async () => {
    const { onSave } = renderForm({
      adapterConfig: {
        timeoutSec: 30,
        env: { ANTHROPIC_API_KEY: { type: "literal", value: "sk-ant-existing" } },
      },
    });

    await screen.findByTestId("agent-readiness-badge");
    // Dirty the form through a field OTHER than env, so the assertion below
    // proves the existing env survives a save rather than being re-emitted by
    // the very interaction under test. `timeoutSec: 30` above exists only to
    // give this input a value no other numeric field shares.
    const timeout = await screen.findByDisplayValue("30");
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "42");
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterConfig: expect.objectContaining({
            env: { ANTHROPIC_API_KEY: { type: "literal", value: "sk-ant-existing" } },
          }),
        }),
      );
    });
  });
});
