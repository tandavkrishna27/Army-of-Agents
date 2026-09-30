import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { AgentsNowWidget } from "../../components/home/widgets/AgentsNowWidget";

const { useLiveAgentCountMock } = vi.hoisted(() => ({ useLiveAgentCountMock: vi.fn() }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useLiveAgentCount", () => ({ useLiveAgentCount: useLiveAgentCountMock }));

describe("AgentsNowWidget", () => {
  it("shows the live agent count", () => {
    useLiveAgentCountMock.mockReturnValue(3);
    renderWithProviders(<AgentsNowWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    expect(screen.getByText("Agents working now")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders 0 (not hidden) when no agents are working", () => {
    useLiveAgentCountMock.mockReturnValue(0);
    renderWithProviders(<AgentsNowWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("Agents working now")).toBeInTheDocument();
  });

  it("the tile body is a link to /agents when not editing", () => {
    useLiveAgentCountMock.mockReturnValue(3);
    renderWithProviders(<AgentsNowWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    // Two links exist while not editing: WidgetShell's own header link
    // (aria-label "Open Agents working now") and this row's own link — both
    // point at /agents, so distinguish by the header's aria-label instead of
    // by href.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    const rowLink = links.find((el) => !el.hasAttribute("aria-label"));
    expect(rowLink).toBeDefined();
    expect(rowLink).toHaveAttribute("href", "/agents");
  });

  // Regression: the row was a hardcoded <Link>, ignoring `editing` — a click
  // during arrange mode navigated away instead of letting drag/select work,
  // unlike every other widget (which use WidgetRowLink to swap to a plain
  // div while editing).
  it("does not render any link while editing, so a click during arrange doesn't navigate", () => {
    useLiveAgentCountMock.mockReturnValue(3);
    renderWithProviders(<AgentsNowWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} editing />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
