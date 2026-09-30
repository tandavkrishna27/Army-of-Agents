/**
 * Settings → Connectors: the MANAGE half of the connector journey — status
 * badges, credential binding, per-agent access, and the empty state that hands
 * a founder with nothing installed the route to the Marketplace.
 *
 * The BROWSE + INSTALL half (shelf, consent dialog, token freshness) moved to
 * Marketplace → Connectors so connectors are acquired the same way skills,
 * agents, plugins and teams are. Those assertions live — unchanged — in
 * `ui/src/pages/__tests__/MarketplaceConnectors.test.tsx`.
 *
 * WHAT THESE TESTS ARE FOR (in priority order):
 *
 *  1. `StatusBadge` used to have NO fallback branch, so an unrecognised status
 *     rendered literally nothing. P3a-11 made `needs_credentials` reachable in
 *     production, which meant a founder who installed a catalog connector saw a
 *     row with no badge at all. Both the new case and the fallback are pinned.
 *  2. A connector installed from the Marketplace lands `needs_credentials` and
 *     is useless until a secret is bound HERE. That hand-off is the seam the
 *     relocation created, so it is pinned from both ends.
 *  3. Settings must no longer render a browsable catalog — and must not become a
 *     dead end because of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/context/ToastContext";
import { ApiError } from "@/api/client";
import type { McpConnector } from "@/api/mcpConnectors";
import {
  MCPConnectorsSection,
  StatusBadge,
} from "../sections/MCPConnectorsSection";

/* ── mocks ─────────────────────────────────────────────────────────────── */

const listMock = vi.fn();
const catalogMock = vi.fn();
const installMock = vi.fn();
const bindCredentialsMock = vi.fn();
const oauthStartMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();
const setAgentsMock = vi.fn();
const roleMock = vi.fn(async () => ({
  currentUser: { role: "founder", permissions: {} },
}));

vi.mock("@/api/mcpConnectors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/mcpConnectors")>();
  return {
    ...actual,
    mcpConnectorsApi: {
      list: (...a: unknown[]) => listMock(...a),
      catalog: (...a: unknown[]) => catalogMock(...a),
      install: (...a: unknown[]) => installMock(...a),
      bindCredentials: (...a: unknown[]) => bindCredentialsMock(...a),
      oauthStart: (...a: unknown[]) => oauthStartMock(...a),
      create: (...a: unknown[]) => createMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
      remove: (...a: unknown[]) => removeMock(...a),
      setAgents: (...a: unknown[]) => setAgentsMock(...a),
    },
  };
});

vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async () => []) } }));

const healthMock = vi.fn(async () => ({
  status: "ok",
  deploymentMode: "local_trusted",
}));
vi.mock("@/api/health", () => ({ healthApi: { get: () => healthMock() } }));

vi.mock("@/api/team", () => ({
  teamApi: {
    get: () => roleMock(),
  },
}));

const COMPANY_ID = "company-1";
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: COMPANY_ID,
    // `@/lib/router`'s Link reads selectedCompany to resolve the board prefix.
    selectedCompany: {
      id: COMPANY_ID,
      name: "Acme",
      status: "active",
      issuePrefix: "ACME",
    },
    companies: [
      { id: COMPANY_ID, name: "Acme", status: "active", issuePrefix: "ACME" },
    ],
    loading: false,
  }),
}));

/* ── fixtures ──────────────────────────────────────────────────────────── */

function connector(over: Partial<McpConnector> = {}): McpConnector {
  return {
    id: "conn-1",
    companyId: COMPANY_ID,
    serverName: "notion",
    displayName: "Notion",
    transport: "http",
    url: "https://mcp.notion.com/sse",
    command: null,
    args: [],
    headerTemplate: {},
    envTemplate: {},
    secretRef: null,
    source: "catalog",
    catalogEntryId: "notion",
    oauthPolicyVersion: null,
    oauthEligibility: "not_oauth",
    status: "active",
    requiresSecret: false,
    createdByUserId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    enabledAgentIds: [],
    deliverability: null,
    ...over,
  };
}

