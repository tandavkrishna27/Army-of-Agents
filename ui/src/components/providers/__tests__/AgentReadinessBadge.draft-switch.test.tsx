import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentReadinessBadge } from "../AgentReadinessBadge";

/**
 * The badge is draft-aware for DISPLAY (it shows the provider the form currently
 * has selected). But the agent-scope probe keys off the PERSISTED agent row, so
 * the server rejects a probe for a draft adapter the agent isn't saved with
 * ("Agent does not use provider ..."). So when the draft adapter differs from the
 * saved one, Test must be disabled with an explanation — not fail mid-edit.
 */
// The router's <Link> resolves company-prefixed hrefs via useCompany.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: null }),
}));

const { listMock, testMock } = vi.hoisted(() => ({ listMock: vi.fn(), testMock: vi.fn() }));
vi.mock("@/api/providers", async () => {
  const actual = await vi.importActual<typeof import("@/api/providers")>("@/api/providers");
  return { ...actual, providersApi: { list: listMock, test: testMock } };
});

/** A providers-list row for Codex with no probed agent scope. */
function codexRow() {
  return {
    descriptor: { id: "openai", label: "Codex", adapterType: "codex_local" },
    companyDefault: {
      scopeType: "company_default" as const,
      scopeId: null,
      outcome: "unknown" as const,
      testedAt: null,
      checks: [],
    },
    agents: [],
    existingKey: { configured: false, source: null, secretName: null, envVar: null },
  };
}

function renderBadge(props: { adapterType: string; savedAdapterType?: string }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AgentReadinessBadge companyId="company-1" agentId="agent-1" {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AgentReadinessBadge — draft adapter switch", () => {
  beforeEach(() => {
    listMock.mockReset();
    testMock.mockReset();
    listMock.mockResolvedValue({ providers: [codexRow()] } as never);
  });

  it("disables Test and explains when the draft adapter differs from the saved one", async () => {
    renderBadge({ adapterType: "codex_local", savedAdapterType: "claude_local" });
    await screen.findByTestId("agent-readiness-badge");
    expect(screen.getByTestId("agent-readiness-draft-switch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test/i })).toBeDisabled();
  });

  it("enables Test when the draft matches the saved adapter", async () => {
    renderBadge({ adapterType: "codex_local", savedAdapterType: "codex_local" });
    await screen.findByTestId("agent-readiness-badge");
    expect(screen.queryByTestId("agent-readiness-draft-switch")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /test/i })).toBeEnabled();
  });

  it("refetches the providers list even after a FAILED Test", async () => {
    // A probe that fails during config resolution still records a fresh `failed`
    // row server-side, so the badge must refetch to drop any stale `Ready` — the
    // invalidation must run on the error path, not only on success.
    testMock.mockRejectedValue(new Error("Secret is not bound to this consumer path"));
    renderBadge({ adapterType: "codex_local", savedAdapterType: "codex_local" });
    await screen.findByTestId("agent-readiness-badge");
    expect(listMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /test/i }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});
