import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";

import { internalAgentApi } from "@/api/internal-agent";
import { CommanderSection } from "../CommanderSection";

// Mock the company context so getConfig/updateConfig receive a stable company id.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// Stub the internal-agent API. getConfig returns a complete config; updateConfig
// is the assertion target.
vi.mock("@/api/internal-agent", () => ({
  internalAgentApi: {
    getConfig: vi.fn(async () => ({
      id: "cfg-1",
      executionMode: "cli",
      cliTool: "claude_cli",
      provider: "anthropic",
      model: null,
      crewModel: null,
      autonomyLevel: 0,
      enabledCapabilities: [],
      notificationPreference: "realtime",
      contextTokenBudget: 8000,
      budgetMonthlyCents: 5000,
      spentMonthlyCents: 0,
      proactiveIntervalMinutes: 240,
      lastProactiveRunAt: null,
      cheapModel: null,
      runtimeApprovalsEnabled: true,
      runtimeAllowAlwaysEnabled: true,
      vendorCliBypassEnabled: true,
      inboundRoutingLevel: "off",
    })),
    updateConfig: vi.fn(async () => ({})),
    getRuns: vi.fn(async () => ({ runs: [], total: 0, limit: 20, offset: 0, aggregates: null })),
    testConnection: vi.fn(async () => ({ success: true })),
  },
  // Re-export the named API objects the component imports so the module shape stays intact.
  commanderTrustRulesApi: { list: vi.fn(async () => ({ rules: [] })), revoke: vi.fn() },
  toolPermissionsApi: { get: vi.fn(async () => ({ default: undefined, permissions: {} })), update: vi.fn() },
}));

// Mock the design-system Select (Radix) as a native <select> so the crew provider
// control is driven by fireEvent.change (Radix combobox can't be changed in jsdom).
// SelectItem children become <option>s; the aria-label/id on SelectTrigger lands on
// the native <select> so getByLabelText(/crew provider/i) resolves to it.
vi.mock("@/components/ui/select", () => {
  function collectOptions(node: React.ReactNode): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const el = child as React.ReactElement<{ value?: string; children?: React.ReactNode }>;
      if (el.props && typeof el.props.value === "string") {
        out.push(
          <option key={el.props.value} value={el.props.value}>
            {el.props.children}
          </option>,
        );
      } else if (el.props && el.props.children) {
        out.push(...collectOptions(el.props.children));
      }
    });
    return out;
  }
  return {
    Select: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value?: string;
      onValueChange?: (v: string) => void;
    }) => {
      // Pull the aria-label/id off the SelectTrigger child so the native select is labeled.
      let triggerProps: { id?: string; "aria-label"?: string } = {};
      React.Children.forEach(children, (child) => {
        if (
          React.isValidElement(child) &&
          (child.type as { displayName?: string })?.displayName === "SelectTrigger"
        ) {
          const p = (child as React.ReactElement<{ id?: string; "aria-label"?: string }>).props;
          triggerProps = { id: p.id, "aria-label": p["aria-label"] };
        }
      });
      return (
        <select
          id={triggerProps.id}
          aria-label={triggerProps["aria-label"]}
          value={value}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          {collectOptions(children)}
        </select>
      );
    },
    SelectTrigger: Object.assign(
      ({ children }: { children?: React.ReactNode }) => <>{children}</>,
      { displayName: "SelectTrigger" },
    ),
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectValue: () => null,
  };
});

function renderSection() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/CO/settings?tab=commander"]}>
        <CommanderSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("CommanderSection execution tab — crew provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves provider + crewModel when the crew control changes", async () => {
    renderSection();
    await screen.findByLabelText(/crew provider/i);
    fireEvent.change(screen.getByLabelText(/crew provider/i), {
      target: { value: "openai" },
    });
    fireEvent.change(screen.getByLabelText(/crew model/i), {
      target: { value: "gpt-5.5" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: /save/i })[0]);
    await waitFor(() =>
      expect(internalAgentApi.updateConfig).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ provider: "openai", crewModel: "gpt-5.5" }),
      ),
    );
  });
});