function renderSection() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      {/* NewConnectorDialog (mounted whenever the founder can add a connector,
          regardless of whether it's open) calls useToast() for its
          success/pending-approval notice, so it needs a real ToastProvider —
          not just in production (main.tsx), but here too. */}
      <ToastProvider>
        <MemoryRouter initialEntries={["/ACME/settings?tab=connectors"]}>
          <MCPConnectorsSection />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([]);
  // Default catalog response for the conditional cross-reference query (Task 16)
  // — only actually FETCHED when a needs_credentials row is present (see
  // "never fetches the connector catalog" below), but a defined default keeps
  // React Query quiet on tests that do trigger it without asserting on it.
  catalogMock.mockResolvedValue({ entries: [], stale: false });
  bindCredentialsMock.mockResolvedValue(
    connector({ secretRef: "mcp:notion", status: "active" })
  );
  healthMock.mockResolvedValue({
    status: "ok",
    deploymentMode: "local_trusted",
  });
  createMock.mockResolvedValue(connector());
  updateMock.mockResolvedValue(connector());
  removeMock.mockResolvedValue(connector());
  setAgentsMock.mockResolvedValue({ connectorId: "conn-1", agentIds: [] });
  roleMock.mockResolvedValue({
    currentUser: { role: "founder", permissions: {} },
  });
});

describe("connector list request states", () => {
  it("does not present loading as an empty connector collection", async () => {
    listMock.mockReturnValue(new Promise(() => {}));
    renderSection();

    expect(await screen.findByRole("status")).toHaveTextContent(/loading registered connectors/i);
    expect(screen.queryByTestId("connectors-empty-state")).not.toBeInTheDocument();
  });

  it("renders a retryable error instead of the empty state", async () => {
    listMock.mockRejectedValue(new Error("offline"));
    renderSection();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not load registered connectors/i);
    expect(within(alert).getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId("connectors-empty-state")).not.toBeInTheDocument();
  });
});

/* ── 1. StatusBadge ─────────────────────────────────────────────────────── */

