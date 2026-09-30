import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/context/SidebarContext";
import { TeamLayout } from "@/components/team/TeamLayout";

function renderTeamLayout(onSectionChange = vi.fn()) {
  render(
    <SidebarProvider>
      <TeamLayout
        activeSection="agents"
        counts={{ agents: 3, humans: 7, teams: 2 }}
        onSectionChange={onSectionChange}
      >
        <div data-testid="team-layout-content">Team content</div>
      </TeamLayout>
    </SidebarProvider>,
  );
}

describe("TeamLayout", () => {
  it("renders the team section navigation and content", () => {
    renderTeamLayout();

    expect(screen.getByText("Visualize")).toBeInTheDocument();
    expect(screen.getByText("Workforce")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /org tree/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /agents/i })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("button", { name: /humans/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /teams/i })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByTestId("team-layout-content")).toBeInTheDocument();
  });

  it("notifies when a different section is selected", async () => {
    const onSectionChange = vi.fn();
    const user = userEvent.setup();
    renderTeamLayout(onSectionChange);

    await user.click(screen.getByRole("button", { name: /humans/i }));

    expect(onSectionChange).toHaveBeenCalledWith("humans");
  });
});
