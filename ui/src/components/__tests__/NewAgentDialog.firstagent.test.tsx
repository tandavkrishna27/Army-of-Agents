import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { UnifiedOrgNode } from "@armyofagents/shared";

import { NewAgentDialog } from "../NewAgentDialog";
import { agentsApi } from "../../api/agents";
import { TooltipProvider } from "@/components/ui/tooltip";

// `@/lib/router`'s useNavigate derives the active company prefix from the route;
// under a bare MemoryRouter that prefix is undefined and throws. Fall back to the
// plain react-router-dom navigate, which works inside MemoryRouter.
vi.mock("@/lib/router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual };
});

// --- Mock the surrounding contexts so the dialog renders open + scoped ---
vi.mock("../../context/DialogContext", () => ({
  useDialog: () => ({ newAgentOpen: true, closeNewAgent: vi.fn() }),
}));

vi.mock("../../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { id: "comp-1", name: "Test Corp", rootFolder: null },
  }),
}));

vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// --- Mock the agents API: no agents (first hire) + an org tree with a founder ---
const founderNode: UnifiedOrgNode = {
  id: "user-1",
  name: "Alice Founder",
  role: "founder",
  status: "active",
  nodeType: "user",
  userRole: "founder",
  children: [],
};

vi.mock("../../api/agents", () => ({
  agentsApi: {
    list: vi.fn(),
    org: vi.fn(),
    adapterModels: vi.fn(),
    hire: vi.fn(),
  },
}));

function wrap(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TooltipProvider>{node}</TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NewAgentDialog — first agent reports-to", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom shims for Radix Select / Popover pointer + scroll APIs.
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.setPointerCapture) {
      Element.prototype.setPointerCapture = () => {};
    }
    if (!Element.prototype.releasePointerCapture) {
      Element.prototype.releasePointerCapture = () => {};
    }
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = () => {};
    }

    // First hire: no existing agents.
    vi.mocked(agentsApi.list).mockResolvedValue([]);
    // Org tree contains the founder (the human root).
    vi.mocked(agentsApi.org).mockResolvedValue([founderNode]);
    // Adapter models query — irrelevant to this test.
    vi.mocked(agentsApi.adapterModels).mockResolvedValue([]);
  });

  // The dialog also embeds AgentConfigForm, which renders its own Select
  // (combobox) controls. The reports-to picker is uniquely the combobox whose
  // displayed value resolves to the founder's name once the org tree loads.
  async function findReportsToTrigger(): Promise<HTMLElement> {
    const founderLabel = await screen.findByText("Alice Founder");
    const trigger = founderLabel.closest('[role="combobox"]');
    expect(trigger).not.toBeNull();
    return trigger as HTMLElement;
  }

  it("enables the reports-to picker for the first agent (not disabled)", async () => {
    wrap(<NewAgentDialog />);

    const trigger = await findReportsToTrigger();
    expect(trigger).not.toBeDisabled();
  });

  it("defaults the first agent's reports-to to the founder once the org tree loads", async () => {
    wrap(<NewAgentDialog />);

    // The picker's selected value should resolve to the founder's name —
    // proving the default reports-to is the founder (the human root).
    const trigger = await findReportsToTrigger();
    expect(trigger).toHaveTextContent("Alice Founder");
    // …and the trigger must be enabled (the whole point of this change).
    expect(trigger).not.toBeDisabled();
  });
});