describe("StatusBadge", () => {
  it.each([
    ["active", "Active"],
    ["pending_approval", "Pending approval"],
    ["needs_credentials", "Needs setup"],
    ["disabled", "Disabled"],
  ])("renders a badge for %s", (status, label) => {
    render(<StatusBadge status={status as McpConnector["status"]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("renders the raw status for an unknown value instead of nothing", () => {
    // Regression: the original implementation had no fallback `return`, so an
    // unrecognised status produced an empty render and the founder saw a
    // connector row with no state at all.
    const { container } = render(
      <StatusBadge status={"quarantined" as McpConnector["status"]} />
    );
    expect(container.textContent).toContain("quarantined");
    expect(container.textContent).not.toBe("");
  });
});

/* ── 4. post-install credential path ────────────────────────────────────── */

describe("needs_credentials follow-through", () => {
  it("offers a one-click credential path on an installed-but-unusable connector", async () => {
    listMock.mockResolvedValue([
      connector({
        status: "needs_credentials",
        requiresSecret: true,
        secretRef: null,
        headerTemplate: { Authorization: "" },
      }),
    ]);
    renderSection();

    expect(await screen.findByText("Needs setup")).toBeInTheDocument();

    const row = screen.getByTestId("connector-row-conn-1");
    fireEvent.click(
      within(row).getByRole("button", { name: /add credential/i })
    );
    fireEvent.change(within(row).getByLabelText(/secret reference/i), {
      target: { value: "mcp:notion" },
    });
    fireEvent.click(
      within(row).getByRole("button", { name: /save credential/i })
    );

    await waitFor(() =>
      expect(bindCredentialsMock).toHaveBeenCalledWith(
        COMPANY_ID,
        "conn-1",
        "mcp:notion"
      )
    );
  });
});

/* ── 6. Re-authorize (Task 16) ──────────────────────────────────────────── */

describe("re-authorize (needs_credentials OAuth connector)", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    // Same convention as pages/__tests__/Auth.test.tsx: replace window.location
    // wholesale so `.assign` is a spy, then restore it after each test.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: {
        href: "http://localhost/settings?tab=connectors",
        assign: vi.fn(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it("shows Re-authorize (not Add credential) for a needs_credentials connector whose catalog entry is OAuth, and navigates on click", async () => {
    listMock.mockResolvedValue([
      connector({
        status: "needs_credentials",
        requiresSecret: true,
        secretRef: null,
        serverName: "notion-hosted",
        displayName: "Notion (hosted)",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
        oauthEligibility: "supported",
      }),
    ]);
    oauthStartMock.mockResolvedValue({
      authorizeUrl: "https://mcp.notion.com/authorize?x=1",
    });
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(catalogMock).not.toHaveBeenCalled();

    const reauthBtn = await within(row).findByRole("button", {
      name: /re-authorize/i,
    });
    expect(
      within(row).queryByRole("button", { name: /add credential/i })
    ).not.toBeInTheDocument();

    fireEvent.click(reauthBtn);

    await waitFor(() =>
      expect(oauthStartMock).toHaveBeenCalledWith(COMPANY_ID, "conn-1")
    );
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://mcp.notion.com/authorize?x=1"
      )
    );
  });

  it("shows Re-authorize for a needs_credentials OAuth connector even when secretRef is still bound (post-refresh-failure shape)", async () => {
    // The runtime refresh-failure path sets status: "needs_credentials" while
    // KEEPING secretRef bound (JIT token refresh failed, but the old — now
    // stale/expired — secretRef is left in place). The old render condition
    // gated Re-authorize on `needsCredential && isOAuth`, where
    // `needsCredential = requiresSecret && !secretRef` — with secretRef still
    // set, needsCredential is false, so the button never rendered in exactly the
    // refresh-death case it exists for. The fix gates on `status ===
    // "needs_credentials"` instead, regardless of secretRef.
    listMock.mockResolvedValue([
      connector({
        status: "needs_credentials",
        requiresSecret: true,
        secretRef: "mcp:notion",
        serverName: "notion-hosted",
        displayName: "Notion (hosted)",
        catalogEntryId: "notion-hosted",
        oauthPolicyVersion: 1,
        oauthEligibility: "supported",
      }),
    ]);
    oauthStartMock.mockResolvedValue({
      authorizeUrl: "https://mcp.notion.com/authorize?x=1",
    });
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(catalogMock).not.toHaveBeenCalled();

    const reauthBtn = await within(row).findByRole("button", {
      name: /re-authorize/i,
    });
    fireEvent.click(reauthBtn);

    await waitFor(() =>
      expect(oauthStartMock).toHaveBeenCalledWith(COMPANY_ID, "conn-1")
    );
  });

  it("keeps Add credential (not Re-authorize) for a needs_credentials connector whose catalog entry is not OAuth", async () => {
    listMock.mockResolvedValue([
      connector({
        status: "needs_credentials",
        requiresSecret: true,
        secretRef: null,
        headerTemplate: { Authorization: "" },
      }),
    ]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(
      await within(row).findByRole("button", { name: /add credential/i })
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: /re-authorize/i })
    ).not.toBeInTheDocument();
  });

  it("shows the server policy reason without offering re-authorization", async () => {
    listMock.mockResolvedValue([
      connector({
        status: "needs_credentials",
        requiresSecret: true,
        catalogEntryId: "sentry",
        oauthPolicyVersion: null,
        oauthEligibility: "policy_blocked",
        oauthUnavailableReason:
          "Sentry OAuth has not completed provider acceptance.",
      }),
    ]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(
      within(row).getByText(/has not completed provider acceptance/i)
    ).toBeInTheDocument();
    expect(
      within(row).queryByRole("button", { name: /re-authorize/i })
    ).not.toBeInTheDocument();
    expect(catalogMock).not.toHaveBeenCalled();
  });

  it("shows policy-blocked unavailability to non-founders without mutation controls", async () => {
    roleMock.mockResolvedValue({
      currentUser: { role: "team_member", permissions: {} },
    });
    listMock.mockResolvedValue([
      connector({
        status: "active",
        oauthEligibility: "policy_blocked",
        oauthUnavailableReason: "Provider approval is still pending.",
      }),
    ]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(within(row).getByText(/unavailable to agents/i)).toBeInTheDocument();
    expect(within(row).queryByTestId("connector-access-conn-1")).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /enable|disable|remove|re-authorize/i })).not.toBeInTheDocument();
  });
});

/* ── 5. delivery health (FU-1) ──────────────────────────────────────────── */

