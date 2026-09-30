import { screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { WidgetShell } from "../../components/home/widgets/WidgetShell";

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));

describe("WidgetShell", () => {
  it("renders the header as an accessible link to `to` when not editing", () => {
    renderWithProviders(
      <WidgetShell title="Action queue" icon={Inbox} to="/issues">
        <div>widget body</div>
      </WidgetShell>,
    );

    const link = screen.getByRole("link", { name: "Open Action queue" });
    expect(link).toHaveAttribute("href", "/issues");
    // The title is still its own heading node (HomeBoard's heading-order
    // assertions depend on this) even though the link carries the aria-label.
    expect(screen.getByRole("heading", { level: 2, name: "Action queue" })).toBeInTheDocument();
    expect(screen.getByText("widget body")).toBeInTheDocument();
  });

  it("renders the header as a non-navigating element (not a link) when editing", () => {
    renderWithProviders(
      <WidgetShell title="Action queue" icon={Inbox} to="/issues" editing>
        <div>widget body</div>
      </WidgetShell>,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Action queue" })).toBeInTheDocument();
    expect(screen.getByText("widget body")).toBeInTheDocument();
  });
});
