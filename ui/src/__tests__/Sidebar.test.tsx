import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "@/components/Sidebar";
import { SidebarProvider } from "@/context/SidebarContext";
import { DialogProvider } from "@/context/DialogContext";
import { pluginsApi } from "@/api/plugins";

// Mock APIs the sidebar pulls from
vi.mock("@/api/sidebarBadges", () => ({
  sidebarBadgesApi: {
    get: vi.fn().mockResolvedValue({ inbox: 0, pendingDiscussions: 0, failedRuns: 0 }),
  },
}));
vi.mock("@/api/plugins", () => ({
  pluginsApi: { listUiContributions: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: vi.fn().mockResolvedValue([
      { id: "p1", name: "Q4 launch", type: "project", color: "#10b981", archivedAt: null, sortOrder: 0 },
      { id: "d1", name: "Engineering", type: "department", color: "#06b6d4", archivedAt: null, sortOrder: 0 },
    ]),
  },
}));
vi.mock("@/hooks/useLiveAgentCount", () => ({
  useLiveAgentCount: () => 0,
}));
vi.mock("@/hooks/usePendingUpdates", () => ({
  usePendingUpdates: () => ({ data: [] }),
}));
vi.mock("@/components/UserMenu", () => ({
  UserMenu: () => <div data-testid="user-menu" />,
}));
vi.mock("@/context/CompanyContext", async () => {
  return {
    CompanyProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useCompany: () => ({
      selectedCompany: { id: "c1", name: "Phase4 Test Co", issuePrefix: "P4", brandColor: "#7c3aed" },
      selectedCompanyId: "c1",
    }),
  };
});

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/P4/home"]}>
        <DialogProvider>
          <SidebarProvider>
            <Sidebar />
          </SidebarProvider>
        </DialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(pluginsApi.listUiContributions).mockClear();
  // Force desktop dimensions for these tests
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
  window.dispatchEvent(new Event("resize"));
});

describe("Sidebar — Phase E chrome", () => {
  it("discovers plugin pages only for the selected company", async () => {
    renderSidebar();

    await waitFor(() => {
      expect(pluginsApi.listUiContributions).toHaveBeenCalledWith("c1");
    });
  });

  it("does not render Marketplace nav item", () => {
    renderSidebar();
    expect(screen.queryByText("Marketplace")).toBeNull();
  });

  it("does not render Updates nav item", () => {
    renderSidebar();
    expect(screen.queryByText(/^Updates/)).toBeNull();
  });

  it("does not render bottom UserMenu", () => {
    renderSidebar();
    expect(screen.queryByTestId("user-menu")).toBeNull();
  });

  it("renders the external SidebarCollapseToggle on desktop", () => {
    renderSidebar();
    expect(screen.getByLabelText(/collapse sidebar/i)).toBeInTheDocument();
  });

  it("header company-name link navigates to lobby (href='/' )", () => {
    renderSidebar();
    const link = screen.getByTitle(/back to all companies/i);
    expect(link).toHaveAttribute("href", "/");
  });

  it("active row uses brand-red glow dot pattern (no bg-accent)", async () => {
    renderSidebar();
    // /P4/home → Home is the active route
    const homeLink = await screen.findByRole("link", { name: /^Home/ });
    expect(homeLink.className).toContain("bg-brand/[0.08]");
    expect(homeLink.className).not.toContain("bg-accent");
  });

  it("renders project rows with a Rocket icon tinted in project.color", async () => {
    renderSidebar();
    const projectLink = await screen.findByRole("link", { name: /Q4 launch/ });
    // The project icon is an SVG; lucide-react renders <svg class="lucide lucide-rocket">.
    const rocketSvg = projectLink.querySelector("svg.lucide-rocket");
    expect(rocketSvg).not.toBeNull();
    expect(rocketSvg).toHaveAttribute("style", expect.stringContaining("color"));
  });

  it("renders department rows with a colored square (no Rocket)", async () => {
    renderSidebar();
    const deptLink = await screen.findByRole("link", { name: /Engineering/ });
    expect(deptLink.querySelector("svg.lucide-rocket")).toBeNull();
    // The colored square is a 14×14 span with inline backgroundColor
    const square = deptLink.querySelector("span[style*='background']");
    expect(square).not.toBeNull();
  });

  it("renders Workspaces nav item under WORK section", () => {
    renderSidebar();
    expect(screen.getByText("Workspaces")).toBeInTheDocument();
  });

  it("does not render an Approvals nav item (hub is the queue; routes kept)", async () => {
    renderSidebar();
    // Nav entry removed per founder decision — the Inbox hub is the single queue.
    // The /approvals/:id routes survive (deep-link target), but no nav link points there.
    await screen.findByRole("link", { name: /^Inbox/ });
    expect(screen.queryByRole("link", { name: /approvals/i })).toBeNull();
    expect(screen.queryByText("Approvals")).toBeNull();
  });

  it("renders Inbox as the single hub entry point", async () => {
    renderSidebar();
    expect(await screen.findByRole("link", { name: /^Inbox/ })).toHaveAttribute(
      "href",
      "/P4/inbox",
    );
    expect(screen.queryByRole("link", { name: /Hub preview/i })).not.toBeInTheDocument();
  });
});