describe("delivery-skip visibility (FU-1)", () => {
  it("shows no delivery warning for a healthy, deliverable active connector", async () => {
    listMock.mockResolvedValue([
      connector({
        deliverability: { deliverable: true, reason: null, blockedAgents: [] },
      }),
    ]);
    renderSection();

    await screen.findByTestId("connector-row-conn-1");
    expect(
      screen.queryByTestId("connector-delivery-warning-conn-1")
    ).not.toBeInTheDocument();
  });

  it("surfaces a global d7_blocked reason on an active-but-undeliverable connector", async () => {
    listMock.mockResolvedValue([
      connector({
        transport: "stdio",
        command: "npx fs-mcp",
        url: null,
        deliverability: {
          deliverable: false,
          reason: "d7_blocked",
          blockedAgents: [],
        },
      }),
    ]);
    renderSection();

    const warning = await screen.findByTestId(
      "connector-delivery-warning-conn-1"
    );
    // Distinct from the healthy green "Active" badge.
    expect(
      within(warning).getByText(/not reaching agents/i)
    ).toBeInTheDocument();
    expect(
      within(warning).getByText(/aren't allowed in this deployment/i)
    ).toBeInTheDocument();
  });

  it("names the blocked agent for a per-agent secret_unreachable (codex + stdio secret)", async () => {
    listMock.mockResolvedValue([
      connector({
        transport: "stdio",
        command: "npx fs-mcp",
        url: null,
        secretRef: "mcp:fs",
        requiresSecret: true,
        deliverability: {
          deliverable: false,
          reason: null,
          blockedAgents: [
            { agentId: "a2", agentName: "Codey", reason: "secret_unreachable" },
          ],
        },
      }),
    ]);
    renderSection();

    const warning = await screen.findByTestId(
      "connector-delivery-warning-conn-1"
    );
    expect(within(warning).getByText(/Codey/)).toBeInTheDocument();
    expect(
      within(warning).getByText(/Codex CLI can't pass/i)
    ).toBeInTheDocument();
  });

  it("still shows the needs_credentials affordance (its own surface) untouched", async () => {
    listMock.mockResolvedValue([
      connector({
        status: "needs_credentials",
        requiresSecret: true,
        secretRef: null,
        headerTemplate: { Authorization: "" },
        // non-active → deliverability is null; the status badge speaks for it
        deliverability: null,
      }),
    ]);
    renderSection();

    expect(await screen.findByText("Needs setup")).toBeInTheDocument();
    const row = screen.getByTestId("connector-row-conn-1");
    expect(
      within(row).getByRole("button", { name: /add credential/i })
    ).toBeInTheDocument();
    // No delivery warning competes with the credential affordance.
    expect(
      screen.queryByTestId("connector-delivery-warning-conn-1")
    ).not.toBeInTheDocument();
  });
});

/* ── 3. Settings is manage-only, and the empty state is not a dead end ──── */

describe("Settings no longer browses the catalog", () => {
  it("never fetches the connector catalog", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    await screen.findByTestId("connector-row-conn-1");
    // The browsable shelf moved to Marketplace → Connectors. If this ever fires
    // again from Settings, the two surfaces have drifted back together.
    expect(catalogMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("connector-shelf-card-notion")
    ).not.toBeInTheDocument();
  });

  it("sends a founder with zero connectors to the Marketplace surface", async () => {
    listMock.mockResolvedValue([]);
    renderSection();

    const empty = await screen.findByTestId("connectors-empty-state");
    expect(within(empty).getByText(/no connectors yet/i)).toBeInTheDocument();
    // A dead end would be: "you have none" with no way to get one.
    expect(
      await within(empty).findByRole("link", {
        name: /browse connectors in marketplace/i,
      })
    ).toHaveAttribute("href", "/marketplace/connectors");
  });

  it("keeps a persistent link to the Marketplace surface next to the list", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    await screen.findByTestId("connector-row-conn-1");
    expect(
      screen.getByRole("link", { name: /browse connectors/i })
    ).toHaveAttribute("href", "/marketplace/connectors");
  });
});

/* ── 7. Enable (re-activating a disabled connector) ─────────────────────── */

describe("Enable (re-activating a disabled connector)", () => {
  it("shows an Enable button for a disabled connector and calls update with status active", async () => {
    listMock.mockResolvedValue([connector({ status: "disabled" })]);
    updateMock.mockResolvedValue(connector({ status: "active" }));
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    const enableBtn = within(row).getByRole("button", { name: /^enable$/i });
    fireEvent.click(enableBtn);

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith(COMPANY_ID, "conn-1", {
        status: "active",
      })
    );
  });

  it("shows Disable (not Enable) for an active connector — Enable is disabled-only", async () => {
    listMock.mockResolvedValue([connector({ status: "active" })]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(
      within(row).queryByRole("button", { name: /^enable$/i })
    ).not.toBeInTheDocument();
    expect(
      within(row).getByRole("button", { name: /^disable$/i })
    ).toBeInTheDocument();
  });

  it("surfaces a failed enable via actionError (e.g. a credential precondition)", async () => {
    listMock.mockResolvedValue([connector({ status: "disabled" })]);
    updateMock.mockRejectedValue(
      new ApiError(
        "Bind a credential before re-enabling this connector",
        422,
        {}
      )
    );
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    fireEvent.click(within(row).getByRole("button", { name: /^enable$/i }));

    expect(
      await screen.findByText(
        /bind a credential before re-enabling this connector/i
      )
    ).toBeInTheDocument();
  });
});

