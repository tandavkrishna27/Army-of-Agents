import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CompanyOrientation } from "../CompanyOrientation";

const getCompany = vi.fn();
const listProjects = vi.fn();
const listAgents = vi.fn();
const getTeam = vi.fn();

vi.mock("../../api/companies", () => ({ companiesApi: { get: (...a: unknown[]) => getCompany(...a) } }));
vi.mock("../../api/projects", () => ({ projectsApi: { list: (...a: unknown[]) => listProjects(...a) } }));
vi.mock("../../api/agents", () => ({ agentsApi: { list: (...a: unknown[]) => listAgents(...a) } }));
vi.mock("../../api/team", () => ({ teamApi: { get: (...a: unknown[]) => getTeam(...a) } }));

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("CompanyOrientation", () => {
  beforeEach(() => {
    getCompany.mockReset();
    listProjects.mockReset();
    listAgents.mockReset();
    getTeam.mockReset();
  });

  it("renders company mission, department chips, and a team+agent count", async () => {
    getCompany.mockResolvedValue({ id: "c1", name: "Acme", vision: "Ship the future of robotics.", mission: null });
    listProjects.mockResolvedValue([
      { id: "p1", type: "department", name: "Engineering" },
      { id: "p2", type: "department", name: "Design" },
      { id: "p3", type: "project", name: "Launch" },
    ]);
    listAgents.mockResolvedValue([{ id: "a1" }, { id: "a2" }, { id: "a3" }]);
    getTeam.mockResolvedValue({ currentUser: {}, members: [{ id: "m1" }, { id: "m2" }], pendingInvites: [] });

    renderWith(<CompanyOrientation companyId="c1" companyName="Acme" />);

    expect(await screen.findByText("Ship the future of robotics.")).toBeInTheDocument();
    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.queryByText("Launch")).not.toBeInTheDocument();
    expect(await screen.findByText(/2 teammates · 3 agents/i)).toBeInTheDocument();
  });

  it("shows per-card fallbacks when data is empty", async () => {
    getCompany.mockResolvedValue({ id: "c1", name: "Acme", vision: null, mission: null });
    listProjects.mockResolvedValue([]);
    listAgents.mockResolvedValue([]);
    getTeam.mockResolvedValue({ currentUser: {}, members: [], pendingInvites: [] });

    renderWith(<CompanyOrientation companyId="c1" companyName="Acme" />);

    expect(await screen.findByText(/shaping this as they go/i)).toBeInTheDocument();
    expect(screen.getByText(/no departments yet/i)).toBeInTheDocument();
    expect(screen.getByText(/one of the first here/i)).toBeInTheDocument();
  });

  it("shows a loading skeleton, not misleading fallbacks, while fetches are pending", () => {
    // Never-resolving promises hold every query in its loading state.
    getCompany.mockReturnValue(new Promise(() => {}));
    listProjects.mockReturnValue(new Promise(() => {}));
    listAgents.mockReturnValue(new Promise(() => {}));
    getTeam.mockReturnValue(new Promise(() => {}));

    renderWith(<CompanyOrientation companyId="c1" companyName="Acme" />);

    // Same footprint (titles render) but none of the fallback copy flashes
    // before the real data arrives.
    expect(screen.getByText("Departments")).toBeInTheDocument();
    expect(screen.getByText("Who's here")).toBeInTheDocument();
    expect(screen.queryByText(/no departments yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/one of the first here/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/shaping this as they go/i)).not.toBeInTheDocument();
  });

  it("renders all fallbacks and fetches nothing when companyId is null", () => {
    renderWith(<CompanyOrientation companyId={null} companyName="Acme" />);
    expect(getCompany).not.toHaveBeenCalled();
    expect(screen.getByText(/shaping this as they go/i)).toBeInTheDocument();
    expect(screen.getByText(/no departments yet/i)).toBeInTheDocument();
    expect(screen.getByText(/one of the first here/i)).toBeInTheDocument();
  });
});