/* ── 8. Remove now requires confirmation ────────────────────────────────── */

describe("Remove (destructive — now gated behind a confirm dialog)", () => {
  it("does not remove immediately: Remove opens a confirm dialog first", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));

    expect(removeMock).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/remove connector\?/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(new RegExp(connector().displayName))
    ).toBeInTheDocument();
  });

  it("calls remove only after confirming", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^remove$/i }));

    await waitFor(() =>
      expect(removeMock).toHaveBeenCalledWith(COMPANY_ID, "conn-1")
    );
  });

  it("does not call remove when the confirm dialog is cancelled", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    fireEvent.click(within(row).getByRole("button", { name: /^remove$/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(removeMock).not.toHaveBeenCalled();
  });
});

/* ── 9. Add connector — now a modal, mirroring NewAoaAgentDialog ────────── */

describe("Add connector (modal)", () => {
  it("opens the Add-connector dialog from the header button without fetching the catalog", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    await screen.findByTestId("connector-row-conn-1");
    fireEvent.click(screen.getByRole("button", { name: /^add connector$/i }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/add a custom connector/i)
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/display name/i)).toBeInTheDocument();
    // Regression guard shared with "never fetches the connector catalog": the
    // modal must not pull in the browsable shelf either.
    expect(catalogMock).not.toHaveBeenCalled();
  });

  it("submits the form and creates a connector, then closes the dialog", async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue(connector({ id: "new-conn" }));
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: /^add connector$/i })
    );
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByPlaceholderText("Notion Docs"), {
      target: { value: "My Connector" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText("notion-docs"), {
      target: { value: "my-connector" },
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText("https://mcp.example.com/sse"),
      {
        target: { value: "https://example.com/mcp" },
      }
    );

    fireEvent.click(
      within(dialog).getByRole("button", { name: /^add connector$/i })
    );

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(
        COMPANY_ID,
        expect.objectContaining({
          displayName: "My Connector",
          serverName: "my-connector",
          transport: "http",
          url: "https://example.com/mcp",
        })
      )
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });
});

/* ── 11. Per-connector access indicator (b2) ────────────────────────────── */

describe("Per-connector access indicator", () => {
  it("shows Commander + N agents for an active connector with assigned agents", async () => {
    listMock.mockResolvedValue([
      connector({ status: "active", enabledAgentIds: ["a1", "a2"] }),
    ]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(
      within(row).getByTestId("connector-access-conn-1")
    ).toHaveTextContent("Commander + 2 agents");
  });

  it("uses singular 'agent' for exactly one assigned agent", async () => {
    listMock.mockResolvedValue([
      connector({ status: "active", enabledAgentIds: ["a1"] }),
    ]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(
      within(row).getByTestId("connector-access-conn-1")
    ).toHaveTextContent("Commander + 1 agent");
  });

  it("shows Commander only for an active connector with no assigned agents", async () => {
    listMock.mockResolvedValue([
      connector({ status: "active", enabledAgentIds: [] }),
    ]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    expect(
      within(row).getByTestId("connector-access-conn-1")
    ).toHaveTextContent("Commander only");
  });
});

/* ── 10. Access-model clarity (Commander vs. crew/org agents) ───────────── */

describe("Access-model clarity", () => {
  it("explains that Commander gets every active connector automatically and agents need explicit assignment", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    await screen.findByTestId("connector-row-conn-1");
    // The sentence is split across inline <span> emphasis elements ("Commander",
    // "crew or org agent", "Agents"), so assert on the "Commander" emphasis and
    // the surrounding plain-text run separately rather than one regex spanning
    // the element boundary (RTL's default text matcher only looks at an
    // element's own direct text-node children, not descendants').
    expect(screen.getByText("Commander")).toBeInTheDocument();
    expect(
      screen.getByText(/can use every active connector automatically/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/assign it with/i)).toBeInTheDocument();
  });

  it("points a founder with no agents yet at the Agents page from the agent-assignment panel", async () => {
    listMock.mockResolvedValue([connector()]);
    renderSection();

    const row = await screen.findByTestId("connector-row-conn-1");
    fireEvent.click(within(row).getByRole("button", { name: /^agents$/i }));

    expect(
      await screen.findByText(/no agents in this company yet/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/commander already has access to active connectors/i)
    ).toBeInTheDocument();
  });
});
